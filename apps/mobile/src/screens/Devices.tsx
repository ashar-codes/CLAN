// Me › My Devices on the phone: link to your computer (code shown there, approved there), your linked devices, real
// sync counters, conflicts to compare, Unlink, and what syncs (Diary opt-in, large files opt-in).
import { useState } from 'react';
import { Text, View } from 'react-native';
import { phoneClan } from '../core/clan';
import { isSyncing, linkWithCode, startOverPhoneSync, syncNow } from '../sync/phone';
import { act, bump, Btn, Card, Choice, Err, Field, H1, Muted, Row, Screen, useC, useData, when } from '../ui/kit';

const KIND: Record<string, string> = { note: 'Note', diary: 'Diary entry', task: 'Task', course: 'Course', reminder: 'Reminder', exam: 'Exam', deck: 'Deck', 'saved-item': 'Saved item', tape: 'Study Tape', file: 'File', profile: 'Profile' };
const show = (v: unknown) => v === null ? '(deleted)' : typeof v === 'object' ? String((v as { body?: string; title?: string; name?: string }).body ?? (v as { title?: string }).title ?? (v as { name?: string }).name ?? JSON.stringify(v).slice(0, 300)) : String(v);
const mb = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

export function DevicesScreen() {
  const c = useC();
  const s = phoneClan().sync;
  const devices = useData(() => s.devices()) ?? [];
  const stats = useData(() => s.stats());
  const settings = useData(() => s.settings());
  const conflicts = useData(() => s.conflicts()) ?? [];
  const revoked = useData(() => s.selfRevoked()) ?? false;
  const [code, setCode] = useState(''), [addr, setAddr] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null);
  const others = devices.filter((d) => !d.current);
  const run = async (f: () => Promise<unknown>, done: string) => { setBusy(true); setMsg(null); try { await f(); setMsg(done); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); bump(); } };
  return (
    <Screen>
      <H1>My Devices</H1>
      {revoked && <Card tone="danger"><Text style={{ color: c.text }} accessibilityRole="alert">This phone was unlinked from your other devices. It no longer syncs; what is already here stays here.</Text>
        <Btn label="Link this phone again" onPress={() => void run(() => startOverPhoneSync(devices.find((d) => d.current)?.name ?? 'Phone'), 'Ready to link as a new device.')} /></Card>}
      {devices.map((d) => (
        <Card key={d.fp}>
          <Text style={{ color: c.text, fontWeight: '700' }}>{d.name} <Text style={{ color: c.muted, fontWeight: '400' }}>{d.platform}{d.current ? ' · this phone' : ''}{d.revoked ? ' · unlinked' : ''}</Text></Text>
          {!d.current && !d.revoked && <Muted small>Last sync {d.lastSync ? when(d.lastSync) : 'never'}{d.error ? ` · ${d.error}` : ''}</Muted>}
          {!d.current && !d.revoked && !revoked && (confirm === d.fp
            ? <Row><Muted small>It stops syncing now; what's on it stays on it.</Muted><Btn small danger label={`Unlink ${d.name}`} onPress={() => { setMsg(act(() => s.revoke(d.fp))); setConfirm(null); void syncNow(); }} /><Btn small label="Keep" onPress={() => setConfirm(null)} /></Row>
            : <Btn small danger label="Unlink" a11y={`Unlink ${d.name}`} onPress={() => setConfirm(d.fp)} />)}
        </Card>
      ))}
      {others.length > 0 && stats && (
        <Card title="Sync">
          <Muted>{isSyncing() ? 'Syncing…' : settings?.paused ? 'Paused.' : 'Syncs when this phone and your computer are on the same Wi-Fi and CLAN is open.'}</Muted>
          <Muted small>{stats.pending} change{stats.pending === 1 ? '' : 's'} not yet sent{stats.transfers ? ` · ${stats.transfers} files to fetch (${mb(stats.transferBytes)})` : ''}{stats.skippedBytes ? ` · ${mb(stats.skippedBytes)} of large files not downloaded` : ''}{stats.deferred ? ` · ${stats.deferred} waiting for related items` : ''}</Muted>
          <Btn primary label={busy ? 'Syncing…' : 'Sync now'} disabled={busy || revoked} onPress={() => void run(async () => { const r = await syncNow(); if (r.error && !r.ok) throw new Error(r.error); }, 'Synced.')} />
        </Card>
      )}
      {!revoked && (
        <Card title={others.length ? 'Link to another computer' : 'Link this phone to your computer'}>
          <Muted>On your computer open Me › My Devices › “Link a new device”, then type the code it shows. Approve on the computer.</Muted>
          <Field label="Link code" value={code} onChange={setCode} placeholder="CLAN-XXXX-XXXX-XXXX" autoCapitalize="characters" autoCorrect={false} />
          <Field label="Computer address (only if not found)" value={addr} onChange={setAddr} placeholder="192.168.1.20:52341" keyboardType="numbers-and-punctuation" autoCapitalize="none" />
          <Btn primary label={busy ? 'Waiting for approval on your computer…' : 'Link'} disabled={busy || !code.trim()} onPress={() => void run(() => linkWithCode(code, addr), 'Linked. Your data is coming across.').then(() => setCode(''))} />
          <Muted small>The phone gets your personal study data. It does not join your CLANs or get host rights, and your AI key stays on each device.</Muted>
        </Card>
      )}
      {conflicts.map((x) => (
        <Card key={x.id} title={`${KIND[x.kind] ?? x.kind} — needs your choice`} tone="warn">
          <Muted>{x.note}</Muted>
          <View style={{ gap: 6 }}><Muted small>This phone</Muted><Text style={{ color: c.text }} numberOfLines={8}>{show(x.local)}</Text><Muted small>{x.fromDevice}</Muted><Text style={{ color: c.text }} numberOfLines={8}>{show(x.remote)}</Text></View>
          <Row>
            <Btn small label="Keep this phone's" onPress={() => { setMsg(act(() => s.resolve(x.id, 'mine'))); void syncNow(); }} />
            <Btn small label={`Use ${x.fromDevice}'s`} onPress={() => { setMsg(act(() => s.resolve(x.id, 'theirs'))); void syncNow(); }} />
            {x.canKeepBoth && <Btn small label="Keep both" onPress={() => { setMsg(act(() => s.resolve(x.id, 'both'))); void syncNow(); }} />}
          </Row>
        </Card>
      ))}
      {others.length > 0 && settings && !revoked && (
        <Card title="What syncs">
          <Muted small>Profile, courses, notes, Saved, Inbox, tasks, reminders, exams, flashcards and reviews, study sessions, boards and your own files. Never: CLANs, chats, other people's files, or your AI key.</Muted>
          <Choice label="Diary" value={settings.syncDiary ? 'on' : 'off'} options={[['off', 'Stays on this phone'], ['on', 'Sync Diary']]} onChange={(v) => setMsg(act(() => s.setSettings({ syncDiary: v === 'on' })))} />
          <Choice label="Files" value={settings.files} options={[['small', 'Up to 50 MB'], ['all', 'All, incl. recordings'], ['off', 'None']]} onChange={(v) => setMsg(act(() => s.setSettings({ files: v as 'all' | 'small' | 'off' })))} />
          <Choice label="Sync on this phone" value={settings.paused ? 'paused' : 'on'} options={[['on', 'On'], ['paused', 'Paused']]} onChange={(v) => setMsg(act(() => s.setSettings({ paused: v === 'paused' })))} />
        </Card>
      )}
      <Card title="Lost a device?"><Muted small>Unlink it here or on your computer: it is refused from then on. Its local copy can't be erased remotely — use the device's own lock or erase. There is no cloud copy.</Muted></Card>
      <Err msg={msg && !/^(Synced|Linked)/.test(msg) ? msg : null} />
      {msg && /^(Synced|Linked)/.test(msg) && <Muted>{msg}</Muted>}
    </Screen>
  );
}
