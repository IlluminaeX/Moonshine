// Reads tailnet state through the Tailscale CLI.
const fs = require('fs');
const { execFile } = require('child_process');

const CLI_CANDIDATES = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];

function cliPath() {
  return CLI_CANDIDATES.find((p) => fs.existsSync(p)) || 'tailscale';
}

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(cliPath(), args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function installed() {
  return CLI_CANDIDATES.some((p) => fs.existsSync(p));
}

/**
 * This PC and its online tailnet peers, including devices shared with you.
 * @returns {Promise<{self: object, peers: object[]}|null>} null when Tailscale isn't running.
 */
async function status() {
  let raw;
  try {
    raw = JSON.parse(await cli(['status', '--json']));
  } catch {
    return null;
  }
  if (raw.BackendState !== 'Running') return null;

  const users = raw.User || {};
  const toDevice = (node) => ({
    id: node.ID,
    name: node.HostName,
    dnsName: (node.DNSName || '').replace(/\.$/, ''),
    ip: (node.TailscaleIPs || []).find((ip) => ip.includes('.')),
    os: node.OS,
    online: node.Online,
    user: (users[node.UserID] || {}).LoginName || '',
  });
  return {
    self: toDevice(raw.Self),
    peers: Object.values(raw.Peer || {}).map(toDevice).filter((p) => p.online && p.ip),
    // Including the ones that are off right now (for the Friends list)
    allPeers: Object.values(raw.Peer || {}).map(toDevice),
  };
}

/** Who is behind a tailnet IP, as Tailscale itself vouches for it. */
async function whois(ip) {
  const raw = JSON.parse(await cli(['whois', '--json', ip]));
  return {
    id: raw.Node.ID,
    name: raw.Node.Hostinfo?.Hostname || raw.Node.ComputedName || raw.Node.Name,
    user: raw.UserProfile?.LoginName || '',
  };
}

module.exports = { installed, status, whois };
