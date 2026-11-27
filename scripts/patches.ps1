# Moonshine's changes to Apollo, Moonlight and Artemis (the Android app) live in patches/ as plain patch
# files, on top of the official versions the submodules point at (no forks needed).
#
#   pwsh scripts/patches.ps1 save    Write patches/ from the changes in upstream/ (run after editing them)
#   pwsh scripts/patches.ps1 apply   Apply patches/ to fresh official sources (the build scripts do this)
#
# "apply" is safe to run any time: a patch that is already applied is left alone.
param([Parameter(Mandatory)][ValidateSet('save', 'apply')][string]$Action)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$patchDir = Join-Path $root 'patches'
$targets = @(
    @{ Name = 'apollo'; Dir = 'upstream\apollo' },
    @{ Name = 'moonlight-qt'; Dir = 'upstream\moonlight-qt' },
    @{ Name = 'moonlight-common-c'; Dir = 'upstream\moonlight-qt\moonlight-common-c\moonlight-common-c' },
    @{ Name = 'moonlight-android'; Dir = 'upstream\moonlight-android' }
)

function Invoke-Git([string]$dir, [string[]]$gitArgs) {
    $out = & git -C $dir @gitArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($gitArgs -join ' ') failed in ${dir}:`n$out" }
    return $out
}

# Official sources missing (fresh clone): fetch them, including Moonlight's own submodules
if (-not (Test-Path (Join-Path $root 'upstream\apollo\CMakeLists.txt')) -or
    -not (Test-Path (Join-Path $root 'upstream\moonlight-qt\moonlight-common-c\moonlight-common-c\src')) -or
    -not (Test-Path (Join-Path $root 'upstream\moonlight-android\app\src\main\jni\moonlight-core\moonlight-common-c\src'))) {
    if ($Action -eq 'save') { throw 'upstream/ is missing, so there are no changes to save.' }
    Write-Host 'Fetching the official Apollo, Moonlight and Artemis sources...'
    Invoke-Git $root @('submodule', 'update', '--init', '--recursive') | Out-Null
}

New-Item -ItemType Directory -Force $patchDir | Out-Null
foreach ($t in $targets) {
    $dir = Join-Path $root $t.Dir
    $patch = Join-Path $patchDir "$($t.Name).patch"
    if ($Action -eq 'save') {
        # New files count too: mark them for the diff without staging their contents
        $new = Invoke-Git $dir @('ls-files', '--others', '--exclude-standard')
        if ($new) { Invoke-Git $dir (@('add', '--intent-to-add', '--') + @($new)) | Out-Null }
        # git writes the file itself, so line endings and non-ASCII text stay byte-for-byte
        & git -C $dir diff --binary --ignore-submodules=all "--output=$patch" HEAD
        if ($LASTEXITCODE -ne 0) { throw "git diff failed in $dir" }
        $files = (Select-String -Path $patch -Pattern '^diff --git ' -CaseSensitive).Count
        Write-Host "Saved $($t.Name): $files files changed (base $((Invoke-Git $dir @('rev-parse', '--short', 'HEAD'))))"
    } else {
        if (-not (Test-Path $patch)) { throw "Missing $patch" }
        & git -C $dir apply --check --reverse --whitespace=nowarn $patch 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "$($t.Name): already applied"; continue }
        & git -C $dir apply --check --whitespace=nowarn $patch 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "$($t.Name).patch doesn't apply to $($t.Dir). Is that folder at the version Moonshine pins (git submodule update)? Or does it have other changes?"
        }
        Invoke-Git $dir @('apply', '--whitespace=nowarn', $patch) | Out-Null
        Write-Host "$($t.Name): applied"
    }
}
