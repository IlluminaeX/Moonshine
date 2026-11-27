// A small HTTP API that only programs on this PC can use, for helpers such as the Steam button
// (Millennium plugin). It listens on 127.0.0.1 on a free port and writes { port, token } to a file in
// Moonshine's settings folder; every call must carry that token. A web page can reach 127.0.0.1 but
// can't read the file, and browsers mark their requests with Origin, which is refused outright.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const MAX_BODY = 16 * 1024;

/**
 * routes: { 'GET /friends': async (body) => result, ... }. A result is sent as JSON with status 200;
 * a thrown error as { error } with its `status` (default 500). Returns a function that stops the API.
 */
function start(file, routes) {
  const token = crypto.randomBytes(24).toString('hex');
  const want = Buffer.from(`Bearer ${token}`);
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // Browsers always send Origin on these requests; and a Host other than 127.0.0.1 is a web page
    // using a name it controls to reach this PC (DNS rebinding).
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return reply(403, { error: 'forbidden' });
    const given = Buffer.from(req.headers.authorization || '');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(401, { error: 'unauthorized' });
    const route = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (!route) return reply(404, { error: 'not-found' });
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else parts.push(c);
    });
    req.on('end', async () => {
      let body = {};
      if (parts.length) {
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) || {}; } catch { return reply(400, { error: 'bad-json' }); }
      }
      try {
        reply(200, await route(body));
      } catch (err) {
        reply(err.status || 500, { error: err.message });
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(file, JSON.stringify({ port: server.address().port, token, pid: process.pid }));
  });
  return () => {
    server.close();
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  };
}

module.exports = { start };
