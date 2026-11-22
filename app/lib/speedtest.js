// A quick internet speed test (Cloudflare's free speed test servers), used to suggest a stream
// bitrate (this PC's download) and a host upload limit (this PC's upload). A few connections in
// parallel for a few seconds, like the usual speed test sites; only the speed is kept.
const crypto = require('crypto');

const BASE = process.env.MOONSHINE_SPEEDTEST_URL || 'https://speed.cloudflare.com';
const PARALLEL = 4;
const DURATION_MS = 6000;
const WARMUP_MS = 1000; // TCP ramp-up isn't counted
const DOWN_BYTES = 50 * 1000 * 1000; // per request; requests repeat until time is up
const UP_PIECE = 64 * 1024;
const UP_REQUEST_MAX = 100 * 1000 * 1000; // one upload request at most (a new one follows)

/** Count bytes after the warm-up; Mbps over the counted time. */
function meter() {
  const start = Date.now();
  let counted = 0;
  return {
    add(bytes) { if (Date.now() - start >= WARMUP_MS) counted += bytes; },
    elapsed: () => Date.now() - start,
    mbps() {
      const seconds = Math.max(0.001, (Date.now() - start - WARMUP_MS) / 1000);
      return (counted * 8) / seconds / 1e6;
    },
  };
}

async function download({ durationMs = DURATION_MS, onProgress } = {}) {
  const m = meter();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), durationMs);
  const ticker = onProgress && setInterval(() => onProgress(m.mbps()), 500);
  const worker = async () => {
    while (!stop.signal.aborted) {
      const res = await fetch(`${BASE}/__down?bytes=${DOWN_BYTES}`, { signal: stop.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`The speed test server answered ${res.status}.`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        m.add(value.length);
      }
    }
  };
  try {
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, worker));
    const failed = results.find((r) => r.status === 'rejected' && r.reason.name !== 'AbortError');
    if (failed && m.elapsed() < durationMs - 100) throw failed.reason;
  } finally {
    clearTimeout(timer);
    if (ticker) clearInterval(ticker);
  }
  return m.mbps();
}

async function upload({ durationMs = DURATION_MS, onProgress } = {}) {
  const m = meter();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), durationMs);
  const ticker = onProgress && setInterval(() => onProgress(m.mbps()), 500);
  const piece = crypto.randomBytes(UP_PIECE); // random, so nothing along the way can compress it
  // Each connection sends one long upload, counted as it goes (bytes are handed over only as the
  // connection takes them), so a slow upload isn't under-counted by waiting for whole requests.
  const worker = async () => {
    while (!stop.signal.aborted) {
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (stop.signal.aborted) { controller.error(stop.signal.reason); return; }
          if (sent >= UP_REQUEST_MAX) { controller.close(); return; }
          sent += piece.length;
          m.add(piece.length);
          controller.enqueue(new Uint8Array(piece));
        },
      }, { highWaterMark: 1 });
      const res = await fetch(`${BASE}/__up`, {
        method: 'POST', body, duplex: 'half', signal: stop.signal, headers: { 'content-type': 'application/octet-stream' },
      });
      await res.arrayBuffer().catch(() => {});
      if (!res.ok) throw new Error(`The speed test server answered ${res.status}.`);
    }
  };
  try {
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, worker));
    const failed = results.find((r) => r.status === 'rejected' && r.reason.name !== 'AbortError');
    if (failed && m.elapsed() < durationMs - 100) throw failed.reason;
  } finally {
    clearTimeout(timer);
    if (ticker) clearInterval(ticker);
  }
  return m.mbps();
}

/**
 * What to set, from a measured speed. A stream needs headroom for everything else on the line and
 * for bursts (a scene change sends much more for a moment), so neither uses the whole speed.
 */
function recommendBitrate(downMbps) {
  return Math.max(5, Math.min(150, Math.floor((downMbps * 0.7) / 5) * 5 || 5));
}
function recommendUploadLimit(upMbps) {
  return Math.max(3, Math.floor(upMbps * 0.75));
}

module.exports = { download, upload, recommendBitrate, recommendUploadLimit };
