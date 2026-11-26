// The main-process handle on the tunnel thread (tunnel-worker.js): call(op, args) -> Promise, and a
// 'closed' event per tunnel. If the thread ever dies, every open tunnel reports closed and the next
// call starts a fresh thread.
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');

const events = new EventEmitter();
let worker = null;
let nextRe = 1;
const waiting = new Map(); // re -> { resolve, reject }
const live = new Set(); // tunnel ids the thread holds

function start() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, 'tunnel-worker.js'));
  w.on('message', (m) => {
    if (m.event === 'relay-wanted') {
      events.emit('relay-wanted', m.id);
      return;
    }
    if (m.event === 'closed') {
      live.delete(m.id);
      events.emit('closed', m.id, m.reason);
      return;
    }
    const wait = waiting.get(m.re);
    if (!wait) return;
    waiting.delete(m.re);
    if (m.ok) wait.resolve(m.value);
    else wait.reject(Object.assign(new Error(m.value.message), { code: m.value.code }));
  });
  const died = (err) => {
    if (worker !== w) return;
    worker = null;
    for (const wait of waiting.values()) wait.reject(err || new Error('tunnel thread stopped'));
    waiting.clear();
    for (const id of live) events.emit('closed', id, 'thread-stopped');
    live.clear();
  };
  w.on('error', died);
  w.on('exit', () => died(null));
  w.unref(); // never keeps Moonshine from quitting
  worker = w;
  return w;
}

function call(op, args = {}) {
  const w = start();
  const re = nextRe++;
  if (op === 'prepare') live.add(args.id);
  return new Promise((resolve, reject) => {
    waiting.set(re, { resolve, reject });
    w.postMessage({ ...args, op, re });
  });
}

module.exports = { call, events };
