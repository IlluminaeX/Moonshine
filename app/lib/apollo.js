// Talks to Moonshine's host engine (its Apollo build): the Windows service and its local API on https://localhost:47990.
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');

const SERVICE = 'MoonshineHost';
const API_HOST = '127.0.0.1';
const API_PORT = Number(process.env.MOONSHINE_HOST_API_PORT) || 47990; // overridden by tests

// The host engine writes a key next to its settings at each start. Sending it lets Moonshine use the
// API without the web login, so popups work even on a PC whose Apollo login Moonshine was never given.
const TOKEN_FILES = [
  process.env.MOONSHINE_HOST_TOKEN_FILE, // tests
  path.join(path.dirname(process.execPath), 'host', 'config', 'moonshine_token'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Moonshine', 'host', 'config', 'moonshine_token'),
].filter(Boolean);

let authCookie = '';
let token = '';

function readToken() {
  for (const file of TOKEN_FILES) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* not there */ }
  }
  return '';
}

/** The current key, for the embedded web UI. Empty with a host engine too old to have one. */
function webToken() {
  token = readToken();
  return token;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      host: API_HOST,
      port: API_PORT,
      path,
      method,
      rejectUnauthorized: false, // Apollo uses a self-signed certificate on localhost
      timeout: 5000,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(authCookie ? { Cookie: `auth=${authCookie}` } : {}),
        ...(token ? { 'X-Moonshine-Token': token } : {}),
      },
    }, (res) => {
      const parts = [];
      res.on('data', (chunk) => { parts.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const data = raw.toString('utf8');
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Apollo did not respond')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Create Moonshine's Apollo login on first run, or reuse the stored one. */
async function ensureCredentials() {
  let user = store.get('apolloUser');
  let password = store.getSecret('apolloPassword');
  if (user && password) return { user, password };

  user = 'moonshine';
  password = crypto.randomBytes(18).toString('base64url');
  // Only succeeds while Apollo has no credentials yet (fresh install).
  const res = await request('POST', '/api/password', {
    newUsername: user, newPassword: password, confirmNewPassword: password,
  });
  if (res.status !== 200) {
    throw new Error('Apollo already has a login. Sign in once under Host → Apollo login.');
  }
  store.set('apolloUser', user);
  store.setSecret('apolloPassword', password);
  return { user, password };
}

async function login(user, password) {
  const res = await request('POST', '/api/login', { username: user, password });
  if (res.status !== 200) throw new Error('Apollo rejected the login');
  const cookie = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('auth='));
  authCookie = cookie.split(';')[0].slice('auth='.length);
  return authCookie;
}

/** Save a login the user typed (when Apollo was set up before Moonshine). */
async function setCredentials(user, password) {
  await login(user, password);
  store.set('apolloUser', user);
  store.setSecret('apolloPassword', password);
}

/** Call the API, logging in first (or again, if the session expired). */
async function api(method, path, body) {
  return (await apiResponse(method, path, body)).json;
}

async function apiResponse(method, path, body) {
  if (!token) token = readToken();
  if (!token && !authCookie) {
    const { user, password } = await ensureCredentials();
    await login(user, password);
  }
  let res = await request(method, path, body);
  const refused = () => res.status === 401 || res.status === 307; // 307: sent to the login or welcome page
  if (refused() && token) {
    token = readToken(); // the host restarted and made a new key
    res = await request(method, path, body);
  }
  if (refused()) {
    token = '';
    const { user, password } = await ensureCredentials();
    await login(user, password);
    res = await request(method, path, body);
  }
  if (res.status !== 200) {
    throw new Error((res.json && res.json.error) || `Apollo ${path} failed (${res.status})`);
  }
  return res;
}

function sc(...args) {
  return new Promise((resolve) => {
    execFile('sc.exe', args, { windowsHide: true }, (err, stdout) => resolve(stdout || ''));
  });
}

async function serviceState() {
  const out = await sc('query', SERVICE);
  if (/FAILED 1060/.test(out)) return 'not-installed';
  const match = out.match(/STATE\s+:\s+\d+\s+(\w+)/);
  return match ? match[1].toLowerCase() : 'unknown';
}

/** Start or stop the service. Needs admin, so it goes through a UAC prompt. */
function setService(running) {
  const verb = running ? 'start' : 'stop';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process sc.exe -ArgumentList '${verb}','${SERVICE}' -Verb RunAs -WindowStyle Hidden -Wait`,
    ], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

// Keys getConfig adds that aren't part of the config file.
const NON_CONFIG_KEYS = ['status', 'platform', 'version', 'vdisplayStatus', 'moonshineAudio'];
const ON = ['enabled', 'true', 'yes', 'on', '1'];

async function getConfig() {
  return api('GET', '/api/config');
}

/** Merge settings into Apollo's config file, then restart Apollo to apply them. */
async function updateConfig(changes) {
  const current = await getConfig();
  for (const key of NON_CONFIG_KEYS) delete current[key];
  // saveConfig rewrites the whole file, so send every existing key back.
  await api('POST', '/api/config', { ...current, ...changes });
  await restart();
}

/** Merge settings into Apollo's config file without restarting it (for settings it also takes live). */
async function saveConfig(changes) {
  const current = await getConfig();
  for (const key of NON_CONFIG_KEYS) delete current[key];
  await api('POST', '/api/config', { ...current, ...changes });
}

/**
 * Put the host in "managed by Moonshine" mode: no tray icon of its own, its API reachable only from
 * this PC, and streams wait for Moonshine's user to allow them. Returns true if it had to change
 * (and so restart) the host.
 */
async function ensureManaged() {
  const cfg = await getConfig();
  if (ON.includes(String(cfg.moonshine_managed).toLowerCase()) && cfg.origin_web_ui_allowed === 'pc') return false;
  await updateConfig({ moonshine_managed: 'enabled', origin_web_ui_allowed: 'pc' });
  return true;
}

async function listClients() {
  const res = await api('GET', '/api/clients/list');
  return res.named_certs || [];
}

/**
 * Submit a pairing PIN, naming the device. Retries until the device's pairing request has reached
 * the host (when Moonshine's own pairing flow sends the PIN ahead of it).
 * @param {string} [requestId] Which pairing attempt this is for (pendingRequests().pairing[].id or
 *   .offers[].id). Pass it whenever the caller knows which attempt it means: with it, the host applies
 *   the PIN to that attempt and no other, even if another pairing attempt is also waiting. Left empty
 *   only when there is nothing to pick from (the caller just typed a PIN by hand); the host then
 *   requires there to be exactly one attempt waiting, rather than guessing.
 */
async function submitPin(pin, name, timeoutMs = 20000, requestId = '') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api('POST', '/api/pin', { pin, name, id: requestId });
    if (res.status) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Change a paired device's settings. The host replaces them all, so the rest are sent back unchanged. */
async function updateClient(client, changes) {
  const c = { ...client, ...changes };
  await api('POST', '/api/clients/update', {
    uuid: c.uuid,
    name: c.name,
    display_mode: c.display_mode,
    do: c.do,
    undo: c.undo,
    perm: c.perm,
    enable_legacy_ordering: c.enable_legacy_ordering,
    allow_client_commands: c.allow_client_commands,
    always_use_virtual_display: c.always_use_virtual_display,
    require_approval: c.require_approval,
  });
}

/** End a device's current stream. */
async function disconnectClient(uuid) {
  return api('POST', '/api/clients/disconnect', { uuid });
}

/**
 * What's waiting for this PC's user: { streams: [{id, uuid, name, address, app, age}],
 * pairing: [{id, name, address, age}] }. Polling this is also how the host knows Moonshine is running.
 */
/** Devices streaming right now, with their ping and ms since each kind of input (-1 = not used yet). */
async function guests() {
  return (await api('GET', '/api/moonshine/guests')).guests || [];
}

/** Share this upload limit (kbps, 0 = none) between everyone watching, starting now. */
async function setBandwidth(kbps) {
  return api('POST', '/api/moonshine/bandwidth', { kbps });
}

async function pendingRequests() {
  return api('GET', '/api/moonshine/pending');
}

/** Tell a friend's Moonshine whether its pairing request (pendingRequests().offers) was accepted. */
async function decideInvite(id, join) {
  return api('POST', '/api/moonshine/decide-invite', { id, join });
}

/** Accept or decline a file a paired device wants to send (pendingRequests().files). */
async function decideFile(id, accept) {
  return api('POST', '/api/moonshine/decide-file', { id, accept });
}

/** Up to 8 MB of a file that has arrived, from `offset`, as a Buffer. */
async function fileData(id, offset) {
  return (await apiResponse('GET', `/api/moonshine/file-data?id=${encodeURIComponent(id)}&offset=${offset}`)).raw;
}

/** The file is in Downloads now; the host deletes its copy. */
async function fileTaken(id) {
  return api('POST', '/api/moonshine/file-taken', { id });
}

/** Give exactly these controllers ([{uuid, index}]) the player numbers, in this order. */
async function setPadOrder(pads) {
  return api('POST', '/api/moonshine/pad-order', { pads });
}

/** Give these devices' controllers the first player numbers, in this order. */
async function setPlayerOrder(uuids) {
  return api('POST', '/api/moonshine/player-order', { uuids });
}

async function decidePair(id, allow) {
  return api('POST', '/api/moonshine/decide-pair', { id, allow });
}

async function unpairAll() {
  return api('POST', '/api/clients/unpair-all', {});
}

/** Forget the display settings the host saved to restore after a stream. */
async function resetDisplay() {
  return api('POST', '/api/reset-display-device-persistence', {});
}

/** Set the username and password for the host's web page. */
async function setWebLogin(user, password) {
  await api('POST', '/api/password', { newUsername: user, newPassword: password, confirmNewPassword: password });
  store.set('apolloUser', user);
  store.setSecret('apolloPassword', password);
  authCookie = '';
}

/** Allow or decline a waiting stream request. */
async function decideStream(id, allow) {
  return api('POST', '/api/moonshine/decide', { id, allow });
}

async function unpair(uuid) {
  return api('POST', '/api/clients/unpair', { uuid });
}

/** Apollo's app list ({ apps, current_app, ... }). */
async function getApps() {
  return api('GET', '/api/apps');
}

/** Save an app: updates the app with the same uuid, or adds it if it has none. */
async function saveApp(appEntry) {
  return api('POST', '/api/apps', appEntry);
}

async function deleteApp(uuid) {
  return api('POST', '/api/apps/delete', { uuid });
}

async function launchApp(uuid) {
  return api('POST', '/api/apps/launch', { uuid });
}

async function closeApp() {
  return api('POST', '/api/apps/close', {});
}

async function getLogs() {
  return (await apiResponse('GET', '/api/logs')).text;
}

async function restart() {
  await api('POST', '/api/restart', {}).catch(() => {}); // the connection drops as Apollo restarts
  authCookie = '';
}

module.exports = {
  API_PORT,
  webToken,
  decidePair,
  decideInvite,
  decideFile,
  fileData,
  fileTaken,
  setPlayerOrder,
  setPadOrder,
  unpairAll,
  resetDisplay,
  setWebLogin,
  serviceState,
  setService,
  ensureCredentials,
  setCredentials,
  getConfig,
  updateConfig,
  listClients,
  submitPin,
  updateClient,
  disconnectClient,
  pendingRequests,
  guests,
  setBandwidth,
  saveConfig,
  decideStream,
  ensureManaged,
  unpair,
  getApps,
  saveApp,
  deleteApp,
  launchApp,
  closeApp,
  getLogs,
  restart,
};
