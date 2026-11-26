// Stream settings Moonshine shows in its Settings tab, turned into Moonlight CLI flags.
const store = require('./store');
const beta = require('./beta');

const defaults = {
  resolution: '', // '' = Moonlight's default; otherwise "WIDTHxHEIGHT"
  fps: '',
  bitrateMbps: 0, // 0 = automatic for the resolution and frame rate
  displayMode: 'fullscreen',
  videoCodec: 'auto',
  audioConfig: 'stereo',
  hdr: false,
  vsync: true,
  framePacing: false,
  muteHostAudio: false, // false = the host PC plays the stream's audio too (the player's audio-on-host)
  overlayMode: 'off', // performance stats: off, compact or full
  overlayCorner: 'top-left',
  overlayOpacity: 100,
  gameOptimization: true,
  muteOnFocusLoss: false,
  quitAfter: false,
  virtualDisplay: false, // ask the host to stream from its own virtual display at this resolution, not its real monitor (read by the player: MOONSHINE_VIRTUAL_DISPLAY)
  autoReconnect: true, // Moonshine reconnects a dropped stream by itself (not a player flag)
};

// Setting name -> Moonlight toggle flag (passed as --flag or --no-flag).
const toggles = {
  hdr: 'hdr',
  vsync: 'vsync',
  framePacing: 'frame-pacing',
  gameOptimization: 'game-optimization',
  muteOnFocusLoss: 'mute-on-focus-loss',
  quitAfter: 'quit-after',
};

function get() {
  const saved = store.get('streamSettings') || {};
  // Older versions had an on/off checkbox for the stats
  if (!('overlayMode' in saved) && saved.performanceOverlay) saved.overlayMode = 'full';
  delete saved.performanceOverlay;
  return { ...defaults, ...saved };
}

function set(settings) {
  const clean = {};
  for (const key of Object.keys(defaults)) {
    if (key in settings) clean[key] = settings[key];
  }
  store.set('streamSettings', { ...get(), ...clean });
}

// Settings a single PC can override (the rest, like the stats overlay, are about you, not the PC).
const perHost = ['resolution', 'fps', 'bitrateMbps', 'displayMode', 'videoCodec', 'audioConfig', 'hdr', 'virtualDisplay'];

const hostKey = (host) => host.uuid || host.address;

/** What this PC overrides: { name, values }, or null when it follows the defaults. */
function overridesFor(key) {
  const all = store.get('hostStreamSettings') || {};
  return all[key] || null;
}

/** The settings to stream to this PC with: the defaults plus whatever it overrides. */
function getFor(host) {
  const o = host ? overridesFor(hostKey(host)) : null;
  return { ...get(), ...(o ? o.values : {}) };
}

/** Save the changed settings for one PC only. */
function setFor(key, name, settings) {
  const all = { ...(store.get('hostStreamSettings') || {}) };
  const current = all[key] || { name, values: {} };
  const values = { ...current.values };
  for (const k of perHost) if (k in settings) values[k] = settings[k];
  all[key] = { name: name || current.name, values };
  store.set('hostStreamSettings', all);
}

/** Make a PC follow the defaults again. With `field`, only that one setting. */
function resetFor(key, field) {
  const all = { ...(store.get('hostStreamSettings') || {}) };
  if (field && all[key]) {
    const values = { ...all[key].values };
    delete values[field];
    if (Object.keys(values).length) all[key] = { ...all[key], values };
    else delete all[key];
  } else {
    delete all[key];
  }
  store.set('hostStreamSettings', all);
}

function toArgs(s = get()) {
  const args = [];
  if (/^\d+x\d+$/.test(s.resolution)) args.push('--resolution', s.resolution);
  if (/^\d+$/.test(String(s.fps))) args.push('--fps', String(s.fps));
  if (s.bitrateMbps > 0) args.push('--bitrate', String(Math.round(s.bitrateMbps * 1000)));
  args.push('--display-mode', s.displayMode, '--video-codec', s.videoCodec, '--audio-config', s.audioConfig);
  for (const [key, flag] of Object.entries(toggles)) {
    args.push(s[key] ? `--${flag}` : `--no-${flag}`);
  }
  args.push(s.muteHostAudio ? '--no-audio-on-host' : '--audio-on-host');
  args.push(s.overlayMode === 'off' ? '--no-performance-overlay' : '--performance-overlay');
  return args;
}

// How the player draws the stats (read by Moonshine's player when it starts)
function toEnv(s = get()) {
  return {
    MOONSHINE_OVERLAY_MODE: s.overlayMode === 'compact' ? 'compact' : 'full',
    MOONSHINE_OVERLAY_CORNER: s.overlayCorner,
    MOONSHINE_OVERLAY_OPACITY: String(s.overlayOpacity),
    ...(s.virtualDisplay ? { MOONSHINE_VIRTUAL_DISPLAY: '1' } : {}),
    // Beta: the host lowers and raises this stream's bitrate by itself as the connection allows
    ...(beta.isOn('adaptiveBitrate') ? { MOONSHINE_ADAPTIVE_BITRATE: '1' } : {}),
  };
}

module.exports = { get, set, getFor, overridesFor, setFor, resetFor, hostKey, perHost, toArgs, toEnv };
