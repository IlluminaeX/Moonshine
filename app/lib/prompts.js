// Small always-on-top Moonshine windows that ask this PC's user about a device:
// allow a stream, accept a pairing, or type a pairing PIN. One is shown at a time.
const path = require('path');
const { BrowserWindow, ipcMain, screen, shell } = require('electron');

const WIDTH = 420;
const MARGIN = 16;

const queue = []; // { spec, resolve }
let current = null; // { spec, resolve, win }

function finish(result) {
  if (!current) return;
  const { resolve, win } = current;
  current = null;
  resolve(result);
  if (!win.isDestroyed()) win.destroy();
  showNext();
}

function showNext() {
  if (current || !queue.length) return;
  const { spec, resolve } = queue.shift();
  const height = 236 + (spec.checkbox ? 30 : 0) + (spec.pin ? 96 : 0);
  // On the screen being looked at (where the mouse is), so it shows up next to a game on a second monitor
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    width: WIDTH,
    height,
    x: area.x + area.width - WIDTH - MARGIN,
    y: area.y + area.height - height - MARGIN,
    frame: false,
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: !!spec.pin, // a notice never takes the keyboard from a game; a PIN has to be typed
    show: false,
    title: 'Moonshine',
    icon: path.join(__dirname, '..', 'assets', 'moonshine.png'),
    backgroundColor: '#19131f',
    webPreferences: { preload: path.join(__dirname, '..', 'prompt-preload.js'), autoplayPolicy: 'no-user-gesture-required' },
  });
  win.setAlwaysOnTop(true, "screen-saver"); // above full-screen apps, not just above other windows
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  current = { spec, resolve, win };
  win.on('closed', () => {
    if (current && current.win === win) finish({ ok: false });
  });
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('prompt:show', spec);
    // A PIN has to be typed, so that prompt takes focus; the others must not steal a keypress.
    if (spec.pin) win.show();
    else win.showInactive();
    win.moveTop();
    win.flashFrame(true);
    // A full-screen app can pull itself back to the front; keep reclaiming the top while this is up
    const keepOnTop = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(keepOnTop); return; }
      win.setAlwaysOnTop(true, "screen-saver");
      win.moveTop();
    }, 1000);
    win.once("closed", () => clearInterval(keepOnTop));
    if (!spec.sound) shell.beep(); // a prompt with its own sound plays it itself ('none': silent)
    // A notice that goes away by itself: count from when it's on screen, not from when it was queued
    if (spec.timeoutMs) {
      setTimeout(() => {
        if (current && current.win === win) finish({ ok: false, cancelled: true, timedOut: true });
      }, spec.timeoutMs);
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'prompt.html'));
}

ipcMain.handle('prompt:respond', (event, result) => {
  if (current && event.sender === current.win.webContents) finish(result);
});

/**
 * Ask the user something.
 * @param {object} spec
 * @param {string} spec.key Identifies the prompt for cancel().
 * @param {string} spec.title
 * @param {string[]} spec.details Lines under the title.
 * @param {string} spec.accept Label of the main button.
 * @param {string} spec.decline Label of the other button.
 * @param {string} [spec.checkbox] Label of an optional tick-box.
 * @param {boolean} [spec.pin] Ask for a 4-digit PIN and a device name (`spec.name` is the default).
 * @param {boolean} [spec.danger] Show the second button in red (e.g. Kick).
 * @param {string} [spec.sound] A sound id (renderer/sounds.js) to play instead of the system beep; 'none' for silence.
 * @param {number} [spec.timeoutMs] Close by itself this long after showing (resolves as cancelled).
 * @returns {Promise<{ok: boolean, declined?: boolean, cancelled?: boolean, checked?: boolean, pin?: string, name?: string}>}
 *   declined: the second button was clicked (not just the window closed).
 */
function ask(spec) {
  return new Promise((resolve) => {
    queue.push({ spec, resolve });
    showNext();
  });
}

/** Withdraw a prompt whose request went away (it timed out, or the device gave up). */
function cancel(key) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].spec.key === key) queue.splice(i, 1)[0].resolve({ ok: false, cancelled: true });
  }
  if (current && current.spec.key === key) finish({ ok: false, cancelled: true });
}

module.exports = { ask, cancel };
