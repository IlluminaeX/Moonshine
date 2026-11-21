# Stages Moonshine (Electron app + stream player) and the host engine into dist/stage,
# then builds dist/Moonshine-Setup.exe with NSIS.
# Prerequisites: scripts/build-apollo.ps1 -Package, `npm install` in app/, and a stream player:
# scripts/build-moonlight.ps1 -Package (Moonshine's build) or scripts/fetch-moonlight.ps1 (official release).
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null

# Moonshine: the Electron runtime renamed to Moonshine.exe, with our code in resources\app.
$moonshine = Join-Path $stage 'moonshine'
Copy-Item -Recurse (Join-Path $root 'app\node_modules\electron\dist') $moonshine
Rename-Item (Join-Path $moonshine 'electron.exe') 'Moonshine.exe'
Remove-Item (Join-Path $moonshine 'resources\default_app.asar') -ErrorAction SilentlyContinue
# Moonshine is English-only, so keep only Chromium's English texts (about 40 MB less); other
# Windows languages fall back to English for the few built-in texts such as the right-click menu.
Get-ChildItem (Join-Path $moonshine 'locales') -Filter '*.pak' | Where-Object Name -ne 'en-US.pak' | Remove-Item

# Give Moonshine.exe its own icon and name, so shortcuts, the taskbar and Task Manager don't show Electron's.
$version = (Get-Content (Join-Path $root 'app\package.json') -Raw | ConvertFrom-Json).version
& (Join-Path $root 'app\node_modules\rcedit\bin\rcedit-x64.exe') (Join-Path $moonshine 'Moonshine.exe') `
    --set-icon (Join-Path $root 'app\assets\moonshine.ico') `
    --set-file-version $version --set-product-version $version `
    --set-version-string ProductName 'Moonshine' `
    --set-version-string FileDescription 'Moonshine' `
    --set-version-string CompanyName 'Moonshine' `
    --set-version-string OriginalFilename 'Moonshine.exe' `
    --set-version-string InternalName 'Moonshine' `
    --set-version-string LegalCopyright 'GPL-3.0'
if ($LASTEXITCODE -ne 0) { throw 'rcedit failed' }

$appOut = Join-Path $moonshine 'resources\app'
New-Item -ItemType Directory -Force $appOut | Out-Null
foreach ($item in 'package.json', 'package-lock.json', 'main.js', 'preload.js', 'prompt-preload.js', 'lib', 'renderer', 'assets') {
    Copy-Item -Recurse (Join-Path $root "app\$item") $appOut
}
# Runtime dependencies only (Electron itself is the runtime, so it's left out).
Push-Location $appOut
try {
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed for the Moonshine app' }
} finally {
    Pop-Location
}

# The stream player: Moonshine's own Moonlight build (build-moonlight.ps1 -Package) when there is one,
# otherwise the official release from fetch-moonlight.ps1.
$moonlight = Join-Path $moonshine 'moonlight'
$ownPlayer = Join-Path $root 'build\moonlight\dist'
if (Test-Path (Join-Path $ownPlayer 'Moonlight.exe')) {
    Write-Host 'Stream player: Moonshine build (build\moonlight\dist)'
    Copy-Item -Recurse $ownPlayer $moonlight
} else {
    Write-Host 'Stream player: official Moonlight release (vendor\moonlight)'
    Copy-Item -Recurse (Join-Path $root 'vendor\moonlight') $moonlight
}
# Installed system-wide it must not run in portable mode (Program Files isn't writable).
Remove-Item (Join-Path $moonlight 'portable.dat') -ErrorAction SilentlyContinue

# Apollo: the cpack ZIP from build-apollo.ps1 -Package.
$zip = Get-ChildItem (Join-Path $root 'build\apollo\cpack_artifacts') -Filter '*.zip' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $zip) { throw 'No Apollo package found. Run scripts/build-apollo.ps1 -Package first.' }
$apollo = Join-Path $stage 'apollo'
Expand-Archive $zip.FullName -DestinationPath $apollo
$items = Get-ChildItem $apollo
if ($items.Count -eq 1 -and $items[0].PSIsContainer) {
    Get-ChildItem $items[0].FullName | Move-Item -Destination $apollo
    Remove-Item $items[0].FullName
}

# Licences ship with the installer.
Copy-Item -Recurse (Join-Path $root 'LICENSES') (Join-Path $moonshine 'LICENSES')

$makensis = @('C:\msys64\ucrt64\bin\makensis.exe', 'C:\Program Files (x86)\NSIS\makensis.exe') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) { throw 'makensis not found (install mingw-w64-ucrt-x86_64-nsis or NSIS)' }
& $makensis "/DVERSION=$version" "/DSTAGE=$stage" "/DOUTFILE=$(Join-Path $dist 'Moonshine-Setup.exe')" `
    (Join-Path $root 'installer\moonshine.nsi')
if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
Write-Host "Built $(Join-Path $dist 'Moonshine-Setup.exe')"
