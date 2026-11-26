// Runs the tunnels (tunnel-engine.js) in their own thread, so stream packets never wait behind the
// rest of Moonshine's work. Talks to lib/tunnel.js with small request/reply messages.
'use strict';

const { parentPort } = require('worker_threads');
const { Tunnel } = require('./tunnel-engine');

const tunnels = new Map();

function get(id) {
  const t = tunnels.get(id);
  if (!t) throw Object.assign(new Error('tunnel closed'), { code: 'closed' });
  return t;
}

parentPort.on('message', async (m) => {
  const reply = (ok, value) => parentPort.postMessage({ re: m.re, ok, value });
  try {
    switch (m.op) {
      case 'prepare': {
        const t = new Tunnel(m.role, m.options || {});
        tunnels.set(m.id, t);
        t.on('relay-wanted', () => parentPort.postMessage({ event: 'relay-wanted', id: m.id }));
        t.on('closed', (reason) => {
          tunnels.delete(m.id);
          parentPort.postMessage({ event: 'closed', id: m.id, reason });
        });
        try {
          reply(true, await t.prepare());
        } catch (err) {
          t.close('failed');
          throw err;
        }
        break;
      }
      case 'listen':
        reply(true, await get(m.id).listen(m.localIp, m.hostBase, m.preferred));
        break;
      case 'start':
        reply(true, await get(m.id).start({ peerPub: m.peerPub, peerCands: m.peerCands, session: m.session }));
        break;
      case 'relay':
        reply(true, await get(m.id).useRelay(m.creds));
        break;
      case 'addTargets':
        get(m.id).addTargets(m.cands);
        reply(true, null);
        break;
      case 'close': {
        const t = tunnels.get(m.id);
        if (t) t.close(m.reason || 'closed');
        reply(true, null);
        break;
      }
      case 'info': {
        const t = tunnels.get(m.id);
        reply(true, t ? t.info() : null);
        break;
      }
      default:
        reply(false, { message: `unknown op ${m.op}` });
    }
  } catch (err) {
    reply(false, { message: err.message, code: err.code || '' });
  }
});
