// Drives the bundled Moonlight through its command line. Moonshine never shows
// Moonlight's own UI: it pairs, lists apps and streams through these commands.
const os = require('os');
const { execFile, spawn } = require('child_process');
const { moonlightExe } = require('./paths');

// Run from the home folder, never the player's own folder: a portable.dat next to the
// current directory would switch the player to a separate, portable settings store.
const spawnOptions = { cwd: os.homedir(), windowsHide: true };

// Extra environment for the player per host address (lib/tunnels.js: a direct connection's stand-in
// address needs its port shift passed along).
let hostEnv = () => ({});
function setHostEnv(fn) {
  hostEnv = fn;
}
function envFor(host) {
  const extra = hostEnv(host);
  return Object.keys(extra).length ? { ...process.env, ...extra } : undefined;
}

function run(args, timeoutMs, env) {
  return new Promise((resolve) => {
    execFile(moonlightExe, args, { ...spawnOptions, timeout: timeoutMs, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Split one line of Moonlight's CSV output ("quoted",plain,...). */
function parseCsvLine(line) {
  const fields = [];
  const re = /\s*("((?:[^"]|"")*)"|[^,]*)\s*(,|$)/g;
  let m;
  while ((m = re.exec(line)) && m[0] !== '') {
    fields.push(m[2] !== undefined ? m[2].replace(/""/g, '"') : m[1]);
    if (!m[3]) break;
  }
  return fields;
}

/**
 * List a host's apps. Only works once this PC is paired with the host, so it
 * doubles as the "are we paired?" check.
 * @returns {Promise<{id: number, name: string, hdr: boolean, boxArt: string}[]|null>}
 *          The apps, or null if not paired or unreachable.
 */
async function listApps(host) {
  const res = await run(['list', host, '--csv'], 20000, envFor(host));
  // The list is complete once it has been printed, even if the player was slow to exit afterwards.
  const lines = res.stdout.split(/\r?\n/);
  const header = lines.findIndex((line) => line.startsWith('Name, ID,'));
  if (header < 0) return null;
  return lines.slice(header + 1).filter(Boolean).map((line) => {
    const [name, id, hdr, , hidden, , boxArt] = parseCsvLine(line);
    return { name, id: Number(id), hdr: hdr === 'true', hidden: hidden === 'true', boxArt: boxArt || '' };
  }).filter((a) => a.name && !a.hidden);
}

/** Start pairing with a PIN that is entered on (or submitted to) the host. */
function pair(host, pin) {
  return spawn(moonlightExe, ['pair', host, '--pin', pin], { ...spawnOptions, env: envFor(host) });
}

/** Start a full-screen stream. Returns the Moonlight process; it exits when the stream ends. */
function stream(host, appName, extraArgs, env = {}) {
  return spawn(moonlightExe, ['stream', host, appName, ...extraArgs], { ...spawnOptions, windowsHide: false, env: { ...process.env, ...env, ...hostEnv(host) } });
}

/** Close whatever app is running on the host. */
async function quitApp(host) {
  return (await run(['quit', host], 20000, envFor(host))).ok;
}

module.exports = { listApps, pair, stream, quitApp, setHostEnv };
