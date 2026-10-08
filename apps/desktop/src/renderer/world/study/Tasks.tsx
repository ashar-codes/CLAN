// Tasks: student task tracking — title, due, priority, status, checklist. Classroom assignments are shown next to them,
// marked as such, but they are never tasks (the Classroom stays authoritative).
import { useCallback, useState } from 'react';
import type { Task, TaskStatus, Topic } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
import { fromLocal, when } from './common.tsx';

const STATUS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };

export function Tasks({ courseId }: { courseId?: string }) {
  const [courses] = useLoad(api.study.courses);
  const [cid, setCid] = useState(courseId ?? '');
  const topics = courses?.find((c) => c.id === cid)?.topics.map((t, i) => ({ ...t, courseId: cid, position: i, stateAt: null })) ?? [];
  return (
    <div className="stack">
      <div className="row"><select value={cid} onChange={(e) => setCid(e.target.value)} aria-label="Course filter"><option value="">All courses</option>{courses?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <section className="card panel-body"><TaskList key={cid} courseId={cid || undefined} topics={topics} /></section>
    </div>
  );
}

export function TaskList({ courseId, topics }: { courseId?: string; topics: Topic[] }) {
  const [tasks, reload] = useLoad<Task[]>(useCallback(() => api.study.tasks(courseId ? { courseId } : {}), [courseId]));
  const [clans] = useLoad(api.clan.list);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [o, setO] = useState({ title: '', due: '', priority: 'normal' as Task['priority'], topicId: '', clanId: '', remind: false });
  const run = async (f: () => Promise<unknown>) => { setErr(''); try { await f(); reload(); } catch (x) { setErr(errText(x)); } };
  const create = () => run(async () => {
    const dueAt = fromLocal(o.due);
    const t = await api.study.createTask({ title: o.title, courseId: courseId ?? null, topicId: o.topicId || null, clanId: o.clanId || null, dueAt, priority: o.priority });
    if (o.remind && dueAt) await api.study.remind({ text: o.title, dueAt: dueAt - 3_600_000 > Date.now() ? dueAt - 3_600_000 : dueAt, target: { module: 'tasks', id: t.id } });
    setO({ title: '', due: '', priority: 'normal', topicId: '', clanId: '', remind: false });
  });
  return (
    <div className="stack" data-testid="tasks">
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <input required value={o.title} onChange={(e) => setO({ ...o, title: e.target.value })} placeholder="New task" aria-label="Task title" maxLength={200} />
        <input type="datetime-local" value={o.due} onChange={(e) => setO({ ...o, due: e.target.value })} aria-label="Due" />
        <select value={o.priority} onChange={(e) => setO({ ...o, priority: e.target.value as Task['priority'] })} aria-label="Priority"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select>
        {topics.length > 0 && <select value={o.topicId} onChange={(e) => setO({ ...o, topicId: e.target.value })} aria-label="Task topic"><option value="">No topic</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>}
        {!!clans?.length && <select value={o.clanId} onChange={(e) => setO({ ...o, clanId: e.target.value })} aria-label="Task CLAN"><option value="">No CLAN</option>{clans.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        <label className="row small-text"><input type="checkbox" checked={o.remind} disabled={!o.due} onChange={(e) => setO({ ...o, remind: e.target.checked })} /> Remind me an hour before</label>
        <button className="primary">Add task</button>
      </form>
      {err && <p className="error small-text" role="alert">{err}</p>}
      {tasks?.length === 0 && <p className="muted">No tasks. Classroom assignments appear in Today and in their course.</p>}
      {tasks?.map((t) => (
        <div key={t.id} className={`task pr-${t.priority} st-${t.status}`} data-testid="task">
          <div className="line">
            <input type="checkbox" checked={t.status === 'done'} aria-label={`Mark ${t.title} done`} onChange={(e) => void run(() => api.study.taskStatus(t.id, e.target.checked ? 'done' : 'todo'))} />
            <button className="link grow left" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}><b>{t.title}</b>{t.checklist.length ? <small className="muted"> · {t.checklist.filter((c) => c.done).length}/{t.checklist.length}</small> : null}</button>
            <span className={`muted small-text ${t.dueAt && t.dueAt < Date.now() && t.status !== 'done' ? 'overdue' : ''}`}>{t.dueAt ? when(t.dueAt) : ''}</span>
            <select value={t.status} aria-label={`Status of ${t.title}`} onChange={(e) => void run(() => api.study.taskStatus(t.id, e.target.value as TaskStatus))}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </div>
          {open === t.id && (
            <div className="task-body">
              {t.checklist.map((c) => <label key={c.id} className="row"><input type="checkbox" checked={c.done} onChange={(e) => void run(() => api.study.checkItem(t.id, c.id, e.target.checked))} />{c.text}</label>)}
              <form onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget, v = String(new FormData(f).get('item') ?? '').trim(); if (v) void run(() => api.study.addItem(t.id, v)).then(() => f.reset()); }}>
                <input name="item" placeholder="Add a checklist item" aria-label={`Checklist item for ${t.title}`} maxLength={200} />
              </form>
              {t.refs.length > 0 && <small className="muted">{t.refs.length} linked item{t.refs.length === 1 ? '' : 's'}</small>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
