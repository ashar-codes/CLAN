// Personal device sync for the desktop (main process): this device's sync key and long-lived TLS certificate (OS
// keystore), the LAN sync server, DNS-SD discovery of the account's own devices, a background schedule, and IPC for
// Me › My Devices. Linking authorizes personal sync only: no CLAN host keys, memberships, OPAQUE material, TLS session
// keys, AI credentials or other people's data are ever part of it (see docs/SYNC.md).
import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash, createHmac } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';
import { advertiseSync, browseSync, candidateInterfaces, createClassroomTls, logError, startSyncServer } from '@classroom/server';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';
import { joinWithCode, lanSyncTransport } from '@classroom/client/sync';
import { normalizeLinkCode } from '@classroom/protocol';
import type { Keystore } from './keystore.ts';

const TLS_LIFETIME = 5 * 365 * 86_400_000;
const hourTag = (secret: string, h = Math.floor(Date.now() / 3_600_000)) => createHmac('sha256', secret).update(`clan-sync-discovery/v1|${h}`).digest('hex').slice(0, 16);
const linkTag = (code: string) => createHash('sha256').update(`clan-sync-link-tag/v1|${code}`).digest('hex').slice(0, 8);

export async function registerSync(c: ClanApp, keystore: Keystore, deviceName: () => string | undefined) {
  const s = c.sync;
  const signer = nodeSigner(keystore.get('sync-device-ed25519', () => newEd25519().privatePkcs8));
  const fresh = await createClassroomTls('personal-sync', Date.now(), TLS_LIFETIME); // used only on first run
  const tls = JSON.parse(keystore.get('sync-tls', () => JSON.stringify({ certPem: fresh.certPem, keyPem: fresh.keyPem, certificate: fresh.certificate, spkiSha256: fresh.spkiSha256 }))) as typeof fresh;
  const name = () => (deviceName() || hostname()).slice(0, 80);
  s.setup({ publicKey: signer.publicKey, name: name(), platform: process.platform, tlsCa: tls.certificate, tlsSpki: tls.spkiSha256 }, signer);

  const changed = () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:changed'); };
  /** Synced data arrived (screens reload their lists; status-only rounds don't, so forms being typed into stay put). */
  const arrived = () => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:data'); changed(); };
  // The device key is also this device's hosting key: linked devices may pull a frozen CLAN hand-over when the owner delegated it to them.
  const server = await startSyncServer({ host: s, tls, objectPath: (sha) => c.files.personalObject(c.me, sha), onChange: arrived,
    deviceKey: (fp) => s.deviceKey(fp), replication: c.hosting.replicationSource({ localKey: signer.publicKey, signer }),
    sink: c.hosting.replicationSink({ localKey: signer.publicKey, signer }) }); // a phone pushes its CLAN here (phones accept no connections)
  // Development/E2E only (unpackaged builds): also offer loopback so two local app instances can link without a LAN.
  const loopback = !app.isPackaged && process.env.CLAN_TEST_LOOPBACK === '1' ? [`127.0.0.1:${server.port}`] : [];
  const endpoints = () => [...candidateInterfaces().filter((i) => i.private).map((i) => `${i.address}:${server.port}`), ...loopback].slice(0, 8);

  // ---- discovery: an hourly-rotating account tag (no names or ids on the network) ----
  let stopAd: (() => Promise<void>) | null = null, openCode: string | null = null;
  const advertise = async () => {
    await stopAd?.().catch(() => {});
    const acc = s.account();
    stopAd = acc ? advertiseSync({ port: server.port, tag: hourTag(acc.discoverySecret), linkTag: openCode ? linkTag(openCode) : undefined }) : null;
  };
  const seen = new Map<string, number>(); // "addr:port" → last seen (an account device, identity unknown until TLS pin)
  const found = new Map<string, string>(); // link tag → "addr:port"
  browseSync((x) => {
    const acc = s.account(); if (!acc) return;
    if (x.linkTag) found.set(x.linkTag, `${x.addr}:${x.port}`);
    if (x.tag === hourTag(acc.discoverySecret) || x.tag === hourTag(acc.discoverySecret, Math.floor(Date.now() / 3_600_000) - 1)) { seen.set(`${x.addr}:${x.port}`, Date.now()); void syncAll(); }
  });
  void advertise();
  setInterval(() => void advertise(), 3_600_000).unref();

  // ---- schedule: one round at a time; each linked device is tried at its known endpoints, the pin decides who it is ----
  let running: Promise<unknown> | null = null, again: Promise<unknown> | null = null, lastError: string | null = null;
  const transport = (d: ReturnType<typeof s.devices>[number], ep: string) => lanSyncTransport({ peer: d.fp, base: `https://${ep}`, tlsCa: d.tlsCa, tlsSpki: d.tlsSpki, auth: (m, p, b) => s.authHeaders(m, p, b), timeoutMs: 20_000 });
  // A request during a round gets one more round right after it (the running one may predate the change being synced).
  const syncAll = (): Promise<unknown> => running ? (again ??= running.then(() => { again = null; return syncAll(); })) : syncRound();
  const syncRound = () => running = (async () => {
    if (s.selfRevoked() || s.settings().paused) return;
    const lan = [...seen.entries()].filter(([, t]) => Date.now() - t < 10 * 60_000).map(([ep]) => ep);
    for (const d of s.devices().filter((x) => !x.current && !x.revoked && x.tlsSpki !== 'none')) { // phones don't accept connections
      for (const ep of [...new Set([...d.endpoints, ...lan])]) {
        try { const r = await s.syncWith(transport(d, ep)); s.setEndpoints(d.fp, [ep, ...d.endpoints.filter((e) => e !== ep)]); lastError = null; if (r.pulled || r.objects) arrived(); break; }
        catch (e) { lastError = (e as Error).message; if ((e as { code?: string }).code === 'revoked') { changed(); return; } }
      }
    }
  })().catch((e) => { logError('sync', e); }).finally(() => { running = null; changed(); });
  setInterval(() => void syncAll(), 60_000).unref();
  setInterval(() => { try { s.refresh(); } catch (e) { logError('sync', e); } }, 20_000).unref();

  // ---- IPC (Me › My Devices) ----
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const Fp = z.string().min(8).max(64);
  handle('sync:status', () => ({ devices: s.devices().map(({ tlsCa: _c, publicKey: _k, ...d }) => d), settings: s.settings(), stats: s.stats(), syncing: !!running, lastError,
    revoked: s.selfRevoked(), linkRequest: s.linkRequest(), transfers: s.transfers().slice(0, 50) }));
  handle('sync:startLink', async () => { const l = s.startLink(); openCode = l.raw; await advertise(); setTimeout(() => { if (openCode === l.raw) { openCode = null; void advertise(); } }, l.expiresAt - Date.now()).unref(); return { code: l.code, expiresAt: l.expiresAt, addresses: endpoints() }; });
  handle('sync:cancelLink', async () => { s.cancelLink(); openCode = null; await advertise(); });
  handle('sync:approve', async (id) => { s.approveLink(z.string().max(64).parse(id), endpoints()); openCode = null; await advertise(); changed(); });
  handle('sync:reject', (id) => s.rejectLink(z.string().max(64).parse(id)));
  handle('sync:join', async (rawCode, rawAddr) => {
    const code = normalizeLinkCode(z.string().max(40).parse(rawCode)); if (!code) throw new Error('That code doesn’t look right — it looks like CLAN-XXXX-XXXX-XXXX.');
    const manual = z.string().max(80).regex(/^[0-9.]+:\d{2,5}$/).optional().or(z.literal('')).parse(rawAddr) || null;
    let ep = manual;
    for (let i = 0; !ep && i < 40; i++) { ep = found.get(linkTag(code)) ?? null; if (!ep) await new Promise((r) => setTimeout(r, 250)); }
    if (!ep) throw new Error('Couldn’t find your other device on this network. Type the address it shows.');
    const self = s.self();
    const { grant } = await joinWithCode({ base: `https://${ep}`, code, sign: (b) => signer.sign(b), device: { fp: self.fp, publicKey: self.publicKey, name: self.name, platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, endpoints: endpoints() } });
    s.adopt(grant);
    await advertise(); void syncAll();
    return { ok: true };
  });
  handle('sync:now', async () => { await syncAll(); return { lastError }; });
  handle('sync:unlink', async (fp) => { s.revoke(Fp.parse(fp)); await syncAll(); });
  handle('sync:conflicts', () => s.conflicts());
  handle('sync:resolve', (id, choice) => { s.resolve(z.uuid().parse(id), z.enum(['mine', 'theirs', 'both']).parse(choice)); void syncAll(); });
  handle('sync:setSettings', (patch) => { const r = s.setSettings(z.object({ syncDiary: z.boolean(), files: z.enum(['all', 'small', 'off']), paused: z.boolean() }).partial().parse(patch)); void syncAll(); return r; });
  /** One signed JSON POST to a linked computer, pinned to its registered certificate, trying its known addresses. */
  const callLinked = async (fp: string, path: string, body: unknown) => {
    const d = s.devices().find((x) => x.fp === fp && !x.current && !x.revoked);
    if (!d || d.tlsSpki === 'none') throw new Error('That device is not a linked computer.');
    const raw = JSON.stringify(body), t = pinnedTransport({ certificate: d.tlsCa, spkiSha256: d.tlsSpki });
    const lan = [...seen.entries()].filter(([, at]) => Date.now() - at < 10 * 60_000).map(([ep]) => ep);
    let last: Error = new Error('Your other computer could not be reached. Make sure it is on, on this network, and CLAN is open.');
    for (const ep of [...new Set([...d.endpoints, ...lan])]) {
      let res: Response;
      try { res = await t.fetch(`https://${ep}${path}`, { method: 'POST', headers: { ...s.authHeaders('POST', path, raw), 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(60_000) }); }
      catch (e) { last = e as Error; continue; } // unreachable at this address: try the next
      const json = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) throw Object.assign(new Error(json.message ?? `The other computer refused (${res.status}).`), { code: json.error });
      s.setEndpoints(d.fp, [ep, ...d.endpoints.filter((x) => x !== ep)]);
      return json;
    }
    throw last;
  };
  return { close: async () => { await stopAd?.(); await server.close(); }, callLinked, signer };
}
