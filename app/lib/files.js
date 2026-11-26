// Sending files to a paired PC. Uses the same identity the stream player paired with (Moonlight's
// client certificate), over the host's HTTPS port, trusting only the certificate saved at pairing.
// The host asks its user "X wants to send you photo.png"; on Accept the file goes up in pieces.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const PIECE = 4 << 20; // 4 MB per request (the host takes up to 8)
const ANSWER_TIMEOUT_MS = 2 * 60 * 1000;

const PS_READ = `
$k = 'HKCU:\\Software\\Moonlight Game Streaming Project\\Moonlight'
$root = Get-ItemProperty -Path $k
$srv = ''
Get-ChildItem "$k\\hosts" -ErrorAction SilentlyContinue | ForEach-Object {
  $h = Get-ItemProperty -Path $_.PSPath
  if ($h.uuid -eq $env:MS_UUID) { $srv = $h.srvcert }
}
@{ cert = $root.certificate; key = $root.key; srv = $srv } | ConvertTo-Json -Compress`;

/** Qt keeps byte arrays as "@ByteArray(...)", with newlines written as \\n. */
function unwrap(value) {
  const s = String(value || '');
  const m = s.match(/^@ByteArray\(([\s\S]*)\)$/);
  return (m ? m[1] : s).replace(/\\n/g, '\n').replace(/\\r/g, '');
}

function readIdentity(uuid) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', PS_READ], {
      windowsHide: true, env: { ...process.env, MS_UUID: String(uuid) },
    }, (err, stdout) => {
      if (err) return reject(new Error('Couldn’t read this PC’s stream identity.'));
      try {
        const j = JSON.parse(stdout);
        const id = { cert: unwrap(j.cert), key: unwrap(j.key), srv: unwrap(j.srv) };
        if (!id.cert.includes('BEGIN') || !id.key.includes('BEGIN')) throw new Error('none');
        if (!id.srv.includes('BEGIN')) return reject(new Error('Pair with that PC first.'));
        resolve(id);
      } catch {
        reject(new Error('Stream from any PC once first, so Moonshine has an identity to send with.'));
      }
    });
  });
}

/** "host", "host:47989", "[::1]:47989" → { host, httpsPort } (the HTTPS port is 5 below). */
function target(address) {
  let host = String(address);
  let port = 47989;
  const v6 = host.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if ((host.match(/:/g) || []).length === 1) {
    const [h, p] = host.split(':');
    host = h;
    port = Number(p) || port;
  }
  return { host, httpsPort: port - 5 };
}

const ERRORS = {
  'not-allowed': (pc) => `${pc} doesn’t let this PC send files. On ${pc}, turn on “Upload files” for this device in Host → Devices.`,
  closed: (pc) => `Moonshine isn’t running on ${pc}, so nobody can accept the file.`,
  'no-space': (pc) => `${pc} doesn’t have enough free disk space for that file.`,
  busy: (pc) => `${pc} has too many files waiting. Try again in a minute.`,
  'bad-size': () => 'That file is empty or too big (64 GB at most).',
  declined: (pc) => `${pc} declined the file.`,
};

class SendError extends Error {}

/** One connection to a PC, pinned to its saved certificate. */
async function connect(pc) {
  const id = pc.identity || await readIdentity(pc.uuid); // tests pass their own
  const { host, httpsPort } = target(pc.address);
  const agent = new https.Agent({
    // the host closes the connection after each answer, and refuses resumed TLS sessions
    keepAlive: false, maxSockets: 1, maxCachedSessions: 0,
    cert: id.cert, key: id.key, ca: [id.srv],
    checkServerIdentity: () => undefined, // the PC's certificate is trusted by itself, not by its name
  });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = https.request({
      host, port: httpsPort, path: p, method, agent, timeout: 30000,
      headers: body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : { 'Content-Length': 0 },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* not JSON */ }
        if (res.statusCode === 200) return resolve(json);
        const make = ERRORS[json.error];
        const err = new SendError(make ? make(pc.name) : `${pc.name} refused the file (${res.statusCode}).`);
        err.code = json.error;
        err.received = json.received;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new SendError(`${pc.name} stopped answering.`)));
    req.on('error', (e) => reject(e instanceof SendError ? e : new SendError(
      /certificate|self.signed|CERT/i.test(e.message)
        ? `${pc.name}’s identity has changed. Pair with it again.`
        : `Couldn’t reach ${pc.name}.`, { cause: `${method} ${p.split('?')[0]}: ${e.code || e.message}` })));
    if (body) req.write(body);
    req.end();
  });
  return { call, close: () => agent.destroy() };
}

/**
 * Send one file. `onUpdate({ state, sent, size })`, state: asking, sending, done.
 * `signal.cancelled` stops it (the host is told). Throws SendError with a user-facing message.
 */
async function send(pc, file, onUpdate, signal = {}) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new SendError('Only files can be sent, not folders.');
  const size = stat.size;
  const name = path.basename(file);
  const conn = await connect(pc);
  let id = null;
  const cancel = () => id && conn.call('POST', `/moonshine/file/cancel?id=${id}`).catch(() => {});
  try {
    onUpdate({ state: 'asking', sent: 0, size });
    ({ id } = await conn.call('POST', `/moonshine/file/offer?name=${encodeURIComponent(name)}&size=${size}`));
    const asked = Date.now();
    for (;;) {
      if (signal.cancelled) { await cancel(); throw new SendError('Cancelled.'); }
      const st = await conn.call('GET', `/moonshine/file/status?id=${id}`);
      if (st.status === 'accepted') break;
      if (st.status === 'declined') throw new SendError(ERRORS.declined(pc.name));
      if (Date.now() - asked > ANSWER_TIMEOUT_MS) { await cancel(); throw new SendError(`${pc.name} didn’t answer.`); }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const fh = await fs.promises.open(file, 'r');
    try {
      let sent = 0;
      const buf = Buffer.alloc(Math.min(PIECE, Math.max(size, 1)));
      while (sent < size) {
        if (signal.cancelled) { await cancel(); throw new SendError('Cancelled.'); }
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - sent), sent);
        if (!bytesRead) throw new SendError('The file changed while it was being sent.');
        const r = await conn.call('POST', `/moonshine/file/chunk?id=${id}&offset=${sent}`, buf.subarray(0, bytesRead));
        sent = r.received;
        onUpdate({ state: 'sending', sent, size });
      }
    } finally {
      await fh.close();
    }
    onUpdate({ state: 'done', sent: size, size });
  } catch (err) {
    if (!(err instanceof SendError)) await cancel();
    throw err;
  } finally {
    conn.close();
  }
}

module.exports = { send, target, unwrap, readIdentity, SendError };
