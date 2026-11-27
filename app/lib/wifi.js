// Steadier Wi-Fi while streaming. Windows' Wi-Fi driver normally leaves the channel now and then to scan
// for other networks, which stalls the connection for a moment: the player sees the delay jump. Two
// per-adapter settings from Windows' own Wi-Fi API ("media streaming mode" on, "background scan" off)
// ask the driver not to. No admin rights are needed, and Windows undoes both the moment the process
// holding them ends, however it ends, so a crash can never leave the Wi-Fi changed.
const { spawn } = require('child_process');

// Runs in a hidden PowerShell that sits waiting on its input: closing the input (or killing it) ends it.
const HELPER = String.raw`
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("wlanapi.dll")] public static extern int WlanOpenHandle(uint v, IntPtr r, out uint neg, out IntPtr h);
  [DllImport("wlanapi.dll")] public static extern int WlanEnumInterfaces(IntPtr h, IntPtr r, out IntPtr list);
  [DllImport("wlanapi.dll")] public static extern int WlanSetInterface(IntPtr h, ref Guid g, int op, uint size, IntPtr data, IntPtr r);
}
'@
$neg = 0; $h = [IntPtr]::Zero; $list = [IntPtr]::Zero
if ([W]::WlanOpenHandle(2, [IntPtr]::Zero, [ref]$neg, [ref]$h) -ne 0) { exit }
if ([W]::WlanEnumInterfaces($h, [IntPtr]::Zero, [ref]$list) -ne 0) { exit }
$m = [Runtime.InteropServices.Marshal]
$value = $m::AllocHGlobal(4)
$applied = 0
# WLAN_INTERFACE_INFO_LIST: a count and an index, then 532-byte entries that start with the adapter's GUID
for ($i = 0; $i -lt $m::ReadInt32($list); $i++) {
  $bytes = New-Object byte[] 16
  $m::Copy([IntPtr]($list.ToInt64() + 8 + 532 * $i), $bytes, 0, 16)
  $guid = [Guid]::new($bytes)
  # opcode 3 = media streaming mode (on), opcode 2 = background scan (off)
  foreach ($setting in @(@(3, 1), @(2, 0))) {
    $m::WriteInt32($value, $setting[1])
    if ([W]::WlanSetInterface($h, [ref]$guid, $setting[0], 4, $value, [IntPtr]::Zero) -eq 0) { $applied++ }
  }
}
if ($applied -gt 0) { [Console]::In.ReadToEnd() | Out-Null }
`;
const ENCODED = Buffer.from(HELPER, 'utf16le').toString('base64');

/** Ask the Wi-Fi adapters not to scan. Returns the function that gives them back (also done if Moonshine ends). */
function hold() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
    windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('error', () => {}); // no PowerShell or no Wi-Fi: nothing to do
  child.stdin.on('error', () => {});
  return () => child.kill();
}

module.exports = { hold };
