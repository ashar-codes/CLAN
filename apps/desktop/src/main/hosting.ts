// Persistent CLAN hosting on the desktop (docs/PHASE_14_2_HOSTING_DESIGN.md): status, owner authorization, the explicit
// hand-over of a CLAN this computer hosts to another of the owner's linked computers (pushed over the device link),
// incoming hand-overs (served by the device-link server), conflicts resolved only by the owner, and retained copies.
// The hosting key is this device's personal-sync key; it never leaves the OS keystore.
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClanApp } from '@clan/core';
import { pushClan } from '@classroom/client';
import { logError } from '@classroom/server';

type Sync = { callLinked(fp: string, path: string, body: unknown): Promise<unknown>; signer: { publicKey: string; sign(b: Uint8Array): string } };
const Id = z.uuid();

export function registerHosting(c: ClanApp, o: { sync: Promise<Sync>; liveClanId(): string | null }) {
  const send = (ch: string, v: unknown) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, v); };
  c.hosting.onActivated((clanId) => send('hosting:changed', { clanId, activated: true }));
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const sync = async () => { try { return await o.sync; } catch { throw new Error('Device linking is unavailable on this computer, so hosting cannot be moved.'); } };
  const computers = () => c.sync.devices().filter((d) => !d.current && !d.revoked && d.tlsSpki !== 'none').map((d) => ({ fp: d.fp, name: d.name, publicKey: d.publicKey }));
  const nameOfKey = (k: string, me: string) => k === me ? 'This computer' : c.sync.devices().find((d) => d.publicKey === k)?.name ?? 'Another device';
  const running = new Set<string>();

  handle('hosting:status', async (raw) => {
    const clanId = Id.parse(raw), s = await sync(), me = s.signer.publicKey;
    const st = await c.hosting.handoverStatus(clanId, me);
    const request = c.hosting.pendingRequest(clanId);
    const isHost = st.hosting?.hostKey === me;
    return {
      ...st, me, isOwner: st.hosting ? st.hosting.ownerKey === me : c.clans.members(clanId).some((m) => m.userId === c.me && m.role === 'owner'),
      hostName: st.hosting ? nameOfKey(st.hosting.hostKey, me) : null, ownerName: st.hosting ? nameOfKey(st.hosting.ownerKey, me) : null,
      request: request && { destKey: request.destKey, destName: nameOfKey(request.destKey, me), expiresAt: request.expiresAt },
      preflight: isHost && st.hosting && ['active', 'frozen'].includes(st.hosting.state) ? c.hosting.preflight(clanId) : [],
      live: o.liveClanId() === clanId, running: running.has(clanId), computers: computers(),
      conflictNames: st.conflict ? { ours: nameOfKey(st.conflict.oursHost, me), theirs: st.conflict.theirsHost ? nameOfKey(st.conflict.theirsHost, me) : null } : null,
    };
  });
  /** Owner, for a CLAN created on this computer: start signed hosting authority (this computer hosts epoch 0). */
  handle('hosting:enable', async (raw) => { const s = await sync(); return c.hosting.establish(Id.parse(raw), c.me, s.signer); });
  /** Owner: authorize moving hosting to one of their linked computers (the current host confirms before anything pauses). */
  handle('hosting:request', async (rawClan, rawFp) => {
    const clanId = Id.parse(rawClan), fp = z.string().max(64).parse(rawFp), s = await sync();
    const dest = computers().find((d) => d.fp === fp);
    if (!dest) throw new Error('Choose one of your linked computers.');
    const d = c.hosting.delegate(clanId, s.signer, dest.publicKey, { id: randomUUID(), ttlMs: 7 * 86_400_000 });
    const head = c.hosting.chainOf(clanId)!.at(-1)!;
    if (head.hostKey === s.signer.publicKey) return c.hosting.requestHandover(d); // this computer hosts: confirm here
    const host = c.sync.devices().find((x) => x.publicKey === head.hostKey && !x.revoked);
    if (!host) throw new Error('The current host is not one of your linked devices.');
    return s.callLinked(host.fp, '/host/push/request', d);
  });
  /** Owner: withdraw the current (other) host's permission; it stops accepting changes once told. */
  handle('hosting:revoke', async (raw) => {
    const clanId = Id.parse(raw), s = await sync(), head = c.hosting.chainOf(clanId)?.at(-1);
    if (!head?.delegation || head.hostKey === s.signer.publicKey) throw new Error('No other device hosts this CLAN.');
    const rev = c.hosting.revoke(clanId, s.signer, head.delegation.id);
    const failed: string[] = [];
    for (const d of computers()) await s.callLinked(d.fp, '/host/push/revoke', rev).catch(() => failed.push(d.name));
    return { notReached: failed };
  });
  handle('hosting:decline', (raw) => c.hosting.clearRequest(Id.parse(raw)));
  /** Current host: pause, check, prepare and push the CLAN to the requested computer. Safe to call again to resume. */
  handle('hosting:handover', async (rawClan, rawAck) => {
    const clanId = Id.parse(rawClan), acknowledge = z.array(z.string().max(40)).max(10).parse(rawAck ?? []), s = await sync(), me = s.signer.publicKey;
    if (o.liveClanId() === clanId) throw new Error('End the live session of this CLAN first.');
    if (running.has(clanId)) throw new Error('A hand-over of this CLAN is already running.');
    const signed = c.hosting.pendingTransition(clanId);
    const d = c.hosting.pendingRequest(clanId) ?? (signed?.delegation ?? null);
    if (!d) throw new Error('The owner has not asked to move hosting.');
    const dest = computers().find((x) => x.publicKey === d.destKey);
    if (!dest) throw new Error('The chosen computer is not linked to this account any more.');
    running.add(clanId);
    try {
      if (!signed) {
        c.hosting.freeze(clanId, me);
        await c.hosting.prepareCheckpoint(clanId, me, { acknowledge });
      }
      const clan = c.clans.get(clanId)!;
      const r = await pushClan({ call: (path, body) => s.callLinked(dest.fp, path, body), source: c.hosting, clanId, delegation: d, signer: s.signer,
        clan: { type: clan.type, name: clan.name, expiresAt: clan.expiresAt },
        read: async (sha, offset, length) => { const fh = await open(c.hosting.checkpointBlob(clanId, sha)!, 'r'); try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return new Uint8Array(b.subarray(0, bytesRead)); } finally { await fh.close(); } },
        onProgress: (done, total) => send('hosting:progress', { clanId, done, total }) });
      send('hosting:changed', { clanId });
      return { done: true, epoch: r.epoch, destName: dest.name };
    } catch (e) {
      logError('hosting', e);
      throw e; // the CLAN stays paused (or handed over) — never silently resumed; the screen offers Retry or Cancel
    } finally { running.delete(clanId); }
  });
  /** Abort a paused hand-over before it was signed: this computer resumes hosting. */
  handle('hosting:cancel', async (raw) => { const s = await sync(); c.hosting.unfreeze(Id.parse(raw), s.signer.publicKey); });
  /** Owner only: choose which host's record stands. Applied here and sent to every reachable linked computer. */
  handle('hosting:resolve', async (rawClan, rawChoice) => {
    const clanId = Id.parse(rawClan), choice = z.enum(['ours', 'theirs']).parse(rawChoice), s = await sync();
    const st = await c.hosting.handoverStatus(clanId, s.signer.publicKey);
    if (!st.conflict) throw new Error('There is no conflict to resolve.');
    const chosen = choice === 'ours' ? st.conflict.ours : st.conflict.theirs;
    if (!chosen) throw new Error('The other record is not known on this device.');
    const res = c.hosting.resolve(clanId, s.signer, st.conflict.forkEpoch, chosen);
    const out = c.hosting.resolveConflict(res);
    const chain = c.hosting.chainOf(clanId); // the chosen branch, so devices on the other one can adopt it
    const failed: string[] = [];
    for (const d of computers()) await s.callLinked(d.fp, '/host/push/resolve', { resolution: res, chain }).catch(() => failed.push(d.name));
    return { state: out.state, notReached: failed };
  });
  /** Save a readable copy of this device's CLAN data (e.g. the copy the owner did not choose) to a folder. */
  handle('hosting:exportCopy', async (raw) => {
    const clanId = Id.parse(raw);
    const win = BrowserWindow.getFocusedWindow();
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return c.hosting.exportCopy(clanId, r.filePaths[0]);
  });
  handle('hosting:acknowledgeSuperseded', (raw) => c.hosting.acknowledgeSuperseded(Id.parse(raw)));
}
