// The live CLAN room (spatial header of a running session). Data comes from the session the dashboard already holds.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { mateFor, RoomStage, type RoomPerson } from '@clan/design';
import type { Member, ResourceView } from '@classroom/protocol';
import { api } from '../App.tsx';
import { flyPacket } from './flight.ts';

const KIND = (m: string) => (/pdf/.test(m) ? 'pdf' : /image/.test(m) ? 'img' : /video/.test(m) ? 'video' : /zip|compressed/.test(m) ? 'zip' : /presentation|powerpoint/.test(m) ? 'slides' : 'file');
type Action = { label: string; enabled: boolean; why?: string; run?(): void };

/** CLANmate action wheel. Unbuilt actions are shown disabled with the reason — never as working buttons. */
function Wheel({ person, at, actions, onClose, children }: { person: RoomPerson; at: DOMRect; actions: Action[]; onClose(): void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, []);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="wheel-pop" ref={ref} role="dialog" aria-label={`Actions for ${person.name}`} style={{ left: at.left + at.width / 2, top: at.top + window.scrollY }}>
      <div className="wheel-ring">
        {actions.map((a, i) => (
          <button key={a.label} className="spoke" style={{ ['--a' as string]: `${(i / actions.length) * 360 - 90}deg` }} disabled={!a.enabled} title={a.why} aria-label={a.enabled ? a.label : `${a.label} — ${a.why}`} onClick={a.run}>{a.label}</button>
        ))}
      </div>
      <div className="wheel-card card"><b>{person.name}</b>{children}<button className="small" onClick={onClose}>Close</button></div>
    </div>
  );
}

const LATER = (what: string) => ({ enabled: false, why: `${what} arrives in a later update` });

export function HostRoom({ code, hostName, members, resources, onRemove, onBlock, onShared }: {
  code: string; hostName: string | null; members: Member[]; resources: { id: string; name: string; mime: string }[];
  onRemove(id: string): void; onBlock(id: string): void; onShared(msg: string): void;
}) {
  const [sel, setSel] = useState<{ p: RoomPerson; at: DOMRect; m?: Member } | null>(null);
  const roster = members.filter((m) => m.status === 'approved');
  const people: RoomPerson[] = [
    { id: 'host', name: hostName ?? 'You', spec: mateFor(hostName ?? 'host'), beacon: 'available', host: true, you: true },
    ...roster.map((m) => ({ id: m.id, name: m.fullName, spec: mateFor(m.fullName), beacon: m.connected ? 'available' as const : 'away' as const })),
  ];
  const drop = async (files: File[]) => {
    const table = document.querySelector('[data-testid="room-table"]'), me = document.querySelector('[data-person="host"]');
    if (table && me) void flyPacket(me, table, files.length === 1 ? files[0]!.name : `${files.length} files`);
    const r = await api.addDropped(files);
    onShared(r.added ? `Shared ${r.added} file${r.added === 1 ? '' : 's'} with the CLAN — hashed and signed` : r.errors[0] ?? 'Nothing was shared.');
  };
  return (
    <>
      <RoomStage people={people} items={resources.map((r) => ({ id: r.id, name: r.name, kind: KIND(r.mime) }))} selected={sel?.p.id}
        wall={<div className="wall-code"><span>Join with</span><b aria-label="Join code" className="c-num">{code.slice(0, 3)} {code.slice(3)}</b><span>in the CLAN app · drop files on the table to share them</span></div>}
        dropLabel="Drop files here to share with everyone" onDropFiles={drop}
        onPerson={(p, el) => setSel({ p, at: el.getBoundingClientRect(), m: roster.find((m) => m.id === p.id) })} />
      {sel && (
        <Wheel person={sel.p} at={sel.at} onClose={() => setSel(null)} actions={[
          { label: 'Send', ...LATER('Sending to one person'), why: 'Sending to one person arrives later — drop on the table to share with everyone' },
          { label: 'Chat', ...LATER('Chat') }, { label: 'Study', ...LATER('Study rooms') },
          { label: 'Profile', enabled: true, run: () => {} }, { label: 'Invite', ...LATER('Inviting') }, { label: 'Screen', ...LATER('Screen sharing') },
        ]}>
          {sel.m ? <><span className="muted small-text">{sel.m.deviceName} · {sel.m.connected ? 'connected' : 'away'}</span>
            <div className="row"><button className="small" onClick={() => { onRemove(sel.m!.id); setSel(null); }}>Remove</button><button className="small danger" onClick={() => { onBlock(sel.m!.id); setSel(null); }}>Block</button></div></>
            : <span className="muted small-text">That’s you — the host.</span>}
        </Wheel>
      )}
    </>
  );
}

export function MemberRoom({ hostName, hostLabel, people, resources }: {
  hostName: string | null; hostLabel: string; people: { name: string; host: boolean; connected: boolean }[] | null; resources: ResourceView[];
}) {
  const [arrived, setArrived] = useState<string | null>(null);
  const [youName, setYou] = useState('You');
  useEffect(() => { api.getProfile().then((p) => p.fullName && setYou(p.fullName)).catch(() => {}); }, []);
  const seen = useRef(new Set<string>());
  const list: RoomPerson[] = (people && people.length ? people : [{ name: hostName ?? hostLabel, host: true, connected: true }, { name: youName, host: false, connected: true }])
    .map((p, i) => ({ id: p.host ? 'host' : p.name === youName ? 'you' : `m${i}`, name: p.host ? (hostName ?? p.name) : p.name, spec: mateFor(p.host ? (hostName ?? 'host') : p.name), beacon: p.connected ? 'available' : 'away', host: p.host, you: !p.host && p.name === youName }));
  useEffect(() => api.onFileState((s) => {
    const r = resources.find((x) => x.id === s.resourceId);
    if (!r) return;
    if ((s.state === 'downloading' || s.state === 'verifying') && !seen.current.has(r.id)) {
      seen.current.add(r.id);
      const from = document.querySelector('[data-person="host"]'), to = document.querySelector('[data-person="you"]') ?? document.querySelector('[data-testid="room-table"]');
      if (from && to) void flyPacket(from, to, r.name, { tone: 'receive' });
    }
    if (s.state === 'completed') setArrived(`${r.name} · verified ✓${s.via && /peer/.test(s.via) ? ' · with help from classmates' : ''}`);
  }), [resources]);
  return (
    <>
      <RoomStage people={list} items={resources.map((r) => ({ id: r.id, name: r.name, kind: KIND(r.mime) }))}
        wall={<div className="wall-msg"><b>{hostName ? `${hostName}’s room` : 'The room'}</b><span>{arrived ?? `The wall shows the ${hostLabel.toLowerCase()}’s screen or a whiteboard when those arrive.`}</span></div>} />
    </>
  );
}
