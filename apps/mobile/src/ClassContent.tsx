import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { formatBytes } from '@classroom/client';
import { extensionOf, type ClientMessage, type ResourceView, type StudentAssignmentView, type TransferState } from '@classroom/protocol';
import { check, clearIdempotencyKey, download, fileStates, idempotencyKeyFor, pause, receipts as loadReceipts, submit, type Conn, type FileState, type StoredReceipt } from './transfers';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string; ok: string; warn: string };
const LABEL: Record<TransferState, string> = { not_started: 'Not downloaded', queued: 'Queued', downloading: 'Downloading', paused: 'Paused', verifying: 'Verifying…', completed: 'Downloaded', failed: 'Failed' };

export function ClassContent({ c, conn, resources, assignments, pushed, send }: {
  c: C; conn: Conn; resources: ResourceView[]; assignments: StudentAssignmentView[]; pushed: string | null; send(m: ClientMessage): void;
}) {
  const [states, setStates] = useState<Record<string, FileState>>({});
  const [uploads, setUploads] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [myReceipts, setMyReceipts] = useState<StoredReceipt[]>(() => loadReceipts(conn));
  const auto = useRef(new Set<string>());

  const onState = (s: FileState) => {
    setStates((x) => ({ ...x, [s.resourceId]: s }));
    send({ t: 'transfer.state', resourceId: s.resourceId, state: s.state, bytes: s.bytes });
  };
  useEffect(() => { setStates((x) => ({ ...Object.fromEntries(fileStates(conn, resources).map((s) => [s.resourceId, s])), ...pickActive(x) })); }, [resources, conn]);
  useEffect(() => {
    for (const r of resources) {
      if ((r.pushed || r.id === pushed) && !auto.current.has(r.id) && (states[r.id]?.state ?? 'not_started') === 'not_started') {
        auto.current.add(r.id);
        void download(conn, r, onState);
      }
    }
  }, [resources, pushed, states]);

  const submitFor = async (a: StudentAssignmentView) => {
    setErrors((x) => ({ ...x, [a.id]: '' }));
    const pick = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const f = pick.canceled ? null : pick.assets[0];
    if (!f) return;
    const size = f.size ?? new File(f.uri).size ?? 0;
    if (a.allowedExtensions.length && !a.allowedExtensions.includes(extensionOf(f.name))) return setErrors((x) => ({ ...x, [a.id]: `Allowed: ${a.allowedExtensions.map((e) => '.' + e).join(' ')}` }));
    if (size > a.maxBytes) return setErrors((x) => ({ ...x, [a.id]: `That file is ${formatBytes(size)}; the limit is ${formatBytes(a.maxBytes)}.` }));
    // Persist the idempotency key before sending so a retry (even after an app restart) can't duplicate.
    const k = `${conn.sessionId}:${a.id}:${f.name}:${size}`;
    const idem = idempotencyKeyFor(k, randomUUID);
    setUploads((x) => ({ ...x, [a.id]: 0 }));
    try {
      await submit(conn, a.id, { uri: f.uri, name: f.name, size }, idem, (sent, total) => setUploads((x) => ({ ...x, [a.id]: total ? sent / total : 0 })));
      clearIdempotencyKey(k);
      setMyReceipts(loadReceipts(conn));
    } catch (e) {
      setErrors((x) => ({ ...x, [a.id]: `${(e as Error).message} You can retry; nothing will be submitted twice.` }));
    } finally {
      setUploads(({ [a.id]: _, ...rest }) => rest);
    }
  };

  return (
    <View style={{ gap: 22 }}>
      <View style={{ gap: 10 }}>
        <Text style={[st.h2, { color: c.text }]}>Classroom files</Text>
        {resources.length === 0 && <Text style={{ color: c.muted }}>Your teacher hasn't shared any files yet.</Text>}
        {resources.map((r) => {
          const s = states[r.id] ?? { state: 'not_started' as const, bytes: 0, size: r.size, resourceId: r.id };
          const pct = r.size ? Math.min(100, Math.floor((s.bytes / r.size) * 100)) : 100;
          return (
            <View key={r.id} style={[st.card, { borderColor: c.border, backgroundColor: c.surface }]}>
              <Text style={{ color: c.text, fontWeight: '600', fontSize: 16 }} numberOfLines={2}>{r.name}</Text>
              <Text style={{ color: s.state === 'failed' ? c.danger : c.muted }}>{formatBytes(r.size)} · {LABEL[s.state]}{s.state === 'downloading' ? ` ${pct}%` : ''}{s.error ? ` — ${s.error}` : ''}</Text>
              {s.state === 'downloading' && <View style={[st.bar, { backgroundColor: c.border }]}><View style={{ width: `${pct}%`, height: '100%', backgroundColor: c.accent }} /></View>}
              <View style={st.row}>
                {(s.state === 'not_started' || s.state === 'failed' || s.state === 'paused') && <Btn c={c} primary label={s.state === 'paused' ? 'Resume' : s.state === 'failed' ? 'Retry' : 'Download'} onPress={() => download(conn, r, onState)} />}
                {s.state === 'downloading' && <Btn c={c} label="Pause" onPress={() => pause(r)} />}
                {/* Share sheet hands the file to a viewer app chosen by the student; nothing is executed. */}
                {s.state === 'completed' && s.uri && <Btn c={c} label="Open with…" onPress={() => Sharing.shareAsync(s.uri!)} />}
              </View>
            </View>
          );
        })}
      </View>

      <View style={{ gap: 10 }}>
        <Text style={[st.h2, { color: c.text }]}>Assignments</Text>
        {assignments.length === 0 && <Text style={{ color: c.muted }}>No assignments yet.</Text>}
        {assignments.map((a) => (
          <View key={a.id} style={[st.card, { borderColor: c.border, backgroundColor: c.surface }]}>
            <Text style={{ color: c.text, fontWeight: '600', fontSize: 16 }}>{a.title}{a.closed ? ' (closed)' : ''}</Text>
            <Text style={{ color: c.muted }}>{a.dueAt ? `Due ${new Date(a.dueAt).toLocaleString()}` : 'No due time'} · {a.allowedExtensions.length ? a.allowedExtensions.map((e) => '.' + e).join(' ') : 'any type'} · up to {formatBytes(a.maxBytes)}</Text>
            {!!a.instructions && <Text style={{ color: c.text }}>{a.instructions}</Text>}
            {a.latest && (() => {
              const v = check(a.latest, conn.teacherPublicKey);
              const p = a.latest.payload;
              return (
                <View style={[st.receipt, { borderColor: v.verified ? c.ok : c.danger }]}>
                  <Text style={{ color: v.verified ? c.ok : c.danger, fontWeight: '600' }}>{v.verified ? 'Verified ✓' : `Verification failed — ${v.reason}`}</Text>
                  <Text style={{ color: c.text }}>Submitted{p.late ? ' (late)' : ''}: {p.fileName} · {formatBytes(p.size)}</Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>{new Date(p.submittedAt).toLocaleString()} · receipt {p.submissionId.slice(0, 8)} · SHA-256 {p.sha256.slice(0, 12)}…</Text>
                </View>
              );
            })()}
            {a.id in uploads && <Text style={{ color: c.muted }}>Uploading… {Math.floor(uploads[a.id]! * 100)}%</Text>}
            {!!errors[a.id] && <Text style={{ color: c.danger }}>{errors[a.id]}</Text>}
            {!a.closed && !(a.id in uploads) && <Btn c={c} primary={!a.latest} label={a.latest ? 'Submit a new version' : 'Submit file'} onPress={() => submitFor(a)} />}
          </View>
        ))}
        {myReceipts.length > 0 && <Text style={{ color: c.muted }}>{myReceipts.length} receipt(s) saved on this phone.</Text>}
      </View>
    </View>
  );
}

const pickActive = (x: Record<string, FileState>) => Object.fromEntries(Object.entries(x).filter(([, s]) => s.state === 'downloading' || s.state === 'verifying'));

function Btn({ c, label, onPress, primary }: { c: C; label: string; onPress(): void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [st.btn, { backgroundColor: primary ? c.accent : 'transparent', borderColor: primary ? c.accent : c.border, opacity: pressed ? 0.8 : 1 }]}>
      <Text style={{ color: primary ? '#fff' : c.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  h2: { fontSize: 20, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 8 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  bar: { height: 6, borderRadius: 3, overflow: 'hidden' },
  btn: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 18, minHeight: 44, justifyContent: 'center' },
  receipt: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 2 },
});
