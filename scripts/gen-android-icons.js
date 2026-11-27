// Draws Moonshine's Android icons from app/assets/moonshine.svg into the Android app's resources
// (upstream/moonlight-android; saved into patches/moonlight-android.patch by scripts/patches.ps1 save):
// launcher icons, the adaptive icon's foreground, the notification/app icon and the TV banners.
// Runs in Electron so the SVG is drawn by Chromium:
//   app\node_modules\electron\dist\electron.exe scripts\gen-android-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const res = path.join(root, 'upstream', 'moonlight-android', 'app', 'src', 'main', 'res');
const svg = fs.readFileSync(path.join(root, 'app', 'assets', 'moonshine.svg'), 'utf8');

// The logo without its rounded square, for places that draw their own background
const inner = svg.replace(/<rect[^>]*\/>/, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const defs = /<defs>[\s\S]*?<\/defs>/.exec(svg)[0];
const body = inner.replace(defs, '');

/** An adaptive icon's foreground: 108 units with the logo inside the 72-unit area every launcher shows. */
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${defs}
  <g transform="translate(14 14) scale(${80 / 256})">${body}</g></svg>`;

/** A TV banner: the logo and the name on Moonshine's background. */
const banner = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${defs}
  <defs><radialGradient id="bannerBg" cx="30%" cy="50%" r="90%">
    <stop offset="0" stop-color="#34283f"/><stop offset="0.6" stop-color="#231b2e"/><stop offset="1" stop-color="#15101d"/>
  </radialGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#bannerBg)"/>
  <g transform="translate(${h * 0.08} ${h * 0.08}) scale(${(h * 0.84) / 256})">${body}</g>
  <text x="${h * 0.98}" y="${h * 0.58}" font-family="Segoe UI, system-ui, sans-serif" font-weight="600"
    font-size="${Math.min(h * 0.24, (w - h * 1.06) / 5.3)}" fill="#f7f1f3">Moonshine</text></svg>`;

const outputs = [
  ...[['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]
    .map(([d, s]) => ({ file: `mipmap-${d}/ic_launcher.png`, svg, w: s, h: s })),
  ...[['mdpi', 108], ['hdpi', 162], ['xhdpi', 216], ['xxhdpi', 324], ['xxxhdpi', 432]]
    .map(([d, s]) => ({ file: `mipmap-${d}/ic_launcher_foreground.png`, svg: foreground, w: s, h: s })),
  { file: 'drawable/app_icon.png', svg, w: 96, h: 96 },
  { file: 'drawable-xhdpi/atv_banner.png', svg: banner(320, 180), w: 320, h: 180 },
  { file: 'drawable-xhdpi/ouya_icon.png', svg: banner(732, 412), w: 732, h: 412 },
  { file: '../ic_launcher-web.png', svg, w: 512, h: 512 },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  for (const o of outputs) {
    const b64 = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = ${o.w}; c.height = ${o.h};
        c.getContext('2d').drawImage(img, 0, 0, ${o.w}, ${o.h});
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = () => reject(new Error('could not draw ${o.file}'));
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(o.svg).toString('base64'))};
    })`);
    const out = path.join(res, o.file);
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    console.log(`${o.file} ${o.w}x${o.h}`);
  }
  app.quit();
});
