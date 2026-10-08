// The live CLAN room (spatial header of a running session). Data comes from the session the dashboard already holds.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { mateFor, RoomStage, type RoomPerson } from '@clan/design';
import type { Member, ResourceView } from '@classroom/protocol';
import { api } from '../App.tsx';
import { flyPacket } from './flight.ts';
import { RoomSurface, type Presentation } from './Presentation.tsx';

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

/** What the room needs from the dashboard to message / send to a CLANmate (by chat handle). */
export type PersonActions = {
  onMessage(handle: string): void;
  /** Files dropped on the person, or none → a file picker. Resolves to a short confirmation. */
  onSend(handle: string, name: string, files?: File[]): Promise<string>;
  canSendFiles: boolean;
};
const firstName = (n: string) => n.split(' ')[0]!;

/** Person share: the packet flies to that CLANmate and says so ("Only Sara"); the table means everyone. */
async function sendToPerson(a: PersonActions, p: RoomPerson & { handle?: string }, files: File[] | undefined, toast: (m: string) => void) {
  const from = document.querySelector('[data-person="you"]') ?? document.querySelector('[data-person="host"]');
  const to = document.querySelector(`[data-person="${CSS.escape(p.id)}"]`);
  if (files?.length && from && to) void flyPacket(from, to, `Only ${firstName(p.name)} · ${files.length === 1 ? files[0]!.name : `${files.length} files`}`, { tone: 'person' });
  try { toast(await a.onSend(p.handle!, p.name, files)); } catch (e) { toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}

function personActions(a: PersonActions | undefined, p: RoomPerson & { handle?: string }, close: () => void, toast: (m: string) => void): Action[] {
  const self = p.you;
  const can = !!a && !!p.handle && !self;
  return [
    { label: 'Message', enabled: can, why: self ? 'That’s you' : 'Not available in this CLAN', run: () => { close(); a!.onMessage(p.handle!); } },
    { label: 'Send', enabled: can && a!.canSendFiles, why: self ? 'That’s you' : 'Sending files isn’t allowed in this CLAN', run: () => { close(); void sendToPerson(a!, p, undefined, toast); } },
  ];
}

export function HostRoom({ code, hostName, members, resources, onRemove, onBlock, onShared, pres, onPresent, onStopPresenter, people: chatPeople, board }: {
  code: string; hostName: string | null; members: Member[]; resources: { id: string; name: string; mime: string }[];
  onRemove(id: string): void; onBlock(id: string): void; onShared(msg: string): void;
  pres: Presentation; onPresent(): void; onStopPresenter(): void; people?: PersonActions; board?: ReactNode;
}) {
  const [sel, setSel] = useState<{ p: RoomPerson & { handle?: string }; at: DOMRect; m?: Member } | null>(null);
  const roster = members.filter((m) => m.status === 'approved');
  const people: (RoomPerson & { handle?: string })[] = [
    { id: 'host', name: hostName ?? 'You', spec: mateFor(hostName ?? 'host'), beacon: pres.live?.presenter === 'host' ? 'presenting' : 'available', host: true, you: true },
    ...roster.map((m) => ({ id: m.id, handle: m.handle, name: m.fullName, spec: mateFor(m.fullName), beacon: pres.live?.presenter === m.id ? 'presenting' as const : m.connected ? 'available' as const : 'away' as const })),
  ];
  const drop = async (files: File[]) => {
    const table = document.querySelector('[data-testid="room-table"]'), me = document.querySelector('[data-person="host"]');
    if (table && me) void flyPacket(me, table, files.length === 1 ? files[0]!.name : `${files.length} files`);
    const r = await api.addDropped(files);
    onShared(r.added ? `Shared ${r.added} file${r.added === 1 ? '' : 's'} with everyone in the CLAN — hashed and signed` : r.errors[0] ?? 'Nothing was shared.');
  };
  return (
    <>
      <RoomStage people={people} items={resources.map((r) => ({ id: r.id, name: r.name, kind: KIND(r.mime) }))} selected={sel?.p.id}
        wall={<RoomSurface mode={pres.live ? 'SCREEN_SHARE' : board ? 'WHITEBOARD' : 'DEFAULT'} screen={pres.live ? { pres, live: pres.live } : undefined} board={board}><div className="wall-code"><span>Join with</span><b aria-label="Join code" className="c-num">{code.slice(0, 3)} {code.slice(3)}</b><span>in the CLAN app · table = everyone · a CLANmate = only them</span></div></RoomSurface>}
        dropLabel="Drop files here to share with everyone" onDropFiles={drop}
        onDropOnPerson={chatPeople ? (p, files) => void sendToPerson(chatPeople, people.find((x) => x.id === p.id)!, files, onShared) : undefined}
        onPerson={(p, el) => setSel({ p: people.find((x) => x.id === p.id)!, at: el.getBoundingClientRect(), m: roster.find((m) => m.id === p.id) })} />
      {sel && (
        <Wheel person={sel.p} at={sel.at} onClose={() => setSel(null)} actions={[
          ...personActions(chatPeople, sel.p, () => setSel(null), onShared),
          { label: 'Study', ...LATER('Study rooms') },
          { label: 'Profile', enabled: true, run: () => {} }, { label: 'Invite', ...LATER('Inviting') },
          sel.p.id === 'host' ? { label: 'Present', enabled: !pres.presenting, run: () => { setSel(null); onPresent(); } }
            : pres.live?.presenter === sel.p.id ? { label: 'Stop', enabled: true, run: () => { setSel(null); onStopPresenter(); } } : { label: 'Screen', enabled: false, why: 'They are not presenting' },
        ]}>
          {sel.m ? <><span className="muted small-text">{sel.m.deviceName} · {sel.m.connected ? 'connected' : 'away'}</span>
            <div className="row"><button className="small" onClick={() => { onRemove(sel.m!.id); setSel(null); }}>Remove</button><button className="small danger" onClick={() => { onBlock(sel.m!.id); setSel(null); }}>Block</button></div></>
            : <span className="muted small-text">That’s you — the host.</span>}
        </Wheel>
      )}
    </>
  );
}

export function MemberRoom({ hostName, hostLabel, people, resources, pres, presenterName, actions, onTableDrop, onToast, board }: {
  hostName: string | null; hostLabel: string; people: { name: string; host: boolean; connected: boolean; handle?: string }[] | null; resources: ResourceView[];
  pres: Presentation; presenterName: string | null; actions?: PersonActions & { me: string | null }; board?: ReactNode;
  /** Members who may share files: dropping on the table shares with everyone. */
  onTableDrop?(files: File[]): Promise<string>; onToast?(m: string): void;
}) {
  const [arrived, setArrived] = useState<string | null>(null);
  const [youName, setYou] = useState('You');
  const [sel, setSel] = useState<{ p: RoomPerson & { handle?: string }; at: DOMRect } | null>(null);
  useEffect(() => { api.getProfile().then((p) => p.fullName && setYou(p.fullName)).catch(() => {}); }, []);
  const seen = useRef(new Set<string>());
  const toast = onToast ?? (() => {});
  const list: (RoomPerson & { handle?: string })[] = (people && people.length ? people : [{ name: hostName ?? hostLabel, host: true, connected: true }, { name: youName, host: false, connected: true }])
    .map((p, i) => {
      const you = !p.host && (actions?.me ? 'handle' in p && p.handle === actions.me : p.name === youName);
      return { id: p.host ? 'host' : you ? 'you' : `m${i}`, handle: 'handle' in p ? p.handle : undefined, name: p.host ? (hostName ?? p.name) : p.name, spec: mateFor(p.host ? (hostName ?? 'host') : p.name), beacon: pres.live && (p.host ? pres.live.presenter === 'host' : p.name === presenterName) ? 'presenting' as const : p.connected ? 'available' as const : 'away' as const, host: p.host, you };
    });
  useEffect(() => api.onFileState((s) => {
    const r = resources.find((x) => x.id === s.resourceId);
    if (!r) return;
    if ((s.state === 'downloading' || s.state === 'verifying') && !seen.current.has(r.id)) {
      seen.current.add(r.id);
      const from = document.querySelector('[data-person="host"]'), to = document.querySelector('[data-person="you"]') ?? document.querySelector('[data-testid="room-table"]');
      if (from && to) void flyPacket(from, to, r.direct ? `For you · ${r.name}` : r.name, { tone: 'receive' });
    }
    if (s.state === 'completed') setArrived(`${r.name} · verified ✓${r.direct ? ` · sent to you by ${r.direct.from}` : ''}${s.via && /peer/.test(s.via) ? ' · with help from classmates' : ''}`);
  }), [resources]);
  const tableDrop = onTableDrop && (async (files: File[]) => {
    const table = document.querySelector('[data-testid="room-table"]'), me = document.querySelector('[data-person="you"]');
    if (table && me) void flyPacket(me, table, files.length === 1 ? files[0]!.name : `${files.length} files`);
    try { toast(await onTableDrop(files)); } catch (e) { toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  });
  return (
    <>
      <RoomStage people={list} items={resources.filter((r) => !r.direct).map((r) => ({ id: r.id, name: r.name, kind: KIND(r.mime) }))} selected={sel?.p.id}
        dropLabel={tableDrop ? 'Drop files here to share with everyone' : undefined} onDropFiles={tableDrop}
        onDropOnPerson={actions?.canSendFiles ? (p, files) => { const x = list.find((y) => y.id === p.id); if (x?.handle) void sendToPerson(actions, x, files, toast); } : undefined}
        onPerson={actions ? (p, el) => setSel({ p: list.find((x) => x.id === p.id)!, at: el.getBoundingClientRect() }) : undefined}
        wall={<RoomSurface mode={pres.live ? 'SCREEN_SHARE' : board ? 'WHITEBOARD' : 'DEFAULT'} screen={pres.live ? { pres, live: pres.live } : undefined} board={board}><div className="wall-msg"><b>{hostName ? `${hostName}’s room` : 'The room'}</b><span>{arrived ?? `When someone presents, their screen appears on this wall.`}</span></div></RoomSurface>} />
      {sel && actions && (
        <Wheel person={sel.p} at={sel.at} onClose={() => setSel(null)} actions={[
          ...personActions(actions, sel.p, () => setSel(null), toast),
          { label: 'Profile', enabled: true, run: () => setSel(null) },
          { label: 'Study', ...LATER('Study rooms') },
        ]}>
          <span className="muted small-text">{sel.p.you ? 'That’s you.' : sel.p.host ? `${hostLabel} of this CLAN` : sel.p.beacon === 'away' ? 'Not connected right now' : 'In the room'}</span>
        </Wheel>
      )}
    </>
  );
}
