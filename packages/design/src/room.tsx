// The CLAN room's spatial header: a wall (code / presentation / later screen share & whiteboard), a shared table holding
// real resources, and the people around it. Presentation only: everything arrives as props.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { CLANmate, type CLANmateSpec } from './clanmate.tsx';
import { BEACON_LABEL, CLANBeacon, type BeaconState } from './beacon.tsx';
import { MOTION } from './motion';

export type RoomPerson = { id: string; name: string; spec: CLANmateSpec; beacon: BeaconState; host?: boolean; you?: boolean };
export type RoomItem = { id: string; name: string; kind: string };

export function RoomStage({ wall, people, items, onPerson, onDropFiles, onDropOnPerson, dropLabel, selected, kind = 'CLASSROOM' }: {
  kind?: string; wall: ReactNode; people: RoomPerson[]; items: RoomItem[];
  onPerson?(p: RoomPerson, el: HTMLElement): void;
  /** When set, files dropped on the table are shared with the CLAN. */
  onDropFiles?(files: File[]): void; dropLabel?: string; selected?: string | null;
  /** When set, files dropped on a CLANmate go to that person only (never the table). */
  onDropOnPerson?(p: RoomPerson, files: File[]): void;
}) {
  const [over, setOver] = useState(false);
  const [overPerson, setOverPerson] = useState<string | null>(null);
  const previous = useRef(people), [departing, setDeparting] = useState<RoomPerson[]>([]);
  const rosterKey = people.map((p) => p.id).join('|');
  useEffect(() => {
    const ids = new Set(people.map((p) => p.id));
    const removed = previous.current.filter((p) => !ids.has(p.id)); previous.current = people;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.experience === 'minimal') { setDeparting([]); return; }
    setDeparting(removed);
    const timer = setTimeout(() => setDeparting([]), MOTION.slow);
    return () => clearTimeout(timer);
  }, [rosterKey]); // Presentation snapshots only; departed people immediately lose all actions.
  const leaving = new Set(departing.filter((p) => !people.some((a) => a.id === p.id)).map((p) => p.id));
  const displayed = [...people, ...departing.filter((p) => leaving.has(p.id))];
  const personDrop = (p: RoomPerson) => (onDropOnPerson && !p.you ? {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOverPerson(p.id); } },
    onDragLeave: () => setOverPerson(null),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOverPerson(null); const f = [...e.dataTransfer.files]; if (f.length) onDropOnPerson(p, f); },
  } : {});
  const drop = onDropFiles && {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); const f = [...e.dataTransfer.files]; if (f.length) onDropFiles(f); },
  };
  // Small groups sit together behind the table; larger ones fill both sides.
  const back = displayed.length <= 4 ? displayed : displayed.slice(0, Math.ceil(displayed.length / 2)), front = displayed.slice(back.length);
  const row = (ps: RoomPerson[]) => (
    <div className="c-room-row">
      {ps.map((p) => (
        <button key={p.id} type="button" className={`c-room-person ${leaving.has(p.id) ? 'leaving' : ''} ${selected === p.id ? 'on' : ''} ${overPerson === p.id ? 'drop' : ''}`} aria-hidden={leaving.has(p.id) || undefined} aria-label={`${p.name}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''} — ${BEACON_LABEL[p.beacon]}`}
          data-person={leaving.has(p.id) ? undefined : p.id} onClick={(e) => onPerson?.(p, e.currentTarget)} disabled={!onPerson || leaving.has(p.id)} {...(leaving.has(p.id) ? {} : personDrop(p))}>
          {overPerson === p.id && <span className="c-room-only" aria-hidden>Only {p.name.split(' ')[0]}</span>}
          <CLANmate spec={p.spec} beacon={p.beacon} size={96} />
          <span className="c-room-name"><CLANBeacon state={p.beacon} size={14} /> {p.you ? 'You' : p.name.split(' ')[0]}{p.host ? ' · host' : ''}</span>
        </button>
      ))}
    </div>
  );
  return (
    <div className="c-room" data-kind={kind}>
      <div className="c-room-wall">{wall}</div>
      {row(back)}
      <div className={`c-room-table ${over ? 'over' : ''}`} {...drop} aria-label={dropLabel} data-testid="room-table">
        {items.length === 0 ? <span className="c-room-empty">{dropLabel ?? 'Nothing on the table yet'}</span>
          : items.slice(0, 9).map((i, n) => <span key={i.id} className="c-room-item" style={{ ['--r' as string]: `${(n % 3) * 3 - 3}deg` }} title={i.name}>{i.kind}</span>)}
        {items.length > 9 && <span className="c-room-more">+{items.length - 9}</span>}
      </div>
      {row(front)}
    </div>
  );
}
