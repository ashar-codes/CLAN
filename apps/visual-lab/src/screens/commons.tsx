// Commons (who is near) and the CLANmate interaction (radial wheel + drag-a-file-onto-a-person).
import { lazy, Suspense, useRef, useState, type DragEvent } from 'react';
import { BEACON_LABEL, CLANBeacon, CLANmate, ResourceCard, type BeaconState } from '@clan/design';
import { loadCommons } from '@clan/world';
import { FILES, PEOPLE } from '../demo/fixtures.ts';
import { markScene } from '../overlays.tsx';
import type { Lab } from '../main.tsx';

const t0 = { v: 0 };
const CommonsScene = lazy(() => { t0.v = performance.now(); return loadCommons(); });
const RING = { here: 'At your table', near: 'In this building', far: 'On campus network' } as const;
const RADIUS = { here: 22, near: 34, far: 46 };

function Fallback({ onSelect }: { onSelect(id: string): void }) {
  return (
    <div className="commons-2d" role="list" aria-label="People nearby">
      {[46, 34, 22].map((r) => <span key={r} className="ring" style={{ width: `${r * 2}%`, height: `${r * 2}%` }} />)}
      {(['here', 'near', 'far'] as const).flatMap((d) => {
        const ps = PEOPLE.filter((p) => p.distance === d);
        return ps.map((p, i) => {
          const a = (i / ps.length) * Math.PI * 2 + (d === 'near' ? 0.5 : d === 'far' ? 1 : 0.2);
          return <button key={p.id} role="listitem" className="mate-pin" style={{ left: `${50 + Math.sin(a) * RADIUS[d]}%`, top: `${50 + Math.cos(a) * RADIUS[d] * 0.62}%` }} onClick={() => onSelect(p.id)}>
            <CLANmate spec={p.spec} beacon={p.beacon} size={d === 'far' ? 62 : 78} /><span>{p.name}</span></button>;
        });
      })}
    </div>
  );
}

export function Commons({ lab }: { lab: Lab }) {
  const open = (id: string) => lab.go('mate', id);
  return (
    <div className="split">
      <div className="scene">
        {lab.threeD ? <Suspense fallback={<Fallback onSelect={open} />}><CommonsScene people={PEOPLE} onSelect={open} onReady={() => markScene('commons', t0.v)} /></Suspense> : <Fallback onSelect={open} />}
      </div>
      <aside className="side">
        <h1 className="c-title">Commons</h1>
        <p className="muted">People reachable on this network right now. Tap someone to send, chat or study together.</p>
        {(['here', 'near', 'far'] as const).map((d) => (
          <section key={d}><span className="c-eyebrow">{RING[d]}</span>
            {PEOPLE.filter((p) => p.distance === d).map((p) => (
              <button key={p.id} className="person-row" onClick={() => open(p.id)}>
                <CLANmate spec={p.spec} size={44} /><span><b>{p.name}</b><small>{p.course} · {p.note}</small></span>
                <span className="beacon-tag"><CLANBeacon state={p.beacon} size={18} />{BEACON_LABEL[p.beacon].split(' —')[0]}</span>
              </button>
            ))}
          </section>
        ))}
      </aside>
    </div>
  );
}

const ACTIONS = ['Send', 'Chat', 'Study', 'Profile', 'Screen', 'Invite'] as const;

export function Mate({ lab }: { lab: Lab }) {
  const p = PEOPLE.find((x) => x.id === lab.arg) ?? PEOPLE[0]!;
  const [beacon, setBeacon] = useState<BeaconState>(p.beacon);
  const [panel, setPanel] = useState<(typeof ACTIONS)[number] | null>(null);
  const [over, setOver] = useState(false);
  const [chat, setChat] = useState([`${p.name}: did you get the lecture 6 slides?`]);
  const target = useRef<HTMLDivElement>(null);

  const send = (fileId: string, from?: DOMRect) => {
    const f = FILES.find((x) => x.id === fileId); const to = target.current?.getBoundingClientRect();
    if (!f || !to) return;
    const src = from ?? new DOMRect(16, innerHeight / 2, 200, 40);
    const chip = Object.assign(document.createElement('div'), { className: 'fly-chip', textContent: f.title });
    document.body.append(chip);
    const dx = to.left + to.width / 2 - (src.left + 60), dy = to.top + to.height * 0.35 - src.top;
    const anim = chip.animate([
      { transform: `translate(${src.left}px, ${src.top}px) scale(1)`, opacity: 1, easing: 'ease-out' },
      { transform: `translate(${src.left + dx / 2}px, ${src.top + dy / 2 - 140}px) scale(.9) rotate(-8deg)`, opacity: 1, offset: 0.5, easing: 'ease-in' },
      { transform: `translate(${src.left + dx}px, ${src.top + dy}px) scale(.3)`, opacity: 0 },
    ], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 900 });
    anim.onfinish = () => { chip.remove(); setBeacon('transfer'); setTimeout(() => { setBeacon(p.beacon); lab.toast(`${f.title} sent to ${p.name} · verified`); }, 1400); };
    setPanel(null);
  };
  const act = (a: (typeof ACTIONS)[number]) => {
    if (a === 'Study') return lab.go('study');
    if (a === 'Screen') return lab.toast(`Asked ${p.name} to share their screen (lab prototype)`);
    if (a === 'Invite') return lab.toast(`Invited ${p.name} to your Study Room (lab prototype)`);
    setPanel(panel === a ? null : a);
  };

  return (
    <div className="mate-view">
      <aside className={`tray ${panel === 'Send' ? 'pick' : ''}`}>
        <span className="c-eyebrow">{panel === 'Send' ? 'Pick a file to send' : 'Your files — drag onto ' + p.name}</span>
        {FILES.map((f) => (
          <div key={f.id} draggable onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/clan-file', f.id)} onClick={(e) => panel === 'Send' && send(f.id, e.currentTarget.getBoundingClientRect())}>
            <ResourceCard title={f.title} kind={f.kind} bytes={f.bytes} />
          </div>
        ))}
      </aside>
      <div className="wheel-wrap">
        <button className="c-btn ghost back" onClick={() => lab.go('commons')}>← Commons</button>
        <div ref={target} className={`drop ${over ? 'over' : ''}`} aria-label={`Drop a file to send to ${p.name}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.getData('text/clan-file'), new DOMRect(e.clientX - 60, e.clientY, 0, 0)); }}>
          <CLANmate spec={p.spec} beacon={beacon} size={230} label={p.name} />
          <div className="wheel" role="menu" aria-label={`Actions for ${p.name}`}>
            {ACTIONS.map((a, i) => <button key={a} role="menuitem" className={`spoke ${panel === a ? 'on' : ''}`} style={{ ['--a' as string]: `${i * 60 - 90}deg` }} onClick={() => act(a)}>{a}</button>)}
          </div>
        </div>
        <h1 className="c-title center">{p.name}</h1>
        <p className="muted center"><CLANBeacon state={beacon} size={16} /> {BEACON_LABEL[beacon]} · {p.course}</p>
        {panel === 'Profile' && <div className="c-card pop"><b>{p.name}</b><p className="muted">{p.course} · {p.note}</p><p className="small">Shares 2 CLANs with you: CS-201, Thursday study group.</p></div>}
        {panel === 'Chat' && <form className="c-card pop chat" onSubmit={(e) => { e.preventDefault(); const i = (e.currentTarget.elements.namedItem('m') as HTMLInputElement); if (i.value.trim()) { setChat([...chat, `You: ${i.value.trim()}`]); i.value = ''; } }}>
          {chat.map((m, i) => <p key={i} className={m.startsWith('You') ? 'me' : ''}>{m}</p>)}<input name="m" placeholder={`Message ${p.name}`} autoFocus /></form>}
      </div>
    </div>
  );
}
