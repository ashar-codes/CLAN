// The CLAN room's spatial header: a wall (code / presentation / later screen share & whiteboard), a shared table holding
// real resources, and the people around it. Presentation only: everything arrives as props.
import { useState, type DragEvent, type ReactNode } from 'react';
import { CLANmate, type CLANmateSpec } from './clanmate.tsx';
import { BEACON_LABEL, CLANBeacon, type BeaconState } from './beacon.tsx';

export type RoomPerson = { id: string; name: string; spec: CLANmateSpec; beacon: BeaconState; host?: boolean; you?: boolean };
export type RoomItem = { id: string; name: string; kind: string };

export function RoomStage({ wall, people, items, onPerson, onDropFiles, dropLabel, selected }: {
  wall: ReactNode; people: RoomPerson[]; items: RoomItem[];
  onPerson?(p: RoomPerson, el: HTMLElement): void;
  /** When set, files dropped on the table are shared with the CLAN. */
  onDropFiles?(files: File[]): void; dropLabel?: string; selected?: string | null;
}) {
  const [over, setOver] = useState(false);
  const drop = onDropFiles && {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); const f = [...e.dataTransfer.files]; if (f.length) onDropFiles(f); },
  };
  // Small groups sit together behind the table; larger ones fill both sides.
  const back = people.length <= 4 ? people : people.slice(0, Math.ceil(people.length / 2)), front = people.slice(back.length);
  const row = (ps: RoomPerson[]) => (
    <div className="c-room-row">
      {ps.map((p) => (
        <button key={p.id} type="button" className={`c-room-person ${selected === p.id ? 'on' : ''}`} aria-label={`${p.name}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''} — ${BEACON_LABEL[p.beacon]}`}
          data-person={p.id} onClick={(e) => onPerson?.(p, e.currentTarget)} disabled={!onPerson}>
          <CLANmate spec={p.spec} size={84} />
          <span className="c-room-name"><CLANBeacon state={p.beacon} size={14} /> {p.you ? 'You' : p.name.split(' ')[0]}{p.host ? ' · host' : ''}</span>
        </button>
      ))}
    </div>
  );
  return (
    <div className="c-room">
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
