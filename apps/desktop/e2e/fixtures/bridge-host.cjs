// Minimal Electron host for the mobile OPAQUE bridge page: sandboxed, no preload, no node, local file only.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.loadFile(process.env.BRIDGE_FILE);
});
