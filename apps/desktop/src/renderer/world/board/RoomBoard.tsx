// The CLAN board in a live room: wall controls and the board itself on the RoomSurface. Switching the wall away from a
// presentation is explicit ("Switch from Sara's screen to Whiteboard?") and the host decides; nobody's membership changes.
import type { ClanType, ClientMessage, ResourceView } from '@classroom/protocol';
import type { Presentation } from '../Presentation.tsx';
import { lazy, Suspense } from 'react';
import type { Placeable } from './BoardView.tsx';

const BoardView = lazy(() => import('./BoardView.tsx').then((m) => ({ default: m.BoardView })));
import type { BoardModel } from './useBoard.ts';

export function BoardControls({ board, pres, send, clanType, me }: { board: BoardModel; pres: Presentation; send(m: ClientMessage): void; clanType: ClanType; me: string | null }) {
  const v = board.view;
  if (!v) return null;
  const onWall = v.wall === 'WHITEBOARD';
  const put = () => {
    if (pres.live) { if (!confirm(`Switch from ${pres.presenting ? 'your' : `${pres.live.presenterName}’s`} screen to Whiteboard?`)) return; send({ t: 'wb.wall', mode: 'WHITEBOARD', takeover: true }); }
    else send({ t: 'wb.wall', mode: 'WHITEBOARD' });
  };
  return (
    <div className="row board-controls" role="group" aria-label="Whiteboard">
      {!onWall && (v.canEdit || v.canManage) && <button className="small" onClick={put}>Whiteboard</button>}
      {onWall && (v.canManage || me) && <button className="small" onClick={() => send({ t: 'wb.wall', mode: 'DEFAULT' })}>Take the board off the wall</button>}
      {v.canManage && clanType === 'CLASSROOM' && <label className="check small-text"><input type="checkbox" checked={v.memberEdit} onChange={(e) => send({ t: 'wb.memberEdit', on: e.target.checked })} /> Students may draw</label>}
      {onWall && !v.canEdit && <span className="muted small-text">The board is on the wall · view only</span>}
    </div>
  );
}

export function WallBoard({ board, resources, title }: { board: BoardModel; resources: ResourceView[]; title: string }) {
  // only files that are on the table (shared with everyone) can be placed; private files never go onto a CLAN board
  const placeables: Placeable[] = resources.filter((r) => !(r as { direct?: unknown }).direct).map((r) => ({ module: 'resource', id: r.id, title: r.name, mime: r.mime }));
  return <Suspense fallback={<p className="muted" role="status">Opening the board…</p>}><BoardView board={board} title={title} placeables={placeables} readOnlyReason="View only — the host can let you draw." /></Suspense>;
}
