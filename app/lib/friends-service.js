// Talks to Moonshine's friends service (cloud/, a Cloudflare Worker): Discord sign-in, your username,
// friend requests, and each signed-in PC's presence (how friends can reach its host, whether it's busy).
// Video never goes through the service; it only helps PCs find each other.
const crypto = require('crypto');
const os = require('os');
const { shell } = require('electron');
const store = require('./store');

const SERVICE_URL = (process.env.MOONSHINE_SERVICE_URL || 'https://moonshine.moonshine-streaming.workers.dev').replace(/\/$/, '');
const LOGIN_WAIT_MS = 10 * 60 * 1000;

let loginAttempt = null; // { session, cancelled }

function configured() {
  return Boolean(SERVICE_URL);
}

function token() {
  try {
    return store.getSecret('serviceToken');
  } catch {
    return '';
  }
}

function signedIn() {
  return Boolean(token());
}

async function call(method, path, body) {
  const t = token();
  const res = await fetch(SERVICE_URL + path, {
    method,
    headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && t && path !== '/auth/poll') {
    // The service forgot this PC (signed out elsewhere, or the account went away)
    store.set('serviceToken', '');
    store.set('serviceUsername', '');
  }
  if (!res.ok) throw Object.assign(new Error((json && json.error) || `The friends service answered ${res.status}`), { status: res.status });
  return json;
}

/** Open Discord sign-in in the browser and wait for it to finish. Resolves { username } (null until picked). */
async function signIn() {
  if (loginAttempt) loginAttempt.cancelled = true;
  const attempt = { session: crypto.randomBytes(24).toString('base64url'), cancelled: false };
  loginAttempt = attempt;
  await shell.openExternal(`${SERVICE_URL}/auth/discord/start?session=${attempt.session}`);
  const deadline = Date.now() + LOGIN_WAIT_MS;
  try {
    while (Date.now() < deadline && !attempt.cancelled) {
      await new Promise((r) => setTimeout(r, 1500));
      let res;
      try {
        res = await call('GET', `/auth/poll?session=${attempt.session}`);
      } catch (err) {
        if (err.status === 401) throw new Error('Sign-in was cancelled.');
        if (err.status === 410) continue; // the browser hasn't reached the service yet
        continue; // network blip; keep waiting
      }
      if (res && res.token) {
        store.setSecret('serviceToken', res.token);
        store.set('serviceUsername', res.username || '');
        return { username: res.username || null };
      }
    }
    throw new Error(attempt.cancelled ? 'Sign-in was cancelled.' : 'Sign-in timed out. Try again.');
  } finally {
    if (loginAttempt === attempt) loginAttempt = null;
  }
}

function cancelSignIn() {
  if (loginAttempt) loginAttempt.cancelled = true;
}

async function signOut() {
  await call('POST', '/auth/signout').catch(() => {});
  store.set('serviceToken', '');
  store.set('serviceUsername', '');
}

async function setUsername(name) {
  const res = await call('POST', '/me/username', { name });
  store.set('serviceUsername', res.username);
  return res.username;
}

/** This PC's addresses a friend might reach it on: Tailscale's, and its home-network ones. */
function localAddresses() {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
      addrs.push(a.address);
    }
  }
  return addrs;
}

async function reportPresence(state) {
  return call('POST', '/presence', { ...state, addrs: [...new Set([...(state.addrs || []), ...localAddresses()])] });
}

async function friends() {
  const res = await call('GET', '/friends');
  if (res.me) store.set('serviceUsername', res.me.username || '');
  return res;
}

const request = (username) => call('POST', '/friends/request', { username });
const respond = (username, accept) => call('POST', '/friends/respond', { username, accept });
const remove = (username) => call('POST', '/friends/remove', { username });

// Direct connections (lib/tunnels.js): a one-time pass for the live link (lib/hub.js), and the
// offer and answer two PCs swap to connect straight to each other.
const hubTicket = async () => (await call('POST', '/hub/ticket')).ticket;
const tunnelOffer = (offer) => call('POST', '/tunnel/offer', offer);
const tunnelAnswer = (answer) => call('POST', '/tunnel/answer', answer);

module.exports = {
  configured, signedIn, signIn, cancelSignIn, signOut, setUsername, reportPresence, friends, request, respond, remove,
  hubTicket, tunnelOffer, tunnelAnswer, SERVICE_URL,
  username: () => store.get('serviceUsername') || '',
};
