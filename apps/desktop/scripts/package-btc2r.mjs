// Avoid platform shell/short-option parsing of dotted electron-builder metadata overrides.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const { build, Platform, Arch } = createRequire(import.meta.url)('electron-builder');
const sha = process.env.CLAN_SOURCE_SHA;
if (!/^[0-9a-f]{40}$/.test(sha ?? '') || sha !== execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) {
  throw new Error('CLAN_SOURCE_SHA must match the frozen checkout');
}
const target = process.argv[2];
if (target !== 'mac' && target !== 'win') throw new Error('Use package-btc2r.mjs mac|win');
await build({
  targets: target === 'mac' ? Platform.MAC.createTarget(['dmg'], Arch.arm64) : Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  config: { extends: './electron-builder.btc2r.yml', extraMetadata: { clanSourceCommit: sha } },
  publish: 'never',
});
