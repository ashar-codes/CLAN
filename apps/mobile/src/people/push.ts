// Internet-assisted wake-ups on the phone (docs/FINAL_ANDROID_FCM.md, docs/FINAL_IOS_PUSH_CALLKIT.md). Optional: with no
// relay or no push configuration in this build, everything stays local-network only and this does nothing.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { getRandomBytes } from 'expo-crypto';
import { b64u, pushMac } from '@classroom/protocol';
import { PushAgent, type PushDevice } from '@clan/core';
import { ClanPush } from '../../modules/clan-push';
import { phoneClan, me } from '../core/clan';

let agent: PushAgent | null = null, devices: PushDevice[] = [];
const answered = new Set<string>(), declined = new Set<string>();
export const pushStatus = () => !ClanPush ? 'This build has no push module: local network only.' : !ClanPush.configured() ? 'Push is not configured in this build (no Firebase/Apple push credentials): local network only.' : agent?.status ?? 'Starting…';
export const pushTick = () => void agent?.tick();

async function tokens() {
  const out: PushDevice[] = [], topic = ClanPush?.bundleId?.() ?? undefined;
  if (!ClanPush?.configured()) return out;
  if (Platform.OS === 'android') { const t = await ClanPush.token().catch(() => null); if (t) out.push({ platform: 'fcm', token: t }); }
  else {
    try { const t = await Notifications.getDevicePushTokenAsync(); if (typeof t.data === 'string') out.push({ platform: 'apns', token: t.data, topic }); } catch { /* not provisioned */ }
    const v = await ClanPush.token().catch(() => null); if (v) out.push({ platform: 'apns-voip', token: v, topic });
  }
  return out;
}
/** Native code verifies and names wake-ups with these per-friend keys (they never leave the phone). */
export function syncWakeKeys() {
  try { ClanPush?.setKeys(JSON.stringify(phoneClan().people.wakeKeys())); ClanPush?.setPreviews(phoneClan().notifications.prefs(me()).previews); } catch { /* CLAN not open yet */ }
}
export async function startPush(signer: { sign(b: Uint8Array): string }) {
  if (!agent) agent = new PushAgent(phoneClan().people, { fetch: (u, i) => fetch(u, i), sign: (b) => signer.sign(b), devices: () => devices, nonce: () => b64u.encode(getRandomBytes(18)) });
  devices = await tokens();
  syncWakeKeys();
  await agent.tick();
}
/** One notification per message/call, whichever path (LAN or wake-up) arrives first. */
export const firstSighting = (kind: string, ref?: string) => !ref || !ClanPush || ClanPush.firstTime(`${kind}:${ref}`);
/** Taps on wake-up notifications since last time: wake that friend's queue and open the conversation. */
export function takeWakeEvents(): { convId: string | null }[] {
  if (!ClanPush) return [];
  let events: { k: string; id: string; c?: string; convId?: string; action: string }[] = [];
  try { events = JSON.parse(ClanPush.takeEvents()); } catch { return []; }
  const keys = (() => { try { return phoneClan().people.wakeKeys(); } catch { return []; } })();
  return events.map((e) => {
    if (e.k === 'call' && e.action === 'answer') answered.add(e.id);
    if (e.k === 'call' && e.action === 'decline') declined.add(e.id);
    const k = keys.find((x) => x.capId === e.c);
    if (k) { try { phoneClan().people.wake(k.peerKey); } catch { /* removed */ } }
    return { convId: e.convId || k?.convId || null };
  });
}
/** The person already answered/declined this call from the system ringing screen. */
export const preAnswer = (callId: string) => { const a = answered.delete(callId), d = declined.delete(callId); return a ? 'answer' : d ? 'decline' : null; };

/**
 * On-device check of the native half (no network): a wake-up keyed with a throwaway secret goes through exactly the
 * production verify → dedupe → notify path, then a forged copy must be rejected. Returns what native reported.
 */
export async function selfTestWake(kind: 'msg' | 'call' = 'msg') {
  if (!ClanPush) throw new Error('This build has no push module.');
  const keys = (() => { try { return phoneClan().people.wakeKeys(); } catch { return []; } })();
  const capId = b64u.encode(getRandomBytes(16)), mac = b64u.encode(getRandomBytes(32)), id = uuid();
  ClanPush.setKeys(JSON.stringify([...keys, { capId, mac, name: 'CLAN self-test', convId: null }]));
  try {
    const ev = { k: kind, id, exp: Date.now() + (kind === 'call' ? 30_000 : 60_000), c: capId };
    const ok = ClanPush.handle(JSON.stringify({ ...ev, m: pushMac(mac, ev) }));
    const forged = ClanPush.handle(JSON.stringify({ ...ev, id: uuid(), m: pushMac(b64u.encode(getRandomBytes(32)), { ...ev, id: uuid() }) }));
    const replay = ClanPush.handle(JSON.stringify({ ...ev, m: pushMac(mac, ev) }));
    return { genuine: ok, forged, replay };
  } finally { ClanPush.setKeys(JSON.stringify(keys)); }
}
const uuid = () => { const b = getRandomBytes(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
