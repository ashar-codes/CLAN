// Tape shelf (eager, tiny); the player itself is a lazy chunk.
import type { Tape } from '../../../shared.ts';
import { tc } from './recorder.tsx';

/** A shelf of tapes (Course › Recordings, Study › Study Tapes). */
export function TapeShelf({ tapes, onOpen }: { tapes: Tape[]; onOpen(id: string): void }) {
  if (!tapes.length) return <p className="muted">No Study Tapes yet.</p>;
  return (
    <div className="tape-shelf" role="list">
      {tapes.map((t) => <button key={t.id} role="listitem" className="tape-case" onClick={() => onOpen(t.id)} aria-label={`${t.title}, ${tc(t.durationMs ?? 0)}`} data-testid="tape-case">
        <span className="tape-reel" aria-hidden><i /><i /></span><b>{t.title}</b><small className="muted c-num">{t.status === 'recording' ? 'recording…' : tc(t.durationMs ?? 0)} · {new Date(t.startedAt).toLocaleDateString()}</small></button>)}
    </div>
  );
}
