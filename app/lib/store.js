// Persistent Moonshine settings in %APPDATA%\Moonshine\settings.json.
// Secrets are encrypted with Windows DPAPI through Electron's safeStorage.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const defaults = {
  apolloUser: '',
  apolloPassword: '', // DPAPI-encrypted, base64
  // Host device UUID -> { user }: the Tailscale user a paired device belongs to, shown in the Devices list
  pairedDevices: {},
  recentHosts: [],
  // Host uuid -> the name you gave that PC in Moonshine (shown instead of its own name)
  pcNames: {},
  // Show a notification when a friend comes online or starts hosting
  friendAlerts: true,
  // Tell friends what game you're playing or hosting
  shareGame: true,
  // Quick messages with friends, kept on this PC only: username -> [{ mine, text, at }] (newest last)
  messages: {},
  // Unread quick messages: username -> count
  unread: {},
  // Moonshine account (friends service): this PC's sign-in token (DPAPI-encrypted) and username
  serviceToken: '',
  serviceUsername: '',
  // Friends' PCs reached by direct connection: host uuid -> { ip, offset, hostBase }. Keeps each one's
  // stand-in address (127.77.x.y:port) the same, so the player's saved PC stays valid.
  tunnelHosts: {},
  updateNotified: '', // the newest version a "new version" balloon was shown for
  // What a newly paired device may do: 'controller' (start apps, controller only), 'full', 'watch'
  newDevicePerm: 'controller',
  // Host device uuids seen so far; any other device is new and gets newDevicePerm (null: not looked yet)
  knownDevices: null,
  // Hosting paused: until when (ms; -1 until resumed by hand; 0 not paused), and the devices that
  // could stream without asking before the pause (uuid -> true), to let them again afterwards
  pausedUntil: 0,
  pauseSkipped: {},
  // Do not disturb: until when (ms; -1 until turned off; 0 off)
  dndUntil: 0,
  streamSettings: {},
  startAtLogin: false,
};

let data = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (data) return data;
  try {
    data = { ...defaults, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    data = { ...defaults };
  }
  return data;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  save();
}

function getSecret(key) {
  const value = get(key);
  if (!value) return '';
  return safeStorage.decryptString(Buffer.from(value, 'base64'));
}

function setSecret(key, value) {
  set(key, safeStorage.encryptString(value).toString('base64'));
}

module.exports = { get, set, getSecret, setSecret };
