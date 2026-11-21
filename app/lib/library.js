// Moonshine's host library: PCs Moonlight already knows, PCs found on the LAN,
// and Moonshine hosts on the tailnet, merged into one list.
const http = require('http');
const { execFile } = require('child_process');
const mdns = require('multicast-dns');

const MOONLIGHT_KEY = 'HKCU\\Software\\Moonlight Game Streaming Project\\Moonlight';
const DEFAULT_PORT = 47989;

/**
 * Read Moonlight's saved hosts (and their cached app lists) from the registry.
 * Moonshine always runs Moonlight in non-portable mode, so this is the same store
 * an installed Moonlight uses.
 */
function readSavedHosts(key = MOONLIGHT_KEY) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', `${key}\\hosts`, '/s'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const hosts = {};
        let current = null;
        for (const line of stdout.split(/\r?\n/)) {
          const keyMatch = line.match(/\\hosts\\(\d+)(\\apps\\(\d+))?$/);
          if (keyMatch) {
            const host = (hosts[keyMatch[1]] ||= { index: Number(keyMatch[1]), apps: {} });
            current = keyMatch[3] ? (host.apps[keyMatch[3]] ||= {}) : host;
            continue;
          }
          if (/\\hosts(\\\d+\\apps)?$/.test(line)) {
            current = null;
            continue;
          }
          const valueMatch = current && line.match(/^\s{4}(\S+)\s{4}REG_\w+\s{4}(.*)$/);
          if (valueMatch) current[valueMatch[1]] = valueMatch[2];
        }

        resolve(Object.values(hosts).filter((h) => h.uuid).map((h) => ({
          uuid: h.uuid,
          index: h.index,
          name: h.hostname,
          // Moonlight only stores the server certificate once pairing succeeded.
          paired: Boolean(h.srvcert && h.srvcert !== '@ByteArray()'),
          addresses: [
            [h.manualaddress, h.manualport],
            [h.localaddress, h.localport],
            [h.remoteaddress, h.remoteport],
            [h.ipv6address, h.ipv6port],
          ].filter(([a]) => a).map(([a, p]) => ({ address: a, port: Number(p) || DEFAULT_PORT })),
          apps: Object.values(h.apps)
            .filter((a) => a.name && a.hidden !== 'true')
            .map((a) => ({ id: Number(a.id), name: a.name })),
        })));
      });
  });
}

function reg(...args) {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/**
 * Forget a saved PC (and this PC's pairing with it). Moonlight keeps its PCs as a numbered list
 * (hosts\1 .. hosts\N plus a count), so the ones after it move up a place.
 * @returns {Promise<boolean>} false if no saved PC has that uuid
 */
async function removeSavedHost(uuid, key = MOONLIGHT_KEY) {
  const saved = await readSavedHosts(key);
  const target = saved.find((h) => h.uuid === uuid);
  if (!target) return false;
  const size = Math.max(...saved.map((h) => h.index));
  const hostKey = (n) => `${key}\\hosts\\${n}`;
  await reg('delete', hostKey(target.index), '/f');
  for (let n = target.index + 1; n <= size; n++) {
    await reg('copy', hostKey(n), hostKey(n - 1), '/s', '/f');
    await reg('delete', hostKey(n), '/f');
  }
  await reg('add', `${key}\\hosts`, '/v', 'size', '/t', 'REG_DWORD', '/d', String(size - 1), '/f');
  return true;
}

/** Ask a host for its identity over the unauthenticated GameStream HTTP port. */
function serverInfo(address, port = DEFAULT_PORT, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const host = address.includes(':') ? `[${address}]` : address;
    const req = http.get(`http://${host}:${port}/serverinfo`, { timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const tag = (name) => (body.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1];
        const uuid = tag('uniqueid');
        if (!uuid) return resolve(null);
        resolve({
          uuid,
          name: tag('hostname'),
          address,
          port,
          busy: tag('state') === 'SUNSHINE_SERVER_BUSY' || tag('currentgame') !== '0',
          runningApp: tag('currentgameuuid') || '',
        });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Find GameStream hosts (Apollo, Sunshine, GeForce) on the local network. */
function discoverLan(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let browser;
    try {
      browser = mdns();
    } catch {
      return resolve([]);
    }
    browser.on('response', (res) => {
      const records = [...res.answers, ...res.additionals];
      const port = records.find((r) => r.type === 'SRV' && r.name.includes('_nvstream._tcp'))?.data.port;
      for (const r of records) {
        if (r.type === 'A' && !found.has(r.data)) found.set(r.data, port || DEFAULT_PORT);
      }
    });
    browser.on('error', () => {});
    browser.query({ questions: [{ name: '_nvstream._tcp.local', type: 'PTR' }] });
    setTimeout(() => {
      browser.destroy();
      resolve([...found].map(([address, port]) => ({ address, port })));
    }, timeoutMs);
  });
}

module.exports = { DEFAULT_PORT, readSavedHosts, removeSavedHost, serverInfo, discoverLan };
