// Inbox and Saved on the phone, over core's Capture / Saved / Files modules. Capturing works offline and is always
// private; an item goes to a Saved collection, a Course or a CLAN only when the student picks that destination.
import { useState } from 'react';
import { Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { parseIntake } from '@classroom/protocol';
import type { CaptureTarget, InboxItem } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { MAX_INTAKE_BYTES } from '../share/items';
import { act, bump, Btn, Card, Choice, Err, Field, H1, Muted, Row, Screen, useC, useData } from '../ui/kit';


/** Destinations the student may file into: their collections, courses, and CLANs they are an active member of. */
export function destinations() {
  const c = phoneClan(), p = me();
  return [
    ...c.saved.collections(p).map((x) => ({ key: `col:${x.id}`, label: `Saved › ${x.name}`, to: { kind: 'collection', collectionId: x.id } as CaptureTarget, modules: ['saved'] })),
    ...c.courses.list(p).map((x) => ({ key: `course:${x.id}`, label: `Course › ${x.name}`, to: { kind: 'course', courseId: x.id } as CaptureTarget, modules: ['notes', 'saved', 'files'] })),
    ...c.clans.list(c.me).filter((x) => c.clans.isActiveMember(x.id, c.me)).map((x) => ({ key: `clan:${x.id}`, label: `CLAN › ${x.name} (shares it)`, to: { kind: 'clan', clanId: x.id } as CaptureTarget, modules: ['notes', 'saved', 'files'] })),
  ];
}

export async function captureFile(uri: string, name: string, mime: string | undefined, size: number | undefined) {
  if (!/^file:\/\//.test(uri)) throw new Error('Only files this app has copied in can be captured.');
  if (size !== undefined && size > MAX_INTAKE_BYTES) throw new Error('That file is over 200 MB.');
  const safe = name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
  await phoneClan().capture.capture(me(), { kind: 'file', path: uri, name: safe, mime: mime?.slice(0, 120) });
  bump();
}

export function InboxScreen() {
  const c = useC();
  const inbox = useData(() => phoneClan().capture.inbox(me())) ?? [];
  const cols = useData(() => phoneClan().saved.collections(me())) ?? [];
  const [draft, setDraft] = useState(''), [err, setErr] = useState<string | null>(null), [filing, setFiling] = useState<InboxItem | null>(null), [col, setCol] = useState<string | null>(null);
  const items = useData(() => (col ? phoneClan().saved.items(me(), col) : [])) ?? [];
  const add = async () => {
    const v = draft.trim();
    const i = /^https?:\/\//i.test(v) ? parseIntake(`clan://capture?url=${encodeURIComponent(v)}`) : parseIntake(`clan://capture?text=${encodeURIComponent(v)}`);
    if (!i) return setErr('That can’t be saved (links must be http/https; no control characters).');
    try { await phoneClan().capture.capture(me(), i.kind === 'url' ? { kind: 'link', url: i.url, title: i.title } : { kind: 'text', text: i.text }); setDraft(''); setErr(null); bump(); } catch (e) { setErr((e as Error).message); }
  };
  const photo = async (camera: boolean) => {
    try {
      const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : { granted: true };
      if (!perm.granted) return setErr('Camera permission is off. You can turn it on in Settings.');
      const r = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85, exif: false }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85, exif: false });
      if (r.canceled || !r.assets[0]) return;
      const a = r.assets[0];
      const named = a.fileName && !/^[0-9a-f-]{36}\./i.test(a.fileName) ? a.fileName : `Photo ${new Date().toLocaleString().replace(/[/:]/g, '-')}.jpg`;
      await captureFile(a.uri, named, a.mimeType ?? 'image/jpeg', a.fileSize);
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  const file = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (r.canceled || !r.assets[0]) return;
      const a = r.assets[0]; await captureFile(a.uri, a.name, a.mimeType, a.size); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Screen>
      <H1>Inbox</H1>
      <Card title="Capture" tone="warn">
        <Field label="Text or link" value={draft} onChange={setDraft} placeholder="Paste a link or jot a thought" />
        <Row><Btn primary label="Save to Inbox" disabled={!draft.trim()} onPress={() => void add()} /><Btn label="Photo" a11y="Take a photo" onPress={() => void photo(true)} /><Btn label="Gallery" a11y="Pick a photo" onPress={() => void photo(false)} /><Btn label="File" a11y="Pick a file" onPress={() => void file()} /></Row>
        <Muted small>Everything here is private until you file it somewhere. Works offline.</Muted>
        <Err msg={err} />
      </Card>
      {inbox.length === 0 && <Muted>Inbox is empty.</Muted>}
      {inbox.map((it) => (
        <Card key={it.id}>
          <Text style={{ color: c.text, fontWeight: '700' }} numberOfLines={2}>{it.kind === 'link' ? '↗ ' : it.kind === 'file' ? '📎 ' : '❝ '}{it.title}</Text>
          {!!it.detail && <Muted small>{it.detail}</Muted>}
          {filing?.id === it.id ? (
            <View style={{ gap: 6 }}>
              <Muted>File into…</Muted>
              {destinations().filter((d) => d.modules.includes(it.module)).map((d) => <Btn key={d.key} small label={d.label} onPress={() => { setErr(act(() => phoneClan().capture.file(me(), it.id, d.to))); setFiling(null); }} />)}
              <Row><Btn small label="Done (keep where it is)" onPress={() => { setErr(act(() => phoneClan().capture.file(me(), it.id, { kind: 'done' }))); setFiling(null); }} /><Btn small label="Cancel" onPress={() => setFiling(null)} /></Row>
            </View>
          ) : <Btn small label="File…" a11y={`File ${it.title}`} onPress={() => setFiling(it)} />}
        </Card>
      ))}
      <Card title="Saved">
        <Choice label="Collection" value={col ?? ''} options={cols.map((x) => [x.id, `${x.name} (${x.count})`] as const)} onChange={setCol} />
        {items.map((s) => <Muted key={s.id}>↗ {s.title} — {s.source}</Muted>)}
      </Card>
    </Screen>
  );
}
