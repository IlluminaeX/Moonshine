# Talks to Moonshine's local API for helpers such as the Steam (Millennium) button. Copy it into the
# helper and run it with Windows PowerShell:
#
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File moonshine-api.ps1 -Action friends
#   powershell ... -File moonshine-api.ps1 -Action invite -Friends "Bob,Carol" -Game "Hades II"
#
# It always prints one line of JSON:
#   friends -> {"signedIn":true,"hosting":true,"friends":[{"username":"Bob","nickname":"Bobby","name":"Bobby","online":true}]}
#   invite  -> {"ok":true,"invited":["Bobby"],"error":""}
#   failure -> {"ok":false,"error":"..."}
# If Moonshine isn't running it is started hidden in the tray (moonshine://background) and asked again.
param(
    [ValidateSet('friends', 'invite')][string]$Action = 'friends',
    [string]$Friends = '',          # usernames from "friends", separated by commas (max 4)
    [string]$Game = '',             # title shown on the friends' invite, e.g. the Steam game's name (optional)
    [string]$GameB64 = '',          # the same title as UTF-8 base64: use this for any title with quotes, & or accents
    [string]$ApiFile = (Join-Path $env:APPDATA 'Moonshine\local-api.json'),
    [int]$StartTimeoutSec = 30
)
$ErrorActionPreference = 'Stop'

function Call {
    $api = Get-Content -LiteralPath $ApiFile -Raw | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $($api.token)" }
    $base = "http://127.0.0.1:$($api.port)"
    if ($Action -eq 'friends') { return Invoke-RestMethod -Uri "$base/friends" -Headers $headers -TimeoutSec 20 }
    # Usernames are 3-20 letters, numbers, dots, dashes or underscores; anything else is dropped.
    $names = @($Friends -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^[A-Za-z0-9_.-]{3,20}$' } | Select-Object -First 4)
    $title = if ($GameB64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($GameB64)) } else { $Game }
    $body = ConvertTo-Json -Compress @{ friends = $names; game = $title }
    # Inviting can start hosting (Windows may ask for permission) and wait for the friends service, so allow long
    return Invoke-RestMethod -Method Post -Uri "$base/invite" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 150
}

function Out-Json($value) { $value | ConvertTo-Json -Compress -Depth 5 }

try {
    Out-Json (Call)
    exit 0
} catch {
    # Not running (no file, or a file left by a Moonshine that has quit): start it hidden and retry.
}
try {
    Start-Process 'moonshine://background'
} catch {
    Out-Json @{ ok = $false; error = 'Moonshine isn''t installed, or hasn''t been opened once yet.' }
    exit 1
}
$deadline = (Get-Date).AddSeconds($StartTimeoutSec)
$last = 'Moonshine didn''t start.'
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    try {
        Out-Json (Call)
        exit 0
    } catch {
        $last = $_.Exception.Message
    }
}
Out-Json @{ ok = $false; error = "Moonshine didn't answer. Open Moonshine and try again. ($last)" }
exit 1
