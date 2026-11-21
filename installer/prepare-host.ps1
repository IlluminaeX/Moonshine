# Prepares Moonshine's host folder before the host engine is installed. Run elevated by the installer.
#
# 1. If a separate Apollo is installed, move it into Moonshine and remove the old install.
#    Kept: Apollo's settings, apps, covers, login, paired devices and its identity (so no device has
#    to pair again). They are copied while Moonshine's own host engine isn't installed yet, so
#    re-running the installer later never overwrites newer Moonshine data with an old Apollo's.
#    Removed: the Apollo service, firewall rule, PATH entry, Start menu folder, program files and its
#    entry in Windows' installed apps. The virtual display and gamepad drivers stay; Moonshine uses them.
# 2. Put the host in "managed by Moonshine" mode: no tray icon of its own, its API reachable only
#    from this PC, and streams wait for Moonshine's user to allow them.
#
# Nothing here may stall the installer: every external command has a time limit, and the steps that
# matter (stop the old service, copy its settings, delete the service) come before the tidying-up.
# Each step is written to -LogFile.
param(
    [Parameter(Mandatory)][string]$HostDir,
    [string]$ApolloDir = '',
    [string]$LogFile = '',
    # Copy and fix up the settings only; leave the old Apollo installed (used by tests).
    [switch]$CopyOnly
)
$ErrorActionPreference = 'Continue'

$newConfig = Join-Path $HostDir 'config'

function Log([string]$Message) {
    $line = '{0:HH:mm:ss} {1}' -f (Get-Date), $Message
    Write-Output $line
    if ($LogFile) { Add-Content -LiteralPath $LogFile -Value $line -ErrorAction SilentlyContinue }
}

# Runs a command and waits at most $TimeoutSec for it; a command that overruns is stopped.
function Invoke-Limited([string]$Exe, [string]$Arguments, [int]$TimeoutSec = 30) {
    Log "run: $Exe $Arguments"
    try {
        $info = New-Object Diagnostics.ProcessStartInfo $Exe, $Arguments
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $process = [Diagnostics.Process]::Start($info)
        if (-not $process.WaitForExit($TimeoutSec * 1000)) {
            Log "  still running after ${TimeoutSec}s; stopping it"
            try { $process.Kill() } catch { }
            return
        }
        Log "  exit code $($process.ExitCode)"
    } catch {
        Log "  could not run: $($_.Exception.Message)"
    }
}

# Runs a step of our own, logging it and never letting an error end the script.
function Step([string]$Name, [scriptblock]$Action) {
    Log $Name
    try { & $Action } catch { Log "  failed: $($_.Exception.Message)" }
}

function Set-ConfigValue([string]$File, [string]$Key, [string]$Value) {
    $lines = @()
    if (Test-Path $File) { $lines = @([IO.File]::ReadAllLines($File)) }
    $found = $false
    $lines = @($lines | ForEach-Object {
            if ($_ -match "^\s*$([regex]::Escape($Key))\s*=") { $found = $true; "$Key = $Value" } else { $_ }
        })
    if (-not $found) { $lines += "$Key = $Value" }
    [IO.File]::WriteAllLines($File, $lines)
}

Log "prepare-host: HostDir=$HostDir ApolloDir=$ApolloDir CopyOnly=$CopyOnly 64-bit=$([Environment]::Is64BitProcess)"

if ($ApolloDir -and (Test-Path (Join-Path $ApolloDir 'sunshine.exe'))) {
    $oldConfig = Join-Path $ApolloDir 'config'

    if (-not $CopyOnly) {
        Invoke-Limited 'net.exe' 'stop ApolloService' 60
        Step 'stop Apollo processes still running' {
            # The service's stream process can outlive it for a moment and would hold files open.
            Get-Process sunshine, sunshinesvc -ErrorAction SilentlyContinue |
                Where-Object { $_.Path -and $_.Path.StartsWith($ApolloDir, [StringComparison]::OrdinalIgnoreCase) } |
                Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }

    # Until Moonshine's own host engine has been installed, Apollo's settings are the live ones.
    $hostInstalled = Test-Path (Join-Path $HostDir 'sunshine.exe')
    if ((Test-Path $oldConfig) -and -not $hostInstalled) {
        Step "copy Apollo's settings into $newConfig" {
            if (Test-Path $newConfig) { Remove-Item $newConfig -Recurse -Force } # left by an unfinished install
            New-Item -ItemType Directory -Force $newConfig | Out-Null
            Copy-Item (Join-Path $oldConfig '*') $newConfig -Recurse -Force
            Remove-Item (Join-Path $newConfig 'sunshine.log*') -Force -ErrorAction SilentlyContinue
        }
        Step 'point saved paths at the new folder' {
            # Paths saved inside the settings (cover images, custom file locations) still point at the old folder.
            # The files write a path's separators as \, as \\ (JSON) or as /; match any, and keep the style found.
            $parts = $ApolloDir.TrimEnd('\').Split('\') | ForEach-Object { [regex]::Escape($_) }
            $pattern = $parts[0] + '(\\\\|\\|/)' + (($parts | Select-Object -Skip 1) -join '(?:\\\\|\\|/)')
            $newDir = $HostDir.TrimEnd('\')
            foreach ($name in 'apps.json', 'sunshine.conf') {
                $file = Join-Path $newConfig $name
                if (-not (Test-Path $file)) { continue }
                $text = [IO.File]::ReadAllText($file)
                $fixed = [regex]::Replace($text, $pattern, { param($m) $newDir.Replace('\', $m.Groups[1].Value) }, 'IgnoreCase')
                if ($fixed -ne $text) { [IO.File]::WriteAllText($file, $fixed) }
            }
        }
    } else {
        Log "Moonshine's host is already installed; Apollo's settings were not copied"
    }

    if (-not $CopyOnly) {
        # First the part that matters: with its service gone, the old Apollo can't fight Moonshine's host for its ports.
        Invoke-Limited 'sc.exe' 'delete ApolloService' 30
        Invoke-Limited 'netsh.exe' 'advfirewall firewall delete rule name=Apollo' 30
        Step 'remove Apollo from the system PATH' {
            # Edited in the registry directly: no helper script, and no "settings changed" broadcast to wait on.
            $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey(
                'SYSTEM\CurrentControlSet\Control\Session Manager\Environment', $true)
            $path = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
            $drop = @($ApolloDir.TrimEnd('\'), (Join-Path $ApolloDir 'tools').TrimEnd('\'))
            $kept = @($path -split ';' | Where-Object { $_ -and ($drop -notcontains $_.TrimEnd('\')) })
            if (($kept -join ';') -ne $path) { $key.SetValue('Path', ($kept -join ';'), 'ExpandString') }
            $key.Close()
        }
        Step "remove Apollo's Start menu folder" {
            Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Apollo') -Recurse -Force -ErrorAction SilentlyContinue
        }
        Step "remove Apollo from Windows' installed apps" {
            # The 64-bit view, whichever kind of process this is.
            [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').DeleteSubKeyTree(
                'Software\Microsoft\Windows\CurrentVersion\Uninstall\Apollo', $false)
        }
        Step "delete $ApolloDir" {
            Remove-Item $ApolloDir -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path $ApolloDir) { Log "  some files were in use and are left behind; they are safe to delete" }
        }
    }
}

Step 'switch the host to managed mode' {
    New-Item -ItemType Directory -Force $newConfig | Out-Null
    $conf = Join-Path $newConfig 'sunshine.conf'
    Set-ConfigValue $conf 'moonshine_managed' 'enabled'
    Set-ConfigValue $conf 'origin_web_ui_allowed' 'pc'
}
Log 'prepare-host: done'
