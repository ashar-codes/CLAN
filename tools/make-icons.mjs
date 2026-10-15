// Every platform icon from the one CLAN logo (assets/brand/clan-logo.png). Run: node tools/make-icons.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const logo = await loadImage(readFileSync('assets/brand/clan-logo.png'));
const png = (size, draw) => { const c = createCanvas(size, size), g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; draw(g, size); return c.toBuffer('image/png'); };
// the mark sits on a near-white rounded tile in the source; crop to the tile edge (≈2.5 % inset)
const crop = (g, x, y, w) => g.drawImage(logo, 30, 30, 1140, 1140, x, y, w, w);
const full = (s) => png(s, (g, n) => { g.fillStyle = '#fff'; g.fillRect(0, 0, n, n); crop(g, 0, 0, n); });                  // opaque square (iOS, Android legacy)
const rounded = (s, pad = 0.1) => png(s, (g, n) => { const p = n * pad, w = n - 2 * p, r = w * 0.225; g.beginPath(); g.roundRect(p, p, w, w, r); g.closePath(); g.save(); g.clip(); g.fillStyle = '#fff'; g.fillRect(p, p, w, w); crop(g, p, p, w); g.restore(); }); // desktop
const out = (p, b) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, b); };

// mobile (Expo config): iOS 1024 opaque, Android adaptive foreground with the mark inside the 66 % safe zone
out('apps/mobile/assets/icon.png', full(1024));
out('apps/mobile/assets/adaptive-icon.png', png(1024, (g, n) => { g.fillStyle = '#fff'; g.fillRect(0, 0, n, n); const w = n * 0.78; crop(g, (n - w) / 2, (n - w) / 2, w); }));
// desktop: electron-builder picks build/icon.png (Linux), icon.icns (mac), icon.ico (Windows)
out('apps/desktop/build/icon.png', rounded(1024));
const set = 'apps/desktop/build/icon.iconset'; rmSync(set, { recursive: true, force: true }); mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) { out(join(set, `icon_${s}x${s}.png`), rounded(s)); out(join(set, `icon_${s}x${s}@2x.png`), rounded(s * 2)); }
execFileSync('iconutil', ['-c', 'icns', set, '-o', 'apps/desktop/build/icon.icns']); rmSync(set, { recursive: true });
// ICO with embedded PNGs (Vista+), 16–256
const sizes = [16, 24, 32, 48, 64, 128, 256], imgs = sizes.map((s) => rounded(s, s <= 32 ? 0.04 : 0.08));
const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => { const e = 6 + 16 * i; head.writeUInt8(s === 256 ? 0 : s, e); head.writeUInt8(s === 256 ? 0 : s, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(imgs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += imgs[i].length; });
out('apps/desktop/build/icon.ico', Buffer.concat([head, ...imgs]));
// tray/notification + renderer favicon
out('apps/desktop/build/tray.png', rounded(64, 0.02));
console.log('icons written');
