// Phone Guide: Ask CLAN in a course/exam context, streamed where the runtime can (React Native fetch usually can't stream,
// so the answer then arrives at once), citations to the phone's own study data, and draft-card review. The API key is in
// the OS secure store, keyed by the provider address. Device runtime UNVERIFIED (typecheck + unit tests only).
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';
import { AI_SETUP, AI_UNAVAILABLE, AIError, openAICompatible, type GroundedAnswer } from '@classroom/protocol';
import { S } from './model';
import { ask, draftCards, type PhoneCitation, type PhoneScope } from './ai';
import type { useStudy } from './store';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string; bg: string };
type Cfg = { baseUrl: string; model: string };
const cfgFile = () => new File(new Directory(Paths.document, 'CLAN'), 'ai.json');
const loadCfg = (): Cfg => { try { const f = cfgFile(); return f.exists ? JSON.parse(f.textSync()) : { baseUrl: '', model: '' }; } catch { return { baseUrl: '', model: '' }; } };
const keyName = (baseUrl: string) => `clan.ai.key.${baseUrl.replace(/[^A-Za-z0-9]/g, '').slice(0, 80)}`;

export function GuideTab({ c, s, run }: { c: C; s: ReturnType<typeof useStudy>[0]; run(f: Parameters<ReturnType<typeof useStudy>[1]>[0]): boolean }) {
  const [cfg, setCfg] = useState<Cfg>(loadCfg);
  const [key, setKey] = useState(''); const [hasKey, setHasKey] = useState(false);
  const [scope, setScope] = useState<PhoneScope>({ kind: 'global' });
  const [q, setQ] = useState(''); const [stream, setStream] = useState('');
  const [res, setRes] = useState<{ answer: GroundedAnswer; citations: PhoneCitation[] } | null>(null);
  const [drafts, setDrafts] = useState<{ front: string; back: string; from: string; keep: boolean }[]>([]);
  const [msg, setMsg] = useState(''); const ctl = useRef<AbortController | null>(null);
  useEffect(() => { if (cfg.baseUrl) void SecureStore.getItemAsync(keyName(cfg.baseUrl)).then((k) => setHasKey(!!k)); }, [cfg.baseUrl]);
  const provider = () => (cfg.baseUrl && cfg.model ? openAICompatible({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: () => SecureStore.getItemAsync(keyName(cfg.baseUrl)) }) : null);
  const fail = (e: unknown) => setMsg(e instanceof AIError ? (e.code === 'offline' ? `${AI_UNAVAILABLE}. Your study data is still here.` : e.message) : String(e));
  const go = async () => {
    const p = provider(); if (!p) return setMsg(AI_SETUP);
    ctl.current = new AbortController(); setStream(''); setRes(null); setMsg('');
    try { setRes(await ask(p, s, scope, q, { signal: ctl.current.signal, onDelta: (t) => setStream((x) => x + t) })); } catch (e) { fail(e); } finally { ctl.current = null; }
  };
  const courseId = scope.kind === 'course' ? scope.courseId : scope.kind === 'exam' ? s.exams.find((e) => e.id === scope.examId)?.courseId ?? null : null;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 12, gap: 8, backgroundColor: c.surface }}>
        <Text style={{ color: c.text, fontWeight: '700' }}>AI provider (OpenAI-compatible)</Text>
        <TextInput value={cfg.baseUrl} onChangeText={(v) => setCfg({ ...cfg, baseUrl: v.trim() })} placeholder="https://api.example.com/v1" placeholderTextColor={c.muted} accessibilityLabel="Provider address" autoCapitalize="none" style={inp(c)} />
        <TextInput value={cfg.model} onChangeText={(v) => setCfg({ ...cfg, model: v.trim() })} placeholder="Model" placeholderTextColor={c.muted} accessibilityLabel="Model" autoCapitalize="none" style={inp(c)} />
        <TextInput value={key} onChangeText={setKey} secureTextEntry placeholder={hasKey ? 'Key saved — type to replace' : 'API key'} placeholderTextColor={c.muted} accessibilityLabel="API key" style={inp(c)} />
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <B c={c} label="Save" onPress={async () => { const d = new Directory(Paths.document, 'CLAN'); if (!d.exists) d.create({ intermediates: true }); cfgFile().write(JSON.stringify(cfg)); if (key && cfg.baseUrl) { await SecureStore.setItemAsync(keyName(cfg.baseUrl), key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }); setKey(''); setHasKey(true); } setMsg('Saved.'); }} />
          {hasKey && <B c={c} label="Delete key" onPress={async () => { await SecureStore.deleteItemAsync(keyName(cfg.baseUrl)); setHasKey(false); }} />}
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }} accessibilityLabel="Context">
        <B c={c} label="All my study" on={scope.kind === 'global'} onPress={() => setScope({ kind: 'global' })} />
        {s.courses.map((k) => <B key={k.id} c={c} label={k.code || k.name} on={scope.kind === 'course' && scope.courseId === k.id} onPress={() => setScope({ kind: 'course', courseId: k.id })} />)}
        {s.exams.filter((e) => e.status === 'upcoming').map((e) => <B key={e.id} c={c} label={`Exam: ${e.name}`} on={scope.kind === 'exam' && scope.examId === e.id} onPress={() => setScope({ kind: 'exam', examId: e.id })} />)}
      </View>
      <TextInput value={q} onChangeText={setQ} placeholder="Ask CLAN about your study data" placeholderTextColor={c.muted} accessibilityLabel="Ask CLAN" style={inp(c)} onSubmitEditing={go} />
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <B c={c} primary label="Ask" onPress={go} disabled={!q.trim()} />
        {ctl.current && <B c={c} label="Cancel" onPress={() => ctl.current?.abort()} />}
        {courseId && <B c={c} label="Draft flashcards" onPress={async () => { const p = provider(); if (!p) return setMsg(AI_SETUP); try { setDrafts((await draftCards(p, s, courseId)).map((d) => ({ ...d, keep: true }))); } catch (e) { fail(e); } }} />}
      </View>
      {!!msg && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{msg}</Text>}
      {!res && !!stream && <Text style={{ color: c.text }}>{stream}</Text>}
      {res && (
        <View style={{ gap: 6 }} accessibilityLiveRegion="polite">
          {res.answer.material.length ? <Text style={{ color: c.muted, fontWeight: '700' }}>From your CLAN material</Text> : <Text style={{ color: c.text }}>Not found in your study data on this phone.</Text>}
          {res.answer.material.map((m, i) => <Text key={i} style={{ color: c.text }}>{m.text.replace(/\s*\[S\d+\]/g, '')} {m.cites.map((n) => `[${n}]`).join('')}</Text>)}
          {res.citations.map((x) => <Text key={x.n} style={{ color: c.muted, fontSize: 12 }}>[{x.n}] {x.label}</Text>)}
          {res.answer.unsupported.length > 0 && <Text style={{ color: c.muted, fontSize: 12 }}>{res.answer.unsupported.length} unsupported statement(s) left out.</Text>}
        </View>
      )}
      {drafts.length > 0 && courseId && (
        <View style={{ gap: 6, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, borderRadius: 16, padding: 12 }}>
          <Text style={{ color: c.text, fontWeight: '700' }}>Draft cards — not in a deck until you accept</Text>
          {drafts.map((d, i) => <Pressable key={i} accessibilityRole="checkbox" accessibilityState={{ checked: d.keep }} onPress={() => setDrafts(drafts.map((x, k) => (k === i ? { ...x, keep: !x.keep } : x)))}>
            <Text style={{ color: d.keep ? c.text : c.muted, textDecorationLine: d.keep ? 'none' : 'line-through' }}>{d.keep ? '☑' : '☐'} {d.front} — {d.back} <Text style={{ fontSize: 11 }}>({d.from})</Text></Text></Pressable>)}
          <B c={c} primary label={`Accept ${drafts.filter((d) => d.keep).length}`} onPress={() => { const kept = drafts.filter((d) => d.keep); if (run((x, k) => kept.reduce((st, d) => S.addCard(st, k, st.decks.at(-1)!.id, d.front, d.back), S.addDeck(x, k, { name: 'Drafted cards', courseId })))) { setDrafts([]); setMsg(`${kept.length} cards added.`); } }} />
          <B c={c} label="Discard" onPress={() => setDrafts([])} />
        </View>
      )}
    </View>
  );
}
const inp = (c: C) => ({ borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 10, minHeight: 44, color: c.text });
function B({ c, label, onPress, primary, on, disabled }: { c: C; label: string; onPress(): void; primary?: boolean; on?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: on, disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: primary || on ? c.accent : c.border, backgroundColor: primary ? c.accent : c.surface, opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ color: primary ? '#fff' : on ? c.accent : c.text, fontWeight: '600' }}>{label}</Text></Pressable>;
}
