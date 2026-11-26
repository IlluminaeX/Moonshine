// Wake-on-LAN: a "magic packet" (6 bytes of 0xFF, then the PC's MAC address 16 times) broadcast on
// every local network. Only works on the PC's own network, and only if the PC has the feature turned on.
'use strict';

const dgram = require('dgram');
const os = require('os');

const parseMac = (mac) => {
  const parts = String(mac || '').split(/[:-]/);
  if (parts.length !== 6 || !parts.every((p) => /^[0-9a-f]{2}$/i.test(p))) return null;
  return Buffer.from(parts.map((p) => parseInt(p, 16)));
};

function magicPacket(mac) {
  const bytes = parseMac(mac);
  if (!bytes) throw new Error('That PC’s network address isn’t known.');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

const ipv4 = (a) => a.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0);
const dotted = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** This PC's IPv4 networks: { address, netmask, broadcast }. */
function localNetworks() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const mask = ipv4(i.netmask);
      out.push({ address: i.address, netmask: i.netmask, broadcast: dotted(((ipv4(i.address) & mask) | (~mask >>> 0)) >>> 0) });
    }
  }
  return out;
}

/** Is this IPv4 address on one of this PC's own networks (so a wake packet can reach it)? */
function isLocal(address) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const a = ipv4(address);
  return localNetworks().some((n) => ((a & ipv4(n.netmask)) >>> 0) === ((ipv4(n.address) & ipv4(n.netmask)) >>> 0));
}

/** Send the magic packet out of every local network. Resolves how many broadcasts went out. */
async function wake(mac, { port = 9, targets } = {}) {
  const packet = magicPacket(mac);
  const where = targets || [...new Set([...localNetworks().map((n) => n.broadcast), '255.255.255.255'])];
  let sent = 0;
  for (const target of where) {
    await new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', () => { try { sock.close(); } catch { /* closed */ } resolve(); });
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch { /* the send reports it */ }
        sock.send(packet, port, target, (err) => {
          if (!err) sent++;
          try { sock.close(); } catch { /* closed */ }
          resolve();
        });
      });
    });
  }
  if (!sent) throw new Error('Couldn’t send the wake signal. Is this PC on a network?');
  return sent;
}

module.exports = { magicPacket, parseMac, wake, isLocal, localNetworks };
