// Diary on the phone (core's Diary module). Private: never shared, never searchable, read by AI only with your
// explicit permission on this device, and synced to your other devices only if you turn that on in My Devices.
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { phoneClan, me } from '../core/clan';
import { act, Btn, Card, Choice, Err, Field, H1, Muted, Screen, useC, useData } from '../ui/kit';

const MOODS = [['calm', 'Calm'], ['happy', 'Happy'], ['proud', 'Proud'], ['tired', 'Tired'], ['anxious', 'Anxious'], ['low', 'Low']] as const;
const today = () => new Date().toLocaleDateString('en-CA');

export function DiaryScreen() {
  const c = useC();
  const entry = useData(() => phoneClan().diary.day(me(), today()));
  const recent = useData(() => phoneClan().diary.recent(me(), 14)) ?? [];
  const syncing = useData(() => phoneClan().sync.settings().syncDiary) ?? false;
  const [body, setBody] = useState(''), [mood, setMood] = useState<string>(''), [err, setErr] = useState<string | null>(null), [saved, setSaved] = useState(false);
  useEffect(() => { if (entry) { setBody(entry.body); setMood(entry.mood ?? ''); } }, [entry?.id]);
  return (
    <Screen>
      <H1>Diary</H1>
      <Card title={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} tone="burgundy">
        <Choice label="Mood (optional)" value={mood} options={MOODS} onChange={setMood} />
        <Field label="Today" value={body} onChange={(v) => { setBody(v); setSaved(false); }} multiline placeholder="Only you can read this." />
        <Btn primary label={saved ? 'Saved' : 'Save'} onPress={() => { const e = act(() => phoneClan().diary.write(me(), { day: today(), body, mood: (mood || undefined) as never })); setErr(e); setSaved(!e); }} />
        <Err msg={err} />
        <Muted small>{syncing ? 'Diary syncs to your linked devices (encrypted in transit).' : 'Diary stays on this phone. Syncing it is off (My Devices).'}</Muted>
      </Card>
      {recent.filter((e) => e.day !== today()).map((e) => (
        <Card key={e.id}><Text style={{ color: c.text2, fontWeight: '700' }}>{e.day}{e.mood ? ` · ${e.mood}` : ''}</Text><Text style={{ color: c.text }} numberOfLines={4}>{e.body}</Text></Card>
      ))}
    </Screen>
  );
}
