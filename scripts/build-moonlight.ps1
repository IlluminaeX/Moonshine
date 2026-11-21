# Builds upstream/moonlight-qt (our `moonshine` branch: MinGW support and Moonshine branding) with
# MSYS2 UCRT64 into build/moonlight, and with -Package collects a runnable copy in build/moonlight/dist.
# Usage: pwsh scripts/build-moonlight.ps1 [-InstallDeps] [-Package] [-Drive M:]
param([switch]$InstallDeps, [switch]$Package, [string]$Drive = 'M:')
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$msys = if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' }
$bash = Join-Path $msys 'usr\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "MSYS2 not found at $msys (set MSYS2_ROOT)" }

function Invoke-Ucrt([string]$cmd) {
    $env:MSYSTEM = 'UCRT64'
    $env:CHERE_INVOKING = '1'
    & $bash -lc $cmd
    if ($LASTEXITCODE -ne 0) { throw "MSYS2 command failed ($LASTEXITCODE): $cmd" }
}

if ($InstallDeps) {
    $deps = @(
        'mingw-w64-ucrt-x86_64-toolchain', 'mingw-w64-ucrt-x86_64-qt6-base', 'mingw-w64-ucrt-x86_64-qt6-declarative',
        'mingw-w64-ucrt-x86_64-qt6-svg', 'mingw-w64-ucrt-x86_64-qt6-tools', 'mingw-w64-ucrt-x86_64-SDL2',
        'mingw-w64-ucrt-x86_64-SDL2_ttf', 'mingw-w64-ucrt-x86_64-ffmpeg', 'mingw-w64-ucrt-x86_64-libplacebo',
        'mingw-w64-ucrt-x86_64-openssl', 'mingw-w64-ucrt-x86_64-opus', 'mingw-w64-ucrt-x86_64-ntldd'
    )
    Invoke-Ucrt "pacman -S --needed --noconfirm $($deps -join ' ')"
}

# Our changes to the official sources live in patches/; put them in place (skipped if already there).
& (Join-Path $PSScriptRoot "patches.ps1") apply

# windres breaks on paths with spaces or '~' (8.3 names), so build through a subst drive.
if ($root -match '[ ~]') {
    $existing = (subst) | Where-Object { $_ -like "${Drive}\: => $root" }
    if (-not $existing) {
        if (Test-Path "${Drive}\") { throw "Drive $Drive is in use; pass -Drive with a free letter" }
        subst $Drive $root
    }
    $root = "$Drive\"
}

$src = (Join-Path $root 'upstream\moonlight-qt') -replace '\\', '/'
$build = (Join-Path $root 'build\moonlight') -replace '\\', '/'
Invoke-Ucrt "mkdir -p '$build' && cd '$build' && qmake6 '$src/moonlight-qt.pro' CONFIG+=release && mingw32-make -j`$(nproc) release"

if ($Package) {
    # A self-contained folder: the player, Qt's runtime and QML modules, and every MSYS2 DLL it loads.
    $collect = (Join-Path $root 'scripts\collect-moonlight.sh') -replace '\\', '/'
    Invoke-Ucrt "bash '$collect' '$src' '$build'"
}
Write-Host "Moonlight built in $build"
