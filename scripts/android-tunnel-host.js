// The host side of the Android app's tunnel interop test (upstream/moonlight-android TunnelInteropTest):
// the desktop's real tunnel engine, as a friend's PC, with echo servers standing in for its host engine.
//
//   node scripts/android-tunnel-host.js <hostBase> [dropRate]
//
// Talks JSON lines over stdin/stdout: prints { pub, port } once ready, reads { pub, cands, session },
// then prints { connected: true } or { error } and finally { closed: reason } when the phone side closes.
'use strict';

const net = require('net');
const dgram = require('dgram');
const readline = require('readline');
const path = require('path');
const { Tunnel, PORTS } = require(path.join(__dirname, '..', 'app', 'lib', 'tunnel-engine.js'));

const hostBase = Number(process.argv[2]);
const dropRate = Number(process.argv[3]) || 0;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// Echo servers on the "host engine" ports: TCP indexes 0-2, UDP 3-5
const servers = [];
for (const idx of [0, 1, 2]) {
  const s = net.createServer((sock) => sock.pipe(sock));
  s.listen(hostBase + PORTS[idx], '127.0.0.1');
  servers.push(s);
}
for (const idx of [3, 4, 5]) {
  const u = dgram.createSocket('udp4');
  u.on('message', (msg, rinfo) => u.send(msg, rinfo.port, rinfo.address));
  u.bind(hostBase + PORTS[idx], '127.0.0.1');
  servers.push(u);
}

const tunnel = new Tunnel('host', { hostBase, srcIp: '127.88.7.9', dropRate });
tunnel.on('closed', (reason) => {
  say({ closed: reason });
  setTimeout(() => process.exit(0), 100);
});

(async () => {
  const prep = await tunnel.prepare();
  say({ pub: prep.pub, port: tunnel.sock4.address().port });
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', async (line) => {
    const peer = JSON.parse(line);
    try {
      await tunnel.start({ peerPub: peer.pub, peerCands: peer.cands, session: peer.session });
      say({ connected: true });
    } catch (err) {
      say({ error: err.code || err.message });
    }
  });
  rl.on('close', () => tunnel.close('stdin-closed'));
})().catch((err) => {
  say({ error: err.message });
  process.exit(1);
});
