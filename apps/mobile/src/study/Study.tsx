// Phone Study: Today · Courses · Tasks · Exams · Cards · Session. Same model and algorithms as desktop; stored on this
// phone only. No 3D. Dates are typed as "YYYY-MM-DD HH:MM" (no date-picker dependency).
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { GRADES, RECURRENCES, TOPIC_STATE_LABEL, TOPIC_STATES, type Grade, type Recurrence, type TopicState } from '@classroom/protocol';
import { S, type MCard } from './model';
import { loadStudy, useStudy } from './store';
import { GuideTab } from './Guide';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string; bg: string };
type Tab = 'today' | 'courses' | 'tasks' | 'exams' | 'cards' | 'session' | 'guide';
const TABS: [Tab, string][] = [['today', 'Today'], ['courses', 'Courses'], ['tasks', 'Tasks'], ['exams', 'Exams'], ['cards', 'Cards'], ['session', 'Session'], ['guide', 'Ask CLAN']];
const parse = (v: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(v.trim()); return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 9), +(m[5] ?? 0)).getTime() : null; };
const when = (t: number | null) => (t === null ? '' : new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));

export function StudyScreen({ c, onBack }: { c: C; onBack(): void }) {
  const [tab, setTab] = useState<Tab>('today');
  const [s, apply] = useStudy();
  const [err, setErr] = useState<string | null>(null);
  const run = (f: Parameters<typeof apply>[0]) => { const e = apply(f); setErr(e); return !e; };
  const P = { c, s, run };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: c.text, fontSize: 24, fontWeight: '800' }}>Study</Text>
        <Btn c={c} label="Back" onPress={onBack} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} accessibilityRole="tablist">
        {TABS.map(([t, l]) => <Btn key={t} c={c} label={l} on={tab === t} onPress={() => setTab(t)} role="tab" />)}
      </ScrollView>
      {!!err && <Text style={{ color: c.danger }} accessibilityLiveRegion="polite">{err}</Text>}
      {tab === 'today' && <Today {...P} />}
      {tab === 'courses' && <Courses {...P} />}
      {tab === 'tasks' && <Tasks {...P} />}
      {tab === 'exams' && <Exams {...P} />}
      {tab === 'cards' && <Cards {...P} />}
      {tab === 'session' && <Session {...P} />}
      {tab === 'guide' && <GuideTab {...P} />}
      <Text style={{ color: c.muted, fontSize: 12 }}>Stored on this phone only. Nothing here needs the internet.</Text>
    </ScrollView>
  );
}

type P = { c: C; s: ReturnType<typeof useStudy>[0]; run(f: Parameters<ReturnType<typeof useStudy>[1]>[0]): boolean };
const courseName = (s: P['s'], id: string | null) => s.courses.find((x) => x.id === id)?.name ?? 'General';

function Today({ c, s, run }: P) {
  const now = Date.now(), items = S.today(s, now);
  return (
    <Card c={c} title="Today">
      {items.length === 0 && <Text style={{ color: c.muted }}>Nothing due today.</Text>}
      {items.map((i) => (
        <Row key={i.kind + i.id} c={c}>
          <Text style={{ flex: 1, color: i.overdue ? c.danger : c.text }}>{i.title}{'\n'}<Text style={{ color: c.muted, fontSize: 12 }}>{i.source} · {when(i.at)}{i.courseId ? ` · ${courseName(s, i.courseId)}` : ''}</Text></Text>
          {i.kind === 'reminder' && <Btn c={c} label="Done" onPress={() => run((x, k) => S.reminderDone(x, i.id, k.now))} />}
          {i.kind === 'reminder' && <Btn c={c} label="+1 h" onPress={() => run((x, k) => S.snooze(x, i.id, k.now + 3_600_000))} />}
          {i.kind === 'task' && <Btn c={c} label="Done" onPress={() => run((x) => S.setTaskStatus(x, i.id, 'done'))} />}
        </Row>
      ))}
      <NewReminder c={c} run={run} />
    </Card>
  );
}

function NewReminder({ c, run }: Pick<P, 'c' | 'run'>) {
  const [t, setT] = useState(''); const [at, setAt] = useState(''); const [rec, setRec] = useState<Recurrence>('none');
  return (
    <View style={{ gap: 6 }}>
      <Input c={c} value={t} onChange={setT} placeholder="Reminder" label="Reminder text" />
      <Input c={c} value={at} onChange={setAt} placeholder="2026-10-20 09:00" label="Reminder time" />
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>{RECURRENCES.map((r) => <Btn key={r} c={c} label={r === 'none' ? 'Once' : r} on={rec === r} onPress={() => setRec(r)} />)}</View>
      <Btn c={c} primary label="Add reminder" onPress={() => { const d = parse(at); if (d && run((x, k) => S.addReminder(x, k, { text: t, dueAt: d, recurrence: rec }))) { setT(''); setAt(''); } }} />
    </View>
  );
}

function Courses({ c, s, run }: P) {
  const [name, setName] = useState(''); const [code, setCode] = useState('');
  const [open, setOpen] = useState<string | null>(null); const [topic, setTopic] = useState('');
  return (
    <>
      {s.courses.map((k) => (
        <Card key={k.id} c={c} title={`${k.code ? `${k.code} · ` : ''}${k.name}`} onPress={() => setOpen(open === k.id ? null : k.id)}>
          <Text style={{ color: c.muted }}>{S.topics(s, k.id).filter((t) => t.state === 'confident').length} of {S.topics(s, k.id).length} topics marked Confident{k.clanId ? ' · linked Classroom' : ''}</Text>
          {open === k.id && <>
            {S.topics(s, k.id).map((t, i) => (
              <Row key={t.id} c={c}>
                <Text style={{ flex: 1, color: c.text }}>{t.title}</Text>
                <Btn c={c} label={TOPIC_STATE_LABEL[t.state]} onPress={() => run((x) => S.setConfidence(x, t.id, TOPIC_STATES[(TOPIC_STATES.indexOf(t.state) + 1) % 4] as TopicState))} hint="Tap to change your mark" />
                {i > 0 && <Btn c={c} label="↑" onPress={() => run((x) => S.moveTopic(x, t.id, i - 1))} hint={`Move ${t.title} up`} />}
              </Row>
            ))}
            <Input c={c} value={topic} onChange={setTopic} placeholder="Add a topic" label="New topic" />
            <Btn c={c} label="Add topic" onPress={() => { if (run((x, kk) => S.addTopic(x, kk, k.id, topic))) setTopic(''); }} />
            {s.links.filter((l) => l.courseId === k.id).map((l) => <Row key={l.id} c={c}><Text style={{ flex: 1, color: c.text }}>{l.module === 'file' ? '▤' : '↗'} {l.title}</Text><Btn c={c} label="Remove" onPress={() => run((x) => S.unlink(x, l.id))} /></Row>)}
            {s.assignments.filter((a) => a.clanId === k.clanId).map((a) => <Text key={a.id} style={{ color: c.text }}>Classroom Assignment · {a.title} · {a.status}{a.dueAt ? ` · ${when(a.dueAt)}` : ''}</Text>)}
          </>}
        </Card>
      ))}
      <Card c={c} title="New course">
        <Input c={c} value={name} onChange={setName} placeholder="Operating Systems" label="Course name" />
        <Input c={c} value={code} onChange={setCode} placeholder="CS-330 (optional)" label="Course code" />
        <Btn c={c} primary label="Add course" onPress={() => { if (run((x, k) => S.addCourse(x, k, { name, code }))) { setName(''); setCode(''); } }} />
      </Card>
    </>
  );
}

function Tasks({ c, s, run }: P) {
  const [t, setT] = useState(''); const [due, setDue] = useState(''); const [cid, setCid] = useState<string | null>(null);
  const open = s.tasks.filter((x) => x.status === 'todo' || x.status === 'in_progress');
  return (
    <Card c={c} title="Tasks">
      {open.map((x) => <Row key={x.id} c={c}><Text style={{ flex: 1, color: c.text }}>{x.title}{'\n'}<Text style={{ color: c.muted, fontSize: 12 }}>{courseName(s, x.courseId)}{x.dueAt ? ` · ${when(x.dueAt)}` : ''}</Text></Text>
        <Btn c={c} label={x.status === 'todo' ? 'Start' : 'Done'} onPress={() => run((y) => S.setTaskStatus(y, x.id, x.status === 'todo' ? 'in_progress' : 'done'))} /></Row>)}
      {!open.length && <Text style={{ color: c.muted }}>No open tasks.</Text>}
      <Input c={c} value={t} onChange={setT} placeholder="New task" label="Task title" />
      <Input c={c} value={due} onChange={setDue} placeholder="Due: 2026-10-20 17:00 (optional)" label="Task due" />
      <CoursePick c={c} s={s} value={cid} onChange={setCid} />
      <Btn c={c} primary label="Add task" onPress={() => { const d = due.trim() ? parse(due) : null; if (due.trim() && !d) return; if (run((x, k) => S.addTask(x, k, { title: t, dueAt: d, courseId: cid }))) { setT(''); setDue(''); } }} />
    </Card>
  );
}

function Exams({ c, s, run }: P) {
  const [name, setName] = useState(''); const [at, setAt] = useState(''); const [cid, setCid] = useState<string | null>(null); const [scope, setScope] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();
  return (
    <>
      {s.exams.filter((e) => e.status === 'upcoming').map((e) => {
        const p = S.prep(s, e.id, now);
        return (
          <Card key={e.id} c={c} title={`${e.name} · ${p.countdown.label}`} onPress={() => setOpen(open === e.id ? null : e.id)}>
            <Text style={{ color: c.muted }}>{courseName(s, e.courseId)} · {when(e.at)}</Text>
            <Text style={{ color: c.text, fontWeight: '700' }}>{p.readiness ? p.readiness.label : 'No topics in scope'}</Text>
            {open === e.id && <>
              <Text style={{ color: c.muted, fontSize: 12 }}>Counted from your own topic marks only. Nothing is estimated.</Text>
              {p.remaining.map((t) => <Text key={t.id} style={{ color: c.text }}>• {t.title} — {TOPIC_STATE_LABEL[t.state]}</Text>)}
              <Text style={{ color: c.text }}>{p.dueCards} cards due · {p.tasks.length} open tasks · {p.links.length} linked items</Text>
              <Btn c={c} label="Mark completed" onPress={() => run((x) => S.setExamStatus(x, e.id, 'completed'))} />
            </>}
          </Card>
        );
      })}
      <Card c={c} title="New exam">
        <CoursePick c={c} s={s} value={cid} onChange={(v) => { setCid(v); setScope([]); }} required />
        <Input c={c} value={name} onChange={setName} placeholder="Midterm" label="Exam name" />
        <Input c={c} value={at} onChange={setAt} placeholder="2026-11-02 10:00" label="Exam date" />
        {cid && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{S.topics(s, cid).map((t) => <Btn key={t.id} c={c} label={t.title} on={scope.includes(t.id)} onPress={() => setScope(scope.includes(t.id) ? scope.filter((x) => x !== t.id) : [...scope, t.id])} />)}</View>}
        <Btn c={c} primary label="Add exam" onPress={() => { const d = parse(at); if (d && cid && run((x, k) => S.addExam(x, k, { courseId: cid, name, at: d, topicIds: scope }))) { setName(''); setAt(''); setScope([]); } }} />
      </Card>
    </>
  );
}

function Cards({ c, s, run }: P) {
  const [name, setName] = useState(''); const [deck, setDeck] = useState<string | null>(null);
  const [front, setFront] = useState(''); const [back, setBack] = useState('');
  const [card, setCard] = useState<MCard | null>(null); const [shown, setShown] = useState(false);
  const now = Date.now();
  const next = (d: string) => { setCard(S.queue(loadStudy(), d, Date.now())[0] ?? null); setShown(false); }; // fresh state: the review just persisted
  if (deck && card) return (
    <Card c={c} title="Review">
      <Pressable accessibilityRole="button" accessibilityLabel={shown ? `Answer: ${card.back}` : `Question: ${card.front}. Tap to show the answer.`} onPress={() => setShown(true)}
        style={{ minHeight: 160, borderRadius: 16, borderWidth: 1, borderColor: c.border, padding: 16, justifyContent: 'center', backgroundColor: c.bg }}>
        <Text style={{ color: c.text, fontSize: 20, fontWeight: '600', textAlign: 'center' }}>{shown ? card.back : card.front}</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
        {GRADES.map((g: Grade) => <Btn key={g} c={c} label={g[0]!.toUpperCase() + g.slice(1)} disabled={!shown} onPress={() => { run((x, k) => S.review(x, card.id, g, k.now)); setTimeout(() => next(deck), 0); }} />)}
      </View>
      <Btn c={c} label="Stop" onPress={() => setCard(null)} />
    </Card>
  );
  return (
    <>
      {s.decks.map((d) => { const due = S.queue(s, d.id, now).length; return (
        <Card key={d.id} c={c} title={d.name} onPress={() => setDeck(deck === d.id ? null : d.id)}>
          <Text style={{ color: c.muted }}>{s.cards.filter((x) => x.deckId === d.id).length} cards · {due} due · {courseName(s, d.courseId)}</Text>
          {deck === d.id && <>
            <Btn c={c} primary label={`Review ${due} due`} disabled={!due} onPress={() => next(d.id)} />
            <Input c={c} value={front} onChange={setFront} placeholder="Front" label="Card front" />
            <Input c={c} value={back} onChange={setBack} placeholder="Back" label="Card back" />
            <Btn c={c} label="Add card" onPress={() => { if (run((x, k) => S.addCard(x, k, d.id, front, back))) { setFront(''); setBack(''); } }} />
          </>}
        </Card>); })}
      <Card c={c} title="New deck">
        <Input c={c} value={name} onChange={setName} placeholder="OS terms" label="Deck name" />
        <Btn c={c} primary label="Add deck" onPress={() => { if (run((x, k) => S.addDeck(x, k, { name }))) setName(''); }} />
      </Card>
    </>
  );
}

function Session({ c, s, run }: P) {
  const active = S.active(s);
  const [goal, setGoal] = useState(''); const [cid, setCid] = useState<string | null>(null); const [reflection, setReflection] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  if (active) {
    const sec = Math.max(0, Math.floor((now - active.startedAt) / 1000));
    return (
      <Card c={c} title={active.focus ? 'Focus session' : 'Study session'}>
        <Text style={{ color: c.text }}>{active.goal || 'Study'} · {courseName(s, active.courseId)}</Text>
        <Text style={{ color: c.text, fontSize: 36, fontWeight: '800' }} accessibilityRole="timer">{String(Math.floor(sec / 60)).padStart(2, '0')}:{String(sec % 60).padStart(2, '0')}</Text>
        <Input c={c} value={reflection} onChange={setReflection} placeholder="How did it go? (optional)" label="Reflection" />
        <Btn c={c} primary label="End session" onPress={() => { if (run((x, k) => S.endSession(x, active.id, k.now, reflection))) setReflection(''); }} />
      </Card>
    );
  }
  return (
    <>
      <Card c={c} title="Start studying">
        <Input c={c} value={goal} onChange={setGoal} placeholder="Goal (optional)" label="Study goal" />
        <CoursePick c={c} s={s} value={cid} onChange={setCid} />
        <Btn c={c} primary label="Start (focus)" onPress={() => run((x, k) => S.startSession(x, k, { courseId: cid, goal, focus: true }))} />
      </Card>
      <Card c={c} title="Last 30 days">
        {S.history(s, Date.now() - 30 * 86_400_000).map((r) => <Text key={r.courseId ?? 'g'} style={{ color: c.text }}>{courseName(s, r.courseId)} · {r.sessions} sessions · {r.minutes} min · {r.reviews} reviews</Text>)}
      </Card>
    </>
  );
}

function CoursePick({ c, s, value, onChange, required }: { c: C; s: P['s']; value: string | null; onChange(v: string | null): void; required?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityLabel="Course">
      {!required && <Btn c={c} label="General" on={value === null} onPress={() => onChange(null)} />}
      {s.courses.map((k) => <Btn key={k.id} c={c} label={k.code || k.name} on={value === k.id} onPress={() => onChange(k.id)} />)}
    </View>
  );
}
function Card({ c, title, children, onPress }: { c: C; title: string; children: React.ReactNode; onPress?(): void }) {
  return (
    <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 12, gap: 8, backgroundColor: c.surface }}>
      {onPress ? <Pressable accessibilityRole="button" onPress={onPress}><Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }}>{title}</Text></Pressable> : <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }}>{title}</Text>}
      {children}
    </View>
  );
}
const Row = ({ c, children }: { c: C; children: React.ReactNode }) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderTopWidth: 1, borderColor: c.border, paddingTop: 6 }}>{children}</View>;
function Input({ c, value, onChange, placeholder, label }: { c: C; value: string; onChange(v: string): void; placeholder: string; label: string }) {
  return <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={c.muted} accessibilityLabel={label} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 12, paddingHorizontal: 10, minHeight: 44, color: c.text }} />;
}
function Btn({ c, label, onPress, primary, on, disabled, role, hint }: { c: C; label: string; onPress(): void; primary?: boolean; on?: boolean; disabled?: boolean; role?: 'tab'; hint?: string }) {
  return (
    <Pressable accessibilityRole={role ?? 'button'} accessibilityState={{ selected: on, disabled }} accessibilityHint={hint} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: primary || on ? c.accent : c.border, backgroundColor: primary ? c.accent : on ? c.bg : c.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
      <Text style={{ color: primary ? '#fff' : on ? c.accent : c.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}
