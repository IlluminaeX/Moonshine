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
//   POST /presence {name, hostUuid, port, addrs, hosting, busy, guests, tunnel, version, game}
//   GET  /friends                        { me, friends: [{ username, nickname, status, online, pcs }] }
//   POST /friends/request {username}
//   POST /friends/respond {username, accept}
//   POST /friends/remove {username}
//   POST /friends/nickname {username, nickname}   your name for a friend ('' clears it); only you see it
//   POST /messages/send {username, text}          a quick message to a friend's online PCs (not stored)
//   POST /hub/ticket                     { ticket }: a one-time pass for the live link below
//   GET  /hub?ticket=T                   WebSocket: the service pushes direct-connection requests and
//                                        "friends-changed" notices here; the PC sends "bye" before it quits
//   POST /tunnel/offer {device, session, pub, cands}         ask a friend's PC for a direct connection
//   POST /tunnel/answer {device, session, pub, cands, error}  that PC's reply
//   POST /tunnel/relay {device, session, relay}   no direct path: this PC's relayed address, for that PC to send to
//   POST /turn                           { urls, username, credential }: a short-lived login for the relay
//   POST /invites                        host: make a one-time invite link { id, url, expires }
//   GET  /invites                        host: open and in-use links
//   POST /invites/revoke {id}            host: cancel a link, or end the guest's session
//   POST /invites/end {id}               guest: leave (the host can use it too)
//   POST /invites/redeem {token, name}   guest, no login: use up a link, get a guest login
//   GET  /join/<secret>                  the page a link opens in a browser
//
// Direct connections: the two PCs swap their public addresses and keys through here (over the live
// link), then connect to each other straight through their routers. Only friends (or the same person)
// can ask, and the stream itself never passes through the service.
//
// Live friends list: whenever something friends see changes (a PC comes online or goes offline, starts
// or stops hosting or streaming, a guest joins or leaves, a friend request is sent or answered, a
// username changes), the service pushes {type: "friends-changed"} to those friends' connected PCs, and
// they fetch /friends again. So PCs only need to report every few minutes, and a PC that quits or
// loses its link shows offline within seconds instead of after the reporting window.

import { DurableObject } from 'cloudflare:workers';

// A PC with its live link up reports every 5 minutes (every minute without it), and at once when
// something changes. Missing reports for this long counts as offline even if no "bye" came.
const ONLINE_MS = 6 * 60 * 1000;
const OFFLINE_GRACE_MS = 20 * 1000; // a link that drops without "bye" may just be reconnecting
const MESSAGE_MAX = 200;
const MESSAGES_PER_MINUTE = 20;
const NICKNAME_MAX = 32;
const MESSAGES_SINCE = '0.3.0'; // the first Moonshine that shows quick messages

/** "0.10.0" vs "0.9.2"; '' (a Moonshine too old to say) is older than everything. */
function compareVersions(a, b) {
  const p = (v) => String(v || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Text from a PC, made safe to store and show: no control characters, trimmed, capped. */
const cleanText = (t, max) => String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
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
<body style="font:16px system-ui,sans-serif;background:#15101d;color:#f7f1f3;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px"><h1 style="color:#ff5470;font-size:24px">${title}</h1><p style="color:#b6a6bd">${text}</p></div>`,
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
    `SELECT d.id AS device_id, d.user_id, u.username, u.avatar, u.guest FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`,
  ).bind(await sha256(token)).first();
}

/** Finish a sign-in: find or make the user, give this PC a token, and hand it to the waiting app. */
async function completeLogin(env, session, externalId, avatar = '') {
  const now = Date.now();
  let user = await env.DB.prepare('SELECT id, username FROM users WHERE discord_id = ?').bind(externalId).first();
  if (!user) {
    user = await env.DB.prepare('INSERT INTO users (discord_id, created) VALUES (?, ?) RETURNING id, username')
      .bind(externalId, now).first();
  }
  // Discord's picture hash is letters a-f, digits and an optional animated prefix ("a_"); anything else is no picture
  await env.DB.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(AVATAR_HASH.test(avatar || '') ? avatar : '', user.id).run();
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
  await completeLogin(env, session, `discord:${discordUser.id}`, discordUser.avatar || '');
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

async function setUsername(env, ctx, me, body) {
  const name = String(body.name || '').trim();
  if (!USERNAME.test(name)) return fail(400, 'Usernames are 3–20 letters, numbers, dots, dashes or underscores.');
  if (RESERVED.has(name.toLowerCase())) return fail(409, 'That username is taken.');
  try {
    await env.DB.prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?')
      .bind(name, name.toLowerCase(), me.user_id).run();
  } catch {
    return fail(409, 'That username is taken.');
  }
  ctx.waitUntil(notifyFriends(env, me.user_id));
  return json({ username: name });
}

function cleanAddrs(addrs) {
  if (!Array.isArray(addrs)) return [];
  return [...new Set(addrs.filter((a) => typeof a === 'string' && a.length <= 64 && /^[0-9a-fA-F.:]+$/.test(a)))].slice(0, 8);
}

/** What friends see of a device; a report that changes it (or brings it back online) is news. */
const deviceView = (d, now) => JSON.stringify([d.name, d.host_uuid, d.port, d.addrs, d.public_ip, Boolean(d.hosting),
  Boolean(d.busy), d.guests, Boolean(d.tunnel), d.version, d.game, d.kind, now - d.last_seen < ONLINE_MS]);

async function presence(env, ctx, me, body, request) {
  const publicIp = request.headers.get('CF-Connecting-IP') || '';
  const now = Date.now();
  const phone = body.kind === 'phone'; // Moonshine for Android: it only watches, so it never hosts
  const cols = 'name, host_uuid, port, addrs, public_ip, hosting, busy, guests, tunnel, version, game, kind, last_seen';
  const before = await env.DB.prepare(`SELECT ${cols} FROM devices WHERE id = ?`).bind(me.device_id).first();
  const after = await env.DB.prepare(
    `UPDATE devices SET name = ?, host_uuid = ?, port = ?, addrs = ?, public_ip = ?, hosting = ?, busy = ?, guests = ?, tunnel = ?, version = ?, game = ?, kind = ?, last_seen = ?
     WHERE id = ? RETURNING ${cols}`,
  ).bind(
    String(body.name || '').slice(0, 64),
    phone ? '' : String(body.hostUuid || '').slice(0, 64),
    Math.min(Math.max(Number(body.port) || 47989, 1), 65535),
    JSON.stringify(cleanAddrs(body.addrs)),
    publicIp,
    !phone && body.hosting ? 1 : 0,
    !phone && body.busy ? 1 : 0,
    phone ? 0 : Math.min(Math.max(Number(body.guests) || 0, 0), 64),
    body.tunnel ? 1 : 0,
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[\w.]{1,20})?$/.test(String(body.version || '')) ? String(body.version) : '',
    phone ? '' : cleanText(body.game, 80),
    phone ? 'phone' : '',
    now,
    me.device_id,
  ).first();
  if (!before || !after || deviceView(before, now) !== deviceView(after, now)) ctx.waitUntil(notifyFriends(env, me.user_id));
  return json({ ok: true, publicIp });
}

async function userByName(env, name) {
  return env.DB.prepare('SELECT id, username FROM users WHERE username_lower = ?').bind(String(name || '').trim().toLowerCase()).first();
}

async function requestFriend(env, ctx, me, body) {
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
    ctx.waitUntil(notifyUsers(env, [them.id]));
    return json({ status: 'accepted' });
  }
  const open = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE a = ? AND status = ?').bind(me.user_id, 'pending').first();
  if (open.n >= MAX_PENDING_OUT) return fail(429, 'You have too many friend requests waiting. Cancel some first.');
  await env.DB.prepare('INSERT INTO friends (a, b, status, created) VALUES (?, ?, ?, ?)').bind(me.user_id, them.id, 'pending', Date.now()).run();
  ctx.waitUntil(notifyUsers(env, [them.id]));
  return json({ status: 'outgoing' });
}

async function respondFriend(env, ctx, me, body) {
  const them = await userByName(env, body.username);
  if (!them) return fail(404, 'No one has that username.');
  const stmt = body.accept
    ? env.DB.prepare('UPDATE friends SET status = ? WHERE a = ? AND b = ? AND status = ?').bind('accepted', them.id, me.user_id, 'pending')
    : env.DB.prepare('DELETE FROM friends WHERE a = ? AND b = ? AND status = ?').bind(them.id, me.user_id, 'pending');
  const res = await stmt.run();
  if (!res.meta.changes) return fail(404, 'That request is gone.');
  ctx.waitUntil(notifyUsers(env, [them.id]));
  return json({ status: body.accept ? 'accepted' : 'declined' });
}

async function removeFriend(env, ctx, me, body) {
  const them = await userByName(env, body.username);
  if (!them) return fail(404, 'No one has that username.');
  await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)')
    .bind(me.user_id, them.id, them.id, me.user_id).run();
  await env.DB.prepare('DELETE FROM nicknames WHERE (owner = ? AND friend = ?) OR (owner = ? AND friend = ?)')
    .bind(me.user_id, them.id, them.id, me.user_id).run();
  ctx.waitUntil(notifyUsers(env, [them.id, me.user_id]));
  return json({ ok: true });
}

async function acceptedFriend(env, me, username) {
  const them = await userByName(env, username);
  if (!them || them.id === me.user_id) return null;
  const ok = await env.DB.prepare(
    "SELECT 1 AS ok FROM friends WHERE status = 'accepted' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))",
  ).bind(me.user_id, them.id).first();
  return ok ? them : null;
}

async function setNickname(env, ctx, me, body) {
  const them = await acceptedFriend(env, me, body.username);
  if (!them) return fail(404, 'They aren’t on your friends list.');
  const nick = cleanText(body.nickname, NICKNAME_MAX);
  if (nick) {
    await env.DB.prepare('INSERT INTO nicknames (owner, friend, nick) VALUES (?, ?, ?) ON CONFLICT (owner, friend) DO UPDATE SET nick = excluded.nick')
      .bind(me.user_id, them.id, nick).run();
  } else {
    await env.DB.prepare('DELETE FROM nicknames WHERE owner = ? AND friend = ?').bind(me.user_id, them.id).run();
  }
  ctx.waitUntil(notifyUsers(env, [me.user_id])); // your other PCs show it too
  return json({ nickname: nick });
}

/** A quick message, pushed to the friend's online PCs. Nothing is kept but when it was sent. */
async function sendMessage(env, me, body) {
  if (!me.username) return fail(400, 'Pick a username first.');
  const them = await acceptedFriend(env, me, body.username);
  if (!them) return fail(404, 'They aren’t on your friends list.');
  const text = cleanText(body.text, MESSAGE_MAX);
  if (!text) return fail(400, 'Type a message first.');
  const now = Date.now();
  const sent = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log WHERE sender = ? AND at > ?').bind(me.user_id, now - 60000).first();
  if (sent.n >= MESSAGES_PER_MINUTE) return fail(429, 'That’s a lot of messages. Wait a minute.');
  const { results: pcs } = await env.DB.prepare('SELECT version FROM devices WHERE user_id = ? AND tunnel = 1 AND last_seen > ?')
    .bind(them.id, now - ONLINE_MS).all();
  if (!pcs.length) return fail(409, `${them.username} isn’t online right now.`);
  if (!pcs.some((p) => compareVersions(p.version, MESSAGES_SINCE) >= 0)) {
    return fail(409, `${them.username}’s Moonshine is too old for messages. Ask them to update it.`);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM message_log WHERE at < ?').bind(now - 60000),
    env.DB.prepare('INSERT INTO message_log (sender, at) VALUES (?, ?)').bind(me.user_id, now),
  ]);
  const hub = env.HUB.get(env.HUB.idFromName(String(them.id)));
  const res = await hub.fetch('https://hub/broadcast', {
    method: 'POST', body: JSON.stringify({ type: 'message', from: me.username, text, at: now }),
  });
  const { sent: delivered } = await res.json();
  if (!delivered) return fail(409, `${them.username} isn’t online right now.`);
  return json({ ok: true, at: now });
}

const AVATAR_HASH = /^(a_)?[a-f0-9]{32}$/;
const PLAY_INVITES_SINCE = '0.3.7'; // the first Moonshine that shows "join my game" invites sent through here

/**
 * "Join my game": a friend's online PCs get a popup whatever way the two PCs can reach each other (this
 * goes through the live link, so it works over direct connections and the relay too). Nothing is kept.
 */
async function playInvite(env, me, body) {
  if (!me.username) return fail(400, 'Pick a username first.');
  const them = await acceptedFriend(env, me, body.username);
  if (!them) return fail(404, 'They aren’t on your friends list.');
  const id = String(body.id || '');
  const hostUuid = String(body.hostUuid || '');
  if (!/^[A-Za-z0-9]{8,40}$/.test(id) || !/^[0-9A-Za-z-]{8,64}$/.test(hostUuid)) return fail(400, 'bad request');
  const now = Date.now();
  const sent = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log WHERE sender = ? AND at > ?').bind(me.user_id, now - 60000).first();
  if (sent.n >= MESSAGES_PER_MINUTE) return fail(429, 'That’s a lot of invites. Wait a minute.');
  const { results: pcs } = await env.DB.prepare('SELECT version FROM devices WHERE user_id = ? AND tunnel = 1 AND last_seen > ?')
    .bind(them.id, now - ONLINE_MS).all();
  if (!pcs.length) return fail(409, `${them.username} isn’t online right now.`);
  if (!pcs.some((p) => compareVersions(p.version, PLAY_INVITES_SINCE) >= 0)) {
    return fail(409, `${them.username}’s Moonshine is too old for invites. Ask them to update it.`);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM message_log WHERE at < ?').bind(now - 60000),
    env.DB.prepare('INSERT INTO message_log (sender, at) VALUES (?, ?)').bind(me.user_id, now),
  ]);
  const hub = env.HUB.get(env.HUB.idFromName(String(them.id)));
  const res = await hub.fetch('https://hub/broadcast', {
    method: 'POST',
    body: JSON.stringify({
      type: 'play-invite', id, hostUuid, app: cleanText(body.app, 80), game: cleanText(body.game, 80), host: cleanText(body.host, 60),
      from: { username: me.username, device: me.device_id },
    }),
  });
  const { sent: delivered } = await res.json();
  if (!delivered) return fail(409, `${them.username} isn’t online right now.`);
  return json({ ok: true });
}

/** The friend's answer to a "join my game" invite, back to the PC that sent it. */
async function playAnswer(env, me, body) {
  const id = String(body.id || '');
  const status = body.status === 'joined' ? 'joined' : 'declined';
  if (!/^[A-Za-z0-9]{8,40}$/.test(id)) return fail(400, 'bad request');
  const target = await reachableDevice(env, me, body.device);
  if (!target) return fail(404, 'That PC isn’t one of your friends’ PCs.');
  const sent = await pushTo(env, target, { type: 'play-answer', id, status, from: { username: me.username || '' } });
  return sent ? json({ ok: true }) : fail(409, 'That PC isn’t connected right now.');
}

/**
 * A profile picture: the signed-in person's own, or an accepted friend's. The service fetches it from
 * Discord's picture server, so friends never see the Discord account number in its address.
 */
async function avatarPicture(env, me, url) {
  const name = url.searchParams.get('username') || '';
  const who = name.toLowerCase() === String(me.username || '').toLowerCase() ? { id: me.user_id } : await acceptedFriend(env, me, name);
  if (!who) return fail(404, 'No picture.');
  const row = await env.DB.prepare('SELECT discord_id, avatar FROM users WHERE id = ?').bind(who.id).first();
  const discordId = row && /^discord:(\d{5,25})$/.exec(row.discord_id);
  if (!discordId || !AVATAR_HASH.test(row.avatar || '')) return fail(404, 'No picture.');
  const cdn = (env.AVATAR_CDN || 'https://cdn.discordapp.com').replace(/\/$/, '');
  const res = await fetch(`${cdn}/avatars/${discordId[1]}/${row.avatar}.png?size=128`, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || !type.startsWith('image/')) return fail(404, 'No picture.');
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}

async function listFriends(env, me, request) {
  const myIp = request.headers.get('CF-Connecting-IP') || '';
  const { results: rows } = await env.DB.prepare(
    `SELECT f.a, f.b, f.status, u.id AS other, u.username, u.avatar, n.nick FROM friends f
     JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
     LEFT JOIN nicknames n ON n.owner = ?1 AND n.friend = u.id
     WHERE f.a = ?1 OR f.b = ?1`,
  ).bind(me.user_id).all();

  const accepted = rows.filter((r) => r.status === 'accepted').map((r) => r.other);
  const devices = new Map();
  const phones = new Map(); // user id -> their online phones
  // Friends' devices, and (not for a guest) the signed-in person's own other PCs, reachable with no friend step
  const owners = me.guest ? accepted : [...accepted, me.user_id];
  if (owners.length) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, name, host_uuid, port, addrs, public_ip, hosting, busy, guests, tunnel, version, game, kind, last_seen FROM devices
       WHERE user_id IN (${owners.map(() => '?').join(',')}) AND last_seen > ?`,
    ).bind(...owners, Date.now() - DEVICE_SHOWN_MS).all();
    for (const d of results) {
      if (d.kind === 'phone') {
        // Phones only watch: listed apart from PCs (so no Moonshine shows them as a PC to connect to), with
        // the addresses their owner's friends may see them pair from (Tailscale, or the same network)
        if (Date.now() - d.last_seen >= ONLINE_MS) continue;
        const sameNetwork = d.public_ip && d.public_ip === myIp;
        const list = phones.get(d.user_id) || [];
        list.push({ device: d.id, name: d.name, addrs: JSON.parse(d.addrs).filter((a) => isTailnet(a) || sameNetwork), version: d.version });
        phones.set(d.user_id, list);
        continue;
      }
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
        version: d.version,
        game: online ? d.game : '',
      });
      devices.set(d.user_id, list);
    }
  }

  return json({
    me: { username: me.username, avatar: me.avatar || '' },
    mine: me.guest ? [] : (devices.get(me.user_id) || []).filter((p) => p.name && p.device !== me.device_id),
    friends: rows.map((r) => {
      const status = r.status === 'accepted' ? 'accepted' : r.a === me.user_id ? 'outgoing' : 'incoming';
      const pcs = status === 'accepted' ? (devices.get(r.other) || []).filter((p) => p.name) : [];
      const phoneList = status === 'accepted' ? phones.get(r.other) || [] : [];
      return {
        username: r.username, nickname: r.nick || '', avatar: status === 'accepted' ? r.avatar || '' : '', status,
        online: pcs.some((p) => p.online) || phoneList.length > 0, pcs, phones: phoneList,
      };
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
  if (me.guest) {
    // A guest can only reach the one PC whose invite they used
    const inv = await guestInvite(env, me.user_id);
    return inv && inv.host_device === id ? target : null;
  }
  const hostOfGuest = await env.DB.prepare(
    "SELECT 1 AS ok FROM invites WHERE guest_device = ? AND host_user = ? AND status = 'claimed'",
  ).bind(id, me.user_id).first();
  if (hostOfGuest) return target;
  if (target.user_id === me.user_id) return target;
  const friends = await env.DB.prepare(
    "SELECT 1 AS ok FROM friends WHERE status = 'accepted' AND ((a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1))",
  ).bind(me.user_id, target.user_id).first();
  return friends ? target : null;
}

/**
 * Tell these users' connected PCs that their friends list changed. Only users with a PC online are
 * told (a Durable Object call each); the rest see the change when they next open Moonshine.
 */
async function notifyUsers(env, userIds) {
  const ids = [...new Set(userIds)].filter((id) => Number.isInteger(id));
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM devices WHERE tunnel = 1 AND last_seen > ? AND user_id IN (${ids.map(() => '?').join(',')})`,
  ).bind(Date.now() - ONLINE_MS, ...ids).all();
  await Promise.all(results.map(async (r) => {
    try {
      const hub = env.HUB.get(env.HUB.idFromName(String(r.user_id)));
      await hub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify({ type: 'friends-changed' }) });
    } catch (err) {
      console.error('notify', r.user_id, err && err.message);
    }
  }));
}

/** Tell everyone on this user's friends list (accepted or asked) that something about them changed. */
async function notifyFriends(env, userId) {
  const { results } = await env.DB.prepare(
    'SELECT CASE WHEN a = ?1 THEN b ELSE a END AS other FROM friends WHERE a = ?1 OR b = ?1',
  ).bind(userId).all();
  await notifyUsers(env, results.map((r) => r.other));
}

/** Show a PC offline now (unless it reported after `since`), and tell its friends. */
async function markOffline(env, deviceId, userId, since) {
  const res = await env.DB.prepare('UPDATE devices SET last_seen = ?, tunnel = 0 WHERE id = ? AND last_seen <= ?')
    .bind(Date.now() - ONLINE_MS, deviceId, since).run();
  if (res.meta.changes) await notifyFriends(env, userId);
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
  return hub.fetch(`https://hub/connect?device=${row.device_id}&user=${row.user_id}`, { headers: request.headers });
}

async function tunnelOffer(env, me, body) {
  const cands = cleanCands(body.cands);
  if (!validSession(body.session) || !validPub(body.pub) || !cands) return fail(400, 'bad request');
  const target = await reachableDevice(env, me, body.device);
  if (!target) return fail(404, 'That PC isn’t one of your friends’ PCs.');
  const mine = await env.DB.prepare('SELECT name FROM devices WHERE id = ?').bind(me.device_id).first();
  const inv = me.guest ? await guestInvite(env, me.user_id) : null;
  const sent = await pushTo(env, target, {
    type: 'tunnel-offer',
    from: me.guest
      ? { username: 'Guest', device: me.device_id, name: (mine && mine.name) || '', guest: true, invite: inv ? inv.id : 0 }
      : { username: me.username || '', device: me.device_id, name: (mine && mine.name) || '' },
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

const RELAY_LOGINS_PER_HOUR = 30;
const RELAY_TTL_S = 3600;

/** The other PC's address to send to when a relay carries the connection: public IPv4 only. */
function cleanRelay(r) {
  if (!r || typeof r.a !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(r.a)) return null;
  const parts = r.a.split('.').map(Number);
  if (parts.some((n) => n > 255)) return null;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return null;
  if (!Number.isInteger(r.p) || r.p < 1 || r.p > 65535) return null;
  return { a: r.a, p: r.p };
}

async function tunnelRelay(env, me, body) {
  const relay = cleanRelay(body.relay);
  if (!validSession(body.session) || !relay) return fail(400, 'bad request');
  const target = await reachableDevice(env, me, body.device);
  if (!target) return fail(404, 'That PC isn’t one of your friends’ PCs.');
  const sent = await pushTo(env, target, {
    type: 'tunnel-relay',
    from: { username: me.username || '', device: me.device_id },
    session: body.session, relay,
  });
  if (!sent) return fail(409, 'That PC isn’t connected right now.');
  return json({ ok: true });
}

/**
 * A login for Cloudflare's relay (TURN), made when two PCs can't reach each other directly. It lasts an
 * hour; the key that makes it never leaves this service. Limited per PC so it can't be used as a free
 * credential tap.
 */
async function turnCredentials(env, me) {
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return fail(501, 'relay-not-configured');
  const now = Date.now();
  await env.DB.prepare('DELETE FROM turn_log WHERE at < ?').bind(now - 60 * 60 * 1000).run();
  const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM turn_log WHERE device_id = ?').bind(me.device_id).first();
  if (used && used.n >= RELAY_LOGINS_PER_HOUR) return fail(429, 'Too many relay requests. Try again later.');
  await env.DB.prepare('INSERT INTO turn_log (device_id, at) VALUES (?, ?)').bind(me.device_id, now).run();
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: RELAY_TTL_S }),
  });
  if (!res.ok) {
    console.error('turn credentials', res.status);
    return fail(502, 'The relay isn’t available right now.');
  }
  const data = await res.json();
  const servers = Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers].filter(Boolean);
  const turn = servers.find((x) => x && x.username && x.credential);
  const urls = turn ? [].concat(turn.urls || []).filter((u) => /^turns?:/i.test(u)) : [];
  if (!turn || !urls.length) return fail(502, 'The relay isn’t available right now.');
  return json({ urls, username: turn.username, credential: turn.credential, ttl: RELAY_TTL_S });
}

/**
 * One per user: holds the live links of that user's signed-in PCs (WebSockets tagged with the PC's
 * device id) and pushes messages to them. It hibernates between messages, so idle links cost nothing.
 * When a link closes it marks that PC offline: at once after a "bye", or after a short grace period
 * if the link just dropped (a reconnect or a fresh report in the meantime cancels that).
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
      const user = url.searchParams.get('user') || '';
      if (!/^\d+$/.test(device) || !/^\d+$/.test(user)) return new Response('bad device', { status: 400 });
      // One link per PC: a reconnect replaces the old one
      for (const old of this.ctx.getWebSockets(device)) {
        try { old.close(4000, 'replaced'); } catch { /* already closing */ }
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [device]);
      pair[1].serializeAttachment({ device: Number(device), user: Number(user) });
      await this.ctx.storage.delete([`offline:${device}`, `bye:${device}`]); // back before its grace period ran out
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
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const text = await request.text();
      let sent = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(text); sent++; } catch { /* closing */ }
      }
      return Response.json({ ok: true, sent });
    }
    return new Response('not found', { status: 404 });
  }

  // Keep-alive pings are answered automatically; the only other message is "bye" when Moonshine quits
  async webSocketMessage(ws, message) {
    if (message !== 'bye') return;
    const who = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch { /* closing */ }
    if (who && !this.otherLink(ws, who.device)) {
      await this.ctx.storage.put(`bye:${who.device}`, true); // its close needs no grace period
      await this.ctx.storage.delete(`offline:${who.device}`);
      await markOffline(this.env, who.device, who.user, Date.now());
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    await this.linkGone(ws, code);
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch { /* already closed */ }
    await this.linkGone(ws, 1011);
  }

  /** Another open link from the same PC (it reconnected). */
  otherLink(ws, device) {
    return this.ctx.getWebSockets(String(device)).some((w) => w !== ws && w.readyState === WebSocket.READY_STATE_OPEN);
  }

  async linkGone(ws, code) {
    const who = ws.deserializeAttachment();
    if (!who) return;
    if (await this.ctx.storage.get(`bye:${who.device}`)) { // already marked offline
      await this.ctx.storage.delete(`bye:${who.device}`);
      return;
    }
    if (code === 4000 || this.otherLink(ws, who.device)) return; // replaced by a newer link
    const key = `offline:${who.device}`;
    if (await this.ctx.storage.get(key)) return;
    const due = Date.now() + OFFLINE_GRACE_MS;
    await this.ctx.storage.put(key, { user: who.user, since: Date.now(), due });
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm || alarm > due) await this.ctx.storage.setAlarm(due);
  }

  async alarm() {
    const pending = await this.ctx.storage.list({ prefix: 'offline:' });
    let next = 0;
    for (const [key, p] of pending) {
      const device = Number(key.slice('offline:'.length));
      if (p.due > Date.now()) {
        next = next ? Math.min(next, p.due) : p.due;
        continue;
      }
      await this.ctx.storage.delete(key);
      if (!this.otherLink(null, device)) await markOffline(this.env, device, p.user, p.since);
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }
}

// ---- One-time invite links ------------------------------------------------------------------------
//
// A host makes a link (POST /invites); whoever opens it (GET /join/<secret> shows a page that opens
// Moonshine) redeems it once (POST /invites/redeem) and gets a guest login: a user with no friends that
// may only ask for a connection to that one host PC. When the guest's session ends, the host (or the
// guest) ends the invite and the guest login is deleted. Only a hash of the secret is stored.

const INVITE_OPEN_MS = 60 * 60 * 1000; // an unused link works for an hour
const INVITE_CLAIMED_MAX_MS = 12 * 60 * 60 * 1000; // a used one is cut off after this even if nobody ended it
const INVITES_PER_HOST = 5;
const RELEASES_URL = 'https://github.com/IlluminaeX/Moonshine/releases/latest';
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validInviteSecret = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(t);

/** The claimed invite a guest login belongs to, or null. */
const guestInvite = (env, userId) => env.DB.prepare(
  "SELECT id, host_user, host_device, status FROM invites WHERE guest_user = ? AND status = 'claimed'",
).bind(userId).first();

/** End an invite: the guest login goes, and both PCs are told. */
async function finishInvite(env, invite, reason) {
  await env.DB.prepare("UPDATE invites SET status = 'ended' WHERE id = ?").bind(invite.id).run();
  const message = { type: 'invite-ended', invite: invite.id, reason };
  if (invite.guest_device) await pushTo(env, { id: invite.guest_device, user_id: invite.guest_user }, message).catch(() => {});
  await pushTo(env, { id: invite.host_device, user_id: invite.host_user }, message).catch(() => {});
  if (invite.guest_user) await env.DB.prepare('DELETE FROM users WHERE id = ? AND guest = 1').bind(invite.guest_user).run();
}

/** Drop what has run out: unused links, and links in use for too long. */
async function cleanupInvites(env) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM invites WHERE status = 'open' AND expires < ?").bind(now).run();
  await env.DB.prepare("DELETE FROM invites WHERE status = 'ended' AND created < ?").bind(now - 24 * 60 * 60 * 1000).run();
  const { results } = await env.DB.prepare(
    "SELECT * FROM invites WHERE status = 'claimed' AND claimed < ?",
  ).bind(now - INVITE_CLAIMED_MAX_MS).all();
  for (const inv of results) await finishInvite(env, inv, 'expired');
}

async function createInvite(env, me, request) {
  if (me.guest) return fail(403, 'Guests can’t make invite links.');
  await cleanupInvites(env);
  const dev = await env.DB.prepare('SELECT host_uuid FROM devices WHERE id = ?').bind(me.device_id).first();
  if (!dev || !dev.host_uuid) return fail(409, 'This PC isn’t hosting yet. Start hosting, then make a link.');
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE host_user = ? AND status IN ('open', 'claimed')").bind(me.user_id).first();
  if (open && open.n >= INVITES_PER_HOST) return fail(429, `You already have ${INVITES_PER_HOST} invite links open. Revoke one first.`);
  const secret = randomToken(24);
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO invites (token_hash, host_user, host_device, created, expires, status) VALUES (?, ?, ?, ?, ?, 'open') RETURNING id",
  ).bind(await sha256(secret), me.user_id, me.device_id, now, now + INVITE_OPEN_MS).first();
  return json({ id: row.id, url: `${new URL(request.url).origin}/join/${secret}`, expires: now + INVITE_OPEN_MS });
}

async function listInvites(env, me) {
  if (me.guest) return fail(403, 'Not available to guests.');
  await cleanupInvites(env);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.status, i.created, i.expires, i.claimed, i.guest_device, d.name AS guest_name
       FROM invites i LEFT JOIN devices d ON d.id = i.guest_device
      WHERE i.host_user = ? AND i.status IN ('open', 'claimed') ORDER BY i.created DESC`,
  ).bind(me.user_id).all();
  return json({ invites: results.map((r) => ({
    id: r.id, status: r.status, created: r.created, expires: r.expires, claimed: r.claimed || 0, guest: r.guest_name || '', guestDevice: r.guest_device || 0,
  })) });
}

/** Host: revoke an invite (unused or in use). Guest: leave. Either way it's over. */
async function endInvite(env, me, body) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) return fail(400, 'bad request');
  const inv = await env.DB.prepare(
    me.guest
      ? "SELECT * FROM invites WHERE id = ? AND guest_user = ? AND status != 'ended'"
      : "SELECT * FROM invites WHERE id = ? AND host_user = ? AND status != 'ended'",
  ).bind(id, me.user_id).first();
  if (!inv) return json({ ok: true }); // already over
  await finishInvite(env, inv, me.guest ? 'guest-left' : 'revoked');
  return json({ ok: true });
}

/** Someone opened a link: use it up and give them a guest login. No sign-in needed. */
async function redeemInvite(env, body) {
  if (!validInviteSecret(body.token)) return fail(400, 'bad request');
  await cleanupInvites(env);
  const now = Date.now();
  const inv = await env.DB.prepare(
    "UPDATE invites SET status = 'claimed', claimed = ? WHERE token_hash = ? AND status = 'open' AND expires > ? RETURNING id, host_user, host_device",
  ).bind(now, await sha256(body.token), now).first();
  if (!inv) return fail(410, 'This invite link was already used or has expired. Ask for a new one.');
  const host = await env.DB.prepare(
    'SELECT d.id, d.host_uuid, d.port, d.name, u.username FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?',
  ).bind(inv.host_device).first();
  if (!host || !host.host_uuid) {
    await env.DB.prepare("UPDATE invites SET status = 'ended' WHERE id = ?").bind(inv.id).run();
    return fail(410, 'That PC isn’t available any more. Ask for a new link.');
  }
  const token = randomToken();
  const user = await env.DB.prepare("INSERT INTO users (discord_id, created, guest) VALUES (?, ?, 1) RETURNING id")
    .bind(`guest:${randomToken(16)}`, now).first();
  const guestName = cleanText(body.name, 40) || 'Guest';
  const device = await env.DB.prepare(
    'INSERT INTO devices (user_id, token_hash, name, created, last_seen) VALUES (?, ?, ?, ?, ?) RETURNING id',
  ).bind(user.id, await sha256(token), guestName, now, now).first();
  await env.DB.prepare('UPDATE invites SET guest_user = ?, guest_device = ? WHERE id = ?').bind(user.id, device.id, inv.id).run();
  await pushTo(env, { id: inv.host_device, user_id: inv.host_user }, {
    type: 'invite-claimed', invite: inv.id, guestDevice: device.id, guestName,
  }).catch(() => {});
  return json({
    token, invite: inv.id,
    host: { device: host.id, uuid: host.host_uuid, port: host.port, name: host.name, user: host.username || '' },
  });
}

/** The page a link opens in the browser: who invited you, and a button that opens Moonshine. It does not use the link up. */
async function joinPage(env, secret) {
  const style = 'font:16px system-ui,sans-serif;background:#15101d;color:#f7f1f3;display:grid;place-items:center;min-height:90vh;margin:0';
  const wrap = (inner) => new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Moonshine invite</title>
<body style="${style}"><div style="text-align:center;max-width:440px;padding:24px">${inner}</div>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
  const button = 'display:inline-block;margin:6px;padding:12px 22px;border-radius:12px;font-weight:600;text-decoration:none;';
  if (!validInviteSecret(secret)) return wrap('<h1 style="color:#ff5470;font-size:24px">Invite not found</h1><p style="color:#b6a6bd">This link isn’t right. Ask for a new one.</p>');
  const row = await env.DB.prepare(
    `SELECT i.status, i.expires, u.username FROM invites i JOIN users u ON u.id = i.host_user WHERE i.token_hash = ?`,
  ).bind(await sha256(secret)).first();
  if (!row || row.status !== 'open' || row.expires < Date.now()) {
    return wrap('<h1 style="color:#ff5470;font-size:24px">This invite is used up</h1><p style="color:#b6a6bd">An invite link works once, and only for a little while. Ask for a new one.</p>');
  }
  const who = row.username ? esc(row.username) : 'Someone';
  return wrap(`<h1 style="color:#ff5470;font-size:24px">${who} invited you to play</h1>
<p style="color:#b6a6bd">Moonshine streams a game from their PC to yours. This link works once.</p>
<p><a href="moonshine://join/${secret}" style="${button}background:#e5193f;color:#fff">Open in Moonshine</a></p>
<p style="color:#b6a6bd;font-size:14px">Don’t have Moonshine yet?</p>
<p><a href="${RELEASES_URL}" style="${button}background:#34283f;color:#f7f1f3">Get Moonshine</a></p>
<p style="color:#b6a6bd;font-size:13px">Install it, then open this page again and press Open in Moonshine.</p>`);
}

const GUEST_ROUTES = new Set(['GET /me', 'POST /hub/ticket', 'POST /tunnel/offer', 'POST /tunnel/answer', 'POST /tunnel/relay', 'POST /turn', 'POST /invites/end']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /': return page('Moonshine', 'This is Moonshine’s friends service. Open the Moonshine app to use it.');
        case 'GET /auth/discord/start': return await startLogin(env, url);
        case 'GET /auth/discord/callback': return await discordCallback(env, url);
        case 'GET /auth/dev': return await devLogin(env, url);
        case 'GET /auth/poll': return await pollLogin(env, url);
        case 'POST /invites/redeem': return await redeemInvite(env, await readJson(request));
        case 'GET /hub': return await hubConnect(env, request, url);
        default: break;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/join/')) return await joinPage(env, url.pathname.slice(6));

      const me = await authenticate(env, request);
      if (!me) return fail(401, 'Sign in again.');
      // A guest (joined by an invite link) can only ask for a connection to the PC that invited them
      if (me.guest && !GUEST_ROUTES.has(route)) return fail(403, 'Not available to guests.');
      const body = request.method === 'POST' ? await readJson(request) : {};
      switch (route) {
        case 'POST /auth/signout':
          await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(me.device_id).run();
          return json({ ok: true });
        case 'GET /me': return json({ username: me.username });
        case 'POST /me/username': return await setUsername(env, ctx, me, body);
        case 'POST /presence': return await presence(env, ctx, me, body, request);
        case 'GET /friends': return await listFriends(env, me, request);
        case 'GET /friends/avatar': return await avatarPicture(env, me, url);
        case 'POST /friends/request': return await requestFriend(env, ctx, me, body);
        case 'POST /friends/respond': return await respondFriend(env, ctx, me, body);
        case 'POST /friends/remove': return await removeFriend(env, ctx, me, body);
        case 'POST /friends/nickname': return await setNickname(env, ctx, me, body);
        case 'POST /messages/send': return await sendMessage(env, me, body);
        case 'POST /friends/play-invite': return await playInvite(env, me, body);
        case 'POST /friends/play-answer': return await playAnswer(env, me, body);
        case 'POST /hub/ticket': return await hubTicket(env, me);
        case 'POST /tunnel/offer': return await tunnelOffer(env, me, body);
        case 'POST /tunnel/answer': return await tunnelAnswer(env, me, body);
        case 'POST /tunnel/relay': return await tunnelRelay(env, me, body);
        case 'POST /turn': return await turnCredentials(env, me);
        case 'POST /invites': return await createInvite(env, me, request);
        case 'GET /invites': return await listInvites(env, me);
        case 'POST /invites/revoke': return await endInvite(env, me, body);
        case 'POST /invites/end': return await endInvite(env, me, body);
        default: return fail(404, 'not found');
      }
    } catch (err) {
      console.error(route, err && err.stack);
      return fail(500, 'Something went wrong on Moonshine’s service.');
    }
  },
};
