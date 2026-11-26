// Beta features: new things that work but haven't had much real-world use yet. Each one is off until
// turned on in the Beta tab, and the app behaves as it always did while it is off.
const store = require('./store');

const features = [
  {
    id: 'adaptiveBitrate',
    name: 'Auto-tuned quality',
    description: 'While you stream, the PC you’re watching lowers the video quality a step when your connection can’t keep up, and raises it again after a calm stretch, so the picture stays smooth instead of stuttering. It never goes above the bitrate you chose in Settings, and every change causes a brief hitch, so it holds off for a few seconds between changes. Needs the other PC to run this version of Moonshine too.',
  },
];

const state = () => store.get('beta') || {};
const isOn = (id) => state()[id] === true;

/** Every beta feature with whether it is on. */
function list() {
  return features.map((f) => ({ ...f, on: isOn(f.id) }));
}

function set(id, on) {
  if (!features.some((f) => f.id === id)) throw new Error('Unknown beta feature.');
  store.set('beta', { ...state(), [id]: Boolean(on) });
}

module.exports = { list, set, isOn };
