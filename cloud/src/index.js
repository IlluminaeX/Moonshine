// Moonshine friends service: a Cloudflare Worker with a D1 database.
//
// It knows usernames, who is friends with whom, and, for each signed-in PC, how its friends can reach
// its host and whether it's busy. Video never passes through here: PCs only use it to find each other.
//
// Sign-in is with Discord (scope "identify": only the Discord account's id is used), so a username
// can be recovered on a new PC. Each signed-in PC then holds its own random token.
//
// Endpoints (JSON; all but /auth/* need "Authorization: Bearer <token>"):
//   GET  /auth/discord/start?session=S   browser: sends you to Discord
//   GET  /auth/discord/callback          browser: Discord sends you back here
//   GET  /auth/poll?session=S            app: { token, username } once signed in
//   POST /auth/signout                   app: forget this PC's token
//   GET  /me                             { username }
//   POST /me/username {name}             pick or change your username
//   POST /presence {name, hostUuid, port, addrs, hosting, busy, guests}
//   GET  /friends                        { me, friends: [{ username, status, online, pcs }] }
//   POST /friends/request {username}
//   POST /friends/respond {username, accept}
//   POST /friends/remove {username}
//   POST /hub/ticket                     { ticket }: a one-time pass for the live link below
//   GET  /hub?ticket=T                   WebSocket: the service pushes direct-connection requests here
//   POST /tunnel/offer {device, session, pub, cands}         ask a friend's PC for a direct connection
//   POST /tunnel/answer {device, session, pub, cands, error}  that PC's reply
//
// Direct connections: the two PCs swap their public addresses and keys through here (over the live
// link), then connect to each other straight through their routers. Only friends (or the same person)
// can ask, and the stream itself never passes through the service.

import { DurableObject } from 'cloudflare:workers';

const ONLINE_MS = 2 * 60 * 1000; // a PC reports every minute while Moonshine is open
const LOGIN_TTL_MS = 10 * 60 * 1000;
const DEVICE_SHOWN_MS = 30 * 24 * 60 * 60 * 1000; // PCs not seen for a month drop off friends' lists
const MAX_PENDING_OUT = 20;
const TICKET_TTL_MS = 60 * 1000;
const USERNAME = /^[A-Za-z0-9_.-]{3,20}$/;
const RESERVED = new Set(['admin', 'moonshine', 'support', 'system', 'everyone', 'here']);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const fail = (status, error) => json({ error }, status);
const page = (title, text, status = 200) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<body style="font:16px system-ui,sans-serif;background:#0b0709;color:#f7f1f3;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px"><h1 style="color:#ff5470;font-size:24px">${title}</h1><p style="color:#a8959c">${text}</p></div>`,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
);

function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const validSession = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(s);

/** Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48) are the same wherever you are. */
const isTailnet = (a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** The signed-in PC making this request, with its user; null if the token is unknown. */
async function authenticate(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  return env.DB.prepare(
    `SELECT d.id AS device_id, d.user_id, u.username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`,
  ).bind(await sha256(token)).first();
}

/** Finish a sign-in: find or make the user, give this PC a token, and hand it to the waiting app. */
async function completeLogin(env, session, externalId) {
  const now = Date.now();
  let user = await env.DB.prepare('SELECT id, username FROM users WHERE discord_id = ?').bind(externalId).first();
  if (!user) {
    user = await env.DB.prepare('INSERT INTO users (discord_id, created) VALUES (?, ?) RETURNING id, username')
      .bind(externalId, now).first();
  }
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO devices (user_id, token_hash, created, last_seen) VALUES (?, ?, ?, ?)')
      .bind(user.id, await sha256(token), now, now),
    env.DB.prepare('UPDATE logins SET token = ? WHERE session = ?').bind(token, session),
  ]);
}

async function startLogin(env, url) {
  const session = url.searchParams.get('session');
  if (!validSession(session)) return page('Sign-in link is broken', 'Start signing in again from Moonshine.', 400);
  if (!env.DISCORD_CLIENT_ID) return page('Discord sign-in isn’t set up yet', 'The Moonshine service is missing its Discord app.', 503);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM logins WHERE created < ?').bind(now - LOGIN_TTL_MS),
    env.DB.prepare('INSERT OR IGNORE INTO logins (session, created) VALUES (?, ?)').bind(session, now),
  ]);
  const discord = new URL('https://discord.com/oauth2/authorize');
  discord.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: `${url.origin}/auth/discord/callback`,
    state: session,
    prompt: 'none',
  }).toString();
  return Response.redirect(discord.toString(), 302);
}

async function discordCallback(env, url) {
  const session = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!validSession(session)) return page('Sign-in link is broken', 'Start signing in again from Moonshine.', 400);
  const login = await env.DB.prepare('SELECT created FROM logins WHERE session = ?').bind(session).first();
  if (!login || Date.now() - login.created > LOGIN_TTL_MS) return page('That sign-in expired', 'Start signing in again from Moonshine.', 410);
  if (!code) {
    await env.DB.prepare('UPDATE logins SET error = ? WHERE session = ?').bind('cancelled', session).run();
    return page('Sign-in cancelled', 'You can close this tab.');
  }

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${url.origin}/auth/discord/callback`,
    }),
  });
  const grant = tokenRes.ok ? await tokenRes.json() : null;
  const meRes = grant && await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${grant.access_token}` } });
  const discordUser = meRes && meRes.ok ? await meRes.json() : null;
  if (!discordUser || !discordUser.id) {
    await env.DB.prepare('UPDATE logins SET error = ? WHERE session = ?').bind('discord', session).run();
    return page('Discord sign-in failed', 'Close this tab and try again from Moonshine.', 502);
  }
  await completeLogin(env, session, `discord:${discordUser.id}`);
  return page('You’re signed in', 'Go back to Moonshine. You can close this tab.');
}

/** Local testing only (wrangler dev with DEV_LOGIN=1 in .dev.vars): sign in without Discord. */
async function devLogin(env, url) {
  if (env.DEV_LOGIN !== '1') return fail(404, 'not found');
  const session = url.searchParams.get('session');
  const id = url.searchParams.get('id') || '';
  if (!validSession(session) || !/^[a-z0-9]{1,20}$/.test(id)) return fail(400, 'bad request');
  await env.DB.prepare('INSERT OR IGNORE INTO logins (session, created) VALUES (?, ?)').bind(session, Date.now()).run();
  await completeLogin(env, session, `dev:${id}`);
  return page('You’re signed in', 'Test sign-in.');
}

async function pollLogin(env, url) {
  const session = url.searchParams.get('session');
  if (!validSession(session)) return fail(400, 'bad session');
  const login = await env.DB.prepare('SELECT created, token, error FROM logins WHERE session = ?').bind(session).first();
  if (!login || Date.now() - login.created > LOGIN_TTL_MS) return fail(410, 'expired');
  if (login.error) {
    await env.DB.prepare('DELETE FROM logins WHERE session = ?').bind(session).run();
    return fail(401, login.error);
  }
  if (!login.token) return json({ pending: true });
  await env.DB.prepare('DELETE FROM logins WHERE session = ?').bind(session).run();
  const who = await env.DB.prepare(
    'SELECT u.username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?',
  ).bind(await sha256(login.token)).first();
  return json({ token: login.token, username: who ? who.username : null });
}

async function setUsername(env, me, body) {
  const name = String(body.name || '').trim();
  if (!USERNAME.test(name)) return fail(400, 'Usernames are 3–20 letters, numbers, dots, dashes or underscores.');
  if (RESERVED.has(name.toLowerCase())) return fail(409, 'That username is taken.');
  try {
    await env.DB.prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?')
      .bind(name, name.toLowerCase(), me.user_id).run();
  } catch {
    return fail(409, 'That username is taken.');
  }
  return json({ username: name });
}

function cleanAddrs(addrs) {
  if (!Array.isArray(addrs)) return [];
  return [...new Set(addrs.filter((a) => typeof a === 'string' && a.length <= 64 && /^[0-9a-fA-F.:]+$/.test(a)))].slice(0, 8);
}

async function presence(env, me, body, request) {
  const publicIp = request.headers.get('CF-Connecting-IP') || '';
  await env.DB.prepare(
    `UPDATE devices SET name = ?, host_uuid = ?, port = ?, addrs = ?, public_ip = ?, hosting = ?, busy = ?, guests = ?, tunnel = ?, last_seen = ?
     WHERE id = ?`,
  ).bind(
    String(body.name || '').slice(0, 64),
    String(body.hostUuid || '').slice(0, 64),
    Math.min(Math.max(Number(body.port) || 47989, 1), 65535),
    JSON.stringify(cleanAddrs(body.addrs)),
    publicIp,
    body.hosting ? 1 : 0,
    body.busy ? 1 : 0,
    Math.min(Math.max(Number(body.guests) || 0, 0), 64),
    body.tunnel ? 1 : 0,
    Date.now(),
    me.device_id,
  ).run();
  return json({ ok: true, publicIp });
}

async function userByName(env, name) {
  return env.DB.prepare('SELECT id, username FROM users WHERE username_lower = ?').bind(String(name || '').trim().toLowerCase()).first();
}

async function requestFriend(env, me, body) {
  if (!me.username) return fail(400, 'Pick a username first.');
  const them = await userByName(env, body.username);
  if (!them) return fail(404, 'No one has that username.');
  if (them.id === me.user_id) return fail(400, 'That’s you.');
  const mine = await env.DB.prepare('SELECT status FROM friends WHERE a = ? AND b = ?').bind(me.user_id, them.id).first();
  if (mine) return json({ status: mine.status === 'accepted' ? 'accepted' : 'outgoing' });
  const theirs = await env.DB.prepare('SELECT status FROM friends WHERE a = ? AND b = ?').bind(them.id, me.user_id).first();
  if (theirs) {
    // They already asked: asking back accepts
    await env.DB.prepare('UPDATE friends SET status = ? WHERE a = ? AND b = ?').bind('accepted', them.id, me.user_id).run();
    return json({ status: 'accepted' });
  }
  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE a = ? AND status = ?').bind(me.user_id, 'pending').first();
  if (open.n >= MAX_PENDING_OUT) return fail(429, 'You have too many friend requests waiting. Cancel some first.');
  await env.DB.prepare('INSERT INTO friends (a, b, status, created) VALUES (?, ?, ?, ?)').bind(me.user_id, them.id, 'pending', Date.now()).run();
  return json({ status: 'outgoing' });
}

async function respondFriend(env, me, body) {
  const them = await userByName(env, body.username);
  if (!them) return fail(404, 'No one has that username.');
  const stmt = body.accept
    ? env.DB.prepare('UPDATE friends SET status = ? WHERE a = ? AND b = ? AND status = ?').bind('accepted', them.id, me.user_id, 'pending')
    : env.DB.prepare('DELETE FROM friends WHERE a = ? AND b = ? AND status = ?').bind(them.id, me.user_id, 'pending');
  const res = await stmt.run();
  if (!res.meta.changes) return fail(404, 'That request is gone.');
  return json({ status: body.accept ? 'accepted' : 'declined' });
}

async function removeFriend(env, me, body) {
  const them = await userByName(env, body.username);
  if (!them) return fail(404, 'No one has that username.');
  await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
    .bind(me.user_id, them.id, them.id, me.user_id).run();
  return json({ ok: true });
}

async function listFriends(env, me, request) {
  const myIp = request.headers.get('CF-Connecting-IP') || '';
  const { results: rows } = await env.DB.prepare(
    `SELECT f.a, f.b, f.status, u.id AS other, u.username FROM friends f
     JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
     WHERE f.a = ?1 OR f.b = ?1`,
  ).bind(me.user_id).all();

  const accepted = rows.filter((r) => r.status === 'accepted').map((r) => r.other);
  const devices = new Map();
  if (accepted.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, name, host_uuid, port, addrs, public_ip, hosting, busy, guests, tunnel, last_seen FROM devices
       WHERE user_id IN (${accepted.map(() => '?').join(',')}) AND last_seen > ?`,
    ).bind(...accepted, Date.now() - DEVICE_SHOWN_MS).all();
    for (const d of results) {
      // Where a friend can reach this PC: its Tailscale addresses work from anywhere; its home-network
      // addresses only from the same network; its public address if its owner forwarded the port.
      const sameNetwork = d.public_ip && d.public_ip === myIp;
      const addrs = JSON.parse(d.addrs).filter((a) => isTailnet(a) || sameNetwork);
      if (d.public_ip) addrs.push(d.public_ip);
      const list = devices.get(d.user_id) || [];
      const online = Date.now() - d.last_seen < ONLINE_MS;
      list.push({
        device: d.id,
        name: d.name,
        hostUuid: d.host_uuid,
        port: d.port,
        addrs,
        online,
        tunnel: online && Boolean(d.tunnel),
        hosting: Boolean(d.hosting),
        busy: Boolean(d.busy),
        guests: d.guests,
      });
      devices.set(d.user_id, list);
    }
  }

  return json({
    me: { username: me.username },
    friends: rows.map((r) => {
      const status = r.status === 'accepted' ? 'accepted' : r.a === me.user_id ? 'outgoing' : 'incoming';
      const pcs = status === 'accepted' ? (devices.get(r.other) || []).filter((p) => p.name) : [];
      return { username: r.username, status, online: pcs.some((p) => p.online), pcs };
    }).filter((f) => f.username),
  });
}

// ---- Live link and direct connections ------------------------------------------------------

const validPub = (p) => typeof p === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p); // an X25519 key: 32 bytes
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]{2,39}$/;

/** Where a PC can be reached for a direct connection: [{ a: address, p: port }], checked and capped. */
function cleanCands(cands) {
  if (!Array.isArray(cands) || !cands.length || cands.length > 16) return null;
  const out = [];
  for (const c of cands) {
    if (!c || typeof c !== 'object') return null;
    const a = String(c.a || '');
    const p = Number(c.p);
    if (!(IPV4.test(a) || (IPV6.test(a) && a.includes(':'))) || !Number.isInteger(p) || p < 1 || p > 65535) return null;
    out.push({ a, p });
  }
  return out;
}

/** The other PC, if this user may ask it for a direct connection: their own PC or an accepted friend's. */
async function reachableDevice(env, me, deviceId) {
  const id = Number(deviceId);
  if (!Number.isInteger(id) || id <= 0 || id === me.device_id) return null;
  const target = await env.DB.prepare('SELECT id, user_id FROM devices WHERE id = ?').bind(id).first();
  if (!target) return null;
  if (target.user_id === me.user_id) return target;
  const friends = await env.DB.prepare(
    "SELECT 1 AS ok FROM friends WHERE status = 'accepted' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))",
  ).bind(me.user_id, target.user_id).first();
  return friends ? target : null;
}

/** Push a message to one PC over its live link. False if that PC isn't connected right now. */
async function pushTo(env, target, message) {
  const hub = env.HUB.get(env.HUB.idFromName(String(target.user_id)));
  const res = await hub.fetch('https://hub/send', { method: 'POST', body: JSON.stringify({ device: target.id, message }) });
  return res.ok && (await res.json()).sent === true;
}

async function hubTicket(env, me) {
  const ticket = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM hub_tickets WHERE created < ?').bind(now - TICKET_TTL_MS),
    env.DB.prepare('INSERT INTO hub_tickets (ticket, device_id, user_id, created) VALUES (?, ?, ?, ?)').bind(ticket, me.device_id, me.user_id, now),
  ]);
  return json({ ticket });
}

async function hubConnect(env, request, url) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return fail(426, 'WebSocket only');
  const ticket = url.searchParams.get('ticket') || '';
  if (!validSession(ticket)) return fail(401, 'Sign in again.');
  // A ticket works once, for a minute
  const row = await env.DB.prepare('DELETE FROM hub_tickets WHERE ticket = ? RETURNING device_id, user_id, created').bind(ticket).first();
  if (!row || Date.now() - row.created > TICKET_TTL_MS) return fail(401, 'Sign in again.');
  const hub = env.HUB.get(env.HUB.idFromName(String(row.user_id)));
  return hub.fetch(`https://hub/connect?device=${row.device_id}`, { headers: request.headers });
}

async function tunnelOffer(env, me, body) {
  const cands = cleanCands(body.cands);
  if (!validSession(body.session) || !validPub(body.pub) || !cands) return fail(400, 'bad request');
  const target = await reachableDevice(env, me, body.device);
  if (!target) return fail(404, 'That PC isn’t one of your friends’ PCs.');
  const mine = await env.DB.prepare('SELECT name FROM devices WHERE id = ?').bind(me.device_id).first();
  const sent = await pushTo(env, target, {
    type: 'tunnel-offer',
    from: { username: me.username || '', device: me.device_id, name: (mine && mine.name) || '' },
    session: body.session, pub: body.pub, cands,
  });
  if (!sent) return fail(409, 'Their Moonshine isn’t connected right now.');
  return json({ ok: true });
}

async function tunnelAnswer(env, me, body) {
  if (!validSession(body.session)) return fail(400, 'bad request');
  const error = body.error ? String(body.error).slice(0, 40) : '';
  const cands = error ? [] : cleanCands(body.cands);
  if (!error && (!cands || !validPub(body.pub))) return fail(400, 'bad request');
  const target = await reachableDevice(env, me, body.device);
  if (!target) return fail(404, 'That PC isn’t one of your friends’ PCs.');
  const sent = await pushTo(env, target, {
    type: 'tunnel-answer',
    from: { username: me.username || '', device: me.device_id },
    session: body.session, pub: error ? '' : body.pub, cands, error,
  });
  if (!sent) return fail(409, 'That PC isn’t connected right now.');
  return json({ ok: true });
}

/**
 * One per user: holds the live links of that user's signed-in PCs (WebSockets tagged with the PC's
 * device id) and pushes messages to them. It hibernates between messages, so idle links cost nothing.
 */
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const device = url.searchParams.get('device') || '';
      if (!/^\d+$/.test(device)) return new Response('bad device', { status: 400 });
      // One link per PC: a reconnect replaces the old one
      for (const old of this.ctx.getWebSockets(device)) {
        try { old.close(4000, 'replaced'); } catch { /* already closing */ }
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [device]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/send' && request.method === 'POST') {
      const { device, message } = await request.json();
      let sent = false;
      for (const ws of this.ctx.getWebSockets(String(device))) {
        try {
          ws.send(JSON.stringify(message));
          sent = true;
        } catch { /* closing */ }
      }
      return Response.json({ sent });
    }
    return new Response('not found', { status: 404 });
  }

  webSocketMessage() {
    // PCs only send keep-alive pings, which are answered automatically
  }

  webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
  }

  webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /': return page('Moonshine', 'This is Moonshine’s friends service. Open the Moonshine app to use it.');
        case 'GET /auth/discord/start': return await startLogin(env, url);
        case 'GET /auth/discord/callback': return await discordCallback(env, url);
        case 'GET /auth/dev': return await devLogin(env, url);
        case 'GET /auth/poll': return await pollLogin(env, url);
        case 'GET /hub': return await hubConnect(env, request, url);
        default: break;
      }

      const me = await authenticate(env, request);
      if (!me) return fail(401, 'Sign in again.');
      const body = request.method === 'POST' ? await readJson(request) : {};
      switch (route) {
        case 'POST /auth/signout':
          await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(me.device_id).run();
          return json({ ok: true });
        case 'GET /me': return json({ username: me.username });
        case 'POST /me/username': return await setUsername(env, me, body);
        case 'POST /presence': return await presence(env, me, body, request);
        case 'GET /friends': return await listFriends(env, me, request);
        case 'POST /friends/request': return await requestFriend(env, me, body);
        case 'POST /friends/respond': return await respondFriend(env, me, body);
        case 'POST /friends/remove': return await removeFriend(env, me, body);
        case 'POST /hub/ticket': return await hubTicket(env, me);
        case 'POST /tunnel/offer': return await tunnelOffer(env, me, body);
        case 'POST /tunnel/answer': return await tunnelAnswer(env, me, body);
        default: return fail(404, 'not found');
      }
    } catch (err) {
      console.error(route, err && err.stack);
      return fail(500, 'Something went wrong on Moonshine’s service.');
    }
  },
};
