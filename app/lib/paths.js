// Where the stream player (Moonlight) lives: next to Moonshine.exe when installed. When running from
// source, Moonshine's own build if it has been built, otherwise the official release in vendor/.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const repo = path.resolve(__dirname, '..', '..');
const candidates = [
  path.join(path.dirname(app.getPath('exe')), 'moonlight', 'Moonlight.exe'),
  path.join(repo, 'build', 'moonlight', 'dist', 'Moonlight.exe'),
  path.join(repo, 'vendor', 'moonlight', 'Moonlight.exe'),
];

module.exports = {
  moonlightExe: candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1],
};
