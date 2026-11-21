// Stream settings Moonshine shows in its Settings tab, turned into Moonlight CLI flags.
const store = require('./store');

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
  audioOnHost: false,
  overlayMode: 'off', // performance stats: off, compact or full
  overlayCorner: 'top-left',
  overlayOpacity: 100,
  gameOptimization: true,
  muteOnFocusLoss: false,
  quitAfter: false,
};

// Setting name -> Moonlight toggle flag (passed as --flag or --no-flag).
const toggles = {
  hdr: 'hdr',
  vsync: 'vsync',
  framePacing: 'frame-pacing',
  audioOnHost: 'audio-on-host',
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

function toArgs(s = get()) {
  const args = [];
  if (/^\d+x\d+$/.test(s.resolution)) args.push('--resolution', s.resolution);
  if (/^\d+$/.test(String(s.fps))) args.push('--fps', String(s.fps));
  if (s.bitrateMbps > 0) args.push('--bitrate', String(Math.round(s.bitrateMbps * 1000)));
  args.push('--display-mode', s.displayMode, '--video-codec', s.videoCodec, '--audio-config', s.audioConfig);
  for (const [key, flag] of Object.entries(toggles)) {
    args.push(s[key] ? `--${flag}` : `--no-${flag}`);
  }
  args.push(s.overlayMode === 'off' ? '--no-performance-overlay' : '--performance-overlay');
  return args;
}

// How the player draws the stats (read by Moonshine's player when it starts)
function toEnv(s = get()) {
  return {
    MOONSHINE_OVERLAY_MODE: s.overlayMode === 'compact' ? 'compact' : 'full',
    MOONSHINE_OVERLAY_CORNER: s.overlayCorner,
    MOONSHINE_OVERLAY_OPACITY: String(s.overlayOpacity),
  };
}

module.exports = { get, set, toArgs, toEnv };
