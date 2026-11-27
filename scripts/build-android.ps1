# Builds Moonshine for Android (upstream/moonlight-android with patches/moonlight-android.patch) into
# dist\Moonshine-Android.apk, signed with Moonshine's Android release key.
#
#   pwsh scripts/build-android.ps1              signed release APK
#   pwsh scripts/build-android.ps1 -Debug       debug APK (installs as "Moonshine (Debug)" next to the real one)
#   pwsh scripts/build-android.ps1 -Test        also run Moonshine's unit tests (the tunnel one needs node)
#   pwsh scripts/build-android.ps1 -Install     also install it on the phone plugged in over USB (adb)
#
# Needs JDK 17 and the Android SDK with NDK 27.0.12077973, platform 36 and build-tools 36 (see README).
# The release key is made on first use in %USERPROFILE%\.moonshine-release\ (never in the repo). Back it
# up: Android only installs an update signed with the same key, so without it people would have to
# uninstall Moonshine (losing its paired PCs) to get a new version.
param([switch]$Debug, [switch]$Test, [switch]$Install, [string]$Drive = 'M:')
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$keyDir = Join-Path $env:USERPROFILE '.moonshine-release'
$signing = if ($env:MOONSHINE_ANDROID_SIGNING) { $env:MOONSHINE_ANDROID_SIGNING } else { Join-Path $keyDir 'android-signing.properties' }

# ---- Tools ----
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $jdk = Get-ChildItem 'C:\Program Files\Microsoft', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java' -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^jdk-?17' } | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) { throw 'JDK 17 not found. Install it (winget install Microsoft.OpenJDK.17) or set JAVA_HOME.' }
    $env:JAVA_HOME = $jdk.FullName
}
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path (Join-Path $sdk 'ndk\27.0.12077973'))) { throw "Android SDK with NDK 27.0.12077973 not found at $sdk. See README (Building for Android)." }
$env:ANDROID_HOME = $sdk
$buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
# A stray quote mark in PATH (Windows keeps it as typed) breaks how Gradle starts the test runner; this
# copy of PATH is only for this build
$env:PATH = $env:PATH -replace '"', ''

# ---- Sources ----
& (Join-Path $PSScriptRoot 'patches.ps1') apply
if ($LASTEXITCODE) { throw 'Applying the patches failed' }

# ---- Release key (first time only) ----
if (-not $Debug -and -not (Test-Path $signing)) {
    New-Item -ItemType Directory -Force (Split-Path $signing) | Out-Null
    $store = Join-Path (Split-Path $signing) 'android-release.jks'
    if (Test-Path $store) { throw "$store exists but $signing doesn't. Restore android-signing.properties from your backup." }
    $bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $password = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
    & $keytool -genkeypair -keystore $store -storetype PKCS12 -alias moonshine -keyalg RSA -keysize 4096 -validity 36500 `
        -storepass $password -keypass $password -dname 'CN=Moonshine, O=Moonshine' 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw 'Making the Android release key failed' }
    $props = "storeFile=$($store -replace '\\', '/')`nstorePassword=$password`nkeyAlias=moonshine`nkeyPassword=$password`n"
    [IO.File]::WriteAllText($signing, $props, [Text.UTF8Encoding]::new($false))
    Write-Host "New Android release key: $store (password in $signing). Back both up; never commit them." -ForegroundColor Yellow
}

# ---- Build ----
# The NDK's build tools break on paths with spaces, so build through a drive letter.
$src = Join-Path $root 'upstream\moonlight-android'
if ($root -match ' ') {
    $existing = (subst) | Where-Object { $_ -like "${Drive}\: => $root" }
    if (-not $existing) {
        if (Test-Path "${Drive}\") { throw "Drive $Drive is in use; pass -Drive with a free letter" }
        subst $Drive $root
    }
    $src = "$Drive\upstream\moonlight-android"
}
[IO.File]::WriteAllText((Join-Path $src 'local.properties'), "sdk.dir=$($sdk -replace '\\', '/' -replace ':', '\:')`n")

$variant = if ($Debug) { 'Debug' } else { 'Release' }
$tasks = @("assembleNonRoot_game$variant")
# Moonshine's own tests (five of Artemis's v20.2.6 tests already fail upstream, so those aren't run here)
if ($Test) { $tasks += @("testNonRoot_game${variant}UnitTest", '--tests', 'com.moonshine.*') }
Push-Location $src
try {
    & .\gradlew.bat --no-daemon @tasks
    if ($LASTEXITCODE) { throw 'The Android build failed' }
} finally { Pop-Location }

$outDir = Join-Path $src "app\build\outputs\apk\nonRoot_game\$($variant.ToLower())"
$apk = Get-ChildItem $outDir -Filter '*.apk' | Where-Object { $_.Name -notmatch 'unsigned' } | Select-Object -First 1
if (-not $apk) { throw "No signed APK in $outDir (is the release key set up?)" }

# Check the signature before handing it out
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$certs = & $apksigner verify --print-certs $apk.FullName 2>&1
if ($LASTEXITCODE) { throw "The APK's signature doesn't verify:`n$certs" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$name = if ($Debug) { 'Moonshine-Android-debug.apk' } else { 'Moonshine-Android.apk' }
Copy-Item $apk.FullName (Join-Path $dist $name) -Force
$sha = (Get-FileHash (Join-Path $dist $name) -Algorithm SHA256).Hash.ToLower()
Write-Host "Built dist\$name ($([math]::Round($apk.Length / 1MB, 1)) MB, sha256 $sha)"
($certs | Select-String 'certificate SHA-256 digest') | ForEach-Object { Write-Host "Signed by: $($_.Line.Split(':')[-1].Trim())" }

if ($Install) {
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    & $adb install -r (Join-Path $dist $name)
    if ($LASTEXITCODE) { throw 'adb install failed (is the phone plugged in with USB debugging on?)' }
}
