// Content cards. Props only; no feature imports.
import { CLANmate, type CLANmateSpec } from './clanmate.tsx';
import type { BeaconState } from './beacon.tsx';

const KIND_TINT: Record<string, string> = { pdf: 'var(--clay-soft)', slides: 'var(--mustard-soft)', video: 'var(--sky-soft)', code: 'var(--sage-soft)', link: 'var(--paper-2)' };
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function ResourceCard({ title, kind, bytes, from, onOpen }: { title: string; kind: string; bytes?: number; from?: string; onOpen?(): void }) {
  return (
    <button className="c-card c-resource" onClick={onOpen} style={{ display: 'flex', gap: 12, alignItems: 'center', textAlign: 'left', width: '100%', cursor: onOpen ? 'pointer' : 'default', font: 'inherit', color: 'inherit' }}>
      <span style={{ width: 40, height: 48, borderRadius: 6, background: KIND_TINT[kind] ?? 'var(--paper-2)', display: 'grid', placeItems: 'center', font: '700 10px var(--font-body)', textTransform: 'uppercase', color: 'var(--ink-2)', flex: 'none' }}>{kind}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{[bytes && fmtSize(bytes), from].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  );
}

export type SavedCardProps = { title: string; source: string; url: string; preview?: string; note?: string; tags: string[] };
/** Links + metadata only — never a copy of the linked content. */
export function SavedCard({ title, source, url, preview, note, tags }: SavedCardProps) {
  return (
    <article className="c-card c-saved" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ height: 84, background: preview ?? 'var(--paper-2)', display: 'flex', alignItems: 'flex-end', padding: 10 }}>
        <span className="c-chip" style={{ background: 'var(--surface)' }}>{source}</span>
      </div>
      <div style={{ padding: 12, display: 'grid', gap: 6 }}>
        <a href={url} target="_blank" rel="noreferrer noopener" style={{ font: '650 15px/1.25 var(--font-display)', color: 'var(--ink)', textDecoration: 'none' }}>{title}</a>
        {note && <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)' }}>{note}</p>}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{tags.map((t) => <span key={t} className="c-chip">#{t}</span>)}</div>
      </div>
    </article>
  );
}

/** Days left + readiness ring. */
export function ExamIndicator({ course, daysLeft, readiness }: { course: string; daysLeft: number; readiness: number }) {
  const r = 18, c = 2 * Math.PI * r;
  const tone = daysLeft <= 3 ? 'var(--clay)' : daysLeft <= 10 ? 'var(--mustard)' : 'var(--sage)';
  return (
    <div className="c-exam" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={`${Math.round(readiness * 100)}% ready`}>
        <circle cx="22" cy="22" r={r} fill="none" stroke="var(--paper-2)" strokeWidth="5" />
        <circle cx="22" cy="22" r={r} fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * readiness} ${c}`} transform="rotate(-90 22 22)" />
        <text x="22" y="26" textAnchor="middle" style={{ font: '700 11px var(--font-body)', fill: 'var(--ink)' }}>{daysLeft}d</text>
      </svg>
      <div><div style={{ fontWeight: 650 }}>{course}</div><div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{daysLeft === 0 ? 'Today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`} · {Math.round(readiness * 100)}% ready</div></div>
    </div>
  );
}

export type Seat = { name: string; spec: CLANmateSpec; beacon: BeaconState };
/** A shared table seen at a gentle angle: people around it, shared items on it. */
export function StudyTable({ seats, items = [] }: { seats: Seat[]; items?: { label: string; tint: string }[] }) {
  const back = seats.slice(0, Math.ceil(seats.length / 2)), front = seats.slice(back.length);
  const row = (s: Seat[]) => <div style={{ display: 'flex', justifyContent: 'center', gap: 18 }}>{s.map((p) => <div key={p.name} style={{ textAlign: 'center' }}><CLANmate spec={p.spec} beacon={p.beacon} size={92} label={p.name} /><div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div></div>)}</div>;
  return (
    <div className="c-table" style={{ display: 'grid', gap: 0 }}>
      {row(back)}
      <div style={{ margin: '-6px auto -10px', width: 'min(100%, 460px)', height: 120, background: 'linear-gradient(#c99a6b, #b88655)', borderRadius: 28, transform: 'perspective(600px) rotateX(38deg)', boxShadow: '0 22px 0 #8f6440, var(--shadow-2)', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        {items.map((i) => <span key={i.label} style={{ background: i.tint, borderRadius: 4, padding: '14px 10px', font: '700 10px var(--font-body)', color: 'var(--ink)', boxShadow: '0 2px 0 rgba(0,0,0,.15)', transform: 'rotate(-4deg)' }}>{i.label}</span>)}
      </div>
      <div style={{ position: 'relative', zIndex: 2 }}>{row(front)}</div>
    </div>
  );
}
