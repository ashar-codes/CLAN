// Durable per-CLAN mobile Outbox. Controllers can discard one removed copy without touching other conversations.
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import type { ClientMessage } from '@classroom/protocol';
import { phoneClan } from './core/clan';
type Send = Extract<ClientMessage, { t: 'chat.send' }>;
const dir = () => new Directory(Paths.document, 'CLAN');
const file = () => new File(dir(), 'chat-outbox.json');
const read = (): Record<string, Send[]> => {
  const f = file(), all = f.exists ? JSON.parse(f.textSync()) : {};
  if (!all || Array.isArray(all) || typeof all !== 'object' || Object.values(all).some((items) => !Array.isArray(items) || items.some((m) => !m || m.t !== 'chat.send' || typeof m.id !== 'string'))) throw new Error('Chat Outbox is unreadable; the stored file was retained.');
  return all;
};
const write = (all: Record<string, Send[]>) => {
  if (!dir().exists) dir().create({ intermediates: true });
  const temporary = new File(dir(), `chat-outbox-${randomUUID()}.tmp`), uri = temporary.uri;
  try { temporary.write(JSON.stringify(all)); temporary.moveSync(file(), { overwrite: true }); }
  finally { const leftover = new File(uri); if (leftover.exists) leftover.delete(); }
};
export const outbox = {
  list: (clanId: string) => phoneClan().clans.cleanup(clanId) ? [] : read()[clanId] ?? [],
  add(clanId: string, m: Send) {
    if (phoneClan().clans.cleanup(clanId)) throw new Error('This CLAN copy is removed or awaiting cleanup.');
    const all = read(); all[clanId] = [...(all[clanId] ?? []).filter((x) => x.id !== m.id), m]; write(all);
  },
  sent(id: string) { const all = read(); for (const key of Object.keys(all)) all[key] = all[key]!.filter((m) => m.id !== id); write(all); },
};
export function discardClanOutbox(clanId: string) { const all = read(); delete all[clanId]; write(all); }
