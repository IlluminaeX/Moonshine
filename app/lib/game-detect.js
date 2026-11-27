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
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MsWin {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
}
'@
$steam = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').RunningAppID
$steamPath = (Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath
$h = [MsWin]::GetForegroundWindow()
$fgPid = 0; [void][MsWin]::GetWindowThreadProcessId($h, [ref]$fgPid)
$p = Get-Process -Id $fgPid
$r = New-Object MsWin+R; [void][MsWin]::GetWindowRect($h, [ref]$r)
$b = [System.Windows.Forms.Screen]::FromHandle($h).Bounds
$full = ($r.L -le $b.Left) -and ($r.T -le $b.Top) -and ($r.Rt -ge $b.Right) -and ($r.B -ge $b.Bottom)
[pscustomobject]@{
  steamAppId = [int64]$steam; steamPath = $steamPath
  process = $p.ProcessName; path = $p.Path; title = $p.MainWindowTitle
  description = $p.MainModule.FileVersionInfo.FileDescription; product = $p.MainModule.FileVersionInfo.ProductName
  fullscreen = [bool]$full
} | ConvertTo-Json -Compress
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

/** A Steam game's name from its install manifest ('' if it isn't installed from Steam, e.g. a shortcut). */
function steamGameName(appId, steamPath) {
  if (!appId || appId <= 0) return '';
  for (const lib of steamLibraries(steamPath)) {
    try {
      const text = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`), 'utf8');
      const m = /"name"\s+"([^"]+)"/.exec(text);
      if (m) return m[1];
    } catch { /* not in this library */ }
  }
  return '';
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** The game name from what was found, or '' when it doesn't look like a game. */
function pick(info, lookupSteam = steamGameName) {
  if (!info) return '';
  const fromSteam = lookupSteam(Number(info.steamAppId), info.steamPath);
  if (fromSteam) return clean(fromSteam);
  const proc = String(info.process || '');
  if (!proc || NOT_GAMES.test(proc)) return '';
  const exePath = String(info.path || '');
  for (const re of GAME_DIRS) {
    const m = re.exec(exePath);
    if (m) return clean(m[1]);
  }
  if (!info.fullscreen) return '';
  // Something fullscreen that isn't a known non-game: its own name for itself, else the window title
  const desc = String(info.description || '').trim();
  const product = String(info.product || '').trim();
  const generic = /^(unity|unreal|application|launcher|game)$/i;
  return clean([product, desc, info.title, proc].find((n) => n && !generic.test(n)) || '');
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

module.exports = { detect, pick, steamGameName, steamLibraries, NOT_GAMES };
