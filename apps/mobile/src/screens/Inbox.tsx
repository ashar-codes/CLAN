// Inbox and Saved on the phone, over core's Capture / Saved / Files modules. Capturing works offline and is always
// private; an item goes to a Saved collection, a Course or a CLAN only when the student picks that destination.
import { useState } from 'react';
import { Text, View, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { parseIntake } from '@classroom/protocol';
import type { CaptureTarget, InboxItem, SavedItem } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { MAX_INTAKE_BYTES } from '../share/items';
import {Editor,confirmRemove} from '../ui/Editor';
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
  const [editing,setEditing]=useState<SavedItem|null>(null),[collectionEdit,setCollectionEdit]=useState<{id:string|null;name:string}|null>(null);
  const files=useData(()=>phoneClan().files.list(me(),{kind:'personal',ownerId:phoneClan().me}))??[];
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
      {editing&&<Editor title="Edit saved link" initial={{title:editing.title,note:editing.note}} labels={{title:'Title',note:'Note'}} multiline={['note']} read={()=>{const s=phoneClan().saved.get(me(),editing.id);if(!s)throw Error('This link was deleted; your draft is kept.');return {title:s.title,note:s.note};}} onSave={v=>phoneClan().saved.update(me(),editing.id,v)} onClose={()=>setEditing(null)}/>}
      {collectionEdit&&<Editor title={collectionEdit.id?'Rename collection':'New collection'} initial={{name:collectionEdit.name}} labels={{name:'Collection name'}} onSave={v=>{if(collectionEdit.id)phoneClan().saved.renameCollection(me(),collectionEdit.id,v.name!);else{const id=phoneClan().saved.createCollection(me(),v.name!);setCol(id);}}} onClose={()=>setCollectionEdit(null)}/>}

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
              {destinations().filter((d) => d.modules.includes(it.module)).map((d) => <Btn key={d.key} small label={d.label} onPress={() => { const e=act(() => phoneClan().capture.file(me(), it.id, d.to));setErr(e);if(!e)setFiling(null); }} />)}
              <Row><Btn small label="Done (keep where it is)" onPress={() => { const e=act(() => phoneClan().capture.file(me(), it.id, { kind: 'done' }));setErr(e);if(!e)setFiling(null); }} /><Btn small label="Cancel" onPress={() => setFiling(null)} /></Row>
            </View>
          ) : <Btn small label="File…" a11y={`File ${it.title}`} onPress={() => setFiling(it)} />}
        </Card>
      ))}
      <Card title="Saved">
        <Choice label="Collection" value={col ?? ''} options={cols.map((x) => [x.id, `${x.name} (${x.count})`] as const)} onChange={setCol} />
        <Btn label="New collection" onPress={()=>setCollectionEdit({id:null,name:''})}/>
        {cols.filter(x=>x.id===col&&x.kind==='custom').map(x=><Row key={x.id}><Btn small label="Rename collection" onPress={()=>setCollectionEdit({id:x.id,name:x.name})}/><Btn small danger label="Delete collection" onPress={()=>confirmRemove(x.name,'Saved links move to Inbox; the links themselves remain.',()=>{phoneClan().saved.removeCollection(me(),x.id);setCol(null);},setErr)}/></Row>)}
        {items.map(s=><Card key={s.id} title={s.title}><Muted>{s.source}</Muted><Row><Btn small label="Open link" onPress={()=>{void Linking.openURL(s.url).catch(e=>setErr(e.message));}}/><Btn small label="Edit saved link" onPress={()=>setEditing(s)}/><Btn small danger label="Delete saved link" a11y={`Delete saved ${s.title}`} onPress={()=>confirmRemove(s.title,'Removes your saved link and its shares on linked devices. The website and independent copies remain.',()=>phoneClan().saved.remove(me(),s.id),setErr)}/></Row><Choice label={`Move ${s.title}`} value={s.collectionId} options={cols.map(x=>[x.id,x.name] as const)} onChange={id=>setErr(act(()=>phoneClan().saved.move(me(),s.id,id)))}/></Card>)}
      </Card>
      <Card title="Personal files"><Muted small>Files used by a timetable, course, task or exam must be detached there before removal.</Muted>{files.map(f=><Row key={f.refId}><Muted>{f.name}</Muted><Btn small danger label="Delete file" a11y={`Delete file ${f.name}`} onPress={()=>confirmRemove(f.name,'Remove your personal library reference from linked devices. Independently referenced copies remain.',()=>phoneClan().files.remove(me(),f.refId),setErr)}/></Row>)}</Card><Err msg={err}/>
    </Screen>
  );
}
