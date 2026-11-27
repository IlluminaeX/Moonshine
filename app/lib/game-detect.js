// Which game is being played on this PC right now, so friends see "Playing Elden Ring" and not "Playing the desktop".
// Everything is read locally (Steam's running-game entry and the window in front), nothing is sent anywhere here.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Windows that are never the game
const NOT_GAMES = /^(explorer|applicationframehost|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|lockapp|textinputhost|systemsettings|taskmgr|dwm|sihost|moonshine|electron|sunshine|apollo|sunshinesvc|steamwebhelper|steam|epicgameslauncher|galaxyclient|battle\.net|launcher|chrome|msedge|firefox|brave|opera|vlc|mpv|discord|spotify|code|cmd|powershell|pwsh|windowsterminal|notepad|mmc|msiexec)$/i;
// Folders games are installed in, and where in the path the game's own folder name sits
const GAME_DIRS = [
  /\\steamapps\\common\\([^\\]+)\\/i,
  /\\Epic Games\\([^\\]+)\\/i,
  /\\GOG Games\\([^\\]+)\\/i,
  /\\GOG Galaxy\\Games\\([^\\]+)\\/i,
  /\\Riot Games\\([^\\]+)\\/i,
  /\\XboxGames\\([^\\]+)\\/i,
];

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MsWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$steam = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').RunningAppID
$steamPath = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath
$h = [MsWin]::GetForegroundWindow()
$fgPid = 0; [void][MsWin]::GetWindowThreadProcessId($h, [ref]$fgPid)
$p = Get-Process -Id $fgPid
$gog = @(Get-ChildItem 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games' | ForEach-Object { $k = Get-ItemProperty $_.PSPath; [pscustomobject]@{ name = $k.gameName; path = $k.path } })
[pscustomobject]@{
  steamAppId = [int64]$steam; steamPath = $steamPath
  process = $p.ProcessName; path = $p.Path; title = $p.MainWindowTitle
  description = $p.MainModule.FileVersionInfo.FileDescription; product = $p.MainModule.FileVersionInfo.ProductName
  gog = $gog
} | ConvertTo-Json -Compress -Depth 4
`;

/** Steam's library folders, from its libraryfolders.vdf. */
function steamLibraries(steamPath) {
  const out = [];
  if (!steamPath) return out;
  const root = path.normalize(steamPath);
  out.push(root);
  try {
    const text = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) out.push(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch { /* no extra libraries */ }
  return [...new Set(out)];
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const norm = (p) => path.normalize(String(p || '').replace(/^"+|"+$/g, '')).toLowerCase();
const inside = (file, dir) => {
  const d = norm(dir).replace(/[\\/]+$/, '');
  return d.length > 3 && norm(file).startsWith(d + path.sep);
};

/** A Steam game's name from its install manifest ('' if it isn't installed from Steam, e.g. a shortcut, or the shared test id 480). */
function steamGameName(appId, steamPath) {
  if (!appId || appId <= 0 || appId === 480) return '';
  for (const lib of steamLibraries(steamPath)) {
    try {
      const text = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`), 'utf8');
      const m = /"name"\s+"([^"]+)"/.exec(text);
      if (m) return m[1];
    } catch { /* not in this library */ }
  }
  return '';
}

/** The Steam game whose install folder holds this program, by name from its manifest (any library). */
function steamGameByFolder(exePath, steamPath) {
  for (const lib of steamLibraries(steamPath)) {
    const common = path.join(lib, 'steamapps', 'common');
    if (!inside(exePath, common)) continue;
    const dir = norm(exePath).slice(norm(common).length + 1).split(path.sep)[0];
    try {
      for (const f of fs.readdirSync(path.join(lib, 'steamapps'))) {
        if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
        const text = fs.readFileSync(path.join(lib, 'steamapps', f), 'utf8');
        const inst = /"installdir"\s+"([^"]+)"/.exec(text);
        const name = /"name"\s+"([^"]+)"/.exec(text);
        if (inst && name && inst[1].toLowerCase() === dir) return name[1];
      }
    } catch { /* unreadable library */ }
  }
  return '';
}

/** Games added to Steam by hand ("Add a Non-Steam Game"): [{name, exe}] from every Steam user's shortcuts.vdf. */
function steamShortcuts(steamPath) {
  const out = [];
  if (!steamPath) return out;
  const users = path.join(path.normalize(steamPath), 'userdata');
  let ids = [];
  try { ids = fs.readdirSync(users); } catch { return out; }
  for (const id of ids) {
    let text;
    try { text = fs.readFileSync(path.join(users, id, 'config', 'shortcuts.vdf'), 'latin1'); } catch { continue; }
    let name = '';
    for (const m of text.matchAll(/\x01(appname|exe)\x00([^\x00]*)\x00/gi)) {
      const v = Buffer.from(m[2], 'latin1').toString('utf8');
      if (m[1].toLowerCase() === 'appname') name = v;
      else if (name) { out.push({ name, exe: v }); name = ''; }
    }
  }
  return out;
}

/** Epic Games Store installs: [{name, dir}] from the launcher's manifests. */
function epicGames() {
  const out = [];
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.item')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.DisplayName && j.InstallLocation) out.push({ name: j.DisplayName, dir: j.InstallLocation });
    } catch { /* skip */ }
  }
  return out;
}

const defaults = { steamGameName, steamGameByFolder, steamShortcuts, epicGames };

/** The game name from what was found, or '' when it doesn't look like a game. Never guesses from fullscreen. */
function pick(info, deps = {}) {
  if (!info) return '';
  const d = { ...defaults, ...(typeof deps === 'function' ? { steamGameName: deps } : deps) };
  const exePath = String(info.path || '');
  const proc = String(info.process || '');
  const appId = Number(info.steamAppId);
  // A game added to Steam by hand: matched by the program in front
  if (exePath) {
    const hit = d.steamShortcuts(info.steamPath).find((s) => norm(s.exe) === norm(exePath));
    if (hit) return clean(hit.name);
  }
  // Steam's own name, unless it is the shared test id (480) that online-fix games run as
  const fromSteam = d.steamGameName(appId, info.steamPath);
  if (fromSteam) return clean(fromSteam);
  if (!proc || NOT_GAMES.test(proc)) return '';
  if (exePath) {
    const byFolder = d.steamGameByFolder(exePath, info.steamPath);
    if (byFolder) return clean(byFolder);
    const epic = d.epicGames().find((g) => inside(exePath, g.dir));
    if (epic) return clean(epic.name);
    const gog = [].concat(info.gog || []).find((g) => g && g.path && g.name && inside(exePath, g.path));
    if (gog) return clean(gog.name);
    for (const re of GAME_DIRS) {
      const m = re.exec(exePath);
      if (m) return clean(m[1]);
    }
  }
  // Steam says a game is running (e.g. 480) and this is the window in front: the program's own name
  if (appId > 0) {
    const generic = /^(unity|unreal|application|launcher|game)$/i;
    return clean([String(info.product || '').trim(), String(info.description || '').trim(), info.title, proc].find((n) => n && !generic.test(n)) || '');
  }
  return '';
}

/** Run the check: resolves the game's name, or '' (Windows only). */
function detect() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve('');
        try {
          resolve(pick(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())));
        } catch {
          resolve('');
        }
      });
  });
}

module.exports = { detect, pick, steamGameName, steamLibraries, steamShortcuts, steamGameByFolder, epicGames, NOT_GAMES };
