// Phone Capture Inbox: links and text captured on this phone (typed in, or arriving as clan://capture links from other
// apps — parsed with the same strict parser as desktop). Private to the phone until you send an item into a live CLAN.
// OS share-sheet receiving (iOS Share Extension / Android SEND intent) is NOT implemented; only the clan:// link path is.
import { useEffect, useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { parseIntake, type IntakeInput } from '@classroom/protocol';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string };
export type PhoneInboxItem = IntakeInput & { id: string; createdAt: number };
const file = () => new File(new Directory(Paths.document, 'CLAN'), 'inbox.json');
const read = (): PhoneInboxItem[] => { try { const f = file(); return f.exists ? JSON.parse(f.textSync()) : []; } catch { return []; } };
const write = (v: PhoneInboxItem[]) => { const d = new Directory(Paths.document, 'CLAN'); if (!d.exists) d.create({ intermediates: true }); file().write(JSON.stringify(v.slice(0, 500))); };
export const phoneInbox = {
  list: read,
  add(i: IntakeInput) { const it = { ...i, id: randomUUID(), createdAt: Date.now() }; write([it, ...read()]); return it; },
  remove(id: string) { write(read().filter((x) => x.id !== id)); },
};

export function InboxCard({ c, onSend }: { c: C; onSend?(it: PhoneInboxItem): void }) {
  const [items, setItems] = useState(read);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const take = (url: string | null) => { if (!url) return; const i = parseIntake(url); if (i) { phoneInbox.add(i); setItems(read()); } };
    void Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener('url', (e) => take(e.url));
    return () => sub.remove();
  }, []);
  const add = () => {
    const v = draft.trim();
    const i = /^https?:\/\//i.test(v) ? parseIntake(`clan://capture?url=${encodeURIComponent(v)}`) : parseIntake(`clan://capture?text=${encodeURIComponent(v)}`);
    if (!i) return setErr('That can’t be saved (links must be http/https; no control characters).');
    phoneInbox.add(i); setItems(read()); setDraft(''); setErr('');
  };
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 12, gap: 8, backgroundColor: c.surface }} accessibilityLabel="Inbox">
      <Text style={{ color: c.text, fontWeight: '700' }}>Inbox · on this phone only</Text>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <TextInput style={{ flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 10, minHeight: 44, color: c.text }} value={draft} onChangeText={setDraft} placeholder="Paste a link or write an idea" placeholderTextColor={c.muted} accessibilityLabel="Capture" />
        <Pressable accessibilityRole="button" onPress={add} disabled={!draft.trim()} style={{ justifyContent: 'center', paddingHorizontal: 12 }}><Text style={{ color: c.accent, fontWeight: '700' }}>Save</Text></Pressable>
      </View>
      {!!err && <Text style={{ color: c.danger }}>{err}</Text>}
      {items.length === 0 && <Text style={{ color: c.muted }}>Nothing captured yet.</Text>}
      {items.slice(0, 20).map((it) => (
        <View key={it.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, color: c.text }} numberOfLines={2}>{it.kind === 'url' ? `↗ ${it.title ?? it.url}` : `❝ ${it.text}`}</Text>
          {onSend && <Pressable accessibilityRole="button" onPress={() => { onSend(it); phoneInbox.remove(it.id); setItems(read()); }}><Text style={{ color: c.accent }}>Send to Everyone</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="Remove" onPress={() => { phoneInbox.remove(it.id); setItems(read()); }}><Text style={{ color: c.muted }}>✕</Text></Pressable>
        </View>
      ))}
    </View>
  );
}
