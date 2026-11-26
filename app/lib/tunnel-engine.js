// Direct connections between two PCs ("tunnels"), with no port forwarding and no VPN.
//
// Both PCs learn their public address from a STUN server, swap addresses and keys through Moonshine's
// friends service, then send packets at each other at the same time. Each router sees its own PC's
// packets go out first, so it lets the other's in: a direct path through both routers ("hole punching").
// It doesn't work when both routers change the outgoing port for every destination (some phone and
// carrier-grade networks); Tailscale still works there.
//
// Everything then travels in one encrypted UDP path (X25519 key agreement, AES-256-GCM, replay window):
//  - the player's UDP streams (video, control, audio) as datagrams, and
//  - its TCP connections (HTTP, HTTPS, RTSP) over a small retransmitting stream layer.
// Only the host's six streaming ports can be reached through a tunnel; never its settings page.
//
// The client side (the PC that watches) listens on a stand-in address (127.77.x.y) for the player,
// with every port shifted by an offset, because this PC's own host may hold the usual ports.
// The host side connects to its host engine from a stand-in source address (127.88.x.y) per tunnel,
// so the host can tell which friend a request comes from.
//
// This file has no Electron in it: it runs in a worker thread (tunnel-worker.js) and in tests.

'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const { TurnClient } = require('./turn');

// Ports a tunnel carries, as offsets from the host's base port (47989 by default)
const PORTS = [-5, 0, 21, 9, 10, 11]; // HTTPS, HTTP, RTSP (TCP); video, control, audio (UDP)
const TCP_IDX = [0, 1, 2];
const UDP_IDX = [3, 4, 5];

const VERSION = 0x4d;
const F = { PROBE: 1, PROBE_ACK: 2, KEEPALIVE: 3, CLOSE: 4, UDP: 0x10, DATA: 0x20, ACK: 0x21, RST: 0x22 };
const SYN = 1;
const FIN = 2;

const MSS = 1100; // TCP payload per packet: with headers, well under every path's MTU
const WINDOW = 256; // unacknowledged packets per TCP stream
const QUEUE_PAUSE = 1024 * 1024; // pause the local socket when this much is waiting to be sent
const RECV_AHEAD = 4096; // out-of-order packets kept per stream
const MAX_TRIES = 12;
const MAX_STREAMS = 256;
const MAX_FLOWS = 64;
const FLOW_IDLE_MS = 2 * 60 * 1000;
const CLOSED_LINGER_MS = 30 * 1000;
const STREAM_IDLE_MS = 30 * 60 * 1000; // the player can hold an HTTP connection open for a while

const PUNCH_EVERY_MS = 150;
const PUNCH_FOR_MS = 15000;
const PUNCH_RELAY_MS = 30000; // when a relay is in play it needs a few more seconds
const RELAY_AFTER_MS = 4000; // no direct path by now: the client side asks for a relay
const KEEPALIVE_MS = 5000;
const DEAD_MS = 30000;
const TICK_MS = 50;

const STUN_SERVERS = [['stun.cloudflare.com', 3478], ['stun.l.google.com', 19302]];
const STUN_COOKIE = 0x2112a442;

const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

// ---- Small helpers -------------------------------------------------------------------------------

function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, pub: Buffer.from(raw).toString('base64url') };
}

/** Session keys for each direction, from both sides' keys and the session id. */
function deriveKeys(privateKey, peerPub, session, role) {
  const raw = Buffer.from(String(peerPub || ''), 'base64url');
  if (raw.length !== 32) throw new Error('bad peer key');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  if (shared.every((b) => b === 0)) throw new Error('bad peer key');
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(session), 'moonshine tunnel v1', 64));
  // Key objects, not raw bytes: Node would otherwise set the key up again for every packet (6x slower)
  const toHost = crypto.createSecretKey(okm.subarray(0, 32));
  const toClient = crypto.createSecretKey(okm.subarray(32, 64));
  return role === 'client' ? { send: toHost, recv: toClient } : { send: toClient, recv: toHost };
}

/** Rejects packets seen before or too old (2048-packet window). */
class ReplayWindow {
  constructor(size = 2048) {
    this.size = size;
    this.bits = new Uint8Array(size);
    this.top = -1;
  }

  fresh(n) {
    if (n > this.top) return true;
    if (this.top - n >= this.size) return false;
    return !this.bits[n % this.size];
  }

  mark(n) {
    if (n > this.top) {
      const gap = Math.min(n - this.top, this.size);
      for (let i = 1; i <= gap; i++) this.bits[(this.top + i) % this.size] = 0;
      this.top = n;
    }
    this.bits[n % this.size] = 1;
  }
}

const isIPv4 = (a) => net.isIPv4(a);
const sameAddr = (a, b) => a && b && a.address === b.address && a.port === b.port;

/** This PC's own addresses a peer on the same network (or over IPv6) might reach directly. */
function localCandidates(port4, port6) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' && port4) {
        if (a.address.startsWith('169.254.')) continue;
        if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue; // Tailscale: not ours to use
        out.push({ a: a.address, p: port4 });
      } else if (a.family === 'IPv6' && port6) {
        // Global addresses only: link-local needs a zone, fd7a:… is Tailscale, and Teredo (2001:0::)
        // and 6to4 (2002::) are Windows' old IPv6-over-IPv4 tunnels, which rarely work
        if (!/^[23]/i.test(a.address) || /^2001:0{0,4}:/i.test(a.address) || /^2002:/i.test(a.address)) continue;
        out.push({ a: a.address, p: port6 });
      }
    }
  }
  return out;
}

function stunRequest() {
  const tx = crypto.randomBytes(12);
  const msg = Buffer.alloc(20);
  msg.writeUInt16BE(0x0001, 0); // Binding request
  msg.writeUInt16BE(0, 2);
  msg.writeUInt32BE(STUN_COOKIE, 4);
  tx.copy(msg, 8);
  return { tx, msg };
}

/** A STUN Binding success: { tx, address, port }; null for anything else. */
function parseStun(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== STUN_COOKIE) return null;
  if (buf.readUInt16BE(0) !== 0x0101) return null;
  const len = buf.readUInt16BE(2);
  if (20 + len > buf.length) return null;
  const tx = buf.subarray(8, 20);
  let mapped = null;
  for (let off = 20; off + 4 <= 20 + len;) {
    const type = buf.readUInt16BE(off);
    const alen = buf.readUInt16BE(off + 2);
    const v = buf.subarray(off + 4, off + 4 + alen);
    if (v.length < alen) break;
    if ((type === 0x0020 || type === 0x0001) && alen >= 8) {
      const xor = type === 0x0020;
      const family = v[1];
      const port = v.readUInt16BE(2) ^ (xor ? STUN_COOKIE >>> 16 : 0);
      if (family === 1) {
        const b = Buffer.from(v.subarray(4, 8));
        if (xor) for (let i = 0; i < 4; i++) b[i] ^= buf[4 + i];
        mapped = { address: [...b].join('.'), port };
      } else if (family === 2 && alen >= 20) {
        const b = Buffer.from(v.subarray(4, 20));
        if (xor) for (let i = 0; i < 16; i++) b[i] ^= buf[4 + i];
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(i).toString(16));
        mapped = { address: parts.join(':'), port };
      }
      if (xor) break; // XOR-MAPPED-ADDRESS wins over MAPPED-ADDRESS
    }
    off += 4 + alen + ((4 - (alen % 4)) % 4);
  }
  return mapped ? { tx: Buffer.from(tx), ...mapped } : null;
}

// ---- One TCP connection carried over the tunnel ----------------------------------------------------

class Stream {
  constructor(tunnel, id) {
    this.t = tunnel;
    this.id = id;
    this.socket = null;
    // sending
    this.sendNext = 0;
    this.unacked = new Map(); // seq -> { frame, sentAt, tries }
    this.queue = []; // [{ payload, flags }] waiting for room in the window
    this.queued = 0;
    this.ackedTo = 0;
    this.dupAcks = 0;
    this.finQueued = false;
    // receiving
    this.recvNext = 0;
    this.ahead = new Map(); // seq -> { flags, payload }
    this.finReceived = false;
    this.opened = false; // host side: SYN delivered
    this.lastActive = Date.now();
    this.closed = false;
  }

  /** Queue bytes (or a SYN/FIN marker) for the other side. */
  send(payload, flags = 0) {
    if (this.closed) return;
    if (flags) {
      this.queue.push({ payload, flags });
    } else {
      for (let off = 0; off < payload.length; off += MSS) {
        const part = payload.subarray(off, off + MSS);
        this.queue.push({ payload: part, flags: 0 });
        this.queued += part.length;
      }
    }
    this.pump();
    if (this.socket && this.queued > QUEUE_PAUSE && !this.socket.isPaused()) this.socket.pause();
  }

  pump() {
    // Room in the window, and never further ahead of the first gap than the other side keeps
    while (this.queue.length && this.unacked.size < WINDOW && this.sendNext - this.ackedTo < RECV_AHEAD) {
      const seg = this.queue.shift();
      if (!seg.flags) this.queued -= seg.payload.length;
      const seq = this.sendNext++;
      const frame = Buffer.alloc(8 + seg.payload.length);
      frame[0] = F.DATA;
      frame.writeUInt16BE(this.id, 1);
      frame.writeUInt32BE(seq, 3);
      frame[7] = seg.flags;
      seg.payload.copy(frame, 8);
      this.unacked.set(seq, { frame, sentAt: Date.now(), tries: 1 });
      this.t.sendFrame(frame);
    }
    if (this.socket && this.socket.isPaused() && this.queued < QUEUE_PAUSE / 4 && !this.closed) this.socket.resume();
  }

  /**
   * An acknowledgement: everything before `next` arrived, and (when given) so did packet `got`, which
   * came early because something before it is missing.
   */
  onAck(next, got) {
    const now = Date.now();
    this.lastActive = now;
    let sample = null;
    let moved = false;
    if (next > this.ackedTo) {
      for (const [seq, seg] of this.unacked) {
        if (seq >= next) break;
        if (seg.tries === 1) sample = now - seg.sentAt;
        this.unacked.delete(seq);
      }
      this.ackedTo = next;
      this.dupAcks = 0;
      moved = true;
    } else if (next === this.ackedTo && this.unacked.size && got === undefined) {
      // The same ack again: a packet went missing. Resend it now rather than waiting for the timer.
      this.dupAcks += 1;
      if (this.dupAcks === 3) {
        const seg = this.unacked.get(next);
        if (seg) this.resend(seg);
      }
    }
    if (got !== undefined && got >= next) {
      const seg = this.unacked.get(got);
      if (seg) {
        if (seg.tries === 1) sample = now - seg.sentAt;
        this.unacked.delete(got);
        moved = true;
      }
      // A later packet got through, so earlier ones still missing well after it are lost: resend them
      // now (once per round trip) instead of waiting for the timer.
      const late = this.t.srtt * 1.25 + 2;
      for (const [seq, s] of this.unacked) {
        if (seq + 3 > got) break;
        if (now - s.sentAt > late) this.resend(s);
      }
    }
    if (sample !== null) this.t.rttSample(sample);
    if (moved) {
      this.pump();
      this.maybeDone();
    }
  }

  resend(seg) {
    seg.tries += 1;
    seg.sentAt = Date.now();
    this.t.sendFrame(seg.frame);
  }

  /** Resend what's overdue; false when the other side stopped answering. */
  retransmit(now, rto) {
    let sent = 0;
    for (const seg of this.unacked.values()) {
      if (now - seg.sentAt < rto * 2 ** Math.min(seg.tries - 1, 3)) continue;
      if (seg.tries >= MAX_TRIES) return false;
      this.resend(seg);
      if (++sent >= 32) break;
    }
    return true;
  }

  onData(seq, flags, payload) {
    this.lastActive = Date.now();
    const inRange = seq >= this.recvNext && seq < this.recvNext + RECV_AHEAD;
    if (inRange && !this.ahead.has(seq)) {
      this.ahead.set(seq, { flags, payload });
      while (this.ahead.has(this.recvNext)) {
        const seg = this.ahead.get(this.recvNext);
        this.ahead.delete(this.recvNext);
        this.recvNext += 1;
        this.deliver(seg);
        if (this.closed) return;
      }
    }
    // Say which packet came in if it's held back behind a gap, so only the missing ones are resent
    this.t.sendAck(this.id, this.recvNext, inRange && seq >= this.recvNext ? seq : undefined);
  }

  deliver(seg) {
    if (seg.flags & SYN) {
      this.t.onSyn(this, seg.payload);
      return;
    }
    if (!this.opened) {
      this.t.reset(this); // data before the connection was opened: not something we sent
      return;
    }
    if (seg.flags & FIN) {
      this.finReceived = true;
      if (this.socket) this.socket.end();
      this.maybeDone();
      return;
    }
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(seg.payload);
      if (this.socket.writableLength > 16 * 1024 * 1024) this.t.reset(this); // the reader stopped reading
    }
  }

  /** Both directions finished and everything sent was received: tidy up. */
  maybeDone() {
    if (this.closed || !this.finReceived || !this.finQueued || this.queue.length || this.unacked.size) return;
    this.t.forget(this);
  }
}

// ---- A tunnel --------------------------------------------------------------------------------------

/**
 * One tunnel, client or host side.
 *   prepare() -> { pub, cands, nat }    open the UDP sockets, ask STUN for the public address
 *   start({ peerPub, peerCands, session, ... }) -> resolves when the direct path works
 *   close(reason)
 * Events: 'closed' (reason), 'connected' (path)
 */
class Tunnel extends EventEmitter {
  constructor(role, options = {}) {
    super();
    this.role = role; // 'client' or 'host'
    this.opts = options;
    this.sock4 = null;
    this.sock6 = null;
    this.keys = null;
    this.keyPair = newKeyPair();
    this.sendCounter = 0;
    this.replay = new ReplayWindow();
    this.path = null; // { sock, address, port }
    this.connected = false;
    this.closed = false;
    this.lastRecv = 0;
    this.lastSent = 0;
    this.lastUse = Date.now(); // last time the player sent or got anything (not keep-alives)
    this.stunWaits = new Map();
    this.timers = [];
    this.turn = null; // the relay allocation, if this side asked for one
    this.relaySock = null; // a stand-in socket that sends through it
    this.punchFor = PUNCH_FOR_MS;
    this.targets = []; // where to send probes: the other PC's candidate addresses
    // TCP
    this.streams = new Map();
    this.closedStreams = new Map(); // id -> { next, until }: answer late resends of a finished stream
    this.nextStreamId = 1;
    this.srtt = 0;
    this.rttvar = 0;
    this.rto = 500;
    // UDP
    this.flows = new Map(); // id -> flow
    this.flowByKey = new Map(); // client: "idx|address|port" -> flow
    this.nextFlowId = 1;
    // client listeners
    this.servers = [];
    this.udpLocal = new Map(); // idx -> socket
    this.stats = { sent: 0, recv: 0, bytesSent: 0, bytesRecv: 0 };
    // Tests can drop a share of outgoing packets to check the stream layer copes
    this.dropRate = Number(options.dropRate) || 0;
  }

  // ---- setup ----

  async prepare() {
    this.sock4 = await this.bindUdp('udp4');
    this.sock6 = await this.bindUdp('udp6').catch(() => null); // no IPv6 on this PC
    const port4 = this.sock4.address().port;
    const port6 = this.sock6 ? this.sock6.address().port : 0;
    const mapped = (await Promise.all(STUN_SERVERS.map(([h, p]) => this.stun(h, p)))).filter(Boolean);
    const cands = [];
    for (const m of mapped) if (!cands.some((c) => c.a === m.address && c.p === m.port)) cands.push({ a: m.address, p: m.port });
    // A router that picks a new outgoing port per destination ("symmetric NAT") makes punching unlikely
    const nat = mapped.length < 2 ? (mapped.length ? 'unknown' : 'blocked') : mapped[0].port === mapped[1].port ? 'cone' : 'symmetric';
    for (const c of localCandidates(port4, port6)) if (!cands.some((x) => x.a === c.a && x.p === c.p)) cands.push(c);
    if (this.opts.extraCands) cands.push(...this.opts.extraCands); // tests
    return { pub: this.keyPair.pub, cands: cands.slice(0, 16), nat };
  }

  bindUdp(type) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
      sock.once('error', reject);
      sock.bind(0, type === 'udp6' ? '::' : '0.0.0.0', () => {
        sock.removeListener('error', reject);
        sock.on('error', () => {}); // ICMP errors from probes to dead candidates; harmless
        try {
          sock.setRecvBufferSize(4 * 1024 * 1024);
          sock.setSendBufferSize(4 * 1024 * 1024);
        } catch { /* keep the defaults */ }
        sock.on('message', (msg, rinfo) => this.onPacket(sock, msg, rinfo));
        resolve(sock);
      });
    });
  }

  async stun(host, port) {
    let address;
    try {
      ({ address } = await dns.lookup(host, { family: 4 }));
    } catch {
      return null;
    }
    const { tx, msg } = stunRequest();
    const key = tx.toString('hex');
    return new Promise((resolve) => {
      const tries = [0, 250, 600, 1100];
      const timers = tries.map((ms) => setTimeout(() => {
        if (!this.closed) this.sock4.send(msg, port, address, () => {});
      }, ms));
      const done = (res) => {
        timers.forEach(clearTimeout);
        this.stunWaits.delete(key);
        resolve(res);
      };
      this.stunWaits.set(key, done);
      timers.push(setTimeout(() => done(null), 2000));
    });
  }

  /** Start punching towards the other PC; resolves once packets go both ways. */
  start({ peerPub, peerCands, session }) {
    this.keys = deriveKeys(this.keyPair.privateKey, peerPub, session, this.role);
    this.targets = (peerCands || []).filter((c) => c && net.isIP(c.a) && c.p > 0 && c.p < 65536);
    return new Promise((resolve, reject) => {
      this.onConnected = resolve;
      const started = Date.now();
      const punch = () => {
        if (this.closed || this.connected) return;
        if (Date.now() - started > this.punchFor) {
          reject(Object.assign(new Error('no direct path'), { code: 'no-path' }));
          this.close('no-path');
          return;
        }
        const probe = Buffer.alloc(9);
        probe[0] = F.PROBE;
        crypto.randomFillSync(probe, 1);
        for (const c of this.targets) {
          const sock = isIPv4(c.a) ? this.sock4 : this.sock6;
          if (sock) this.sendRaw(sock, this.seal(probe), c.a, c.p);
          if (this.relaySock && this.relayable(c.a)) this.sendRaw(this.relaySock, this.seal(probe), c.a, c.p);
        }
      };
      punch();
      this.timers.push(setInterval(punch, PUNCH_EVERY_MS));
      this.timers.push(setInterval(() => this.tick(), TICK_MS));
      if (this.role === 'client') {
        // Nothing direct yet: tell the arranger (lib/tunnels.js) it's time to try a relay
        this.timers.push(setTimeout(() => { if (!this.closed && !this.connected) this.emit('relay-wanted'); }, RELAY_AFTER_MS));
      }
      this.on('closed', (reason) => reject(Object.assign(new Error(reason), { code: reason })));
    });
  }

  // ---- relay (last resort) ----

  /** Is this a peer address a relay can reach (public IPv4)? */
  relayable(address) {
    if (!isIPv4(address)) return false;
    if (this.opts.allowPrivateRelay) return true; // tests
    return !/^(10.|127.|169.254.|192.168.|172.(1[6-9]|2d|3[01]).|100.(6[4-9]|[7-9]d|1[01]d|12[0-7]).)/.test(address);
  }

  /**
   * Get a relayed address (this PC's side only; the other PC sends to it). The relay is told to accept
   * packets from the other PC's public addresses. Resolves { a, p }.
   */
  async useRelay(creds) {
    if (this.closed || this.turn) throw Object.assign(new Error('relay already in use'), { code: 'closed' });
    const turn = new TurnClient(creds);
    const relayed = await turn.allocate();
    if (this.closed) { turn.close(); throw Object.assign(new Error('closed'), { code: 'closed' }); }
    this.turn = turn;
    this.relaySock = { relay: true, send: (msg, port, address, cb) => turn.send(address, port, msg, cb) };
    turn.on('data', (buf, from) => this.onPacket(this.relaySock, buf, { address: from.address, port: from.port }));
    turn.on('closed', () => {
      // Losing the relay ends a tunnel that was using it
      if (this.path && this.path.sock === this.relaySock) this.close('relay-lost');
    });
    this.punchFor = PUNCH_RELAY_MS;
    await turn.permit(this.targets.map((c) => c.a).filter((a) => this.relayable(a)));
    return { a: relayed.address, p: relayed.port };
  }

  /** More places to try reaching the other PC (its relayed address, once it has one). */
  addTargets(cands) {
    for (const c of cands || []) {
      if (!c || !net.isIP(c.a) || !(c.p > 0 && c.p < 65536)) continue;
      if (!this.targets.some((t) => t.a === c.a && t.p === c.p)) this.targets.push(c);
    }
    this.punchFor = PUNCH_RELAY_MS;
  }

  // ---- packets ----

  seal(frame) {
    const n = this.sendCounter++;
    const header = Buffer.alloc(9);
    header[0] = VERSION;
    header.writeUInt32BE(Math.floor(n / 0x100000000), 1);
    header.writeUInt32BE(n >>> 0, 5);
    const iv = Buffer.alloc(12);
    header.copy(iv, 4, 1, 9);
    const c = crypto.createCipheriv('aes-256-gcm', this.keys.send, iv);
    c.setAAD(header);
    const body = c.update(frame);
    c.final();
    return Buffer.concat([header, body, c.getAuthTag()]);
  }

  open(packet) {
    if (!this.keys || packet.length < 9 + 1 + 16 || packet[0] !== VERSION) return null;
    const n = packet.readUInt32BE(1) * 0x100000000 + packet.readUInt32BE(5);
    if (!this.replay.fresh(n)) return null;
    const header = packet.subarray(0, 9);
    const iv = Buffer.alloc(12);
    header.copy(iv, 4, 1, 9);
    let frame;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.keys.recv, iv);
      d.setAAD(header);
      d.setAuthTag(packet.subarray(packet.length - 16));
      frame = Buffer.concat([d.update(packet.subarray(9, packet.length - 16)), d.final()]);
    } catch {
      return null; // not from the other PC
    }
    this.replay.mark(n);
    return frame;
  }

  sendRaw(sock, packet, address, port) {
    if (this.closed) return;
    if (this.dropRate && Math.random() < this.dropRate) return;
    sock.send(packet, port, address, () => {});
  }

  sendFrame(frame) {
    if (!this.path || this.closed) return;
    this.lastSent = Date.now();
    this.stats.sent += 1;
    this.stats.bytesSent += frame.length;
    this.sendRaw(this.path.sock, this.seal(frame), this.path.address, this.path.port);
  }

  onPacket(sock, msg, rinfo) {
    if (this.closed) return;
    if (msg.length >= 20 && msg[0] < 2) {
      const res = parseStun(msg);
      if (res) {
        const done = this.stunWaits.get(res.tx.toString('hex'));
        if (done) done({ address: res.address, port: res.port });
      }
      return;
    }
    const frame = this.open(msg);
    if (!frame || !frame.length) return;
    this.lastRecv = Date.now();
    this.stats.recv += 1;
    this.stats.bytesRecv += msg.length;
    const from = { sock, address: rinfo.address, port: rinfo.port };
    const type = frame[0];

    if (type === F.PROBE) {
      // Always answer: the other side may not have heard our answer yet
      const ack = Buffer.from(frame);
      ack[0] = F.PROBE_ACK;
      this.sendRaw(sock, this.seal(ack), rinfo.address, rinfo.port);
      if (sock.relay && !this.connected) {
        // Through the relay the other side's real address is only learned from what it sends: probe it
        // back there too (its own address, which may differ from the one it published), so we get an ack
        const back = Buffer.alloc(9);
        back[0] = F.PROBE;
        crypto.randomFillSync(back, 1);
        this.sendRaw(sock, this.seal(back), rinfo.address, rinfo.port);
      }
      return;
    }
    if (type === F.PROBE_ACK) {
      if (!this.connected) {
        this.path = from;
        this.connected = true;
        this.lastSent = Date.now();
        this.emit('connected', { address: rinfo.address, port: rinfo.port });
        if (this.onConnected) this.onConnected({ address: rinfo.address, port: rinfo.port });
      }
      return;
    }
    if (!this.connected) return;
    // The other side only sends data on its chosen path: follow it if its address changed (new network)
    if (!sameAddr(this.path, from) || this.path.sock !== sock) this.path = from;

    switch (type) {
      case F.KEEPALIVE: return;
      case F.CLOSE: this.close('peer-closed'); return;
      case F.UDP: this.onUdpFrame(frame); return;
      case F.DATA: this.onDataFrame(frame); return;
      case F.ACK: this.onAckFrame(frame); return;
      case F.RST: this.onRstFrame(frame); return;
      default:
    }
  }

  tick() {
    if (this.closed || !this.connected) return;
    const now = Date.now();
    if (now - this.lastRecv > DEAD_MS) {
      this.close('peer-gone');
      return;
    }
    if (now - this.lastSent > KEEPALIVE_MS) this.sendFrame(Buffer.from([F.KEEPALIVE]));
    for (const s of [...this.streams.values()]) {
      if (!s.retransmit(now, this.rto)) {
        this.reset(s);
        continue;
      }
      if (now - s.lastActive > STREAM_IDLE_MS && !s.unacked.size) this.reset(s);
    }
    for (const [id, c] of this.closedStreams) if (c.until < now) this.closedStreams.delete(id);
    for (const [id, f] of this.flows) if (now - f.lastActive > FLOW_IDLE_MS) this.dropFlow(id);
  }

  rttSample(ms) {
    if (!this.srtt) {
      this.srtt = ms;
      this.rttvar = ms / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - ms);
      this.srtt = 0.875 * this.srtt + 0.125 * ms;
    }
    this.rto = Math.min(Math.max(this.srtt + 4 * this.rttvar, 150), 3000);
  }

  // ---- TCP over the tunnel ----

  sendAck(id, next, got) {
    const f = Buffer.alloc(got === undefined ? 7 : 11);
    f[0] = F.ACK;
    f.writeUInt16BE(id, 1);
    f.writeUInt32BE(next, 3);
    if (got !== undefined) f.writeUInt32BE(got, 7);
    this.sendFrame(f);
  }

  sendRst(id) {
    const f = Buffer.alloc(3);
    f[0] = F.RST;
    f.writeUInt16BE(id, 1);
    this.sendFrame(f);
  }

  onDataFrame(frame) {
    if (frame.length < 8) return;
    this.lastUse = Date.now();
    const id = frame.readUInt16BE(1);
    const seq = frame.readUInt32BE(3);
    const flags = frame[7];
    const payload = frame.subarray(8);
    let s = this.streams.get(id);
    if (!s) {
      const old = this.closedStreams.get(id);
      if (old) {
        if (seq < old.next) this.sendAck(id, old.next); // a late resend: say it arrived
        else this.sendRst(id);
        return;
      }
      // Only the client opens connections; the host side learns of one from its first packet
      if (this.role !== 'host' || this.streams.size >= MAX_STREAMS) {
        this.sendRst(id);
        return;
      }
      s = new Stream(this, id);
      this.streams.set(id, s);
    }
    s.onData(seq, flags, payload);
  }

  onAckFrame(frame) {
    if (frame.length < 7) return;
    const s = this.streams.get(frame.readUInt16BE(1));
    if (s) s.onAck(frame.readUInt32BE(3), frame.length >= 11 ? frame.readUInt32BE(7) : undefined);
  }

  onRstFrame(frame) {
    if (frame.length < 3) return;
    const s = this.streams.get(frame.readUInt16BE(1));
    if (s) this.forget(s, true);
  }

  /** Host side: the client opened a connection to one of the host's TCP ports. */
  onSyn(stream, payload) {
    const idx = payload[0];
    if (this.role !== 'host' || stream.opened || !TCP_IDX.includes(idx)) {
      this.reset(stream);
      return;
    }
    stream.opened = true;
    const socket = net.connect({
      host: '127.0.0.1',
      port: this.opts.hostBase + PORTS[idx],
      localAddress: this.opts.srcIp,
      allowHalfOpen: true,
    });
    this.attach(stream, socket);
  }

  /** Wire a local TCP socket to a stream, in both directions. */
  attach(stream, socket) {
    stream.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.lastUse = Date.now();
      stream.send(chunk);
    });
    socket.on('end', () => {
      stream.finQueued = true;
      stream.send(Buffer.alloc(0), FIN);
      stream.maybeDone();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      // Closed before both sides finished: tell the other side to drop it
      if (!stream.closed && !(stream.finQueued && stream.finReceived)) this.reset(stream);
    });
  }

  /** Abort a stream on both sides. */
  reset(stream) {
    if (stream.closed) return;
    this.sendRst(stream.id);
    this.forget(stream, true);
  }

  forget(stream, abort = false) {
    if (stream.closed) return;
    stream.closed = true;
    this.streams.delete(stream.id);
    this.closedStreams.set(stream.id, { next: stream.recvNext, until: Date.now() + CLOSED_LINGER_MS });
    if (stream.socket) {
      if (abort) stream.socket.destroy();
      else stream.socket.end();
    }
  }

  // ---- UDP over the tunnel ----

  onUdpFrame(frame) {
    if (frame.length < 4) return;
    this.lastUse = Date.now();
    const id = frame.readUInt16BE(1);
    const idx = frame[3];
    const payload = frame.subarray(4);
    if (this.role === 'client') {
      const flow = this.flows.get(id);
      if (!flow) return;
      flow.lastActive = Date.now();
      const sock = this.udpLocal.get(flow.idx);
      if (sock) sock.send(payload, flow.port, flow.address, () => {});
      return;
    }
    // Host side: forward to the host engine's port from this tunnel's source address
    if (!UDP_IDX.includes(idx)) return;
    let flow = this.flows.get(id);
    if (!flow) {
      if (this.flows.size >= MAX_FLOWS) return;
      const sock = dgram.createSocket('udp4');
      flow = { id, idx, sock, lastActive: Date.now(), ready: false, pending: [] };
      this.flows.set(id, flow);
      sock.on('error', () => {});
      sock.on('message', (msg) => {
        flow.lastActive = Date.now();
        this.lastUse = Date.now();
        this.sendUdp(id, idx, msg);
      });
      sock.bind(0, this.opts.srcIp, () => {
        try {
          sock.setRecvBufferSize(4 * 1024 * 1024);
          sock.setSendBufferSize(4 * 1024 * 1024);
        } catch { /* keep the defaults */ }
        flow.ready = true;
        for (const p of flow.pending) sock.send(p, this.opts.hostBase + PORTS[idx], '127.0.0.1', () => {});
        flow.pending = [];
      });
    }
    if (flow.idx !== idx) return;
    flow.lastActive = Date.now();
    if (flow.ready) flow.sock.send(payload, this.opts.hostBase + PORTS[idx], '127.0.0.1', () => {});
    else if (flow.pending.length < 64) flow.pending.push(Buffer.from(payload));
  }

  sendUdp(id, idx, payload) {
    const f = Buffer.alloc(4 + payload.length);
    f[0] = F.UDP;
    f.writeUInt16BE(id, 1);
    f[3] = idx;
    payload.copy(f, 4);
    this.sendFrame(f);
  }

  dropFlow(id) {
    const flow = this.flows.get(id);
    if (!flow) return;
    this.flows.delete(id);
    if (flow.key) this.flowByKey.delete(flow.key);
    if (flow.sock) try { flow.sock.close(); } catch { /* closed */ }
  }

  // ---- client side: stand-in listeners for the player ----

  /**
   * Listen on localIp for the player, with every host port shifted by an offset. Tries the
   * preferred offset first, then others, since this PC's own host may hold some ports.
   * Resolves the offset in use.
   */
  async listen(localIp, hostBase, preferred) {
    const tries = [preferred, ...Array.from({ length: 12 }, () => 1000 + crypto.randomInt(0, 14000))]
      .filter((o) => Number.isInteger(o) && o >= 1000 && hostBase + 21 + o <= 65535 && hostBase - 5 + o >= 1024);
    for (const offset of tries) {
      if (await this.tryListen(localIp, hostBase, offset)) return offset;
    }
    throw Object.assign(new Error('no free ports'), { code: 'no-ports' });
  }

  async tryListen(localIp, hostBase, offset) {
    const servers = [];
    const udps = new Map();
    const closeAll = () => {
      for (const s of servers) s.close();
      for (const u of udps.values()) try { u.close(); } catch { /* closed */ }
    };
    try {
      for (const idx of TCP_IDX) {
        const server = net.createServer({ allowHalfOpen: true }, (socket) => this.onLocalConnection(idx, socket));
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(hostBase + PORTS[idx] + offset, localIp, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        servers.push(server);
      }
      for (const idx of UDP_IDX) {
        const sock = dgram.createSocket('udp4');
        await new Promise((resolve, reject) => {
          sock.once('error', reject);
          sock.bind(hostBase + PORTS[idx] + offset, localIp, () => {
            sock.removeListener('error', reject);
            resolve();
          });
        });
        sock.on('error', () => {});
        try {
          sock.setRecvBufferSize(4 * 1024 * 1024);
          sock.setSendBufferSize(4 * 1024 * 1024);
        } catch { /* keep the defaults */ }
        sock.on('message', (msg, rinfo) => this.onLocalDatagram(idx, msg, rinfo));
        udps.set(idx, sock);
      }
    } catch {
      closeAll();
      return false;
    }
    this.servers = servers;
    this.udpLocal = udps;
    return true;
  }

  onLocalConnection(idx, socket) {
    if (!this.connected || this.closed || this.streams.size >= MAX_STREAMS) {
      socket.destroy();
      return;
    }
    let id = this.nextStreamId;
    for (let n = 0; n < 65535 && (this.streams.has(id) || this.closedStreams.has(id) || id === 0); n++) id = (id % 65535) + 1;
    this.nextStreamId = (id % 65535) + 1;
    const stream = new Stream(this, id);
    stream.opened = true;
    this.streams.set(id, stream);
    this.lastUse = Date.now();
    stream.send(Buffer.from([idx]), SYN);
    this.attach(stream, socket);
  }

  onLocalDatagram(idx, msg, rinfo) {
    if (!this.connected || this.closed) return;
    this.lastUse = Date.now();
    const key = `${idx}|${rinfo.address}|${rinfo.port}`;
    let flow = this.flowByKey.get(key);
    if (!flow) {
      if (this.flows.size >= MAX_FLOWS) return;
      let id = this.nextFlowId;
      for (let n = 0; n < 65535 && (this.flows.has(id) || id === 0); n++) id = (id % 65535) + 1;
      this.nextFlowId = (id % 65535) + 1;
      flow = { id, idx, key, address: rinfo.address, port: rinfo.port, lastActive: Date.now() };
      this.flows.set(id, flow);
      this.flowByKey.set(key, flow);
    }
    flow.lastActive = Date.now();
    this.sendUdp(flow.id, idx, msg);
  }

  // ---- shutdown ----

  close(reason = 'closed') {
    if (this.closed) return;
    if (this.connected) {
      // Say goodbye (twice, in case one is lost) so the other side doesn't wait for a timeout
      this.sendFrame(Buffer.from([F.CLOSE]));
      this.sendFrame(Buffer.from([F.CLOSE]));
    }
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const done of this.stunWaits.values()) done(null);
    for (const s of this.streams.values()) if (s.socket) s.socket.destroy();
    this.streams.clear();
    for (const id of [...this.flows.keys()]) this.dropFlow(id);
    for (const s of this.servers) s.close();
    for (const u of this.udpLocal.values()) try { u.close(); } catch { /* closed */ }
    if (this.turn) this.turn.close();
    // Let the goodbye leave before the sockets close
    setTimeout(() => {
      for (const s of [this.sock4, this.sock6]) if (s) try { s.close(); } catch { /* closed */ }
    }, 50);
    this.emit('closed', reason);
  }

  info() {
    return {
      connected: this.connected,
      path: this.path ? { address: this.path.address, port: this.path.port } : null,
      relayed: Boolean(this.path && this.path.sock && this.path.sock.relay),
      lastUse: this.lastUse,
      streams: this.streams.size,
      flows: this.flows.size,
      rtt: Math.round(this.srtt),
      stats: this.stats,
    };
  }
}

module.exports = { Tunnel, PORTS, deriveKeys, newKeyPair, parseStun, ReplayWindow, localCandidates };
