// A small TURN client (RFC 8656): asks a relay server for a public address that forwards to this PC.
// Moonshine uses it as the last resort when two PCs can't reach each other directly: the player's
// side gets a relayed address, the other side sends its packets there, and the relay passes them on.
// Everything that crosses it is already encrypted end to end by the tunnel, so the relay sees only
// sealed packets.
//
// Transports: UDP, TCP or TLS to the relay (TCP/TLS for networks that block UDP). Long-term
// credentials (username + password from the service), Send/Data indications (no channels: the packets
// are large anyway, and this keeps the client simple). Allocation and permissions are refreshed
// until close().
//
// No Electron in here: it runs inside the tunnel thread and in tests.
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const COOKIE = 0x2112a442;

// Message types (method with the class bits mixed in)
const M = {
  ALLOCATE: 0x0003, ALLOCATE_OK: 0x0103, ALLOCATE_ERR: 0x0113,
  REFRESH: 0x0004, REFRESH_OK: 0x0104, REFRESH_ERR: 0x0114,
  PERMISSION: 0x0008, PERMISSION_OK: 0x0108, PERMISSION_ERR: 0x0118,
  SEND: 0x0016, DATA: 0x0017,
};
// Attributes
const A = {
  USERNAME: 0x0006, INTEGRITY: 0x0008, ERROR: 0x0009, LIFETIME: 0x000d, PEER: 0x0012, DATA: 0x0013,
  REALM: 0x0014, NONCE: 0x0015, RELAYED: 0x0016, TRANSPORT: 0x0019, MAPPED: 0x0020,
};

const REFRESH_EVERY_MS = 4 * 60 * 1000; // allocations last 10 minutes, permissions 5
const CONNECT_TIMEOUT_MS = 2500;
const UDP_RETRIES_MS = [0, 300, 700];
const STREAM_REQUEST_MS = 4000;

const pad4 = (n) => (4 - (n % 4)) % 4;

/** Build a STUN/TURN message. attrs: [[type, Buffer]]. With `key`, appends MESSAGE-INTEGRITY. */
function build(type, attrs, key, tx = crypto.randomBytes(12)) {
  const parts = [];
  let len = 0;
  for (const [t, v] of attrs) {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(t, 0);
    head.writeUInt16BE(v.length, 2);
    parts.push(head, v, Buffer.alloc(pad4(v.length)));
    len += 4 + v.length + pad4(v.length);
  }
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(len + (key ? 24 : 0), 2); // the length counts the integrity attribute
  header.writeUInt32BE(COOKIE, 4);
  tx.copy(header, 8);
  let msg = Buffer.concat([header, ...parts]);
  if (key) {
    const mac = crypto.createHmac('sha1', key).update(msg).digest();
    const head = Buffer.alloc(4);
    head.writeUInt16BE(A.INTEGRITY, 0);
    head.writeUInt16BE(20, 2);
    msg = Buffer.concat([msg, head, mac]);
  }
  return { msg, tx };
}

/** Parse one message: { type, tx, attrs: Map<type, Buffer[]> }, or null if it isn't one. */
function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== COOKIE) return null;
  const len = buf.readUInt16BE(2);
  if (20 + len > buf.length) return null;
  const attrs = new Map();
  for (let off = 20; off + 4 <= 20 + len;) {
    const type = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    if (off + 4 + alen > 20 + len) return null;
    const v = buf.subarray(off + 4, off + 4 + alen);
    if (!attrs.has(type)) attrs.set(type, []);
    attrs.get(type).push(v);
    off += 4 + alen + pad4(alen);
  }
  return { type: buf.readUInt16BE(0), tx: Buffer.from(buf.subarray(8, 20)), attrs, size: 20 + len };
}

function xorAddr(address, port) {
  const b = Buffer.alloc(8);
  b[1] = 1;
  b.writeUInt16BE(port ^ (COOKIE >>> 16), 2);
  const octets = address.split('.').map(Number);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(COOKIE);
  for (let i = 0; i < 4; i++) b[4 + i] = octets[i] ^ c[i];
  return b;
}

function readXorAddr(v) {
  if (!v || v.length < 8 || v[1] !== 1) return null; // IPv4 only
  const c = Buffer.alloc(4);
  c.writeUInt32BE(COOKIE);
  const octets = [];
  for (let i = 0; i < 4; i++) octets.push(v[4 + i] ^ c[i]);
  return { address: octets.join('.'), port: v.readUInt16BE(2) ^ (COOKIE >>> 16) };
}

/** "turn:host:3478?transport=udp" -> { secure, host, port, transport } */
function parseUrl(url) {
  const m = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(String(url));
  if (!m) return null;
  const secure = m[1].toLowerCase() === 'turns';
  return {
    secure,
    host: m[2],
    port: Number(m[3]) || (secure ? 5349 : 3478),
    transport: secure ? 'tls' : (m[4] || 'udp').toLowerCase(),
  };
}

/** The addresses to try, UDP before TCP before TLS (the faster ones first). */
function plan(urls) {
  const rank = { udp: 0, tcp: 1, tls: 2 };
  return (urls || []).map(parseUrl).filter(Boolean).sort((a, b) => rank[a.transport] - rank[b.transport]);
}

class TurnClient extends EventEmitter {
  /** @param {{urls: string[], username: string, credential: string}} creds */
  constructor(creds) {
    super();
    this.creds = creds;
    this.server = null;
    this.sock = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // tx hex -> { resolve, reject, timers }
    this.realm = '';
    this.nonce = Buffer.alloc(0);
    this.key = null;
    this.relayed = null;
    this.permitted = new Set();
    this.closed = false;
    this.timer = null;
  }

  // ---- connecting ----

  dropConnection() {
    try { if (this.sock) { if (this.sock.close) this.sock.close(); else this.sock.destroy(); } } catch { /* closed */ }
    this.sock = null;
    this.buffer = Buffer.alloc(0);
    this.key = null;
    this.server = null;
  }

  async connectTo(s) {
    const { address } = await dns.lookup(s.host, { family: 4 });
    if (s.transport === 'udp') {
      this.sock = dgram.createSocket('udp4');
      this.sock.on('error', () => {});
      this.sock.on('message', (m) => this.onBytes(m, true));
      await new Promise((resolve) => this.sock.bind(0, resolve));
      this.sendWire = (b) => this.sock.send(b, s.port, address, () => {});
      // UDP has no connection: prove the server answers by allocating (done by the caller)
      return;
    }
    await new Promise((resolve, reject) => {
      const done = (err) => { clearTimeout(t); err ? reject(err) : resolve(); };
      const opts = { host: address, port: s.port };
      const sock = s.transport === 'tls'
        ? tls.connect({ ...opts, servername: s.host })
        : net.connect(opts);
      const t = setTimeout(() => { sock.destroy(); done(new Error('timeout')); }, CONNECT_TIMEOUT_MS);
      sock.setNoDelay(true);
      sock.once('error', done);
      sock.once(s.transport === 'tls' ? 'secureConnect' : 'connect', () => {
        sock.removeListener('error', done);
        sock.on('error', () => this.lost('relay connection error'));
        sock.on('close', () => this.lost('relay connection closed'));
        sock.on('data', (d) => this.onBytes(d, false));
        this.sock = sock;
        this.sendWire = (b) => { if (!sock.destroyed) sock.write(b); };
        done();
      });
    });
  }

  lost(why) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const p of this.pending.values()) { p.timers.forEach(clearTimeout); p.reject(new Error(why)); }
    this.pending.clear();
    this.emit('closed', why);
  }

  // ---- messages ----

  onBytes(data, datagram) {
    if (datagram) {
      this.onMessage(data);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      if (this.buffer.length < 20) return;
      const total = 20 + this.buffer.readUInt16BE(2);
      if (this.buffer.length < total) return;
      const one = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      this.onMessage(one);
    }
  }

  onMessage(buf) {
    const m = parse(buf);
    if (!m) return;
    if (m.type === M.DATA) {
      const peer = readXorAddr((m.attrs.get(A.PEER) || [])[0]);
      const data = (m.attrs.get(A.DATA) || [])[0];
      if (peer && data) this.emit('data', Buffer.from(data), peer);
      return;
    }
    const wait = this.pending.get(m.tx.toString('hex'));
    if (!wait) return;
    wait.timers.forEach(clearTimeout);
    this.pending.delete(m.tx.toString('hex'));
    wait.resolve(m);
  }

  /** Send a request and wait for its answer (UDP resends a few times). */
  request(type, attrs, authed) {
    const attempt = (withKey) => new Promise((resolve, reject) => {
      const all = [...attrs];
      if (withKey) all.push([A.USERNAME, Buffer.from(this.creds.username)], [A.REALM, Buffer.from(this.realm)], [A.NONCE, this.nonce]);
      const { msg, tx } = build(type, all, withKey ? this.key : null);
      const timers = [];
      const key = tx.toString('hex');
      this.pending.set(key, { resolve, reject, timers });
      const resends = this.server && this.server.transport === 'udp' ? UDP_RETRIES_MS : [0];
      for (const ms of resends) timers.push(setTimeout(() => { if (!this.closed) this.sendWire(msg); }, ms));
      timers.push(setTimeout(() => {
        this.pending.delete(key);
        reject(Object.assign(new Error('the relay didn’t answer'), { code: 'relay-timeout' }));
      }, resends[resends.length - 1] + (this.server && this.server.transport === 'udp' ? 1000 : STREAM_REQUEST_MS)));
    });
    const errorCode = (m) => {
      const v = (m.attrs.get(A.ERROR) || [])[0];
      return v && v.length >= 4 ? v[2] * 100 + v[3] : 0;
    };
    return (async () => {
      let res = await attempt(Boolean(authed && this.key));
      let code = errorCode(res);
      if ((code === 401 || code === 438) && authed) {
        // The server's challenge: its realm and a nonce to sign with (also how a stale nonce is renewed)
        const realm = (res.attrs.get(A.REALM) || [])[0];
        const nonce = (res.attrs.get(A.NONCE) || [])[0];
        if (realm && nonce) {
          this.realm = realm.toString();
          this.nonce = Buffer.from(nonce);
          this.key = crypto.createHash('md5').update(`${this.creds.username}:${this.realm}:${this.creds.credential}`).digest();
          res = await attempt(true);
          code = errorCode(res);
        }
      }
      if (code) throw Object.assign(new Error(`the relay refused (${code})`), { code: `relay-${code}` });
      return res;
    })();
  }

  // ---- using the relay ----

  /**
   * Connect to the first relay address that works and ask for a relayed address there.
   * Resolves { address, port }.
   */
  async allocate() {
    const tried = [];
    for (const s of plan(this.creds.urls)) {
      try {
        await this.connectTo(s);
        this.server = s;
        const res = await this.request(M.ALLOCATE, [[A.TRANSPORT, Buffer.from([17, 0, 0, 0])]], true); // UDP
        const relayed = readXorAddr((res.attrs.get(A.RELAYED) || [])[0]);
        if (!relayed) throw new Error('no address given');
        this.relayed = relayed;
        this.timer = setInterval(() => this.refresh().catch((err) => this.lost(err.message)), REFRESH_EVERY_MS);
        this.timer.unref();
        return relayed;
      } catch (err) {
        tried.push(`${s.transport}://${s.host}:${s.port} ${err.message}`);
        this.dropConnection();
      }
    }
    throw Object.assign(new Error(`no relay reachable (${tried.join('; ') || 'no addresses'})`), { code: 'relay-unreachable' });
  }

  /** Let these IPv4 addresses send to the relayed address (the relay filters by IP only). */
  async permit(ips) {
    const fresh = [...new Set(ips)].filter((ip) => net.isIPv4(ip));
    if (!fresh.length) return;
    await this.request(M.PERMISSION, fresh.map((ip) => [A.PEER, xorAddr(ip, 0)]), true);
    for (const ip of fresh) this.permitted.add(ip);
  }

  async refresh() {
    const lifetime = Buffer.alloc(4);
    lifetime.writeUInt32BE(600);
    await this.request(M.REFRESH, [[A.LIFETIME, lifetime]], true);
    if (this.permitted.size) await this.request(M.PERMISSION, [...this.permitted].map((ip) => [A.PEER, xorAddr(ip, 0)]), true);
  }

  /** Send a packet to a peer through the relay. The peer's IP must have been permitted. */
  send(address, port, data, cb) {
    if (this.closed || !net.isIPv4(address)) { if (cb) cb(); return; }
    const { msg } = build(M.SEND, [[A.PEER, xorAddr(address, port)], [A.DATA, data]], null);
    this.sendWire(msg);
    if (cb) cb();
  }

  close() {
    if (this.closed) return;
    // Hand the allocation back (best effort), then drop the connection
    if (this.relayed && this.key) {
      try {
        const lifetime = Buffer.alloc(4); // 0: delete
        const { msg } = build(M.REFRESH, [[A.LIFETIME, lifetime], [A.USERNAME, Buffer.from(this.creds.username)], [A.REALM, Buffer.from(this.realm)], [A.NONCE, this.nonce]], this.key);
        this.sendWire(msg);
      } catch { /* going away anyway */ }
    }
    this.closed = true;
    clearInterval(this.timer);
    for (const p of this.pending.values()) { p.timers.forEach(clearTimeout); p.reject(new Error('closed')); }
    this.pending.clear();
    setTimeout(() => {
      try { this.sock && (this.sock.close ? this.sock.close() : this.sock.destroy()); } catch { /* closed */ }
    }, 50);
    this.emit('closed', 'closed');
  }
}

module.exports = { TurnClient, build, parse, xorAddr, readXorAddr, parseUrl, plan, M, A, COOKIE };
