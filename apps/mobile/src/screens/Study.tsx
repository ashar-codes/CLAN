// Phone Study over @clan/core (the same modules as the desktop, synced by PersonalSync): Courses with topic marks,
// Notes, Tasks, Exams, Reminders, Flashcards (SM-2 review) and Study Sessions. Dates use the native pickers.
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { GRADES, RECURRENCES, TOPIC_STATE_LABEL, TOPIC_STATES, countdown, readiness, type Grade, type Recurrence, type TopicState } from '@classroom/protocol';
import type { Card as FCard } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { act, Btn, Card, Choice, DateField, Err, Field, H1, Muted, Row, Screen, useC, useData, when } from '../ui/kit';
import { AskTab } from './Ask';
import { MobileBoard, useLocalBoard } from '../board/Board';

type Tab = 'courses' | 'notes' | 'tasks' | 'exams' | 'reminders' | 'cards' | 'session' | 'boards' | 'ask';
export type MobileStudyTab = Tab;
const TABS: [Tab, string][] = [['courses', 'Courses'], ['notes', 'Notes'], ['tasks', 'Tasks'], ['exams', 'Exams'], ['reminders', 'Reminders'], ['cards', 'Cards'], ['session', 'Session'], ['boards', 'Boards'], ['ask', 'Ask CLAN']];

export function StudyScreen({ initial = 'courses' }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <Screen>
      <H1>Study</H1>
      <Row gap={6}>{TABS.map(([t, l]) => <Btn key={t} small label={l} on={tab === t} onPress={() => setTab(t)} />)}</Row>
      {tab === 'courses' && <Courses />}{tab === 'notes' && <Notes />}{tab === 'tasks' && <Tasks />}{tab === 'exams' && <Exams />}
      {tab === 'reminders' && <Reminders />}{tab === 'cards' && <Cards />}{tab === 'session' && <Session />}{tab === 'boards' && <Boards />}{tab === 'ask' && <AskTab />}
    </Screen>
  );
}

const courseName = (id: string | null) => (id ? phoneClan().courses.list(me()).find((c) => c.id === id)?.name ?? 'Course' : 'General');
function CoursePick({ value, onChange }: { value: string | null; onChange(v: string | null): void }) {
  const courses = useData(() => phoneClan().courses.list(me())) ?? [];
  return <Choice label="Course" value={value ?? ''} options={[['', 'General'] as const, ...courses.map((c) => [c.id, c.name] as const)]} onChange={(v) => onChange(v || null)} />;
}

function Courses() {
  const c = useC();
  const courses = useData(() => phoneClan().courses.list(me())) ?? [];
  const [open, setOpen] = useState<string | null>(null), [name, setName] = useState(''), [code, setCode] = useState(''), [topic, setTopic] = useState(''), [err, setErr] = useState<string | null>(null);
  const topics = useData(() => (open ? phoneClan().courses.topics(me(), open) : [])) ?? [];
  return (
    <>
      {courses.map((x) => (
        <Card key={x.id} title={`${x.code ? `${x.code} · ` : ''}${x.name}`} tone="study">
          <Muted>{readiness(phoneClan().courses.topics(me(), x.id).map((t) => t.state))?.label ?? 'No topics yet'}</Muted>
          <Btn small label={open === x.id ? 'Close' : 'Topics'} onPress={() => setOpen(open === x.id ? null : x.id)} />
          {open === x.id && (
            <View style={{ gap: 8 }}>
              {topics.map((t) => (
                <View key={t.id} style={{ gap: 4 }}>
                  <Text style={{ color: c.text, fontWeight: '600' }}>{t.title}</Text>
                  <Row gap={4}>{TOPIC_STATES.map((s) => <Btn key={s} small label={TOPIC_STATE_LABEL[s]} on={t.state === s} a11y={`Mark ${t.title} ${TOPIC_STATE_LABEL[s]}`} onPress={() => setErr(act(() => phoneClan().courses.setConfidence(me(), t.id, s as TopicState)))} />)}</Row>
                </View>
              ))}
              <Field label="New topic" value={topic} onChange={setTopic} />
              <Btn label="Add topic" disabled={!topic.trim()} onPress={() => { setErr(act(() => phoneClan().courses.addTopic(me(), x.id, topic))); setTopic(''); }} />
            </View>
          )}
        </Card>
      ))}
      <Card title="New course">
        <Field label="Course name" value={name} onChange={setName} placeholder="Operating Systems" />
        <Field label="Course code" value={code} onChange={setCode} placeholder="CS-330" autoCapitalize="characters" />
        <Btn primary label="Add course" disabled={!name.trim()} onPress={() => { setErr(act(() => phoneClan().courses.create(me(), { name, code }))); setName(''); setCode(''); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Notes() {
  const notes = useData(() => phoneClan().notes.mine(me(), 200)) ?? [];
  const [sel, setSel] = useState<{ id: string | null; title: string; body: string } | null>(null), [err, setErr] = useState<string | null>(null);
  if (sel) return (
    <Card title={sel.id ? 'Edit note' : 'New note'}>
      <Field label="Title" value={sel.title} onChange={(title) => setSel({ ...sel, title })} />
      <Field label="Note" value={sel.body} onChange={(body) => setSel({ ...sel, body })} multiline />
      <Row>
        <Btn primary label="Save" onPress={() => { const e = act(() => (sel.id ? phoneClan().notes.update(me(), sel.id, { title: sel.title, body: sel.body }) : phoneClan().notes.create(me(), { title: sel.title || 'Untitled', body: sel.body }))); setErr(e); if (!e) setSel(null); }} />
        <Btn label="Cancel" onPress={() => setSel(null)} />
        {sel.id && <Btn danger label="Delete" onPress={() => { setErr(act(() => phoneClan().notes.remove(me(), sel.id!))); setSel(null); }} />}
      </Row>
      <Err msg={err} />
    </Card>
  );
  return (
    <>
      <Btn primary label="New note" onPress={() => setSel({ id: null, title: '', body: '' })} />
      {notes.length === 0 && <Muted>No notes yet.</Muted>}
      {notes.map((n) => <Btn key={n.id} label={`${n.title}`} a11y={`Open note ${n.title}`} onPress={() => setSel({ id: n.id, title: n.title, body: n.body })} />)}
    </>
  );
}

function Tasks() {
  const c = useC();
  const tasks = useData(() => phoneClan().tasks.list(me(), { limit: 200 })) ?? [];
  const [title, setTitle] = useState(''), [due, setDue] = useState<number | null>(null), [course, setCourse] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {tasks.filter((t) => t.status !== 'cancelled').map((t) => (
        <Card key={t.id} tone={t.status === 'done' ? 'ok' : t.dueAt && t.dueAt < Date.now() ? 'danger' : undefined}>
          <Text style={{ color: c.text, fontWeight: '700', textDecorationLine: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</Text>
          <Muted small>{courseName(t.courseId)}{t.dueAt ? ` · due ${when(t.dueAt)}` : ''}</Muted>
          {t.checklist.map((i) => <Btn key={i.id} small label={`${i.done ? '☑' : '☐'} ${i.text}`} onPress={() => setErr(act(() => phoneClan().tasks.check(me(), t.id, i.id, !i.done)))} />)}
          <Row>{t.status !== 'done' ? <Btn small label="Done" a11y={`Mark ${t.title} done`} onPress={() => setErr(act(() => phoneClan().tasks.setStatus(me(), t.id, 'done')))} /> : <Btn small label="Reopen" onPress={() => setErr(act(() => phoneClan().tasks.setStatus(me(), t.id, 'todo')))} />}</Row>
        </Card>
      ))}
      <Card title="New task">
        <Field label="Task title" value={title} onChange={setTitle} />
        <DateField label="Due" value={due} onChange={setDue} />
        <CoursePick value={course} onChange={setCourse} />
        <Btn primary label="Add task" disabled={!title.trim()} onPress={() => { setErr(act(() => phoneClan().tasks.create(me(), { title, dueAt: due, courseId: course }))); setTitle(''); setDue(null); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Exams() {
  const exams = useData(() => phoneClan().exams.list(me())) ?? [];
  const courses = useData(() => phoneClan().courses.list(me())) ?? [];
  const [name, setName] = useState(''), [at, setAt] = useState<number | null>(null), [course, setCourse] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {exams.map((e) => {
        const topics = phoneClan().courses.topics(me(), e.courseId).filter((t) => e.topicIds.includes(t.id));
        return (
          <Card key={e.id} title={e.name} tone="danger">
            <Muted>{courseName(e.courseId)} · {when(e.at)} · {countdown(e.at, Date.now()).label}</Muted>
            <Muted>{readiness(topics.map((t) => t.state))?.label ?? 'No topics in scope'}</Muted>
            {e.status === 'upcoming' && <Btn small label="Completed" onPress={() => setErr(act(() => phoneClan().exams.setStatus(me(), e.id, 'completed')))} />}
          </Card>
        );
      })}
      {courses.length === 0 ? <Muted>Add a course first — an exam belongs to a course.</Muted> : (
        <Card title="New exam">
          <Field label="Exam name" value={name} onChange={setName} />
          <DateField label="When" value={at} onChange={setAt} />
          <CoursePick value={course} onChange={setCourse} />
          <Btn primary label="Add exam" disabled={!name.trim() || !at || !course} onPress={() => {
            const topicIds = phoneClan().courses.topics(me(), course!).map((t) => t.id);
            setErr(act(() => phoneClan().exams.create(me(), { courseId: course!, name, at: at!, topicIds }))); setName(''); setAt(null);
          }} />
          <Err msg={err} />
        </Card>
      )}
    </>
  );
}

function Reminders() {
  const c = useC();
  const list = useData(() => phoneClan().reminders.upcoming(me(), Date.now() + 60 * 86_400_000)) ?? [];
  const [text, setText] = useState(''), [at, setAt] = useState<number | null>(null), [rec, setRec] = useState<Recurrence>('none'), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {list.map((r) => (
        <Card key={r.id} tone={r.dueAt < Date.now() ? 'warn' : undefined}>
          <Text style={{ color: c.text, fontWeight: '700' }}>{r.text}</Text><Muted small>{when(r.dueAt)}</Muted>
          <Row><Btn small label="Done" onPress={() => setErr(act(() => phoneClan().reminders.done(me(), r.id)))} /><Btn small label="+1 h" a11y="Snooze one hour" onPress={() => setErr(act(() => phoneClan().reminders.snooze(me(), r.id, Date.now() + 3_600_000)))} /><Btn small danger label="Delete" onPress={() => setErr(act(() => phoneClan().reminders.remove(me(), r.id)))} /></Row>
        </Card>
      ))}
      <Card title="New reminder">
        <Field label="Reminder text" value={text} onChange={setText} />
        <DateField label="Remind me" value={at} onChange={setAt} />
        <Choice label="Repeat" value={rec} options={RECURRENCES.map((x) => [x, x === 'none' ? 'Once' : x[0]!.toUpperCase() + x.slice(1)] as const)} onChange={(v) => setRec(v as Recurrence)} />
        <Btn primary label="Add reminder" disabled={!text.trim() || !at} onPress={() => { setErr(act(() => phoneClan().reminders.create(me(), { text, dueAt: at!, recurrence: rec }))); setText(''); setAt(null); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Cards() {
  const c = useC();
  const decks = useData(() => phoneClan().flashcards.decks(me())) ?? [];
  const [deck, setDeck] = useState<string | null>(null), [review, setReview] = useState<FCard[] | null>(null), [flip, setFlip] = useState(false);
  const [name, setName] = useState(''), [front, setFront] = useState(''), [back, setBack] = useState(''), [err, setErr] = useState<string | null>(null);
  if (review) {
    const card = review[0];
    if (!card) return <Card title="All caught up."><Btn label="Back to decks" onPress={() => setReview(null)} /></Card>;
    return (
      <Card title={`Review · ${review.length} left`} tone="study">
        <Text style={{ color: c.text, fontSize: 22, fontWeight: '700' }} accessibilityLiveRegion="polite">{card.front}</Text>
        {flip ? <Text style={{ color: c.text2, fontSize: 18 }}>{card.back}</Text> : <Btn primary label="Show answer" onPress={() => setFlip(true)} />}
        {flip && <Row>{GRADES.map((g: Grade) => <Btn key={g} label={g[0]!.toUpperCase() + g.slice(1)} onPress={() => { const e = act(() => phoneClan().flashcards.review(me(), card.id, g)); setErr(e); setFlip(false); setReview(review.slice(1)); }} />)}</Row>}
        <Err msg={err} />
      </Card>
    );
  }
  return (
    <>
      {decks.map((d) => (
        <Card key={d.id} title={d.name}>
          <Muted>{d.cards} cards · {d.due} due</Muted>
          <Row>
            <Btn small primary label={`Review ${d.due} due`} disabled={!d.due} onPress={() => setReview(phoneClan().flashcards.queue(me(), d.id))} />
            <Btn small label={deck === d.id ? 'Close' : 'Add card'} onPress={() => setDeck(deck === d.id ? null : d.id)} />
          </Row>
          {deck === d.id && (<>
            <Field label="Card front" value={front} onChange={setFront} /><Field label="Card back" value={back} onChange={setBack} />
            <Btn label="Add card" disabled={!front.trim() || !back.trim()} onPress={() => { setErr(act(() => phoneClan().flashcards.addCard(me(), d.id, { front, back }))); setFront(''); setBack(''); }} />
          </>)}
        </Card>
      ))}
      <Card title="New deck">
        <Field label="Deck name" value={name} onChange={setName} />
        <Btn primary label="Add deck" disabled={!name.trim()} onPress={() => { setErr(act(() => phoneClan().flashcards.createDeck(me(), { name }))); setName(''); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Session() {
  const active = useData(() => phoneClan().study.active(me()));
  const recent = useData(() => phoneClan().study.recent(me(), { limit: 10 })) ?? [];
  const [goal, setGoal] = useState(''), [course, setCourse] = useState<string | null>(null), [reflection, setReflection] = useState(''), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {active ? (
        <Card title={`Studying: ${active.goal || 'Study'}`} tone="ok">
          <Muted>Started {when(active.startedAt)} · {courseName(active.courseId)}</Muted>
          <Field label="Reflection" value={reflection} onChange={setReflection} multiline placeholder="What clicked? (optional)" />
          <Btn primary label="End session" onPress={() => { setErr(act(() => phoneClan().study.end(me(), active.id, reflection))); setReflection(''); }} />
        </Card>
      ) : (
        <Card title="Start a study session">
          <Field label="Goal" value={goal} onChange={setGoal} placeholder="Finish chapter 3" />
          <CoursePick value={course} onChange={setCourse} />
          <Btn primary label="Start" onPress={() => setErr(act(() => phoneClan().study.start(me(), { goal, courseId: course })))} />
        </Card>
      )}
      <Err msg={err} />
      {recent.filter((s) => s.status === 'ended').map((s) => <Muted key={s.id}>{when(s.startedAt)} · {s.goal || 'Study'}{s.reflection ? ` — ${s.reflection}` : ''}</Muted>)}
    </>
  );
}

function Boards() {
  const c = useC();
  const owner = { kind: 'personal' as const, id: phoneClan().me };
  const boards = useData(() => phoneClan().whiteboard.list(me(), owner)) ?? [];
  const [open, setOpen] = useState<string | null>(null), [title, setTitle] = useState(''), [err, setErr] = useState<string | null>(null);
  if (open) return <><Btn label="← Boards" onPress={() => setOpen(null)} /><LocalBoard id={open} title={boards.find((b) => b.id === open)?.title ?? 'Board'} c={c} /></>;
  return (
    <>
      {boards.map((b) => <Btn key={b.id} label={b.title} a11y={`Open board ${b.title}`} onPress={() => setOpen(b.id)} />)}
      {boards.length === 0 && <Muted>No boards yet. Personal boards work offline and sync between your devices.</Muted>}
      <Card title="New board">
        <Field label="Board title" value={title} onChange={setTitle} />
        <Btn primary label="Create board" disabled={!title.trim()} onPress={() => { setErr(act(() => setOpen(phoneClan().whiteboard.create(me(), owner, title).id))); setTitle(''); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}
function LocalBoard({ id, title, c }: { id: string; title: string; c: ReturnType<typeof useC> }) {
  const src = useMemo(() => ({ read: (since: number) => phoneClan().whiteboard.read(me(), id, since), edit: (ops: Parameters<ReturnType<typeof phoneClan>['whiteboard']['edit']>[2]) => { phoneClan().whiteboard.edit(me(), id, ops); } }), [id]);
  const board = useLocalBoard(src, phoneClan().me);
  return <MobileBoard c={c} board={board} title={title} />;
}
