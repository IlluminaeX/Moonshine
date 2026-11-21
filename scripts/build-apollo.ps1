# Builds upstream/apollo (our `moonshine` branch) with MSYS2 UCRT64 into build/apollo.
# Usage: pwsh scripts/build-apollo.ps1 [-InstallDeps] [-Package] [-Drive M:]
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
        'git', 'mingw-w64-ucrt-x86_64-boost', 'mingw-w64-ucrt-x86_64-cmake', 'mingw-w64-ucrt-x86_64-ninja',
        'mingw-w64-ucrt-x86_64-cppwinrt', 'mingw-w64-ucrt-x86_64-curl-winssl', 'mingw-w64-ucrt-x86_64-MinHook',
        'mingw-w64-ucrt-x86_64-miniupnpc', 'mingw-w64-ucrt-x86_64-nodejs', 'mingw-w64-ucrt-x86_64-nsis',
        'mingw-w64-ucrt-x86_64-onevpl', 'mingw-w64-ucrt-x86_64-openssl', 'mingw-w64-ucrt-x86_64-opus',
        'mingw-w64-ucrt-x86_64-toolchain', 'mingw-w64-ucrt-x86_64-nlohmann_json'
    )
    Invoke-Ucrt "pacman -S --needed --noconfirm $($deps -join ' ')"
}

$realRoot = $root
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

# Apollo reads its version from git tags, which fails inside a submodule; pass it explicitly.
$versions = Get-Content (Join-Path $PSScriptRoot '..\versions.json') -Raw | ConvertFrom-Json
$env:BUILD_VERSION = $versions.apollo.tag -replace '^v', ''
# Apollo's build only honours BUILD_VERSION when BRANCH is set too (its CI convention).
$env:BRANCH = $versions.apollo.branch

$src = (Join-Path $root 'upstream\apollo') -replace '\\', '/'
$build = (Join-Path $root 'build\apollo') -replace '\\', '/'
# Vite resolves the subst drive back to the real path and then can't match its own
# module IDs, so the web UI is built here from the real path and CMake gets a no-op npm.
$npmStub = Join-Path $root 'scripts\npm-noop.cmd'
Invoke-Ucrt "cmake -B '$build' -G Ninja -S '$src' -DCMAKE_BUILD_TYPE=Release -DBUILD_DOCS=OFF -DBUILD_TESTS=OFF -DNPM='$npmStub'"

$realSrc = Join-Path $realRoot 'upstream\apollo'
$realBuild = Join-Path $realRoot 'build\apollo'
Push-Location $realSrc
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed for the Apollo web UI' }
    $env:SUNSHINE_SOURCE_ASSETS_DIR = Join-Path $realSrc 'src_assets'
    $env:SUNSHINE_ASSETS_DIR = $realBuild
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Apollo web UI build failed' }
} finally {
    Pop-Location
}

Invoke-Ucrt "ninja -C '$build'"

if ($Package) {
    Invoke-Ucrt "cd '$build' && cpack -G ZIP --config ./CPackConfig.cmake"
}
Write-Host "Apollo built in $build"
