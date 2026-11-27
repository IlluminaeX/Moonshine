// Renders the installer's full-window background to installer/bg-<width>.bmp (NSIS needs BMPs), one per
// common display scale so the installer can pick the one nearest its window size.
// Runs in Electron so the artwork is drawn by Chromium:
//   app\node_modules\electron\dist\electron.exe scripts\gen-installer-art.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '..', 'installer');
// The artwork is designed on a 500x356 canvas (the installer window's inside at 100% scaling).
const BASE_W = 500;
const BASE_H = 356;
const WIDTHS = [500, 625, 750, 875, 1000]; // 100% to 200% display scaling

// Stars: fixed positions from a small seeded generator, so every build draws the same sky.
let seed = 20261114;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const stars = Array.from({ length: 90 }, () => ({
  x: (random() * BASE_W).toFixed(1),
  y: (random() * BASE_H).toFixed(1),
  r: (0.35 + random() * 0.55).toFixed(2),
  o: (0.12 + random() * 0.5).toFixed(2),
}));

// Same palette as the app (style.css) and icon (app/assets/moonshine.svg). The eclipse sits on the right,
// large and dimmed, behind the page content; text and buttons are laid out on the left (x below about 290),
// where the image is plain background (BG in moonshine.nsi) apart from the stars. The installer fills its
// text boxes with that colour, so keep the glow out of that area.
const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BASE_W} ${BASE_H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#cf3a5a" stop-opacity="0.30"/>
      <stop offset="0.6" stop-color="#cf3a5a" stop-opacity="0.10"/>
      <stop offset="0.88" stop-color="#cf3a5a" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#cf3a5a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="corona" cx="50%" cy="50%" r="50%">
      <stop offset="0.6" stop-color="#cf3a5a"/>
      <stop offset="0.72" stop-color="#972847" stop-opacity="0.7"/>
      <stop offset="0.86" stop-color="#611a33" stop-opacity="0.25"/>
      <stop offset="1" stop-color="#4f1228" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="moon" cx="40%" cy="38%" r="70%">
      <stop offset="0" stop-color="#1d1019"/>
      <stop offset="0.7" stop-color="#0c0810"/>
      <stop offset="1" stop-color="#08050c"/>
    </radialGradient>
    <radialGradient id="flare" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#fff2f3"/>
      <stop offset="0.25" stop-color="#f27b93"/>
      <stop offset="0.6" stop-color="#cf3a5a" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#cf3a5a" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <rect width="${BASE_W}" height="${BASE_H}" fill="#0e0a14"/>
  ${stars.map((s) => `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#f4eeef" opacity="${s.o}"/>`).join('')}
  <g opacity="0.8">
    <circle cx="436" cy="142" r="142" fill="url(#glow)"/>
    <circle cx="436" cy="142" r="140" fill="url(#corona)"/>
    <circle cx="436" cy="142" r="103" fill="none" stroke="#d63f60" stroke-width="7" filter="url(#soft)"/>
    <circle cx="436" cy="142" r="101" fill="none" stroke="#f06f89" stroke-width="2.2"/>
  </g>
  <circle cx="440" cy="146" r="100" fill="url(#moon)"/>
  <circle cx="365" cy="71" r="24" fill="url(#flare)" opacity="0.9"/>
  <circle cx="365" cy="71" r="4" fill="#fff6f7"/>
</svg>`;

/** A 24-bit bottom-up BMP from RGBA pixels. */
function bmp(rgba, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[row + x * 3] = rgba[i + 2];
      buf[row + x * 3 + 1] = rgba[i + 1];
      buf[row + x * 3 + 2] = rgba[i];
    }
  }
  return buf;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const encoded = Buffer.from(art).toString('base64');
  for (const w of WIDTHS) {
    const h = Math.round((w * BASE_H) / BASE_W);
    const pixels = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = ${w}; c.height = ${h};
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, ${w}, ${h});
        resolve(Array.from(ctx.getImageData(0, 0, ${w}, ${h}).data));
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,${encoded}';
    })`);
    fs.writeFileSync(path.join(outDir, `bg-${w}.bmp`), bmp(pixels, w, h));
    console.log(`Wrote installer/bg-${w}.bmp (${w}x${h})`);
  }
  app.exit(0);
});
