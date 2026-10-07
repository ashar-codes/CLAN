// JS side of CLAN Direct join on phones: BLE bootstrap carriers + joining the host Wi-Fi. Same contracts as desktop
// (@classroom/client bleCarrier / DirectAssociator); the six-digit code + OPAQUE still decide membership.
import { requireOptionalNativeModule } from 'expo-modules-core';
import { bleCarrier, TransferError, type BleLink, type BootstrapCarrier, type DirectAssociator } from '@classroom/client';

type NativeApi = {
  bluetoothState(): 'on' | 'off' | 'denied' | 'unsupported' | 'unknown';
  joinWifi(ssid: string, passphrase: string): Promise<void>;
  bleScan(ms: number): Promise<string[]>;
  bleConnect(peer: string): Promise<string>;
  bleWrite(conn: string, frameB64: string): boolean;
  bleClose(conn: string): void;
  addListener(event: 'bleFrame', cb: (e: { conn: string; frame: string }) => void): { remove(): void };
};
const Native = requireOptionalNativeModule<NativeApi>('DirectJoin');

const b64 = { to: (u: Uint8Array) => btoa(String.fromCharCode(...u)), from: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };

function link(peer: string): BleLink {
  let conn: Promise<string> | null = null;
  const subs = new Set<(f: Uint8Array) => void>();
  const sub = Native!.addListener('bleFrame', (e) => { void conn?.then((c) => { if (e.conn === c) subs.forEach((cb) => cb(b64.from(e.frame))); }); });
  return {
    write: async (f) => { const c = await (conn ??= Native!.bleConnect(peer)); if (!Native!.bleWrite(c, b64.to(f))) throw new TransferError('unreachable', 'Bluetooth write failed.'); },
    onFrame: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    close: () => { sub.remove(); void conn?.then((c) => Native!.bleClose(c)); },
  };
}

/** Nearby Direct hosts; Bluetooth off/denied/unsupported → [] (QR or LAN discovery still work). */
export async function bleCarriers(ms = 3000): Promise<BootstrapCarrier[]> {
  if (!Native || Native.bluetoothState() === 'unsupported') return [];
  try { return (await Native.bleScan(ms)).filter((p) => /^[0-9a-f]{12}$/.test(p)).map((p) => bleCarrier(link(p))); } catch { return []; }
}

/** Undefined when this build has no native module → the shared client returns the manual-network fallback. */
export const associator: DirectAssociator | undefined = Native
  ? async (pkg) => {
    try { await Native.joinWifi(pkg.ssid, pkg.passphrase); }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'MANUAL') throw Object.assign(new TransferError('direct_manual', 'Join the CLAN network in Settings, then try again.'), { direct: pkg });
      throw new TransferError(code === 'DENIED' ? 'direct_denied' : 'unreachable', (e as Error).message);
    }
  }
  : undefined;
