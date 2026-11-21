// Pairing with another Moonshine without anyone typing the PIN.
//
//   1. This PC asks the host engine on the other PC (same port pairing itself uses) to pair, sending
//      the PIN it is about to pair with: GET /moonshine/pair?pin=1234&name=This-PC
//   2. It starts `Moonlight pair <host> --pin <pin>` as usual.
//   3. Moonshine on the other PC shows "wants to pair: Accept / Decline" and, on Accept, gives its
//      host engine that PIN (main.js, promptForOffer), which completes the pairing.
//   4. This PC polls GET /moonshine/pair-status?id=... for the answer.
//
// The PIN only matters this once; afterwards the host knows this PC's certificate. Whether a paired
// device may then stream is the host engine's call (it asks Moonshine's user; see main.js).
const http = require('http');

const DEFAULT_PORT = 47989;
const REQUEST_TTL_MS = 2 * 60 * 1000;

/** Split "host", "host:port" or a bare IPv6 address into what http.request needs. */
function target(address) {
  const bareIpv6 = (address.match(/:/g) || []).length > 1 && !address.includes(']');
  if (bareIpv6) return { host: address, port: DEFAULT_PORT };
  const [host, port] = address.replace(/^\[|\]/g, '').split(/:(?=\d+$)/);
  return { host, port: Number(port) || DEFAULT_PORT };
}

function call(address, path, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    // agent: false: the host closes each connection after answering, so never reuse one
    const req = http.get({ ...target(address), path, timeout: timeoutMs, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* another kind of host answers in XML */ }
        resolve({ code: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Is the host at this address a Moonshine? Resolves { name, listening } or null. */
async function probe(address) {
  try {
    const res = await call(address, '/moonshine/hello', 1500);
    return res.code === 200 && res.json && res.json.app === 'moonshine' ? res.json : null;
  } catch {
    return null;
  }
}

/**
 * Ask a host's user to accept this PC. Resolves the request ID to poll, or null when the host isn't
 * a Moonshine (the PIN has to be typed there). Rejects with `reason` "closed" when Moonshine isn't
 * open on the host to show the request, or "disabled" when the host has pairing turned off.
 */
async function requestPairing(address, pin, name) {
  const res = await call(address, `/moonshine/pair?pin=${pin}&name=${encodeURIComponent(name)}`).catch(() => null);
  if (!res || res.code === 404 || !res.json) return null;
  if (res.code !== 200) throw Object.assign(new Error('The host refused the pairing request'), { reason: res.json.error });
  return res.json.id;
}

/** Wait until the host's user accepts or declines. */
async function waitForDecision(address, id, timeoutMs = REQUEST_TTL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await call(address, `/moonshine/pair-status?id=${id}`).catch(() => null);
    if (res && res.json && res.json.status && res.json.status !== 'pending') return res.json.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'timeout';
}

/**
 * Invite a friend's Moonshine to join a stream on this PC. Resolves the invite ID to poll.
 * Rejects with `reason` "closed" when Moonshine isn't open there, or "old" when it can't do invites.
 */
async function sendInvite(address, { name, app, port }) {
  const query = `name=${encodeURIComponent(name)}&app=${encodeURIComponent(app)}&port=${port}`;
  const res = await call(address, `/moonshine/invite?${query}`).catch(() => null);
  if (!res) throw Object.assign(new Error('unreachable'), { reason: 'unreachable' });
  if (res.code === 404 || !res.json) throw Object.assign(new Error('old'), { reason: 'old' });
  if (res.code !== 200) throw Object.assign(new Error(res.json.error), { reason: res.json.error });
  return res.json.id;
}

/** Wait until the friend joins or says not now. */
async function waitForInvite(address, id, timeoutMs = REQUEST_TTL_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await call(address, `/moonshine/invite-status?id=${id}`).catch(() => null);
    if (res && res.json && res.json.status && res.json.status !== 'pending') return res.json.status;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'timeout';
}

module.exports = { probe, requestPairing, waitForDecision, sendInvite, waitForInvite };
