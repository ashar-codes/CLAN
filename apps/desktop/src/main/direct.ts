// Desktop glue for CLAN Direct Network: host lifecycle around the CLAN server, member BLE bootstrap + Wi-Fi association.
// Everything privileged goes through a native helper with a fixed, validated command set (see @classroom/server direct.ts).
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import QRCode from 'qrcode';
import { z } from 'zod';
import { bleCarrier, type BleLink, type BootstrapCarrier, type DirectAssociator } from '@classroom/client';
import { encodeDirectQr, type DirectPackage } from '@classroom/protocol';
import {
  createDirectBackend, directAvailability, DirectNetwork, HelperProcess, mockBleConnect, mockBleScan, vpnInterfaces,
  type DirectBackend, type RunningServer,
} from '@classroom/server';

const run = promisify(execFile);
const resources = () => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '..', '..', 'native'));
const helperPath = () => (app.isPackaged ? join(process.resourcesPath, 'CLAN.DirectHelper.exe') : join(resources(), 'windows-direct', 'bin', 'CLAN.DirectHelper.exe'));
const macBlePath = () => (app.isPackaged ? join(process.resourcesPath, 'clan-ble') : join(resources(), 'macos-ble', 'clan-ble'));
const radioDir = () => process.env.CLAN_MOCK_RADIO_DIR ?? join(app.getPath('temp'), 'clan-mock-radio');
const mock = () => process.env.CLAN_DIRECT_BACKEND === 'mock' && !app.isPackaged;

export class DesktopDirect {
  private created: { backend: DirectBackend | null; reason: string | null };
  net: DirectNetwork | null = null;
  constructor() {
    this.created = createDirectBackend({ platform: process.platform, packaged: app.isPackaged, env: process.env, helperPath: helperPath(), radioDir: radioDir() });
    if (this.created.backend) this.net = new DirectNetwork(this.created.backend, join(app.getPath('userData'), 'direct-state.json'));
  }

  async availability() { return { ...(await directAvailability(this.created.backend, this.created.reason)), vpn: vpnInterfaces() }; }
  /** Next launch after a crash: take the stale network and rules down. */
  recover() { return this.net?.recoverStale().catch(() => false) ?? Promise.resolve(false); }

  async start(sessionId: string) {
    if (!this.net) throw new Error(this.created.reason ?? 'Direct Network is unavailable on this device.');
    return this.net.start({ sessionId });
  }

  async publish(s: RunningServer) {
    const ports = { bootstrap: s.port, https: Number(new URL(s.url).port) };
    return this.net!.publish({ sessionId: s.classroom.id, program: process.execPath, ports, bootstrap: s.bootstrap });
  }

  /** QR fallback: network-only package, expires with the session (and at most in 30 min; shown again it is re-issued). */
  async qr(s: RunningServer): Promise<{ dataUrl: string; expiresAt: number }> {
    const d = this.net?.active;
    if (!d) throw new Error('No Direct network.');
    const pkg: DirectPackage = { v: 1, sessionId: s.classroom.id, ssid: d.ssid, passphrase: d.passphrase, auth: 'WPA2', host: d.hostAddress, bootstrapPort: s.port, expiresAt: Date.now() + 30 * 60_000 };
    return { dataUrl: await QRCode.toDataURL(encodeDirectQr(pkg), { errorCorrectionLevel: 'M', margin: 1, width: 280 }), expiresAt: pkg.expiresAt };
  }

  async stop() { await this.net?.stop(); }

  // ---------------- member side ----------------
  private memberHelper: HelperProcess | null = null;
  private helper(exe: string) {
    if (!this.memberHelper) this.memberHelper = new HelperProcess(exe);
    return this.memberHelper;
  }

  /** Nearby CLAN hosts over BLE (foreground scan). Bluetooth off/denied/unsupported → [] and the caller falls back. */
  async bleCarriers(ms = 3000): Promise<BootstrapCarrier[]> {
    if (mock()) return mockBleScan(radioDir()).map((tag) => bleCarrier(mockBleConnect(radioDir(), tag)));
    const exe = process.platform === 'win32' ? helperPath() : process.platform === 'darwin' ? macBlePath() : null;
    if (!exe || !existsSync(exe)) return [];
    try {
      const h = this.helper(exe);
      const { hosts } = await h.call({ cmd: 'ble.scan', ms }, z.object({ hosts: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{12}$/) })).max(16) }), ms + 5000);
      return hosts.map((x) => bleCarrier(this.lazyLink(h, x.id)));
    } catch { return []; }
  }

  /** Connects on first write, so scanning many hosts costs nothing until OPAQUE is attempted. */
  private lazyLink(h: HelperProcess, id: string): BleLink {
    let conn: Promise<string> | null = null;
    const subs = new Set<(f: Uint8Array) => void>();
    const prev = h.onEvent;
    h.onEvent = (e) => { prev(e); if (e.ev === 'ble.frame' && typeof e.frame === 'string') void conn?.then((c) => { if (e.conn === c) subs.forEach((cb) => cb(Buffer.from(e.frame as string, 'base64'))); }); };
    const open = () => (conn ??= h.call({ cmd: 'ble.connect', peer: id }, z.object({ conn: z.string().max(64) }), 20_000).then((r) => r.conn));
    return {
      write: async (f) => { const c = await open(); await h.call({ cmd: 'ble.write', conn: c, frame: Buffer.from(f).toString('base64') }, z.unknown()); },
      onFrame: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      close: () => { void conn?.then((c) => h.call({ cmd: 'ble.close', conn: c }, z.unknown())).catch(() => {}); },
    };
  }

  /** Joins the authenticated Direct Wi-Fi. Windows: helper (Wi-Fi access prompt); macOS: networksetup; else manual. */
  associator(): DirectAssociator | undefined {
    if (mock()) return async () => {};
    if (process.platform === 'win32' && existsSync(helperPath())) return async (pkg) => { await this.helper(helperPath()).call({ cmd: 'wifi.connect', ssid: pkg.ssid, passphrase: pkg.passphrase }, z.unknown(), 45_000); };
    if (process.platform === 'darwin') return async (pkg) => {
      const ports = (await run('/usr/sbin/networksetup', ['-listallhardwareports'])).stdout;
      const dev = /Hardware Port: Wi-Fi\nDevice: (en\d+)/.exec(ports)?.[1];
      if (!dev) throw new Error('No Wi-Fi interface found.');
      // execFile (no shell); ssid/passphrase were validated by the package schema
      const { stdout } = await run('/usr/sbin/networksetup', ['-setairportnetwork', dev, pkg.ssid, pkg.passphrase], { timeout: 45_000 });
      if (/error|could not|failed/i.test(stdout)) throw new Error(`macOS could not join ${pkg.ssid}.`);
      await new Promise((r) => setTimeout(r, 2500)); // DHCP on the new network
    };
    return undefined; // → manual fallback (network name + password shown only after OPAQUE)
  }
}
