// Direct connections to and from friends' PCs, over the internet with no port forwarding or VPN.
// The packets themselves are handled by lib/tunnel-engine.js (in a worker thread); this file does the
// arranging:
//
//  Watching a friend's PC (client side): ask their PC through the service (lib/hub.js carries the
//  answer back), open the tunnel, and hand back a stand-in address (127.77.x.y:port) that the player,
//  pairing and the app list use as if it were the friend's PC.
//
//  Hosting (host side): when a friend's PC asks, open a tunnel into this PC's host engine. Each one
//  connects from its own 127.88.x.y address, so pairing and stream requests show which friend it is.
'use strict';

const crypto = require('crypto');
const store = require('./store');
const service = require('./friends-service');
const hub = require('./hub');
const tunnel = require('./tunnel');

const ANSWER_WAIT_MS = 20 * 1000;
const CLIENT_IDLE_MS = 10 * 60 * 1000; // close a tunnel nobody has used for this long
const MAX_HOST_TUNNELS = 8;
const SOURCE_MEMORY_MS = 10 * 60 * 1000; // keep knowing a friend's address a while after their tunnel closed

const LOCAL_PREFIX = '127.77.';
const SOURCE_PREFIX = '127.88.';

let hooks = {
  hostInfo: async () => ({ running: false, port: 47989 }), // this PC's host engine
  inUse: () => false, // is the player using this address right now?
  friendPc: () => null, // host uuid -> { device, port, name, username, guest? } from the friends list (guest: { token, link } for an invite)
  inviteOk: async () => false, // may a guest of this invite connect? (this PC made the link and it is still open)
  log: () => {},
};

const clients = new Map(); // host uuid -> { id, ip, offset, hostBase, address, open, connecting }
const hosts = new Map(); // tunnel id -> { srcIp, username, name, session }
const sources = new Map(); // 127.88.x.y -> { username, name, until }

const newId = () => crypto.randomBytes(8).toString('hex');

/** Stable stand-in address per friend's PC, so the player's saved PC keeps its address. */
function localIpFor(hostUuid) {
  const saved = store.get('tunnelHosts')[hostUuid];
  if (saved && saved.ip) return saved.ip;
  const used = new Set(Object.values(store.get('tunnelHosts')).map((r) => r.ip));
  const h = crypto.createHash('sha256').update(String(hostUuid)).digest();
  for (let i = 0; i < 64; i++) {
    const ip = `${LOCAL_PREFIX}${(h[i % 32] + i) % 254 + 1}.${(h[(i + 1) % 32] * 7 + i) % 254 + 1}`;
    if (!used.has(ip)) return ip;
  }
  return `${LOCAL_PREFIX}${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
}

function remember(hostUuid, rec) {
  store.set('tunnelHosts', { ...store.get('tunnelHosts'), [hostUuid]: rec });
}

function friendlyError(code, name) {
  switch (code) {
    case 'not-hosting': return `${name} isn’t hosting right now.`;
    case 'not-invited': return `${name} didn’t accept the invite. Ask for a new link.`;
    case 'busy': return `${name} has too many connections open. Try again in a minute.`;
    case 'offline': return `Moonshine on ${name} isn’t connected right now. Ask your friend to open Moonshine.`;
    case 'no-answer': return `${name} didn’t answer. Their Moonshine may have just closed.`;
    case 'no-service': return 'Can’t reach Moonshine’s service right now. Check your internet connection.';
    case 'no-ports': return 'Couldn’t find free ports on this PC for the connection.';
    default: return `Couldn’t connect to ${name}.`;
  }
}

function noPathError(name, nat, relay) {
  if (relay === 'failed') {
    return `Couldn’t connect to ${name}: no direct path, and the relay that takes over then didn’t work either. Tailscale still works for this friend.`;
  }
  return nat === 'symmetric'
    ? `Couldn’t connect directly to ${name}: your network doesn’t allow direct connections (common on mobile and some internet providers). Tailscale still works for this friend.`
    : `Couldn’t connect directly to ${name}. Their network may not allow direct connections (common on mobile and some internet providers). Tailscale still works for this friend.`;
}

// ---- Client side ---------------------------------------------------------------------------------

/**
 * Open (or reuse) a tunnel to a friend's PC. Resolves its stand-in address ("127.77.x.y:port").
 * pc: { hostUuid, device, port, name }
 */
function connect(pc) {
  const existing = clients.get(pc.hostUuid);
  if (existing && existing.open) return Promise.resolve(existing.address);
  if (existing && existing.connecting) return existing.connecting;

  // relay: 'none' until a direct path fails, then 'asked' (a relayed address was handed to the other PC)
  // or 'failed' (couldn’t get one)
  const guest = pc.guest || null; // joined by an invite link: its own login and live link
  const link = guest ? guest.link : hub;
  const asToken = guest ? guest.token : undefined;
  const entry = { id: newId(), open: false, connecting: null, asToken, device: pc.device, name: pc.name || '', session: '', relay: 'none', relayed: false };
  clients.set(pc.hostUuid, entry);
  entry.connecting = (async () => {
    const name = pc.name || 'your friend’s PC';
    if (!(await link.whenConnected(5000))) throw new Error(friendlyError('no-service', name));
    const session = crypto.randomBytes(24).toString('base64url');
    entry.session = session;
    const prep = await tunnel.call('prepare', { id: entry.id, role: 'client' });
    try {
      const saved = store.get('tunnelHosts')[pc.hostUuid] || {};
      const ip = localIpFor(pc.hostUuid);
      const hostBase = Number(pc.port) || 47989;
      let offset;
      try {
        offset = await tunnel.call('listen', { id: entry.id, localIp: ip, hostBase, preferred: saved.hostBase === hostBase ? saved.offset : undefined });
      } catch (err) {
        throw new Error(friendlyError(err.code, name));
      }
      remember(pc.hostUuid, { ip, offset, hostBase });

      const answer = link.waitFor((m) => m.type === 'tunnel-answer' && m.session === session, ANSWER_WAIT_MS);
      try {
        await service.tunnelOffer({ device: pc.device, session, pub: prep.pub, cands: prep.cands }, asToken);
      } catch (err) {
        answer.cancel();
        throw new Error(err.status === 409 ? friendlyError('offline', name) : err.status ? err.message : friendlyError('no-service', name));
      }
      const ans = await answer.promise;
      if (!ans) throw new Error(friendlyError('no-answer', name));
      if (ans.error) throw new Error(friendlyError(ans.error, name));
      try {
        await tunnel.call('start', { id: entry.id, peerPub: ans.pub, peerCands: ans.cands, session });
      } catch (err) {
        throw new Error(err.code === 'no-path' ? noPathError(name, prep.nat, entry.relay === 'failed' || entry.relay === 'asked' ? 'failed' : '') : friendlyError(err.code, name));
      }
      const info = await tunnel.call('info', { id: entry.id }).catch(() => null);
      entry.relayed = Boolean(info && info.relayed);
      Object.assign(entry, { ip, offset, hostBase, address: `${ip}:${hostBase + offset}`, open: true, connecting: null });
      hooks.log(entry.relayed ? `Relayed connection to ${name} open` : `Direct connection to ${name} open`);
      return entry.address;
    } catch (err) {
      tunnel.call('close', { id: entry.id, reason: 'failed' }).catch(() => {});
      if (clients.get(pc.hostUuid) === entry) clients.delete(pc.hostUuid);
      throw err;
    }
  })();
  return entry.connecting;
}

/**
 * No direct path after a few seconds: get a relayed address from Cloudflare's relay and hand it to the
 * other PC, which then sends to it (the engine holds the relay; see tunnel-engine.js useRelay).
 */
async function askForRelay(entry) {
  if (entry.relay !== 'none') return;
  entry.relay = 'failed';
  try {
    const creds = await service.turnCredentials(entry.asToken);
    const relayed = await tunnel.call('relay', { id: entry.id, creds });
    await service.tunnelRelay({ device: entry.device, session: entry.session, relay: relayed }, entry.asToken);
    entry.relay = 'asked';
    hooks.log(`No direct path to ${entry.name || 'a friend'}; trying the relay`);
  } catch (err) {
    hooks.log(`No relay for ${entry.name || 'a friend'}: ${err.message}`);
  }
}

tunnel.events.on('relay-wanted', (id) => {
  for (const entry of clients.values()) {
    if (entry.id === id && entry.connecting && entry.session) askForRelay(entry).catch(() => {});
  }
});

/** Is the open connection to this host going through the relay? */
function isRelayed(hostUuid) {
  const e = clients.get(hostUuid);
  return Boolean(e && e.open && e.relayed);
}

const isTunnelAddress = (address) => typeof address === 'string' && address.startsWith(LOCAL_PREFIX);

/** The friend's PC behind a stand-in address: { hostUuid, ip, offset, hostBase }. */
function recordFor(address) {
  if (!isTunnelAddress(address)) return null;
  const ip = address.replace(/:\d+$/, '');
  for (const [hostUuid, rec] of Object.entries(store.get('tunnelHosts'))) {
    if (rec.ip === ip) return { hostUuid, ...rec };
  }
  return null;
}

/** Before using a stand-in address: make sure its tunnel is open (reopen it if it closed). */
async function ensureFor(address) {
  const rec = recordFor(address);
  if (!rec) return address;
  const open = clients.get(rec.hostUuid);
  if (open && open.open) return open.address;
  const pc = await hooks.friendPc(rec.hostUuid);
  if (!pc) throw new Error('That friend’s PC isn’t online, or you’re no longer friends.');
  return connect({ hostUuid: rec.hostUuid, ...pc });
}

/** Close the tunnel to one PC (leaving an invite). */
function closeFor(hostUuid) {
  const e = clients.get(hostUuid);
  if (e && e.id) tunnel.call('close', { id: e.id, reason: 'closed' }).catch(() => {});
  clients.delete(hostUuid);
}

/** The open tunnel's address for a friend's PC, if there is one. */
function openAddress(hostUuid) {
  const e = clients.get(hostUuid);
  return e && e.open ? e.address : '';
}

/** A summary for diagnostics: counts only, no addresses or identities. */
function diagnostics() {
  const open = [...clients.values()].filter((e) => e.open);
  return {
    outgoing: open.length,
    outgoingRelayed: open.filter((e) => e.relayed).length,
    outgoingConnecting: [...clients.values()].filter((e) => e.connecting && !e.open).length,
    incoming: hosts.size,
  };
}

/**
 * What the player needs to use a stand-in address: the address and how far the ports are shifted.
 * Applies only to that address (see the player's MoonshineTunnel.h).
 */
function playerEnv(address) {
  const rec = recordFor(address);
  return rec ? { MOONSHINE_TUNNEL: `${rec.ip}|${rec.hostBase}|${rec.offset}` } : {};
}

// ---- Host side -----------------------------------------------------------------------------------

function newSourceIp() {
  const used = new Set([...hosts.values()].map((h) => h.srcIp));
  for (;;) {
    const ip = `${SOURCE_PREFIX}${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
    if (!used.has(ip)) return ip;
  }
}

async function onOffer(msg) {
  if (!msg.from || !Number.isInteger(msg.from.device) || typeof msg.session !== 'string') return;
  if ([...hosts.values()].some((h) => h.session === msg.session)) return; // already handling it
  const answer = (body) => service.tunnelAnswer({ device: msg.from.device, session: msg.session, ...body }).catch(() => {});
  if (hosts.size >= MAX_HOST_TUNNELS) {
    await answer({ error: 'busy' });
    return;
  }
  const host = await hooks.hostInfo().catch(() => ({ running: false }));
  if (!host.running) {
    await answer({ error: 'not-hosting' });
    return;
  }
  // A guest gets in only with a link this PC made and that is still open (the service says which link
  // they used, but this PC checks it against its own list, so a service mix-up can't let a stranger in)
  if (msg.from.guest && !(await hooks.inviteOk(Number(msg.from.invite), msg.from.device).catch(() => false))) {
    await answer({ error: 'not-invited' });
    return;
  }
  const id = newId();
  const srcIp = newSourceIp();
  const who = { srcIp, username: msg.from.username || '', name: msg.from.name || '', session: msg.session, device: msg.from.device, invite: msg.from.guest ? Number(msg.from.invite) || 0 : 0 };
  hosts.set(id, who);
  sources.set(srcIp, { username: who.username, name: who.name, invite: who.invite, until: Infinity });
  try {
    const prep = await tunnel.call('prepare', { id, role: 'host', options: { hostBase: host.port, srcIp } });
    // Start punching before answering, so this side is already sending when the other side starts
    const started = tunnel.call('start', { id, peerPub: msg.pub, peerCands: msg.cands, session: msg.session });
    started.catch(() => {});
    await answer({ pub: prep.pub, cands: prep.cands });
    await started;
    hooks.log(`Direct connection from ${who.username || 'a friend'} open`);
  } catch {
    tunnel.call('close', { id, reason: 'failed' }).catch(() => {});
    if (hosts.has(id)) closedHost(id);
  }
}

/** The other PC found no direct path and got a relayed address: send to it too. */
async function onRelay(msg) {
  if (!msg.from || !msg.relay || typeof msg.session !== 'string') return;
  for (const [id, h] of hosts) {
    if (h.session === msg.session && h.device === msg.from.device) {
      await tunnel.call('addTargets', { id, cands: [{ a: String(msg.relay.a), p: Number(msg.relay.p) }] }).catch(() => {});
      hooks.log(`Trying the relay for ${h.username || 'a friend'}`);
      return;
    }
  }
}

function closedHost(id) {
  const h = hosts.get(id);
  if (!h) return;
  hosts.delete(id);
  const s = sources.get(h.srcIp);
  if (s) s.until = Date.now() + SOURCE_MEMORY_MS;
}

/** Which friend a request to this PC's host came from, if it came through one of their tunnels. */
function friendForSource(address) {
  if (typeof address !== 'string' || !address.startsWith(SOURCE_PREFIX)) return null;
  const s = sources.get(address);
  if (!s) return null;
  if (s.until < Date.now()) {
    sources.delete(address);
    return null;
  }
  return { username: s.username, name: s.name, invite: s.invite || 0 };
}

const isTunnelSource = (address) => typeof address === 'string' && address.startsWith(SOURCE_PREFIX);

// ---- Lifecycle -------------------------------------------------------------------------------------

tunnel.events.on('closed', (id, reason) => {
  for (const [hostUuid, e] of clients) {
    if (e.id === id) {
      clients.delete(hostUuid);
      hooks.log(`Direct connection closed (${reason})`);
    }
  }
  if (hosts.has(id)) closedHost(id);
});

hub.events.on('message', (msg) => {
  if (msg.type === 'tunnel-offer') onOffer(msg).catch(() => {});
  if (msg.type === 'tunnel-relay') onRelay(msg).catch(() => {});
});

// Close tunnels nobody uses any more
setInterval(async () => {
  for (const [hostUuid, e] of clients) {
    if (!e.open || hooks.inUse(e.address)) continue;
    const info = await tunnel.call('info', { id: e.id }).catch(() => null);
    if (info && Date.now() - info.lastUse > CLIENT_IDLE_MS) {
      tunnel.call('close', { id: e.id, reason: 'idle' }).catch(() => {});
      clients.delete(hostUuid);
    }
  }
}, 60 * 1000).unref();

function init(h) {
  hooks = { ...hooks, ...h };
}

/** Close everything (signing out). */
function closeAll() {
  for (const e of clients.values()) if (e.id) tunnel.call('close', { id: e.id, reason: 'signed-out' }).catch(() => {});
  for (const id of hosts.keys()) tunnel.call('close', { id, reason: 'signed-out' }).catch(() => {});
  clients.clear();
  for (const id of [...hosts.keys()]) closedHost(id);
}

/**
 * "Can this PC connect directly?" Asks two STUN servers what this PC's public address looks like: the
 * same port both times means a friendly router (direct works), a different one each time means it
 * doesn't (the relay takes over), and no answer at all means UDP is blocked. Resolves { nat }.
 */
async function checkNetwork() {
  const id = newId();
  try {
    const prep = await tunnel.call('prepare', { id, role: 'client' });
    return { nat: prep.nat };
  } finally {
    tunnel.call('close', { id, reason: 'checked' }).catch(() => {});
  }
}

module.exports = {
  init, connect, ensureFor, openAddress, isRelayed, recordFor, closeFor, playerEnv, isTunnelAddress, isTunnelSource, friendForSource, closeAll,
  diagnostics, checkNetwork,
};
