// CLANs as places. Lightweight SVG (no 3D) so a list of CLANs stays cheap; the room opens on click.
import type { ReactNode } from 'react';

export type PlaceType = 'CLASSROOM' | 'STUDY_GROUP' | 'PROJECT_TEAM' | 'FRIENDS' | 'TEMPORARY';

/** Seats around the place = real member count (capped visually); paper stacks = real file count. */
export function ClanPlace({ type, members, files, live = false, title }: { type: PlaceType; members: number; files: number; live?: boolean; title: string }) {
  const seats = Math.min(members, 8), stacks = Math.min(files, 6);
  const accent = { CLASSROOM: 'var(--burgundy)', STUDY_GROUP: 'var(--study)', PROJECT_TEAM: 'var(--brick)', FRIENDS: 'var(--campus)', TEMPORARY: 'var(--notebook)' }[type];
  const scene: Record<PlaceType, ReactNode> = {
    CLASSROOM: <g><rect x="40" y="14" width="120" height="34" rx="4" fill="#2a3a33" /><path d="M54 26h40M54 34h60" stroke="#e9f2ec" strokeWidth="3" strokeLinecap="round" opacity=".7" />
      {[0, 1, 2].map((r) => <rect key={r} x={44 + r * 6} y={62 + r * 16} width={112 - r * 12} height="8" rx="3" fill="var(--wood)" />)}</g>,
    STUDY_GROUP: <g><ellipse cx="100" cy="74" rx="64" ry="22" fill="var(--wood)" /><ellipse cx="100" cy="70" rx="64" ry="22" fill="var(--wood)" opacity=".85" /><rect x="88" y="26" width="24" height="18" rx="3" fill="var(--notebook-soft)" /></g>,
    PROJECT_TEAM: <g><rect x="30" y="58" width="140" height="14" rx="3" fill="var(--wood)" /><rect x="40" y="20" width="56" height="34" rx="3" fill="var(--surface)" stroke="var(--line)" /><path d="M48 30h30M48 38h22" stroke={accent} strokeWidth="3" /><rect x="110" y="24" width="10" height="30" fill="var(--wood-dark)" /><circle cx="140" cy="36" r="10" fill="var(--notebook)" /></g>,
    FRIENDS: <g><path d="M30 80c0-22 30-30 70-30s70 8 70 30z" fill="var(--campus-soft)" /><rect x="44" y="56" width="50" height="16" rx="8" fill={accent} /><rect x="110" y="56" width="46" height="16" rx="8" fill="var(--notebook)" /><circle cx="100" cy="30" r="10" fill="var(--notebook)" opacity=".7" /></g>,
    TEMPORARY: <g><path d="M60 22h80l-10 18H70z" fill={accent} /><path d="M70 22v-6M130 22v-6" stroke="var(--ink-3)" strokeWidth="2" /><rect x="64" y="56" width="72" height="12" rx="3" fill="var(--wood)" /><path d="M76 68v18M124 68v18" stroke="var(--wood-dark)" strokeWidth="4" /></g>,
  };
  const seat = (i: number) => { const a = (i / Math.max(seats, 1)) * Math.PI - Math.PI; return [100 + Math.cos(a) * 82, 70 + Math.sin(a) * -12 + (i % 2 ? 22 : 0)] as const; };
  return (
    <svg viewBox="0 0 200 110" className="c-place" role="img" aria-label={`${title}: ${members} member${members === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}${live ? ', live now' : ''}`}>
      <rect width="200" height="110" rx="14" fill="var(--wall)" />
      <rect y="78" width="200" height="32" fill="var(--floor)" />
      {scene[type]}
      {Array.from({ length: stacks }, (_, i) => <rect key={i} x={86 + (i % 3) * 10} y={62 - Math.floor(i / 3) * 4} width="8" height="5" rx="1" fill={i % 2 ? 'var(--surface)' : 'var(--notebook-soft)'} stroke="var(--line)" strokeWidth=".6" />)}
      {Array.from({ length: seats }, (_, i) => { const [x, y] = seat(i); return <g key={i}><circle cx={x} cy={y} r="7" fill={accent} opacity=".9" /><circle cx={x} cy={y - 9} r="4.5" fill="var(--ink-3)" opacity=".55" /></g>; })}
      {live && <g><circle cx="182" cy="16" r="6" fill="var(--campus)" /><circle cx="182" cy="16" r="10" fill="none" stroke="var(--campus)" strokeWidth="2" className="c-live-ring" /></g>}
    </svg>
  );
}
