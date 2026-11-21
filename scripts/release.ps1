# Publishes dist/Moonshine-Setup.exe as a GitHub release that Moonshine installs from inside the app.
#
#   pwsh scripts/release.ps1 -NewKey          once: make the update signing key (kept outside the repo)
#   pwsh scripts/release.ps1 [-Notes "..."]   sign the installer and publish it as v<app version>
#   pwsh scripts/release.ps1 -SignOnly        sign only (writes dist/Moonshine-Setup.exe.sig)
#
# Before a release: raise "version" in app/package.json, build (build-apollo, build-moonlight,
# package.ps1), and commit. The tag is v<that version>. Needs the GitHub CLI (gh), signed in.
#
# The private key lives in %USERPROFILE%\.moonshine-release\update-key.pem. Back it up somewhere
# safe: without it, the Moonshine apps already installed can't take another in-app update.
param([switch]$NewKey, [switch]$SignOnly, [string]$Notes = '', [string]$KeyFile = '')
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
if (-not $KeyFile) { $KeyFile = Join-Path $env:USERPROFILE '.moonshine-release\update-key.pem' }
$sign = Join-Path $PSScriptRoot 'sign-update.js'
$updater = Join-Path $root 'app\lib\updater.js'
$keyPattern = "const PUBLIC_KEY = '([^']*)';"

if ($NewKey) {
    New-Item -ItemType Directory -Force (Split-Path $KeyFile) | Out-Null
    $public = node $sign keygen $KeyFile
    if ($LASTEXITCODE -ne 0) { throw 'Making the key failed' }
    $code = [IO.File]::ReadAllText($updater)
    $code = [regex]::Replace($code, $keyPattern, "const PUBLIC_KEY = '$public';")
    [IO.File]::WriteAllText($updater, $code, [Text.UTF8Encoding]::new($false))
    Write-Host "New signing key: $KeyFile (back it up; never commit it)"
    Write-Host "Its public half is now in app/lib/updater.js."
    return
}

if (-not (Test-Path $KeyFile)) { throw "No signing key at $KeyFile. Run with -NewKey first (only once)." }
# The app must carry this key's public half, or nobody could install what we publish.
$public = node $sign public $KeyFile
$embedded = [regex]::Match([IO.File]::ReadAllText($updater), $keyPattern).Groups[1].Value
if ($public -ne $embedded) { throw 'app/lib/updater.js has a different public key than the signing key. Builds made from it would refuse this update.' }

$version = (Get-Content (Join-Path $root 'app\package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $root 'dist\Moonshine-Setup.exe'
if (-not (Test-Path $installer)) { throw 'dist/Moonshine-Setup.exe is missing. Run scripts/package.ps1 first.' }
# The installer records its version in the uninstall entry; make sure it was built from this version.
$built = (Get-Item $installer).LastWriteTime
$pkg = (Get-Item (Join-Path $root 'app\package.json')).LastWriteTime
if ($built -lt $pkg) { throw "dist/Moonshine-Setup.exe is older than app/package.json; rebuild it (scripts/package.ps1) so it is $version." }

node $sign sign $KeyFile $installer $version
if ($LASTEXITCODE -ne 0) { throw 'Signing failed' }
if ($SignOnly) { return }

$tag = "v$version"
& gh release view $tag 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists. Raise the version in app/package.json." }
if (-not $Notes) { $Notes = "Moonshine $version" }
gh release create $tag $installer "$installer.sig" --title "Moonshine $version" --notes $Notes
if ($LASTEXITCODE -ne 0) { throw 'gh release create failed' }
Write-Host "Published $tag. Installed copies of Moonshine will offer it within a few hours (or at once with Check for updates)."
