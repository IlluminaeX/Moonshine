// In-app updates from Moonshine's GitHub releases.
//
// A release is tagged vX.Y.Z and carries the installer, Moonshine-Setup.exe, and its signature:
// JSON { version, sha256, signature }, an Ed25519 signature over
// "moonshine-update-v1:<version>:<sha256>" made by scripts/release.ps1 with a private key that never
// leaves the publisher's PC. The signature sits in the release notes as a hidden HTML comment,
// <!-- moonshine-update-sig: <base64 of the JSON> -->, which GitHub doesn't show on the page.
// Releases up to 0.3.3 also attached it as Moonshine-Setup.exe.sig (what 0.3.2 and older look for);
// that file is still used when the notes have none.
// Moonshine only installs a download whose hash and signature check out against the public key
// below and whose signed version is newer than its own, so a tampered or old installer is refused
// even if someone got hold of the GitHub account.
//
// Installing: a small PowerShell helper (not elevated) waits for Moonshine to quit, runs the
// installer silently behind a Windows admin prompt, then starts Moonshine again: the new version
// if it worked, the old one if the prompt was declined or the install failed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const REPO = 'IlluminaeX/Moonshine';
const RELEASES_URL = process.env.MOONSHINE_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = 'Moonshine-Setup.exe';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAKduWnNJU1yHWBfhZiGxcL8yCylYs3MOzvRszwPU85m4='; // Ed25519, SPKI DER in base64 (scripts/release.ps1 -NewKey)
const SIGNED_PREFIX = 'moonshine-update-v1';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;

const events = new EventEmitter();
let fetchImpl = null; // electron's net.fetch (uses Windows' proxy settings); plain fetch in tests
let currentVersion = '0.0.0';
let state = { status: 'idle' }; // idle | checking | current | available | downloading | ready | installing | error
let checkTimer = null;
let downloading = null;

function setState(next) {
  state = { ...next, current: currentVersion };
  events.emit('state', state);
}

/** "1.2.10" > "1.2.9". Pre-release tags ("1.3.0-beta") count as older than the release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function verifySignature(sig, sha256) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
    const message = Buffer.from(`${SIGNED_PREFIX}:${sig.version}:${sha256}`);
    return crypto.verify(null, message, key, Buffer.from(String(sig.signature || ''), 'base64'));
  } catch {
    return false;
  }
}

async function getJson(url) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Moonshine-updater' },
    cache: 'no-store',
  });
  if (res.status === 404) return null; // no release published yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

const SIG_COMMENT = /<!--\s*moonshine-update-sig:\s*([A-Za-z0-9+/=]+)\s*-->/;

/** The signature hidden in the release notes, or null. */
function sigFromNotes(body) {
  const m = SIG_COMMENT.exec(String(body || ''));
  if (!m) return null;
  try {
    const sig = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    return sig && typeof sig === 'object' ? sig : null;
  } catch {
    return null;
  }
}

/** Look for a newer release. Quiet failures when `background`; otherwise the error is shown. */
async function check({ background = false } = {}) {
  if (['downloading', 'ready', 'installing'].includes(state.status)) return state;
  const before = state;
  if (!background) setState({ status: 'checking' });
  try {
    const release = await getJson(RELEASES_URL);
    if (!release || release.draft || release.prerelease) {
      setState({ status: 'current', checkedAt: Date.now() });
      return state;
    }
    const version = String(release.tag_name || '').replace(/^v/, '');
    const installer = (release.assets || []).find((a) => a.name === ASSET);
    const sigAsset = (release.assets || []).find((a) => a.name === `${ASSET}.sig`);
    const sig = sigFromNotes(release.body);
    if (!version || !installer || (!sig && !sigAsset) || compareVersions(version, currentVersion) <= 0) {
      setState({ status: 'current', checkedAt: Date.now() });
      return state;
    }
    setState({
      status: 'available',
      version,
      notes: String(release.body || '').replace(SIG_COMMENT, '').trim().slice(0, 4000),
      size: installer.size || 0,
      url: installer.browser_download_url,
      sig,
      sigUrl: sig ? '' : sigAsset.browser_download_url,
      page: release.html_url || '',
    });
  } catch (err) {
    if (background) setState(before); // try again next time; nothing to show
    else setState({ status: 'error', message: `Couldn't check for updates: ${err.message}` });
  }
  return state;
}

async function downloadTo(url, file, total, onProgress) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'Moonshine-updater' }, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const size = Number(res.headers.get('content-length')) || total || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress(got, size);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest('hex');
}

/** Download and check the update found by check(). Resolves to the checked installer's path. */
function download() {
  if (downloading) return downloading;
  if (state.status === 'ready') return Promise.resolve(state.file);
  if (state.status !== 'available') return Promise.reject(new Error('No update to download.'));
  const offer = state;
  downloading = (async () => {
    const dir = path.join(os.tmpdir(), 'moonshine-update');
    fs.mkdirSync(dir, { recursive: true });
    for (const old of fs.readdirSync(dir)) fs.rmSync(path.join(dir, old), { force: true });
    const file = path.join(dir, `Moonshine-Setup-${offer.version}.exe`);
    try {
      setState({ ...offer, status: 'downloading', received: 0, total: offer.size });
      let sig = offer.sig;
      if (!sig) {
        const sigRes = await fetchImpl(offer.sigUrl, { headers: { 'User-Agent': 'Moonshine-updater' }, cache: 'no-store' });
        if (!sigRes.ok) throw new Error(`signature download failed (${sigRes.status})`);
        sig = JSON.parse(await sigRes.text());
      }
      let last = 0;
      const sha256 = await downloadTo(offer.url, file, offer.size, (received, total) => {
        if (Date.now() - last < 150 && received < total) return;
        last = Date.now();
        setState({ ...offer, status: 'downloading', received, total });
      });
      if (String(sig.sha256).toLowerCase() !== sha256) throw new Error('the download is damaged (its checksum doesn\'t match)');
      if (String(sig.version) !== offer.version) throw new Error('the signature is for a different version');
      if (!verifySignature(sig, sha256)) throw new Error('its signature is not Moonshine\'s');
      setState({ ...offer, status: 'ready', file });
      return file;
    } catch (err) {
      fs.rmSync(file, { force: true });
      setState({ ...offer, status: 'available', error: `The update couldn't be downloaded: ${err.message}. Try again later.` });
      throw err;
    } finally {
      downloading = null;
    }
  })();
  return downloading;
}

// Runs hidden and not elevated. Waits for Moonshine to close, installs behind a UAC prompt, and
// opens Moonshine again either way.
const HELPER = String.raw`
param([string]$Installer, [string]$App, [int]$AppPid, [string]$Log)
function Say($t) { Add-Content -Path $Log -Value "$(Get-Date -Format s) $t" }
Say "waiting for Moonshine to close"
try { Wait-Process -Id $AppPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
$code = -1
try {
  $p = Start-Process -FilePath $Installer -ArgumentList '/S' -Verb RunAs -PassThru -Wait
  $code = $p.ExitCode
  Say "installer finished with $code"
} catch {
  Say "install not started: $($_.Exception.Message)"
}
$result = if ($code -eq 0) { 'done' } elseif ($code -eq -1) { 'declined' } else { 'failed' }
Start-Process -FilePath $App -ArgumentList "--updated=$result"
`;

// Windows closes every process Moonshine starts when Moonshine quits (Electron keeps its child
// processes in a job that ends with it), so the helper is started by Windows itself instead (WMI's
// Win32_Process.Create): same user and desktop session, but not tied to Moonshine.
const LAUNCH = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MOONSHINE_HELPER }; '
  + 'if ($r.ReturnValue -ne 0) { Write-Error "Win32_Process.Create failed: $($r.ReturnValue)"; exit 1 }; $r.ProcessId';

function startOutsideMoonshine(commandLine) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LAUNCH], {
      windowsHide: true, timeout: 30000, env: { ...process.env, MOONSHINE_HELPER: commandLine },
    }, (err, stdout, stderr) => {
      const pid = parseInt(String(stdout).trim(), 10);
      if (err || !pid) reject(new Error(`the installer helper didn't start (${String(stderr || (err && err.message) || '').trim().slice(0, 200)})`));
      else resolve(pid);
    });
  });
}

/**
 * Close Moonshine and install the downloaded update. `quit` is called once the helper is running;
 * it must quit the app (the installer can't replace Moonshine's files while it runs). If the helper
 * can't be started, Moonshine stays open and this throws.
 */
async function install(quit, { appPath = process.execPath } = {}) {
  if (state.status !== 'ready' || !state.file || !fs.existsSync(state.file)) {
    throw new Error('The update isn\'t downloaded yet.');
  }
  const dir = path.dirname(state.file);
  const script = path.join(dir, 'install-update.ps1');
  const log = path.join(dir, 'update.log');
  fs.writeFileSync(script, HELPER);
  fs.rmSync(log, { force: true });
  const q = (s) => `"${s}"`; // none of these paths can contain a double quote
  await startOutsideMoonshine([
    'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', q(script), '-Installer', q(state.file), '-App', q(appPath), '-AppPid', String(process.pid), '-Log', q(log),
  ].join(' '));
  setState({ ...state, status: 'installing' });
  quit();
}

/** Start checking now and then (the first check shortly after startup). */
function init({ version, fetch }) {
  currentVersion = version;
  fetchImpl = fetch;
  state = { status: 'idle', current: version };
  clearInterval(checkTimer);
  setTimeout(() => check({ background: true }), FIRST_CHECK_MS);
  checkTimer = setInterval(() => check({ background: true }), CHECK_EVERY_MS);
}

module.exports = {
  init,
  check,
  download,
  install,
  getState: () => state,
  events,
  compareVersions,
  verifySignature,
  sigFromNotes,
  RELEASES_URL,
};
