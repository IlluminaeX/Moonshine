// Renders app/assets/moonshine.svg into moonshine.png (256 px) and a multi-size moonshine.ico.
// Runs in Electron so the SVG is drawn by Chromium:
//   app\node_modules\electron\dist\electron.exe scripts\gen-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const assets = path.resolve(__dirname, '..', 'app', 'assets');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** An .ico whose entries are PNGs (supported since Windows Vista). */
function buildIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const svg = fs.readFileSync(path.join(assets, 'moonshine.svg'), 'utf8');
  const render = (size) => win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`).then((b64) => Buffer.from(b64, 'base64'));

  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, data: await render(size) });
  fs.writeFileSync(path.join(assets, 'moonshine.png'), pngs.find((p) => p.size === 256).data);
  fs.writeFileSync(path.join(assets, 'moonshine.ico'), buildIco(pngs));
  console.log(`Wrote moonshine.png and moonshine.ico (${ICO_SIZES.join(', ')} px)`);
  app.exit(0);
});
