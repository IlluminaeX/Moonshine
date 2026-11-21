// The live link to Moonshine's friends service: a WebSocket the service uses to push direct-connection
// requests and answers, and "your friends list changed" notices, to this PC the moment they happen.
// Saying "bye" on it (quitting, going to sleep) shows this PC offline to friends at once. Stays up while signed in, reconnecting after
// network trouble; idle, it costs one small ping every 30 seconds.
'use strict';

const { EventEmitter } = require('events');
const service = require('./friends-service');

const PING_MS = 30 * 1000;
const PONG_WAIT_MS = 15 * 1000;

const events = new EventEmitter();
let ws = null;
let connected = false;
let running = false;
let retryMs = 2000;
let retryTimer = null;
let pingTimer = null;
let pongTimer = null;

function setConnected(on) {
  if (connected === on) return;
  connected = on;
  events.emit(on ? 'up' : 'down');
}

function clearTimers() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  retryTimer = pingTimer = pongTimer = null;
}

function scheduleRetry() {
  clearTimers();
  if (!running) return;
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 60 * 1000);
}

async function connect() {
  clearTimers();
  if (!running) return;
  if (!service.signedIn()) {
    scheduleRetry();
    return;
  }
  let ticket;
  try {
    ticket = await service.hubTicket();
  } catch {
    scheduleRetry();
    return;
  }
  if (!running) return;
  const socket = new WebSocket(`${service.SERVICE_URL.replace(/^http/, 'ws')}/hub?ticket=${encodeURIComponent(ticket)}`);
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    retryMs = 2000;
    setConnected(true);
    pingTimer = setInterval(() => {
      try {
        socket.send('ping');
      } catch {
        return;
      }
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => socket.close(), PONG_WAIT_MS); // no answer: the link is dead
    }, PING_MS);
  };
  socket.onmessage = (e) => {
    if (ws !== socket) return;
    if (e.data === 'pong') {
      clearTimeout(pongTimer);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg && typeof msg.type === 'string') events.emit('message', msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConnected(false);
    scheduleRetry();
  };
  socket.onerror = () => {}; // followed by close
}

/** Keep the link up (while signed in). */
function start() {
  if (running) return;
  running = true;
  retryMs = 2000;
  connect();
}

/**
 * Drop the link (signing out, quitting, going to sleep). With `bye`, tell the service first so
 * friends see this PC go offline straight away; resolves once that's sent (at most about a second).
 */
function stop({ bye = false } = {}) {
  running = false;
  clearTimers();
  const socket = ws;
  ws = null;
  setConnected(false);
  if (!socket) return Promise.resolve();
  if (!bye || socket.readyState !== WebSocket.OPEN) {
    try { socket.close(); } catch { /* closed */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, 1000);
    function done() {
      clearTimeout(timer);
      try { socket.close(); } catch { /* closed */ }
      resolve();
    }
    socket.onclose = done; // the service closes it after reading "bye"
    try { socket.send('bye'); } catch { done(); }
  });
}

/** Reconnect now, e.g. right after signing in. */
function restart() {
  stop();
  start();
}

/** Wait for a message matching `test` (registered before the caller sends what it answers). */
function waitFor(test, timeoutMs) {
  let onMessage;
  let timer;
  const promise = new Promise((resolve) => {
    onMessage = (msg) => {
      if (!test(msg)) return;
      cleanup();
      resolve(msg);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    events.on('message', onMessage);
  });
  function cleanup() {
    clearTimeout(timer);
    events.removeListener('message', onMessage);
  }
  return { promise, cancel: () => cleanup() };
}

/** Resolves true once the link is up, false after timeoutMs. */
function whenConnected(timeoutMs) {
  if (connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      events.removeListener('up', onUp);
      resolve(v);
    };
    const onUp = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    events.on('up', onUp);
  });
}

module.exports = { start, stop, restart, waitFor, whenConnected, events, isConnected: () => connected };
