// Discord "Rich Presence" through the Discord app running on this PC (its local pipe), so friends on Discord
// see what you're streaming and can press Join. Nothing goes through the internet from here, and a PC
// without Discord running simply does nothing.
const net = require('net');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 30 * 1000; // looking for Discord again
const MIN_GAP_MS = 5 * 1000; // Discord allows 5 status updates per 20 seconds

const events = new EventEmitter(); // 'join' (secret), 'state' (connected: boolean)

let clientId = '';
let wanted = false; // on in settings
let socket = null;
let ready = false;
let buffer = Buffer.alloc(0);
let retryTimer = null;
let desired = null; // the activity we'd like shown (null = none)
let shown = 'null'; // JSON of what Discord currently has
let lastSent = 0;
let sendTimer = null;
let nonce = 0;
let pipeBase = process.platform === 'win32' ? '\\\\.\\pipe\\discord-ipc-' : '';

function frame(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function write(op, data) {
  if (socket && !socket.destroyed) socket.write(frame(op, data));
}

function command(cmd, args, evt) {
  write(OP.FRAME, { cmd, args, evt, nonce: String(++nonce) });
}

function onMessage(op, msg) {
  if (op === OP.PING) return write(OP.PONG, msg);
  if (op === OP.CLOSE) return drop();
  if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
    ready = true;
    events.emit('state', true);
    command('SUBSCRIBE', {}, 'ACTIVITY_JOIN');
    shown = 'null';
    flush();
  } else if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'ACTIVITY_JOIN') {
    const secret = msg.data && msg.data.secret;
    if (typeof secret === 'string' && secret.length <= 128) events.emit('join', secret);
  }
}

function onData(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 8) {
    const op = buffer.readUInt32LE(0);
    const len = buffer.readUInt32LE(4);
    if (len > 1024 * 1024) return drop(); // not Discord
    if (buffer.length < 8 + len) return;
    let msg = null;
    try { msg = JSON.parse(buffer.subarray(8, 8 + len).toString()); } catch { /* ignore */ }
    buffer = buffer.subarray(8 + len);
    onMessage(op, msg);
  }
}

function drop() {
  const was = ready;
  ready = false;
  buffer = Buffer.alloc(0);
  if (socket) { socket.removeAllListeners(); socket.destroy(); socket = null; }
  if (was) events.emit('state', false);
  clearTimeout(retryTimer);
  if (wanted) retryTimer = setTimeout(connect, RETRY_MS);
}

/** Try Discord's pipes in order (several Discord apps, or none, may be running). */
function connect(index = 0) {
  if (!wanted || socket || !clientId || !pipeBase) return;
  if (index > 9) { retryTimer = setTimeout(connect, RETRY_MS); return; }
  const s = net.connect(pipeBase + index);
  let opened = false;
  s.once('connect', () => {
    opened = true;
    socket = s;
    s.on('data', onData);
    write(OP.HANDSHAKE, { v: 1, client_id: clientId });
  });
  s.on('error', () => {
    if (!opened) { s.destroy(); connect(index + 1); } else drop();
  });
  s.on('close', () => { if (opened && socket === s) drop(); });
}

function flush() {
  if (!ready) return;
  const want = JSON.stringify(desired);
  if (want === shown) return;
  const wait = lastSent + MIN_GAP_MS - Date.now();
  if (wait > 0) {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flush, wait);
    return;
  }
  lastSent = Date.now();
  shown = want;
  command('SET_ACTIVITY', { pid: process.pid, activity: desired || undefined });
}

/** Turn it on or off. `id` is the Discord application's id (the status shows that app's name). */
function enable(on, id) {
  wanted = Boolean(on);
  if (id) clientId = id;
  if (wanted) {
    connect();
  } else {
    clearTimeout(retryTimer);
    clearTimeout(sendTimer);
    if (ready) { desired = null; lastSent = 0; flush(); }
    setTimeout(() => {
      if (wanted) return;
      if (socket) { socket.removeAllListeners(); socket.destroy(); }
      socket = null;
      ready = false;
    }, 500);
  }
}

/** Show this activity (or `null` for none). Cheap to call often: only changes are sent, at most one every 5 seconds. */
function setActivity(activity) {
  desired = activity;
  flush();
}

module.exports = { enable, setActivity, events, isConnected: () => ready, _setPipeBase: (p) => { pipeBase = p; } };
