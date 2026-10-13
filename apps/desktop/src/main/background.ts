// Explicit opt-in window-close and packaged-app login availability. Quit always stops networking.
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let tray: Tray | null = null, quitting = false, enabled = false;
export function backgroundWindow(win: BrowserWindow) {
  const path = join(app.getPath('userData'), 'background-availability.json');
  try { enabled = JSON.parse(readFileSync(path, 'utf8')).enabled === true; } catch { /* opt-in default */ }
  if (!tray) {
    const icon = nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZ0lEQVR4nO2VUQoAIAhDu/+l6wipm07BB362PYjynGUg9zOy4jQRbzFVBC2HJFjlIYloGE0CDYDOs+4xnFP6ti3lcoFSVmAFWgq0kJALlH7FDIm0bVi2ji1h3gkhLWdJ0JAVe0WWWTzgHRb4MdxwaQAAAABJRU5ErkJggg==', 'base64')); icon.setTemplateImage(process.platform === 'darwin');
    tray = new Tray(icon); tray.setToolTip('CLAN TEST — local availability');
    const show = () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus(); } };
    const menu = () => tray!.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open CLAN', click: show },
      { label: 'Keep CLAN Available when window closes', type: 'checkbox', checked: enabled, click: (item) => { enabled = item.checked; writeFileSync(path, JSON.stringify({ enabled })); menu(); } },
      { label: 'Start CLAN at login', type: 'checkbox', enabled: app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32'), checked: app.isPackaged && app.getLoginItemSettings().openAtLogin, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); menu(); } },
      { label: enabled ? 'Background availability enabled while CLAN runs' : 'Closing the window quits CLAN', enabled: false },
      { type: 'separator' }, { label: 'Quit CLAN', click: () => app.quit() },
    ]));
    menu(); tray.on('click', show); app.on('before-quit', () => { quitting = true; });
  }
  win.on('close', (e) => { if (quitting) return; e.preventDefault(); if (enabled) win.hide(); else app.quit(); });
}
