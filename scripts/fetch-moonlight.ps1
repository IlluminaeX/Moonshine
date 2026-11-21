# Downloads the pinned Moonlight portable release into vendor/moonlight and verifies its SHA256.
# Usage: pwsh scripts/fetch-moonlight.ps1 [-UpdateHash]
param([switch]$UpdateHash)
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$versionsPath = Join-Path $root 'versions.json'
$versions = Get-Content $versionsPath -Raw | ConvertFrom-Json
$ml = $versions.moonlight

$vendor = Join-Path $root 'vendor'
$dest = Join-Path $vendor 'moonlight'
$zip = Join-Path $vendor $ml.asset
New-Item -ItemType Directory -Force $vendor | Out-Null

$url = "https://github.com/$($ml.repo)/releases/download/$($ml.tag)/$($ml.asset)"
if (-not (Test-Path $zip)) {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip
}

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ([string]::IsNullOrEmpty($ml.sha256) -or $UpdateHash) {
    Write-Host "Pinning SHA256 $hash"
    $ml.sha256 = $hash
    $versions | ConvertTo-Json -Depth 5 | Set-Content $versionsPath -Encoding utf8
} elseif ($hash -ne $ml.sha256) {
    Remove-Item $zip
    throw "SHA256 mismatch for $($ml.asset): expected $($ml.sha256), got $hash"
}

if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive $zip -DestinationPath $dest
# The portable zip may nest everything in one folder; flatten it.
$items = Get-ChildItem $dest
if ($items.Count -eq 1 -and $items[0].PSIsContainer) {
    Get-ChildItem $items[0].FullName | Move-Item -Destination $dest
    Remove-Item $items[0].FullName
}
Write-Host "Moonlight $($ml.tag) ready in $dest"
