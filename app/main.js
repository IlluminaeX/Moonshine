// Moonshine: one window to host (Apollo) and connect (Moonlight).
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, Tray, Menu, WebContentsView, ipcMain, dialog, nativeImage, nativeTheme, session, shell, protocol, net,
} = require('electron');

const store = require('./lib/store');
const apollo = require('./lib/apollo');
const moonlight = require('./lib/moonlight');
const library = require('./lib/library');
const streamSettings = require('./lib/stream-settings');
const tailscale = require('./lib/tailscale');
const invite = require('./lib/invite');
const prompts = require('./lib/prompts');
const service = require('./lib/friends-service');
const hub = require('./lib/hub');
const tunnels = require('./lib/tunnels');
const updater = require('./lib/updater');

let mainWindow = null;
let tray = null;
let quitting = false;
let streamProcess = null;
let streamAddress = ''; // the address the running stream uses
let streamStarting = false;
let pairProcess = null;

const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'moonshine.png'));
const BOX_ART_DIR = path.join(process.env.LOCALAPPDATA || '', 'Moonlight Game Streaming Project', 'Moonlight', 'cache', 'boxart');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// boxart://<host uuid>/<app id> serves the box art Moonlight has cached.
protocol.registerSchemesAsPrivileged([{ scheme: 'boxart', privileges: { standard: true, secure: true } }]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'Moonshine',
    icon,
    backgroundColor: '#0b0709',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing hides to the tray so friends can still connect.
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function refreshTray() {
  if (!tray) return;
  const state = await apollo.serviceState();
  const recent = store.get('recentHosts');
  const update = updater.getState();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Moonshine', click: showWindow },
    ...(['available', 'downloading', 'ready'].includes(update.status) ? [{
      label: update.status === 'downloading' ? `Downloading Moonshine ${update.version}…` : `Update to Moonshine ${update.version}`,
      enabled: update.status !== 'downloading',
      click: () => { showWindow(); installUpdate().catch(() => {}); },
    }] : []),
    { type: 'separator' },
    {
      label: state === 'running' ? 'Stop hosting' : 'Start hosting',
      enabled: state !== 'not-installed',
      click: async () => {
        await apollo.setService(state !== 'running').catch(() => {});
        refreshTray();
        notifyRenderer('host:changed');
      },
    },
    ...(recent.length ? [{
      label: 'Connect to',
      submenu: recent.map((h) => ({ label: `${h.name}: ${h.app}`, click: () => startStream(h, h.app) })),
    }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---- Host: pairing and stream requests ----------------------------------------------
// The host engine holds every stream request from a device set to "ask before streaming" until
// this PC's user answers, and reports pairing requests: ones from another Moonshine, which sent its
// PIN along and only need an Accept, and ones that need the PIN typed. Moonshine polls for all of
// them and shows its own prompts (lib/prompts.js).

const PAIRING_MAX_AGE_S = 5 * 60; // older "needs a PIN" entries are devices that gave up
const INVITE_QUIET_MS = 15000;

const prompted = new Set(); // request keys that have had (or are having) their prompt
// Friends this PC invited to play: their address -> until when. Their pairing request and stream
// request are let through without a popup, since inviting them was the yes.
const INVITE_VALID_MS = 10 * 60 * 1000;
const invitedFriends = new Map();
function wasInvited(address) {
  const until = invitedFriends.get(address);
  return Boolean(until && until > Date.now());
}
// Addresses of Moonshine friends' PCs (Tailscale or same home network only) -> their username
let friendAddresses = new Map();
const openPrompts = new Set(); // request keys whose prompt is on screen or queued
// Addresses with a Moonshine pairing request in hand. Its PIN came with the request, so the host's
// "needs a PIN" entry for that address must not raise the PIN prompt. Value: Infinity while the
// request is open, then the time it finished.
const invitePairing = new Map();
let managedChecked = false;

/** Tailscale's { name, user } for a tailnet address; null for any other address. */
async function tailnetDevice(address) {
  const onTailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^fd7a:115c:a1e0:/i.test(address);
  return onTailnet ? tailscale.whois(address).catch(() => null) : null;
}

function fromLine(address, device) {
  if (device && device.user) return `${device.user} on Tailscale`;
  const friend = tunnels.friendForSource(address);
  if (friend) return `${friend.username || 'A Moonshine friend'}, connected directly`;
  return address ? `From ${address}` : '';
}

/** Remember which Tailscale user a paired device belongs to, to show in the Devices list. */
function rememberUser(uuid, user) {
  if (user) store.set('pairedDevices', { ...store.get('pairedDevices'), [uuid]: { user } });
}

/** The device a pairing just added. The handshake finishes a moment after the PIN is accepted. */
async function waitForNewClient(before, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const added = (await apollo.listClients()).find((c) => !before.has(c.uuid));
    if (added || Date.now() >= deadline) return added || null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Wait for the pairing attempt that belongs to a request: one from the same address, started after
 * the request was made. The host gives a PIN to its newest waiting attempt, so sending the PIN before
 * this one arrives could hand it to an older attempt the device has given up on.
 */
async function pairingAttemptArrived(offer, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { offers = [], pairing = [] } = await apollo.pendingRequests();
    if (!offers.some((o) => o.id === offer.id)) return false; // expired
    if (pairing.some((p) => p.address === offer.address && p.at >= offer.at)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A friend's Moonshine asked to pair and sent its PIN along (lib/invite.js), so Accept is all it takes. */
async function promptForOffer(offer) {
  try {
    const device = await tailnetDevice(offer.address);
    const name = (device && device.name) || offer.name;
    const friend = friendAddresses.get(offer.address) || (tunnels.friendForSource(offer.address) || {}).username;
    const choice = wasInvited(offer.address) || friend ? { ok: true, checked: false } : await prompts.ask({
      key: `offer:${offer.id}`,
      title: `${name} wants to pair with this PC`,
      details: [fromLine(offer.address, device), 'Once paired, it can ask to stream from this PC.'],
      accept: 'Accept',
      decline: 'Decline',
      checkbox: 'Let it stream without asking each time',
    });
    if (choice.cancelled) return; // the request expired
    if (!choice.ok) {
      await apollo.decidePair(offer.id, false);
      return;
    }

    const before = new Set((await apollo.listClients()).map((c) => c.uuid));
    if (!(await pairingAttemptArrived(offer)) || !(await apollo.submitPin(offer.pin, name, 0))) {
      await apollo.decidePair(offer.id, false);
      notifyRenderer('app:toast', `Pairing with ${name} didn’t complete. Ask them to try again.`);
      return;
    }
    const added = await waitForNewClient(before);
    if (added) {
      rememberUser(added.uuid, friend || (device && device.user));
      if (choice.checked) await apollo.updateClient(added, { require_approval: false });
    }
    await apollo.decidePair(offer.id, true);
    notifyRenderer('app:toast', `Paired with ${name}.`);
    notifyRenderer('host:changed');
  } finally {
    invitePairing.set(offer.address, Date.now());
  }
}

/** A device paired the plain Moonlight way is showing a PIN and waiting for it to be typed here. */
async function promptForPin(request) {
  const device = await tailnetDevice(request.address);
  const choice = await prompts.ask({
    key: `pin:${request.id}`,
    title: 'A device wants to pair with this PC',
    details: [fromLine(request.address, device), 'Type the PIN it’s showing. Only pair devices you trust.'],
    accept: 'Pair',
    decline: 'Ignore',
    pin: true,
    name: device ? device.name : '',
  });
  if (!choice.ok) return;

  const before = new Set((await apollo.listClients()).map((c) => c.uuid));
  await apollo.submitPin(choice.pin, choice.name, 0);
  const added = await waitForNewClient(before, 8000);
  if (added) {
    rememberUser(added.uuid, device && device.user);
    notifyRenderer('app:toast', `Paired with ${added.name}. It will ask before each stream.`);
    notifyRenderer('host:changed');
  } else {
    notifyRenderer('app:toast', 'Pairing didn’t complete. The PIN may have been wrong; try again from that device.');
  }
}

/** A paired device set to "ask before streaming" wants to start or rejoin a stream. */
async function promptForStream(request) {
  if (wasInvited(request.address)) {
    letIn.set(request.uuid, Date.now());
    await apollo.decideStream(request.id, true);
    return;
  }
  const device = await tailnetDevice(request.address);
  const choice = await prompts.ask({
    key: `stream:${request.id}`,
    title: `${request.name || 'A device'} wants to stream from this PC`,
    details: [request.app ? `App: ${request.app}` : '', fromLine(request.address, device)],
    accept: 'Allow',
    decline: 'Decline',
    checkbox: 'Don’t ask again for this device',
  });
  if (choice.cancelled) return; // the request already timed out on the host
  if (choice.ok) letIn.set(request.uuid, Date.now());
  if (choice.ok && choice.checked) {
    const client = (await apollo.listClients()).find((c) => c.uuid === request.uuid);
    if (client) await apollo.updateClient(client, { require_approval: false });
    notifyRenderer('host:changed');
  }
  await apollo.decideStream(request.id, choice.ok);
}

/** A friend's Moonshine invites this PC's user to join a stream on their PC. */
async function promptForInvite(inv) {
  const device = await tailnetDevice(inv.address);
  const who = device && device.user ? device.user.replace(/@.*$/, '') : inv.name;
  const choice = await prompts.ask({
    key: `invite:${inv.id}`,
    title: `${who} invites you to play`,
    details: [`${inv.app} on ${inv.name}`, fromLine(inv.address, device)],
    accept: 'Join',
    decline: 'Not now',
  });
  if (choice.cancelled) return; // the invite expired
  await apollo.decideInvite(inv.id, choice.ok).catch(() => {});
  if (choice.ok) joinInvite(inv).catch((err) => notifyRenderer('app:toast', err.message));
}

/** Connect to the PC that invited us: pair first if needed (they let it through), then stream. */
async function joinInvite(inv) {
  if (streamProcess) throw new Error('End the stream you’re in first.');
  const ipv6 = inv.address.includes(':');
  const host = ipv6 ? `[${inv.address}]` : inv.address;
  const address = inv.port === library.DEFAULT_PORT ? inv.address : `${host}:${inv.port}`;
  const info = await library.serverInfo(inv.address, inv.port, 4000);
  if (!info) throw new Error(`Couldn’t reach ${inv.name}. They may have stopped hosting.`);
  const target = { uuid: info.uuid, name: store.get('pcNames')[info.uuid] || info.name, address, moonshine: true };
  if (!(await moonlight.listApps(address))) {
    showWindow();
    const res = await pairWith(target);
    notifyRenderer('pair:state', null);
    if (!res.ok) throw new Error(res.reason === 'cancelled' ? 'Joining cancelled.' : `Couldn’t pair with ${target.name}.`);
  }
  startStream(target, inv.app);
}

// ---- Host: who is watching right now ---------------------------------------------------------

const JOIN_NOTICE_MS = 20 * 1000; // how long a "joined your stream" notice stays up
const REJOIN_QUIET_MS = 60 * 1000; // a device reconnecting within this long isn't news
const letIn = new Map(); // device uuid -> when this PC's user allowed or invited its stream
let watching = null; // device uuids streaming from this PC (null until the first look)
const leftAt = new Map(); // device uuid -> when it stopped streaming

/** Someone joined a stream on this PC without being asked about: say so, with a Kick button. */
async function noticeJoin(guest) {
  const key = `joined:${guest.uuid}:${Date.now()}`;
  const who = (store.get('pairedDevices')[guest.uuid] || {}).user;
  const timer = setTimeout(() => prompts.cancel(key), JOIN_NOTICE_MS);
  const choice = await prompts.ask({
    key,
    title: `${guest.name || 'A device'} joined your stream`,
    details: [who ? `${who.replace(/@.*$/, '')}’s device` : '', 'It was let in without asking, as set for this device.'],
    accept: 'OK',
    decline: 'Kick',
    danger: true,
  });
  clearTimeout(timer);
  if (!choice.declined) return;
  await apollo.disconnectClient(guest.uuid).catch(() => {});
  // Ask before it streams again, so a kick doesn't just let it straight back in
  const client = (await apollo.listClients().catch(() => [])).find((c) => c.uuid === guest.uuid);
  if (client) await apollo.updateClient(client, { require_approval: true }).catch(() => {});
  notifyRenderer('app:toast', `Kicked ${guest.name || 'that device'}. It has to ask before streaming again.`);
  notifyRenderer('host:changed');
}

/** Every 2 seconds: notice devices joining, and tell friends straight away when the count changes. */
async function watchGuests() {
  try {
    if ((await apollo.serviceState().catch(() => '')) === 'running') {
      const guests = await apollo.guests();
      const now = new Set(guests.map((g) => g.uuid));
      if (watching) {
        for (const g of guests) {
          if (watching.has(g.uuid)) continue;
          const allowed = letIn.get(g.uuid);
          const rejoined = leftAt.get(g.uuid);
          const quiet = (allowed && Date.now() - allowed < REJOIN_QUIET_MS) || (rejoined && Date.now() - rejoined < REJOIN_QUIET_MS);
          if (!quiet) noticeJoin(g).catch(() => {});
        }
        for (const uuid of watching) if (!now.has(uuid)) leftAt.set(uuid, Date.now());
        const changed = now.size !== watching.size || [...now].some((u) => !watching.has(u));
        if (changed) presenceOnce(); // friends see "Hosting · 2 connected" go back to "Free" in seconds
      }
      watching = now;
    } else {
      watching = null;
    }
  } catch {
    watching = null; // the host is restarting
  }
  setTimeout(watchGuests, 2000);
}

function raisePrompt(key, show) {
  prompted.add(key);
  openPrompts.add(key);
  show()
    .catch((err) => console.error('Request prompt failed:', err.message))
    .finally(() => openPrompts.delete(key));
}

async function pollHostRequests() {
  let delay = 1000;
  try {
    const { streams = [], pairing = [], offers = [], invites = [] } = await apollo.pendingRequests();
    if (!managedChecked) {
      managedChecked = true;
      apollo.ensureManaged().catch(() => { managedChecked = false; });
    }

    const live = new Set();
    for (const request of streams) {
      const key = `stream:${request.id}`;
      live.add(key);
      if (!prompted.has(key)) raisePrompt(key, () => promptForStream(request));
    }
    for (const offer of offers) {
      const key = `offer:${offer.id}`;
      live.add(key);
      if (!prompted.has(key)) {
        invitePairing.set(offer.address, Infinity);
        raisePrompt(key, () => promptForOffer(offer));
      }
    }
    for (const inv of invites) {
      const key = `invite:${inv.id}`;
      if (tunnels.isTunnelSource(inv.address)) {
        if (!prompted.has(key)) {
          prompted.add(key);
          apollo.decideInvite(inv.id, false).catch(() => {});
        }
        continue;
      }
      live.add(key);
      if (!prompted.has(key)) raisePrompt(key, () => promptForInvite(inv));
    }
    for (const request of pairing) {
      const key = `pin:${request.id}`;
      const invited = invitePairing.get(request.address);
      if (invited !== undefined && Date.now() - invited < INVITE_QUIET_MS) {
        prompted.add(key); // Moonshine's own pairing flow is handling (or just handled) this one
        continue;
      }
      if (request.age > PAIRING_MAX_AGE_S) continue;
      live.add(key);
      if (!prompted.has(key)) raisePrompt(key, () => promptForPin(request));
    }
    // Withdraw prompts whose request went away (timed out, or the device gave up).
    for (const key of openPrompts) {
      if (!live.has(key)) prompts.cancel(key);
    }
  } catch {
    delay = 5000; // host stopped, restarting, or not signed in yet
  }
  setTimeout(pollHostRequests, delay);
}

/** Pair with a PIN typed by hand, for a pairing request whose popup was missed or ignored. */
async function pairWithPin(pin, name) {
  const before = new Set((await apollo.listClients()).map((c) => c.uuid));
  if (!(await apollo.submitPin(pin, name, 0))) throw new Error('No device is waiting to pair. Start pairing on the device first.');
  const added = await waitForNewClient(before, 8000);
  if (!added) throw new Error('Pairing didn’t complete. The PIN may have been wrong; try again from that device.');
  notifyRenderer('host:changed');
  return added.name;
}

// ---- Host: the host engine's own web page, shown inside the window --------------------------
// Kept for anything Moonshine's own pages don't cover. It is a separate view laid over the page, so
// the renderer tells us where to put it and hides it whenever something else needs the space.

let webUi = null;
let webUiShown = false;
const WEB_UI_ORIGIN = `https://localhost:${apollo.API_PORT}`;

function webUiView() {
  if (webUi) return webUi;
  const ses = session.fromPartition('moonshine-webui');
  // The host engine uses a certificate it made itself; trust it for this PC only.
  ses.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'localhost' ? 0 : -3));
  // The host's key signs the page in, so there's no login to type (lib/apollo.js).
  ses.webRequest.onBeforeSendHeaders({ urls: [`${WEB_UI_ORIGIN}/*`] }, (details, callback) => {
    const token = apollo.webToken();
    callback({ requestHeaders: token ? { ...details.requestHeaders, 'X-Moonshine-Token': token } : details.requestHeaders });
  });
  webUi = new WebContentsView({ webPreferences: { session: ses } });
  webUi.setBackgroundColor('#0b0709');
  webUi.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') && !url.startsWith(WEB_UI_ORIGIN)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return webUi;
}

ipcMain.handle('webui:show', (_e, bounds) => {
  if (!mainWindow) return;
  const view = webUiView();
  view.setBounds({
    x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height),
  });
  if (!webUiShown) {
    mainWindow.contentView.addChildView(view);
    webUiShown = true;
    if (!view.webContents.getURL().startsWith(WEB_UI_ORIGIN)) view.webContents.loadURL(WEB_UI_ORIGIN).catch(() => {});
  }
});

ipcMain.handle('webui:hide', () => {
  if (webUiShown && mainWindow) mainWindow.contentView.removeChildView(webUi);
  webUiShown = false;
});

ipcMain.handle('webui:reload', () => { if (webUi) webUi.webContents.loadURL(WEB_UI_ORIGIN).catch(() => {}); });

// ---- IPC: Host ---------------------------------------------------------------

ipcMain.handle('host:status', async () => {
  const [state, ts] = await Promise.all([apollo.serviceState(), tailscale.status()]);
  let audio = null;
  let loginNeeded = false;
  if (state === 'running') {
    try {
      const cfg = await apollo.getConfig();
      audio = {
        mode: cfg.audio_capture_mode || 'system',
        app: cfg.audio_capture_app || '',
      };
    } catch (err) {
      loginNeeded = /already has a login|rejected/.test(err.message);
    }
  }
  return {
    service: state,
    tailscale: ts ? { ip: ts.self.ip, name: ts.self.name, dnsName: ts.self.dnsName } : null,
    tailscaleInstalled: tailscale.installed(),
    audio,
    loginNeeded,
    startAtLogin: store.get('startAtLogin'),
  };
});

ipcMain.handle('host:setService', async (_e, running) => {
  await apollo.setService(running);
  refreshTray();
});

ipcMain.handle('host:login', (_e, user, password) => apollo.setCredentials(user, password));

ipcMain.handle('host:setAudio', (_e, mode, appName) =>
  apollo.updateConfig({ audio_capture_mode: mode, audio_capture_app: appName }));

ipcMain.handle('host:processes', () => new Promise((resolve) => {
  execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true }, (err, stdout) => {
    const names = new Set((stdout || '').split(/\r?\n/)
      .map((line) => line.split('","')[0].replace(/^"/, ''))
      .filter((n) => n.toLowerCase().endsWith('.exe')));
    resolve([...names].sort((a, b) => a.localeCompare(b)));
  });
}));

// ---- IPC: Devices ------------------------------------------------------------

const CLIENT_SETTINGS = ['name', 'perm', 'display_mode', 'require_approval', 'always_use_virtual_display',
  'allow_client_commands', 'enable_legacy_ordering'];

ipcMain.handle('host:clients', async () => {
  const users = store.get('pairedDevices');
  return (await apollo.listClients()).map((c) => ({
    uuid: c.uuid,
    connected: Boolean(c.connected),
    user: users[c.uuid] ? users[c.uuid].user : '',
    ...Object.fromEntries(CLIENT_SETTINGS.map((k) => [k, c[k]])),
  }));
});

ipcMain.handle('host:updateClient', async (_e, uuid, changes) => {
  const client = (await apollo.listClients()).find((c) => c.uuid === uuid);
  if (!client) throw new Error('That device is no longer paired.');
  const allowed = Object.fromEntries(Object.entries(changes).filter(([k]) => CLIENT_SETTINGS.includes(k)));
  await apollo.updateClient(client, allowed);

  // Renaming a friend's device here also renames their PC in Connect, when it's clearly the same
  // PC: it has the device's old name, or it's the only PC of the Tailscale user the device belongs to.
  if (allowed.name && allowed.name !== client.name) {
    const old = String(client.name || '').toLowerCase();
    const user = (store.get('pairedDevices')[uuid] || {}).user;
    const ofUser = user ? lastHosts.filter((h) => h.tailnetUser === user) : [];
    const same = lastHosts.filter((h) => [h.name, h.ownName].some((n) => n && n.toLowerCase() === old));
    for (const h of same.length ? same : ofUser.length === 1 ? ofUser : []) renamePc(h.uuid, allowed.name);
  }
});

ipcMain.handle('host:guests', () => apollo.guests().catch(() => []));

/** The upload limit shared by everyone watching, in Mbps (0 = none). Saved, and applied at once. */
ipcMain.handle('host:getBandwidth', async () => {
  const cfg = await apollo.getConfig().catch(() => ({}));
  return (Number(cfg.moonshine_total_bitrate) || 0) / 1000;
});
ipcMain.handle('host:setBandwidth', async (_e, mbps) => {
  const kbps = Math.max(0, Math.min(10000000, Math.round((Number(mbps) || 0) * 1000)));
  await apollo.saveConfig({ moonshine_total_bitrate: kbps }); // no restart: streams keep going
  await apollo.setBandwidth(kbps);
  return kbps / 1000;
});
ipcMain.handle('host:setPlayerOrder', (_e, uuids) => apollo.setPlayerOrder(uuids));
ipcMain.handle('host:disconnectClient', (_e, uuid) => apollo.disconnectClient(uuid));

ipcMain.handle('host:unpair', async (_e, uuid) => {
  await apollo.unpair(uuid);
  const users = { ...store.get('pairedDevices') };
  delete users[uuid];
  store.set('pairedDevices', users);
});

// ---- IPC: host settings, applications, logs --------------------------------

/** Run an Apollo call, turning "not running" / "needs login" into states the UI can show. */
async function apolloCall(fn) {
  const state = await apollo.serviceState();
  if (state !== 'running') return { ok: false, reason: state === 'not-installed' ? 'not-installed' : 'stopped' };
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    if (/already has a login|rejected the login/.test(err.message)) return { ok: false, reason: 'login' };
    throw err;
  }
}

ipcMain.handle('apollo:getConfig', () => apolloCall(() => apollo.getConfig()));
ipcMain.handle('apollo:saveConfig', (_e, changes) => apolloCall(() => apollo.updateConfig(changes)));
ipcMain.handle('apollo:getApps', () => apolloCall(() => apollo.getApps()));
ipcMain.handle('apollo:saveApp', (_e, entry) => apolloCall(() => apollo.saveApp(entry)));
ipcMain.handle('apollo:deleteApp', (_e, uuid) => apolloCall(() => apollo.deleteApp(uuid)));
ipcMain.handle('apollo:launchApp', (_e, uuid) => apolloCall(() => apollo.launchApp(uuid)));
ipcMain.handle('apollo:closeApp', () => apolloCall(() => apollo.closeApp()));
ipcMain.handle('apollo:getLogs', () => apolloCall(() => apollo.getLogs()));
ipcMain.handle('apollo:restart', () => apolloCall(() => apollo.restart()));
ipcMain.handle('apollo:unpairAll', () => apolloCall(async () => {
  await apollo.unpairAll();
  store.set('pairedDevices', {});
}));
ipcMain.handle('apollo:resetDisplay', () => apolloCall(() => apollo.resetDisplay()));
ipcMain.handle('apollo:setWebLogin', (_e, user, password) => apolloCall(() => apollo.setWebLogin(user, password)));
ipcMain.handle('apollo:otp', (_e, passphrase, name) => apolloCall(() => apollo.requestOtp(passphrase, name)));
ipcMain.handle('apollo:pairWithPin', (_e, pin, name) => apolloCall(() => pairWithPin(pin, name)));

ipcMain.handle('apollo:browse', async (_e, kind) => {
  const filters = kind === 'image'
    ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    : [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd', 'lnk', 'url'] }, { name: 'All files', extensions: ['*'] }];
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
    filters: kind === 'folder' ? undefined : filters,
  });
  return res.canceled ? null : res.filePaths[0];
});

// ---- Updates (lib/updater.js) ----------------------------------------------------------

/** Download the update (if needed), warn when that would cut off streams, then install it. */
async function installUpdate() {
  if (updater.getState().status !== 'ready') await updater.download();
  const watching = await apollo.guests().catch(() => []);
  const busy = [];
  if (streamProcess) busy.push('your stream will close');
  if (watching.length) busy.push(`${watching.length === 1 ? 'the device watching' : `the ${watching.length} devices watching`} this PC will be disconnected`);
  const { version } = updater.getState();
  const choice = await dialog.showMessageBox(mainWindow && mainWindow.isVisible() ? mainWindow : undefined, {
    type: 'question',
    title: 'Update Moonshine',
    message: `Install Moonshine ${version} now?`,
    detail: `Moonshine closes, Windows asks to allow the install, and Moonshine opens again when it's done (about a minute).${busy.length ? `\n\nWhile it installs, ${busy.join(' and ')}.` : ''}`,
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (choice.response !== 0) return false;
  if (streamProcess) { try { streamProcess.kill(); } catch { /* gone */ } }
  updater.install(() => { quitting = true; app.quit(); });
  return true;
}

ipcMain.handle('update:get', () => updater.getState());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:install', async () => {
  try {
    return await installUpdate();
  } catch (err) {
    throw new Error(updater.getState().error || err.message);
  }
});

ipcMain.handle('app:setStartAtLogin', (_e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  store.set('startAtLogin', enabled);
});

// ---- IPC: Connect ------------------------------------------------------------

function withBoxArt(uuid, apps) {
  return apps.map((a) => ({
    ...a,
    boxArt: fs.existsSync(path.join(BOX_ART_DIR, uuid, `${a.id}.png`)) ? `boxart://${uuid}/${a.id}` : '',
  }));
}

/**
 * Every host Moonshine can show: PCs Moonlight has saved, GameStream hosts on the LAN,
 * and tailnet peers. Hosts that are Moonshine themselves are marked `moonshine`.
 * This PC's own host is left out.
 */
async function findHosts() {
  const [saved, lan, ts, self] = await Promise.all([
    library.readSavedHosts(), library.discoverLan(), tailscale.status(), library.serverInfo('127.0.0.1'),
  ]);
  const hosts = new Map();
  const merge = (uuid, fields) => {
    if (self && uuid === self.uuid) return;
    const host = hosts.get(uuid) || {
      uuid, name: '', address: '', addressRank: 0, online: false, busy: false, saved: false, paired: false,
      moonshine: false, tailnetUser: '', apps: [],
    };
    const { address, addressRank = 0, ...rest } = fields;
    for (const [k, v] of Object.entries(rest)) {
      if (v || !host[k]) host[k] = v;
    }
    // A PC can answer on several addresses. Keep the best one whatever order the lookups finish in:
    // Tailscale first (it works from anywhere, and it's where Moonshine's pairing requests go).
    if (address && addressRank >= host.addressRank) {
      host.address = address;
      host.addressRank = addressRank;
    }
    hosts.set(uuid, host);
  };
  const RANK = { saved: 1, lan: 2, tailnet: 3 };
  const reach = async (address, port, addressRank, fields = {}) => {
    const info = await library.serverInfo(address, port);
    if (info) {
      const full = info.port === library.DEFAULT_PORT ? address : `${address}:${port}`;
      merge(info.uuid, {
        name: info.name, address: full, addressRank,
        online: true, busy: info.busy, moonshine: Boolean(await invite.probe(full)), ...fields,
      });
    }
  };

  for (const h of saved) merge(h.uuid, { name: h.name, saved: true, apps: h.apps });
  await Promise.all([
    ...saved.map(async (h) => {
      for (const a of h.addresses) {
        await reach(a.address, a.port, RANK.saved);
        if (hosts.get(h.uuid)?.online) break;
      }
    }),
    ...lan.map((a) => reach(a.address, a.port, RANK.lan)),
    ...(ts ? ts.peers.map((peer) => reach(peer.ip, library.DEFAULT_PORT, RANK.tailnet, { tailnetUser: peer.user })) : []),
  ]);

  // Pairing is only certain once Moonlight can list the host's apps.
  await Promise.all([...hosts.values()].filter((h) => h.online).map(async (h) => {
    const apps = await moonlight.listApps(h.address);
    h.paired = Boolean(apps);
    if (apps) h.apps = apps;
  }));

  const names = store.get('pcNames');
  lastHosts = [...hosts.values()]
    .map((h) => ({ ...h, ownName: h.name, name: names[h.uuid] || h.name, apps: withBoxArt(h.uuid, h.apps) }))
    .sort((a, b) => (b.online - a.online) || (b.paired - a.paired) || a.name.localeCompare(b.name));
  return lastHosts;
}

let lastHosts = []; // what the Connect tab last showed

/** Give a PC your own name in Moonshine ('' goes back to the name it gives itself). */
function renamePc(uuid, name) {
  const names = { ...store.get('pcNames') };
  const host = lastHosts.find((h) => h.uuid === uuid);
  const oldName = host ? host.name : names[uuid];
  if (name) names[uuid] = name;
  else delete names[uuid];
  store.set('pcNames', names);
  if (host) host.name = name || host.ownName;
  // The tray's recent list remembers names too
  const shown = name || (host && host.ownName);
  if (oldName && shown) {
    store.set('recentHosts', store.get('recentHosts').map((r) => (r.name === oldName ? { ...r, name: shown } : r)));
    refreshTray();
  }
}

async function startStream(host, appName) {
  if (streamProcess || streamStarting) return;
  if (tunnels.isTunnelAddress(host.address)) {
    streamStarting = true;
    try {
      host = { ...host, address: await tunnels.ensureFor(host.address) };
    } catch (err) {
      notifyRenderer('app:toast', err.message);
      return;
    } finally {
      streamStarting = false;
    }
    if (streamProcess) return;
  }
  const recent = store.get('recentHosts').filter((h) => h.app && !(h.address === host.address && h.app === appName));
  store.set('recentHosts', [{ name: host.name, address: host.address, app: appName }, ...recent].slice(0, 5));
  refreshTray();

  let errorOutput = '';
  streamProcess = moonlight.stream(host.address, appName, streamSettings.toArgs(), streamSettings.toEnv());
  streamAddress = host.address;
  streamProcess.stderr.on('data', (chunk) => {
    errorOutput = (errorOutput + chunk).slice(-4000); // only the end is needed, for the error message
  });
  streamProcess.on('exit', (code) => {
    streamProcess = null;
    streamAddress = '';
    for (const ms of [4000, 10000]) setTimeout(() => { friendsCache = { ...friendsCache, at: 0 }; }, ms);
    const lastLine = errorOutput.trim().split(/\r?\n/).pop();
    notifyRenderer('stream:state', { active: false, error: code ? (lastLine || 'The stream ended with an error.') : null });
    showWindow();
  });
  notifyRenderer('stream:state', { active: true, host: host.name, app: appName });
  if (mainWindow) mainWindow.minimize();
}

/**
 * Pair this PC with a host. The PIN is shown either way. A Moonshine host gets it with the request,
 * so its user only has to accept; on any other host the PIN has to be typed in.
 */
async function pairWith(host) {
  if (tunnels.isTunnelAddress(host.address)) {
    try {
      host = { ...host, address: await tunnels.ensureFor(host.address) };
    } catch (err) {
      return { ok: false, reason: 'error', message: err.message };
    }
  }
  const pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  let requestId;
  try {
    requestId = await invite.requestPairing(host.address, pin, os.hostname());
  } catch (err) {
    return { ok: false, reason: ['closed', 'disabled', 'busy'].includes(err.reason) ? err.reason : 'error' };
  }
  notifyRenderer('pair:state', { pin, host: host.name, moonshine: Boolean(requestId) });

  pairProcess = moonlight.pair(host.address, pin);
  const child = pairProcess;
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

  if (requestId) {
    // Also stop waiting if pairing ends by itself (cancelled here, or the PIN was typed on the host).
    const decision = await Promise.race([invite.waitForDecision(host.address, requestId), exited.then(() => 'exited')]);
    if (decision === 'declined' || decision === 'timeout') {
      if (pairProcess === child) pairProcess = null;
      child.kill();
      return { ok: false, reason: decision };
    }
    if (decision === 'accepted') {
      // The host only says so once this PC is on its list. Moonshine's own player then ends by
      // itself; the official one waits on an OK box nobody can see, so don't wait for it for long.
      const ended = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
      if (!ended && pairProcess === child) {
        pairProcess = null;
        child.kill();
        return { ok: true };
      }
    }
  }
  const code = await exited;
  const cancelled = pairProcess !== child;
  pairProcess = null;
  if (cancelled) return { ok: false, reason: 'cancelled' };
  return code === 0 ? { ok: true } : { ok: false, reason: 'error' };
}

ipcMain.handle('connect:hosts', async () => ({ tailscale: Boolean(await tailscale.status()), hosts: await findHosts() }));

ipcMain.handle('connect:add', async (_e, input) => {
  const [address, port] = input.trim().replace(/^\[|\]$/g, '').split(/:(?=\d+$)/);
  const info = await library.serverInfo(address, Number(port) || library.DEFAULT_PORT, 4000);
  if (!info) throw new Error(`No streaming host answered at ${input.trim()}`);
  const apps = await moonlight.listApps(address);
  return {
    uuid: info.uuid, name: info.name, address: input.trim(), online: true, busy: info.busy, saved: false,
    paired: Boolean(apps), moonshine: Boolean(await invite.probe(input.trim())), tailnetUser: '',
    apps: withBoxArt(info.uuid, apps || []),
  };
});

ipcMain.handle('connect:pair', async (_e, host) => {
  const res = await pairWith(host);
  if (res.ok) reachCache.delete(host.uuid); // the Friends tab shows it paired straight away
  return res;
});

/**
 * The Friends list: every PC Moonshine knows, with who it belongs to on Tailscale and whether it's
 * free, in a game, or hosting (and for how many). A quick check of the PCs found last time;
 * `full` looks for PCs again first.
 */
ipcMain.handle('friends:status', (_e, full) => friendsStatus(full));

async function friendsStatus(full) {
  if (full || !lastHosts.length) await findHosts();
  const ts = await tailscale.status();
  const me = ts ? ts.self.user : '';
  const pcs = await Promise.all(lastHosts.map(async (h) => {
    const m = h.address.match(/^(\[.*\]|[^:]+):(\d+)$/);
    const [address, port] = m ? [m[1].replace(/^\[|\]$/g, ''), Number(m[2])] : [h.address, library.DEFAULT_PORT];
    const info = address ? await library.serverInfo(address, port, 1500) : null;
    const hello = info && h.moonshine ? await invite.probe(h.address) : null;
    return {
      uuid: h.uuid, name: h.name, ownName: h.ownName, user: h.tailnetUser || '', address: h.address,
      paired: h.paired, moonshine: h.moonshine, saved: h.saved, online: Boolean(info),
      busy: Boolean(info && info.busy), guests: hello && Number.isFinite(hello.guests) ? hello.guests : null,
    };
  }));
  // Friends' Windows PCs that are off right now still belong in the list
  const known = new Set(lastHosts.map((h) => h.address.replace(/:\d+$/, '')));
  const away = ts ? ts.allPeers.filter((p) => !p.online && p.os === 'windows' && p.user && p.user !== me && !known.has(p.ip)) : [];
  for (const p of away) {
    pcs.push({ uuid: `tailnet-${p.id}`, name: p.name, ownName: p.name, user: p.user, address: '', paired: false, moonshine: false, saved: false, online: false, busy: false, guests: null });
  }
  // A friend's PC that just came online isn't in the last search yet
  const unseen = ts ? ts.peers.some((p) => p.os === 'windows' && p.user !== me && !known.has(p.ip)) : false;

  const account = await accountFriends(full);
  // A PC that's both a Moonshine friend's and on Tailscale is listed once, under the friend
  const accountUuids = new Set(account.pcs.map((p) => p.uuid));
  const merged = [...pcs.filter((p) => !accountUuids.has(p.uuid)), ...account.pcs];
  return { me, tailscale: Boolean(ts), pcs: merged, unseen, alerts: store.get('friendAlerts'), service: account.service };
}

// ---- Moonshine accounts: friends by username -------------------------------------------------

const FRIENDS_CACHE_MS = 15000;
const REACH_CACHE_MS = 60000;
let friendsCache = { at: 0, data: null, error: '' };
const reachCache = new Map(); // host uuid -> { at, address, paired }

const isTailnetAddress = (a) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) || /^fd7a:115c:a1e0:/i.test(a);
const isPrivateAddress = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

async function serviceFriends(fresh = false) {
  if (!service.signedIn()) return null;
  if (!fresh && friendsCache.data && Date.now() - friendsCache.at < FRIENDS_CACHE_MS) return friendsCache.data;
  try {
    const data = await service.friends();
    friendsCache = { at: Date.now(), data, error: '' };
    // Remember where friends' PCs connect from, to let their pairing requests through
    const addrs = new Map();
    for (const f of data.friends) {
      if (f.status !== 'accepted') continue;
      for (const pc of f.pcs) {
        for (const a of pc.addrs) if (isTailnetAddress(a) || isPrivateAddress(a)) addrs.set(a, f.username);
      }
    }
    friendAddresses = addrs;
    return data;
  } catch (err) {
    friendsCache = { at: Date.now(), data: friendsCache.data, error: err.message };
    return friendsCache.data;
  }
}

/** How to reach a friend's PC from here: the first of its addresses whose host answers. */
async function reachFriendPc(pc) {
  const cached = reachCache.get(pc.hostUuid);
  if (cached && Date.now() - cached.at < REACH_CACHE_MS) return cached;
  const known = lastHosts.find((h) => h.uuid === pc.hostUuid && h.online);
  const direct = tunnels.openAddress(pc.hostUuid);
  let result = { at: Date.now(), address: '', paired: false };
  if (direct) {
    result = { at: Date.now(), address: direct, paired: Boolean(await moonlight.listApps(direct)) };
  } else if (known) {
    result = { at: Date.now(), address: known.address, paired: known.paired };
  } else {
    for (const a of pc.addrs) {
      const info = await library.serverInfo(a, pc.port, 1200);
      if (info && info.uuid === pc.hostUuid) {
        const host = a.includes(':') ? `[${a}]` : a;
        const address = pc.port === library.DEFAULT_PORT ? a : `${host}:${pc.port}`;
        result = { at: Date.now(), address, paired: Boolean(await moonlight.listApps(address)) };
        break;
      }
    }
  }
  reachCache.set(pc.hostUuid, result);
  return result;
}

async function accountFriends(fresh = false) {
  const state = {
    configured: service.configured(),
    signedIn: service.signedIn(),
    username: service.username(),
    requests: [],
    friends: [],
    error: '',
  };
  const data = await serviceFriends(fresh);
  state.signedIn = service.signedIn(); // a refused token signs this PC out
  state.error = friendsCache.error;
  if (!data) return { service: state, pcs: [] };
  state.username = data.me ? data.me.username || '' : state.username;
  state.requests = data.friends.filter((f) => f.status !== 'accepted').map((f) => ({ username: f.username, status: f.status }));
  state.friends = data.friends.filter((f) => f.status === 'accepted').map((f) => ({ username: f.username, online: f.online }));
  const names = store.get('pcNames');
  const pcs = [];
  for (const f of data.friends.filter((x) => x.status === 'accepted')) {
    for (const pc of f.pcs) {
      const reach = pc.online && pc.hosting ? await reachFriendPc(pc) : { address: '', paired: false };
      const viaTunnel = tunnels.isTunnelAddress(reach.address);
      pcs.push({
        uuid: pc.hostUuid || `${f.username}:${pc.name}`,
        name: names[pc.hostUuid] || pc.name,
        ownName: pc.name,
        user: f.username,
        account: true,
        address: reach.address,
        paired: reach.paired,
        moonshine: true,
        saved: false,
        online: pc.online && pc.hosting,
        reachable: Boolean(reach.address),
        // No shared network or Tailscale: a direct connection through both routers can still work
        direct: viaTunnel,
        canConnectDirectly: !reach.address && pc.online && pc.hosting && Boolean(pc.tunnel && pc.device) && hub.isConnected(),
        busy: pc.busy,
        guests: pc.guests,
      });
    }
  }
  return { service: state, pcs };
}

/** Tell the service how friends can reach this PC's host. */
async function presenceOnce() {
  try {
    if (service.signedIn()) {
      const running = (await apollo.serviceState().catch(() => '')) === 'running';
      const cfg = running ? await apollo.getConfig().catch(() => ({})) : {};
      const self = running ? await library.serverInfo('127.0.0.1', Number(cfg.port) || library.DEFAULT_PORT) : null;
      const ts = await tailscale.status();
      const guests = running ? await apollo.guests().catch(() => []) : [];
      await service.reportPresence({
        name: cfg.sunshine_name || os.hostname(),
        hostUuid: self ? self.uuid : '',
        port: Number(cfg.port) || library.DEFAULT_PORT,
        addrs: ts && ts.self.ip ? [ts.self.ip] : [],
        hosting: Boolean(self),
        busy: Boolean(self && self.busy),
        guests: guests.length,
        tunnel: hub.isConnected(),
      });
      await serviceFriends(true);
    }
  } catch {
    // offline for a moment; try again next minute
  }
}

/** ...every minute while signed in. */
async function reportPresence() {
  await presenceOnce();
  setTimeout(reportPresence, 60000);
}

ipcMain.handle('service:signIn', async () => {
  const res = await service.signIn();
  showWindow();
  friendsCache = { at: 0, data: null, error: '' };
  hub.restart();
  presenceOnce();
  return res;
});
ipcMain.handle('service:cancelSignIn', () => service.cancelSignIn());
ipcMain.handle('service:signOut', async () => {
  tunnels.closeAll();
  hub.stop();
  await service.signOut();
  friendsCache = { at: 0, data: null, error: '' };
  friendAddresses = new Map();
});
ipcMain.handle('service:setUsername', async (_e, name) => {
  const username = await service.setUsername(name);
  friendsCache.at = 0;
  return username;
});
ipcMain.handle('service:request', async (_e, username) => {
  const res = await service.request(username);
  friendsCache.at = 0;
  return res;
});
ipcMain.handle('service:respond', async (_e, username, accept) => {
  const res = await service.respond(username, accept);
  friendsCache.at = 0;
  return res;
});
ipcMain.handle('service:remove', async (_e, username) => {
  await service.remove(username);
  friendsCache.at = 0;
});

ipcMain.handle('friends:setAlerts', (_e, on) => store.set('friendAlerts', Boolean(on)));

/** A friend's online, hosting PC from the friends list: { device, port, name, username }. */
async function friendPcByUuid(uuid) {
  const data = await serviceFriends();
  for (const f of (data && data.friends) || []) {
    if (f.status !== 'accepted') continue;
    const pc = f.pcs.find((p) => p.hostUuid === uuid && p.online && p.hosting);
    if (pc) return { device: pc.device, port: pc.port, name: pc.name, username: f.username };
  }
  return null;
}

/** Open a direct connection to a friend's PC; returns it as a host the Connect tab can use. */
ipcMain.handle('friends:connect', async (_e, uuid) => {
  const pc = await friendPcByUuid(uuid);
  if (!pc || !pc.device) throw new Error('That PC isn’t hosting any more.');
  const name = store.get('pcNames')[uuid] || pc.name;
  const address = await tunnels.connect({ hostUuid: uuid, device: pc.device, port: pc.port, name });
  const apps = await moonlight.listApps(address);
  reachCache.set(uuid, { at: Date.now(), address, paired: Boolean(apps) });
  return {
    uuid, name, address, online: true, paired: Boolean(apps), moonshine: true, saved: false,
    tailnetUser: '', user: pc.username, direct: true, apps: withBoxArt(uuid, apps || []),
  };
});

/** Invite a friend to join a stream on this PC. */
ipcMain.handle('friends:invite', async (_e, pc) => {
  if ((await apollo.serviceState()) !== 'running') throw new Error('Turn on hosting in the Host tab first.');
  const cfg = await apollo.getConfig().catch(() => ({}));
  const apps = await apollo.getApps().catch(() => ({ apps: [] }));
  const list = apps.apps || [];
  const running = list.find((a) => a.uuid && a.uuid === apps.current_app);
  const desktop = list.find((a) => /^desktop$/i.test(a.name)) || list[0];
  const app = (running || desktop || { name: 'Desktop' }).name;
  const name = cfg.sunshine_name || os.hostname();
  let id;
  try {
    id = await invite.sendInvite(pc.address, { name, app, port: Number(cfg.port) || library.DEFAULT_PORT });
  } catch (err) {
    throw new Error({
      closed: `Moonshine isn’t open on ${pc.name}, so nobody would see the invite.`,
      old: `${pc.name} needs a newer Moonshine to get invites.`,
      busy: `${pc.name} has too many invites waiting. Try again in a minute.`,
    }[err.reason] || `Couldn’t reach ${pc.name}.`);
  }
  invitedFriends.set(pc.address.replace(/^\[|\](:\d+)?$/g, '').replace(/^([^:\]]+):\d+$/, '$1'), Date.now() + INVITE_VALID_MS);
  invite.waitForInvite(pc.address, id).then((status) => {
    notifyRenderer('app:toast', {
      joined: `${pc.name} is joining.`,
      declined: `${pc.name} said not now.`,
      timeout: `No answer from ${pc.name}.`,
    }[status] || `No answer from ${pc.name}.`);
  });
  return { app };
});

// ---- Friend alerts: a notification when a friend comes online or starts hosting --------------

const ALERT_EVERY_MS = 30 * 1000;
const ALERT_SEARCH_EVERY_MS = 5 * 60 * 1000;
const ALERT_QUIET_MS = 15 * 60 * 1000; // per PC and kind
let friendSeen = null; // pc uuid -> { online, guests }
let requestsSeen = null; // usernames with a friend request waiting
const lastAlert = new Map();
let lastAlertSearch = 0;

function alertFriend(key, title, content) {
  if (Date.now() - (lastAlert.get(key) || 0) < ALERT_QUIET_MS) return;
  lastAlert.set(key, Date.now());
  showBalloon(title, content, 'friends');
}

let balloonTab = null; // the tab a click on the current balloon opens (null: just the window)
function showBalloon(title, content, tab = null) {
  if (!tray) return;
  balloonTab = tab;
  tray.displayBalloon({ title, content, icon, respectQuietTime: true });
}

async function watchFriends() {
  try {
    if (store.get('friendAlerts')) {
      let res = await friendsStatus(Date.now() - lastAlertSearch > ALERT_SEARCH_EVERY_MS);
      if (res.unseen) res = await friendsStatus(true);
      if (Date.now() - lastAlertSearch > ALERT_SEARCH_EVERY_MS || res.unseen) lastAlertSearch = Date.now();
      const friends = res.pcs.filter((pc) => pc.user && pc.user !== res.me);
      const now = new Map(friends.map((pc) => [pc.uuid, { online: pc.online, busy: Boolean(pc.busy) }]));
      if (friendSeen) {
        for (const pc of friends) {
          const before = friendSeen.get(pc.uuid) || { online: false, busy: false };
          const who = pc.user.replace(/@.*$/, '');
          if (pc.online && !before.online) {
            alertFriend(`online:${pc.uuid}`, `${who} is online`, pc.busy ? `${pc.name} is streaming a game.` : `${pc.name} is free.`);
          } else if (pc.online && pc.busy && !before.busy) {
            // A game started streaming on their PC. Who else joins it later isn't worth a notification.
            alertFriend(`streaming:${pc.uuid}`, `${who} started streaming`, `A game is running on ${pc.name}. Open Moonshine to ask to join.`);
          }
        }
      }
      friendSeen = now;
      const incoming = (res.service && res.service.requests || []).filter((r) => r.status === 'incoming');
      for (const r of incoming) {
        if (requestsSeen && !requestsSeen.has(r.username)) {
          alertFriend(`request:${r.username}`, `${r.username} wants to be friends`, 'Open Moonshine’s Friends tab to accept.');
        }
      }
      requestsSeen = new Set(incoming.map((r) => r.username));
    } else {
      friendSeen = null;
    }
  } catch {
    // Tailscale or the network is having a moment; try again next round
  }
  setTimeout(watchFriends, ALERT_EVERY_MS);
}
ipcMain.handle('connect:rename', (_e, uuid, name) => renamePc(uuid, String(name || '').trim().slice(0, 60)));

ipcMain.handle('connect:remove', async (_e, host) => {
  if (streamProcess || pairProcess) throw new Error('Wait until streaming or pairing has finished.');
  await library.removeSavedHost(host.uuid);
  store.set('recentHosts', store.get('recentHosts').filter((h) => h.address !== host.address && h.name !== host.name));
  refreshTray();
});

ipcMain.handle('connect:cancelPair', () => {
  if (pairProcess) {
    const child = pairProcess;
    pairProcess = null;
    child.kill();
  }
});

ipcMain.handle('connect:apps', async (_e, host) => withBoxArt(host.uuid, (await moonlight.listApps(await tunnels.ensureFor(host.address))) || []));

ipcMain.handle('connect:stream', (_e, host, appName) => startStream(host, appName));

ipcMain.handle('connect:endStream', () => {
  if (!streamProcess) return;
  // Ask the player to close first, so it ends the stream properly and writes its statistics;
  // force it only if it hasn't gone after a few seconds.
  const child = streamProcess;
  execFile('taskkill.exe', ['/PID', String(child.pid)], { windowsHide: true }, () => {});
  setTimeout(() => {
    if (streamProcess === child) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  }, 4000);
});

ipcMain.handle('connect:quitApp', async (_e, host) => moonlight.quitApp(await tunnels.ensureFor(host.address)));

ipcMain.handle('settings:get', () => {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  return {
    settings: streamSettings.get(),
    nativeResolution: `${Math.round(display.size.width * display.scaleFactor)}x${Math.round(display.size.height * display.scaleFactor)}`,
  };
});

ipcMain.handle('settings:set', (_e, settings) => streamSettings.set(settings));

// ---- App lifecycle -------------------------------------------------------------

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  // Moonshine is dark; this makes Apollo's embedded web UI follow suit.
  nativeTheme.themeSource = 'dark';

  protocol.handle('boxart', (request) => {
    const { hostname, pathname } = new URL(request.url);
    const file = path.join(BOX_ART_DIR, hostname.toUpperCase(), `${pathname.replace(/\D/g, '')}.png`);
    return net.fetch(pathToFileURL(file).toString());
  });

  tray = new Tray(icon);
  tray.setToolTip('Moonshine');
  tray.on('click', showWindow);
  tray.on('balloon-click', () => {
    showWindow();
    if (balloonTab) notifyRenderer('app:selectTab', balloonTab);
  });
  refreshTray();

  if (process.argv.includes('--hidden')) createWindow();
  else showWindow();
  if (process.argv.includes('--hidden')) mainWindow.hide();

  updater.events.on('state', (s) => {
    notifyRenderer('update:state', s);
    if (['available', 'downloading', 'ready', 'current'].includes(s.status)) refreshTray();
    if (s.status === 'available' && store.get('updateNotified') !== s.version) {
      store.set('updateNotified', s.version);
      showBalloon(`Moonshine ${s.version} is available`, 'Open Moonshine and choose Update now. It takes about a minute.');
    }
  });
  updater.init({ version: app.getVersion(), fetch: (url, opts) => net.fetch(url, opts) });
  const updated = (process.argv.find((a) => a.startsWith('--updated=')) || '').slice('--updated='.length);
  if (updated) {
    const message = {
      done: `Moonshine is updated to ${app.getVersion()}.`,
      declined: 'The update wasn’t installed. You can try again from the sidebar.',
      failed: 'The update didn’t install. Try again from the sidebar, or download it from GitHub.',
    }[updated];
    if (message) mainWindow.webContents.once('did-finish-load', () => notifyRenderer('app:toast', message));
  }

  watchGuests();
  moonlight.setHostEnv(tunnels.playerEnv);
  tunnels.init({
    hostInfo: async () => {
      const running = (await apollo.serviceState().catch(() => '')) === 'running';
      const cfg = running ? await apollo.getConfig().catch(() => ({})) : {};
      return { running, port: Number(cfg.port) || library.DEFAULT_PORT };
    },
    inUse: (address) => Boolean(streamProcess) && streamAddress === address,
    friendPc: async (uuid) => {
      const pc = await friendPcByUuid(uuid);
      return pc && pc.device ? { device: pc.device, port: pc.port, name: store.get('pcNames')[uuid] || pc.name } : null;
    },
    log: (line) => console.log(line),
  });
  // Tell friends straight away when this PC can (or can no longer) take direct connections
  hub.events.on('up', () => presenceOnce());
  hub.events.on('down', () => setTimeout(() => { if (!hub.isConnected()) presenceOnce(); }, 5000));
  hub.start();

  pollHostRequests();
  setTimeout(watchFriends, 15000);
  setTimeout(reportPresence, 5000);
  setInterval(refreshTray, 30000);
});

app.on('before-quit', () => {
  quitting = true;
  tunnels.closeAll();
});
app.on('window-all-closed', () => { /* stay in the tray */ });
