// Study › Study Tapes: the shelf, the player, and the Record button. Tapes are personal; sharing one into a CLAN
// creates a reference to the same file (never a copy) and only happens from here, explicitly.
import { lazy, Suspense, useCallback, useState } from 'react';
import type { Tape } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { useLoad } from '../useLoad.ts';
import { useStudy } from '../study/common.tsx';
import { TapeShelf } from './Shelf.tsx';

const TapePlayer = lazy(() => import('./Player.tsx').then((m) => ({ default: m.TapePlayer })));
import { useRecorder } from './recorder.tsx';

export function Tapes({ tapeId, at, courseId, lectureId }: { tapeId?: string; at?: number; courseId?: string; lectureId?: string }) {
  const { go } = useStudy();
  const rec = useRecorder();
  const [tapes, reload] = useLoad<Tape[]>(useCallback(() => api.rec.list(courseId ? { courseId, ...(lectureId ? { lectureId } : {}) } : {}), [courseId, lectureId, rec.last?.id])); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<string | null>(null);
  const id = open ?? (courseId ? null : tapeId) ?? null;
  if (id) return <Suspense fallback={<p className="muted" role="status">Opening the tape…</p>}><TapePlayer id={id} at={id === tapeId ? at : undefined} onBack={() => { setOpen(null); if (!courseId) go({ tab: 'tapes' }); reload(); }} onOpenNote={(noteId) => go({ tab: 'notes', noteId })} /></Suspense>;
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted small-text">Recordings with your own timeline: important moments, notes, screenshots and bookmarks. Private to you.</p>
        <button className="primary" disabled={!!rec.active} onClick={() => rec.open({ courseId: courseId ?? null, lectureId: lectureId ?? null })}>{rec.active ? 'Recording…' : 'Record'}</button>
      </div>
      {tapes && <TapeShelf tapes={tapes} onOpen={setOpen} />}
    </div>
  );
}
