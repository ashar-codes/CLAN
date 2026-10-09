// electron-builder beforePack: the native helpers a platform needs must exist, or the build fails (electron-builder
// itself silently skips a missing extraResources file — a package without them would lose Direct / screen sharing).
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { Arch } = require('builder-util');

const native = join(__dirname, '..', '..', '..', 'native');
const required = (platform, arch) => ({
  darwin: [['macos-ble', 'clan-ble'], ['livekit', 'bin', `darwin-${arch}`, 'livekit-server']],
  win32: [['windows-direct', 'bin', 'publish', 'CLAN.DirectHelper.exe'], ['livekit', 'bin', `win32-${arch}`, 'livekit-server.exe']],
  linux: [['livekit', 'bin', `linux-${arch}`, 'livekit-server']],
})[platform] ?? [];

exports.default = async (context) => {
  const platform = context.electronPlatformName, arch = Arch[context.arch];
  const missing = required(platform, arch).map((p) => join(native, ...p)).filter((p) => !existsSync(p));
  if (missing.length) throw new Error(`Missing native helpers for ${platform}-${arch} (see docs/BUILDING.md):\n  ${missing.join('\n  ')}`);
};
