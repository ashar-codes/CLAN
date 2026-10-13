import {Editor,confirmRemove} from '../ui/Editor';
import {MobileTimetable} from '../timetable/Timetable';
// Phone Study over @clan/core (the same modules as the desktop, synced by PersonalSync): Courses with topic marks,
// Notes, Tasks, Exams, Reminders, Flashcards (SM-2 review) and Study Sessions. Dates use the native pickers.
import { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { GRADES, RECURRENCES, TOPIC_STATE_LABEL, TOPIC_STATES, countdown, readiness, type Grade, type Recurrence, type TopicState } from '@classroom/protocol';
import type { Card as FCard } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { act, Btn, Card, Choice, DateField, Err, Field, H1, Muted, Row, Screen, useC, useData, when } from '../ui/kit';
import { AskTab } from './Ask';
import { MobileBoard, useLocalBoard } from '../board/Board';

type Tab = 'timetable' | 'courses' | 'notes' | 'tasks' | 'exams' | 'reminders' | 'cards' | 'session' | 'boards' | 'ask';
export type MobileStudyTab = Tab;
const TABS: [Tab, string][] = [['timetable','Timetable'], ['courses', 'Courses'], ['notes', 'Notes'], ['tasks', 'Tasks'], ['exams', 'Exams'], ['reminders', 'Reminders'], ['cards', 'Cards'], ['session', 'Session'], ['boards', 'Boards'], ['ask', 'Ask CLAN']];

export function StudyScreen({ initial = 'courses' }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <View style={{flex:1}}>
      <View style={{padding:16,gap:10}}><H1>Study</H1><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:6}}>{TABS.map(([t,l])=><Btn key={t} small label={l} on={tab===t} onPress={()=>setTab(t)}/>)}</ScrollView></View><Screen>
      {tab === 'timetable' && <MobileTimetable/>}
      {tab === 'courses' && <Courses />}{tab === 'notes' && <Notes />}{tab === 'tasks' && <Tasks />}{tab === 'exams' && <Exams />}
      {tab === 'reminders' && <Reminders />}{tab === 'cards' && <Cards />}{tab === 'session' && <Session />}{tab === 'boards' && <Boards />}{tab === 'ask' && <AskTab />}
    </Screen></View>
  );
}

const courseName = (id: string | null) => {if(!id)return 'General';const c=phoneClan().courses.context(me(),id);return c?c.name+(c.archivedAt?' (archived/removed)':''):'Course no longer available';};
function CoursePick({ value, onChange }: { value: string | null; onChange(v: string | null): void }) {
  const courses = useData(() => phoneClan().courses.list(me())) ?? [];
  return <Choice label="Course" value={value ?? ''} options={[['', 'General'] as const, ...courses.map((c) => [c.id, c.name] as const)]} onChange={(v) => onChange(v || null)} />;
}

function Courses() {
  const c = useC();
  const [search,setSearch]=useState('');
  const [archived,setArchived]=useState(false),[editing,setEditing]=useState<string|null>(null),[topicEdit,setTopicEdit]=useState<{id:string;title:string}|null>(null),[lectureEdit,setLectureEdit]=useState<{id:string;title:string}|null>(null),[lectureTitle,setLectureTitle]=useState('');
  const courses = useData(() => phoneClan().courses.list(me(),archived)) ?? [];
  const [open, setOpen] = useState<string | null>(null), [name, setName] = useState(''), [code, setCode] = useState(''), [topic, setTopic] = useState(''), [err, setErr] = useState<string | null>(null);
  const topics = useData(() => (open ? phoneClan().courses.topics(me(), open) : [])) ?? [];
  return (
    <>
      <Row><Btn label={archived?'Show active courses':'Archived courses'} onPress={()=>{setOpen(null);setArchived(!archived);}}/></Row>
      {editing && <Editor key={editing} title="Edit course" initial={(()=>{const x=courses.find(x=>x.id===editing)??{name:'',code:'',instructor:'',term:'',schedule:''};return {name:x.name,code:x.code,instructor:x.instructor,term:x.term,schedule:x.schedule};})()} labels={{name:'Course name',code:'Course code',instructor:'Instructor',term:'Term',schedule:'Schedule'}} onSave={v=>{phoneClan().courses.update(me(),editing,v);setErr(act(()=>{}));}} onClose={()=>setEditing(null)}/>}
      {lectureEdit&&<Editor title="Edit lecture" initial={{title:lectureEdit.title}} labels={{title:'Lecture title'}} onSave={v=>phoneClan().courses.setLecture(me(),lectureEdit.id,{title:v.title!})} onClose={()=>setLectureEdit(null)}/>}
      {topicEdit && <Editor title="Edit topic" initial={{title:topicEdit.title}} labels={{title:'Topic title'}} onSave={v=>{phoneClan().courses.renameTopic(me(),topicEdit.id,v.title!);setErr(act(()=>{}));}} onClose={()=>setTopicEdit(null)}/>}

      <Card title="New course">
        <Field label="Course name" value={name} onChange={setName} placeholder="Operating Systems" />
        <Field label="Course code" value={code} onChange={setCode} placeholder="CS-330" autoCapitalize="characters" />
        <Btn primary label="Add course" disabled={!name.trim()} onPress={() => { const e=act(() => phoneClan().courses.create(me(), { name, code }));setErr(e);if(!e){setName('');setCode('');} }} />
        <Err msg={err} />
      </Card>
      <Field label="Search courses" value={search} onChange={setSearch} placeholder="Name, code or instructor"/>
      {courses.filter(x=>!search.trim()||[x.name,x.code,x.instructor].some(v=>v.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))).map((x) => (
        <Card key={x.id} title={`${x.code ? `${x.code} · ` : ''}${x.name}`} tone="study">
          <Muted>{archived ? 'Archived course' : readiness(phoneClan().courses.topics(me(), x.id).map((t) => t.state))?.label ?? 'No topics yet'}</Muted>
          <Row>{archived?<Btn small label="Restore" a11y={`Restore ${x.name}`} onPress={()=>setErr(act(()=>phoneClan().courses.restore(me(),x.id)))}/>:<><Btn small label="Edit" a11y={`Edit ${x.name}`} onPress={()=>setEditing(x.id)}/><Btn small label="Archive" a11y={`Archive ${x.name}`} onPress={()=>{setErr(act(()=>phoneClan().courses.archive(me(),x.id)));setOpen(null);}}/></>}<Btn small danger label="Delete course" a11y={`Delete course ${x.name}`} onPress={()=>confirmRemove(x.name,'Removes this course, topics and course references from your linked devices. Independent Notes, Tasks, Exams, files and CLAN ownership remain.',()=>{phoneClan().courses.remove(me(),x.id);setOpen(null);},setErr)}/></Row>
          {!archived && <Btn small label={open === x.id ? 'Close' : 'Topics'} onPress={() => setOpen(open === x.id ? null : x.id)} />}
          {open === x.id && (
            <View style={{ gap: 8 }}>
              {topics.map((t) => (
                <View key={t.id} style={{ gap: 4 }}>
                  <Text style={{ color: c.text, fontWeight: '600' }}>{t.title}</Text><Row><Btn small label="Edit topic" onPress={()=>setTopicEdit({id:t.id,title:t.title})}/><Btn small danger label="Delete topic" a11y={`Delete topic ${t.title}`} onPress={()=>confirmRemove(t.title,'Removes the topic and its lecture placement. Linked notes/files remain available at course level; independent content is retained.',()=>phoneClan().courses.removeTopic(me(),t.id),setErr)}/></Row>
                  <Row gap={4}>{TOPIC_STATES.map((s) => <Btn key={s} small label={TOPIC_STATE_LABEL[s]} on={t.state === s} a11y={`Mark ${t.title} ${TOPIC_STATE_LABEL[s]}`} onPress={() => setErr(act(() => phoneClan().courses.setConfidence(me(), t.id, s as TopicState)))} />)}</Row>
                </View>
              ))}
              <H1>Lectures</H1>{phoneClan().courses.lectures(me(),x.id).map(l=><Card key={l.id} title={l.title}><Muted>{l.status}</Muted><Row><Btn small label="Edit lecture" onPress={()=>setLectureEdit({id:l.id,title:l.title})}/><Btn small danger label="Delete lecture" onPress={()=>confirmRemove(l.title,'Removes the lecture and its topic placement. Course references remain; independent recordings/classroom sessions are retained.',()=>phoneClan().courses.removeLecture(me(),l.id),setErr)}/></Row><Choice label={`Status of ${l.title}`} value={l.status} options={['planned','held','cancelled'].map(s=>[s,s] as const)} onChange={v=>setErr(act(()=>phoneClan().courses.setLecture(me(),l.id,{status:v as typeof l.status})))}/></Card>)}
              <Field label="Lecture title" value={lectureTitle} onChange={setLectureTitle}/><Btn label="Add lecture" disabled={!lectureTitle.trim()} onPress={()=>{const e=act(()=>phoneClan().courses.addLecture(me(),x.id,{title:lectureTitle}));setErr(e);if(!e)setLectureTitle('');}}/>
              <Field label="New topic" value={topic} onChange={setTopic} />
              <Btn label="Add topic" disabled={!topic.trim()} onPress={() => { const e=act(() => phoneClan().courses.addTopic(me(), x.id, topic));setErr(e);if(!e)setTopic(''); }} />
            </View>
          )}
        </Card>
      ))}

    </>
  );
}

function Notes() {
  const notes = useData(() => phoneClan().notes.mine(me(), 200)) ?? [];
  const [sel, setSel] = useState<{ id: string | null; title: string; body: string } | null>(null), [err, setErr] = useState<string | null>(null);
  if (sel) return <><Editor key={sel.id??'new'} title={sel.id?'Edit note':'New note'} initial={{title:sel.title,body:sel.body}} labels={{title:'Title',body:'Note'}} multiline={['body']} read={sel.id?()=>{const n=phoneClan().notes.get(me(),sel.id!);if(!n)throw Error('This note was deleted. Your draft is kept.');return {title:n.title,body:n.body};}:undefined} onSave={v=>{if(sel.id)phoneClan().notes.update(me(),sel.id,{title:v.title!,body:v.body!});else phoneClan().notes.create(me(),{title:v.title||'Untitled',body:v.body!});}} onClose={()=>setSel(null)}/></>;
  return (
    <>
      <Btn primary label="New note" onPress={() => setSel({ id: null, title: '', body: '' })} />
      {notes.length === 0 && <Muted>No notes yet.</Muted>}
      {notes.map(n=><Card key={n.id}><Btn label={n.title} a11y={`Open note ${n.title}`} onPress={()=>setSel({id:n.id,title:n.title,body:n.body})}/><Btn small danger label="Delete note" a11y={`Delete note ${n.title}`} onPress={()=>confirmRemove(n.title,'Deletes your note from Personal Space and linked devices. Shared/exported copies may remain.',()=>phoneClan().notes.remove(me(),n.id),setErr)}/></Card>)}<Err msg={err}/>
    </>
  );
}

function Tasks() {
  const [editing,setEditing]=useState<string|null>(null),[showCancelled,setShowCancelled]=useState(false),[editDue,setEditDue]=useState<number|null>(null),[editPriority,setEditPriority]=useState<'low'|'normal'|'high'>('normal');
  const c = useC();
  const tasks = useData(() => phoneClan().tasks.list(me(), { limit: 200 })) ?? [];
  const [title, setTitle] = useState(''), [due, setDue] = useState<number | null>(null), [course, setCourse] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {editing && (()=>{const t=tasks.find(x=>x.id===editing)??{title:'',description:'',dueAt:null,priority:'normal'};return <Editor key={editing} title="Edit task" initial={{title:t.title,description:t.description}} labels={{title:'Task title',description:'Description'}} multiline={['description','notes']} extraDirty={editDue!==t.dueAt||editPriority!==t.priority} onSave={v=>{phoneClan().tasks.update(me(),editing,{...v,dueAt:editDue,priority:editPriority});}} onClose={()=>setEditing(null)}><DateField label="Due" value={editDue} onChange={setEditDue}/><Choice label="Priority" value={editPriority} options={['low','normal','high'].map(x=>[x,x] as const)} onChange={v=>setEditPriority(v as typeof editPriority)}/></Editor>;})()}
      <Err msg={err}/>

      <Btn label={showCancelled?'Hide cancelled tasks':'Show cancelled tasks'} onPress={()=>setShowCancelled(!showCancelled)}/>
      {tasks.filter((t) => showCancelled || t.status !== 'cancelled').map((t) => (
        <Card key={t.id} tone={t.status === 'done' ? 'ok' : t.dueAt && t.dueAt < Date.now() ? 'danger' : undefined}>
          <Text style={{ color: c.text, fontWeight: '700', textDecorationLine: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</Text>
          <Row><Btn small label="Edit task" a11y={`Edit task ${t.title}`} onPress={()=>{setEditDue(t.dueAt);setEditPriority(t.priority);setEditing(t.id);}}/><Btn small danger label="Delete task" a11y={`Delete task ${t.title}`} onPress={()=>confirmRemove(t.title,'Deletes this personal task and its own checklist/references from linked devices. Independent course material and files remain.',()=>phoneClan().tasks.remove(me(),t.id),setErr)}/></Row>
          <Muted small>{courseName(t.courseId)}{t.dueAt ? ` · due ${when(t.dueAt)}` : ''}</Muted>
          {t.checklist.map((i) => <Btn key={i.id} small label={`${i.done ? '☑' : '☐'} ${i.text}`} onPress={() => setErr(act(() => phoneClan().tasks.check(me(), t.id, i.id, !i.done)))} />)}
          <Row>{t.status !== 'done' && t.status !== 'cancelled' ? <Btn small label="Done" a11y={`Mark ${t.title} done`} onPress={() => setErr(act(() => phoneClan().tasks.setStatus(me(), t.id, 'done')))} /> : <Btn small label="Reopen" onPress={() => setErr(act(() => phoneClan().tasks.setStatus(me(), t.id, 'todo')))} />}</Row>
        </Card>
      ))}
      <Card title="New task">
        <Field label="Task title" value={title} onChange={setTitle} />
        <DateField label="Due" value={due} onChange={setDue} />
        <CoursePick value={course} onChange={setCourse} />
        <Btn primary label="Add task" disabled={!title.trim()} onPress={() => { const error=act(() => phoneClan().tasks.create(me(), { title, dueAt: due, courseId: course }));setErr(error);if(!error){setTitle('');setDue(null);} }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Exams() {
  const [editing,setEditing]=useState<string|null>(null),[editAt,setEditAt]=useState<number|null>(null);
  const exams = useData(() => phoneClan().exams.list(me())) ?? [];
  const courses = useData(() => phoneClan().courses.list(me())) ?? [];
  const [name, setName] = useState(''), [at, setAt] = useState<number | null>(null), [course, setCourse] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {editing && (()=>{const e=exams.find(x=>x.id===editing)??{name:'',location:'',notes:'',at:0};return <Editor key={editing} title="Edit exam" initial={{name:e.name,location:e.location,notes:e.notes}} labels={{name:'Exam name',location:'Location',notes:'Notes'}} multiline={['description','notes']} extraDirty={editAt!==e.at} onSave={v=>{if(!editAt)throw new Error('Choose an exam date and time.');phoneClan().exams.update(me(),editing,{...v,at:editAt});}} onClose={()=>setEditing(null)}><DateField label="Exam date and time" value={editAt} onChange={setEditAt}/></Editor>;})()}
      <Err msg={err}/>

      {exams.map((e) => {
        const topics = phoneClan().courses.context(me(),e.courseId)?phoneClan().courses.topics(me(),e.courseId).filter(t=>e.topicIds.includes(t.id)):[];
        return (
          <Card key={e.id} title={e.name} tone="danger">
            <Row><Btn small label="Edit exam" a11y={`Edit exam ${e.name}`} onPress={()=>{setEditAt(e.at);setEditing(e.id);}}/><Btn small danger label="Delete exam" a11y={`Delete exam ${e.name}`} onPress={()=>confirmRemove(e.name,'Deletes this personal exam and its own checklist/references from linked devices. Independent course material and files remain.',()=>phoneClan().exams.remove(me(),e.id),setErr)}/></Row>
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
            const error=act(() => phoneClan().exams.create(me(), { courseId: course!, name, at: at!, topicIds }));setErr(error);if(!error){setName('');setAt(null);}
          }} />
          <Err msg={err} />
        </Card>
      )}
    </>
  );
}

function Reminders() {
  const [editing,setEditing]=useState<string|null>(null),[editAt,setEditAt]=useState<number|null>(null),[editRec,setEditRec]=useState<Recurrence>('none');
  const c = useC();
  const list = useData(() => phoneClan().reminders.upcoming(me(), Date.now() + 60 * 86_400_000)) ?? [];
  const [text, setText] = useState(''), [at, setAt] = useState<number | null>(null), [rec, setRec] = useState<Recurrence>('none'), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {editing&&(()=>{const r=list.find(x=>x.id===editing)??{id:editing,text:'',dueAt:0,recurrence:'none'};return <Editor title="Edit reminder" initial={{text:r.text}} labels={{text:'Reminder text'}} extraDirty={editAt!==r.dueAt||editRec!==r.recurrence} onSave={v=>{if(!editAt)throw new Error('Choose a reminder time.');phoneClan().reminders.update(me(),r.id,{text:v.text!,dueAt:editAt,recurrence:editRec});}} onClose={()=>setEditing(null)}><DateField label="Reminder time" value={editAt} onChange={setEditAt}/><Choice label="Repeat" value={editRec} options={RECURRENCES.map(x=>[x,x] as const)} onChange={v=>setEditRec(v as Recurrence)}/></Editor>;})()}
      {list.map((r) => (
        <Card key={r.id} tone={r.dueAt < Date.now() ? 'warn' : undefined}>
          <Text style={{ color: c.text, fontWeight: '700' }}>{r.text}</Text><Muted small>{when(r.dueAt)}</Muted>
          <Row><Btn small label="Edit reminder" onPress={()=>{setEditAt(r.dueAt);setEditRec(r.recurrence);setEditing(r.id);}}/><Btn small label="Done" onPress={() => setErr(act(() => phoneClan().reminders.done(me(), r.id)))} /><Btn small label="+1 h" a11y="Snooze one hour" onPress={() => setErr(act(() => phoneClan().reminders.snooze(me(), r.id, Date.now() + 3_600_000)))} /><Btn small danger label="Delete" onPress={()=>confirmRemove(r.text,'Deletes this reminder on linked devices. Independently referenced content stays.',()=>phoneClan().reminders.remove(me(),r.id),setErr)} /></Row>
        </Card>
      ))}
      <Card title="New reminder">
        <Field label="Reminder text" value={text} onChange={setText} />
        <DateField label="Remind me" value={at} onChange={setAt} />
        <Choice label="Repeat" value={rec} options={RECURRENCES.map((x) => [x, x === 'none' ? 'Once' : x[0]!.toUpperCase() + x.slice(1)] as const)} onChange={(v) => setRec(v as Recurrence)} />
        <Btn primary label="Add reminder" disabled={!text.trim() || !at} onPress={() => { const e=act(() => phoneClan().reminders.create(me(), { text, dueAt: at!, recurrence: rec }));setErr(e);if(!e){setText('');setAt(null);} }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Cards() {
  const [editingDeck,setEditingDeck]=useState<{id:string;name:string}|null>(null),[editingCard,setEditingCard]=useState<FCard|null>(null);
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
        {flip && <Row>{GRADES.map((g: Grade) => <Btn key={g} label={g[0]!.toUpperCase() + g.slice(1)} onPress={() => { const e = act(() => phoneClan().flashcards.review(me(), card.id, g)); setErr(e);if(!e){setFlip(false);setReview(review.slice(1));} }} />)}</Row>}
        <Err msg={err} />
      </Card>
    );
  }
  return (
    <>
      <Err msg={err}/>
      {editingDeck&&<Editor title="Edit deck" initial={{name:editingDeck.name}} labels={{name:'Deck name'}} read={()=>{const d=phoneClan().flashcards.decks(me()).find(x=>x.id===editingDeck.id);if(!d)throw Error('This deck was deleted; your draft is kept.');return {name:d.name};}} onSave={v=>phoneClan().flashcards.renameDeck(me(),editingDeck.id,v.name!)} onClose={()=>setEditingDeck(null)}/>}
      {editingCard&&<Editor title="Edit card" initial={{front:editingCard.front,back:editingCard.back,note:editingCard.note}} labels={{front:'Card front',back:'Card back',note:'Note'}} multiline={['back','note']} read={()=>{const c=phoneClan().flashcards.card(me(),editingCard.id);if(!c)throw Error('This card was deleted; your draft is kept.');return {front:c.front,back:c.back,note:c.note};}} onSave={v=>phoneClan().flashcards.editCard(me(),editingCard.id,v)} onClose={()=>setEditingCard(null)}/>}

      {decks.map((d) => (
        <Card key={d.id} title={d.name}>
          <Muted>{d.cards} cards · {d.due} due</Muted><Row><Btn small label="Edit deck" onPress={()=>setEditingDeck({id:d.id,name:d.name})}/><Btn small danger label="Delete deck" a11y={`Delete deck ${d.name}`} onPress={()=>confirmRemove(d.name,'Deletes this deck, its cards and their review history on linked devices. Course material stays.',()=>{phoneClan().flashcards.removeDeck(me(),d.id);setDeck(null);},setErr)}/></Row>
          <Row>
            <Btn small primary label={`Review ${d.due} due`} disabled={!d.due} onPress={() => setReview(phoneClan().flashcards.queue(me(), d.id))} />
            <Btn small label={deck === d.id ? 'Close' : 'Manage cards'} onPress={() => setDeck(deck === d.id ? null : d.id)} />
          </Row>
          {deck === d.id && (<>
            {phoneClan().flashcards.cards(me(),d.id).map(card=><Card key={card.id} title={card.front}><Muted>{card.back}</Muted><Row><Btn small label="Edit card" onPress={()=>setEditingCard(card)}/><Btn small danger label="Delete card" onPress={()=>confirmRemove(card.front,'Deletes this card and its review history from linked devices. Other cards remain.',()=>phoneClan().flashcards.removeCard(me(),card.id),setErr)}/></Row></Card>)}
            <Field label="Card front" value={front} onChange={setFront} /><Field label="Card back" value={back} onChange={setBack} />
            <Btn label="Add card" disabled={!front.trim() || !back.trim()} onPress={() => { const e=act(() => phoneClan().flashcards.addCard(me(), d.id, { front, back }));setErr(e);if(!e){setFront('');setBack('');} }} />
          </>)}
        </Card>
      ))}
      <Card title="New deck">
        <Field label="Deck name" value={name} onChange={setName} />
        <Btn primary label="Add deck" disabled={!name.trim()} onPress={() => { const e=act(() => phoneClan().flashcards.createDeck(me(), { name }));setErr(e);if(!e)setName(''); }} />
        <Err msg={err} />
      </Card>
    </>
  );
}

function Session() {
  const [editing,setEditing]=useState<{id:string;goal:string;reflection:string|null}|null>(null);
  const active = useData(() => phoneClan().study.active(me()));
  const recent = useData(() => phoneClan().study.recent(me(), { limit: 10 })) ?? [];
  const [goal, setGoal] = useState(''), [course, setCourse] = useState<string | null>(null), [reflection, setReflection] = useState(''), [err, setErr] = useState<string | null>(null);
  return (
    <>
      {editing&&<Editor title="Edit study record" initial={{goal:editing.goal,reflection:editing.reflection??''}} labels={{goal:'Goal',reflection:'Reflection'}} multiline={['reflection']} onSave={v=>phoneClan().study.update(me(),editing.id,v)} onClose={()=>setEditing(null)}/>}

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
      {recent.filter(s=>s.status==='ended').map(s=><Card key={s.id} title={s.goal||'Study'}><Muted>{when(s.startedAt)}{s.reflection?` — ${s.reflection}`:''}</Muted><Row><Btn small label="Edit record" onPress={()=>setEditing(s)}/><Btn small danger label="Delete record" onPress={()=>confirmRemove(s.goal||'Study session','Deletes this saved personal study record from linked devices. Notes and course material remain.',()=>phoneClan().study.remove(me(),s.id),setErr)}/></Row></Card>)}
    </>
  );
}

function Boards() {
  const [archived,setArchived]=useState(false),[editing,setEditing]=useState<{id:string;title:string}|null>(null);
  const c = useC();
  const owner = { kind: 'personal' as const, id: phoneClan().me };
  const boards = useData(() => phoneClan().whiteboard.list(me(), owner,archived)) ?? [];
  const [open, setOpen] = useState<string | null>(null), [title, setTitle] = useState(''), [err, setErr] = useState<string | null>(null);
  if (open) return <><Btn label="← Boards" onPress={() => setOpen(null)} /><LocalBoard id={open} title={boards.find((b) => b.id === open)?.title ?? 'Board'} c={c} /></>;
  return (
    <>
      <Btn label={archived?'Show active boards':'Archived boards'} onPress={()=>setArchived(!archived)}/>{editing&&<Editor title="Rename board" initial={{title:editing.title}} labels={{title:'Board title'}} onSave={v=>phoneClan().whiteboard.rename(me(),editing.id,v.title!)} onClose={()=>setEditing(null)}/>}
      {boards.map(b=><Card key={b.id} title={b.title}><Row>{archived?<Btn small label="Restore board" onPress={()=>setErr(act(()=>phoneClan().whiteboard.restore(me(),b.id)))}/>:<><Btn label="Open board" a11y={`Open board ${b.title}`} onPress={()=>setOpen(b.id)}/><Btn small label="Rename board" onPress={()=>setEditing({id:b.id,title:b.title})}/><Btn small label="Archive board" onPress={()=>setErr(act(()=>phoneClan().whiteboard.remove(me(),b.id)))}/></>}<Btn small danger label="Delete board" a11y={`Delete board ${b.title}`} onPress={()=>confirmRemove(b.title,'Removes this board and its drawing history on linked devices. Notes and independently referenced files remain.',()=>phoneClan().whiteboard.discard(me(),b.id),setErr)}/></Row></Card>)}
      {boards.length === 0 && <Muted>No boards yet. Personal boards work offline and sync between your devices.</Muted>}
      <Card title="New board">
        <Field label="Board title" value={title} onChange={setTitle} />
        <Btn primary label="Create board" disabled={!title.trim()} onPress={() => { const e=act(() => setOpen(phoneClan().whiteboard.create(me(), owner, title).id));setErr(e);if(!e)setTitle(''); }} />
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
