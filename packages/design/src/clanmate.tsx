// Modular CLANmate: base + hair + top + bottom + shoes + accessory + backpack (+ Beacon beside it).
// Pure function of a spec; the same spec drives the 3D figure in @clan/world. No photos, no face data.
import type { ReactNode } from 'react';
import { CLANBeacon, type BeaconState } from './beacon.tsx';

export type Hair = 'crop' | 'bun' | 'curls' | 'long' | 'buzz' | 'bob';
export type Top = 'hoodie' | 'tee' | 'jacket' | 'sweater';
export type Bottom = 'jeans' | 'skirt' | 'shorts' | 'trousers';
export type Accessory = 'glasses' | 'headphones' | 'cap' | 'scarf' | null;
export type CLANmateSpec = {
  skin: string; hair: Hair; hairColor: string; top: Top; topColor: string; bottom: Bottom; bottomColor: string;
  shoes: 'sneakers' | 'boots'; shoeColor: string; accessory: Accessory; backpack: string | null;
};

const HAIR: Record<Hair, (c: string) => ReactNode> = {
  crop: (c) => <path d="M26 27c0-10 6-15 14-15s14 5 14 14c-3-4-8-6-14-6s-11 2-14 7z" fill={c} />,
  buzz: (c) => <path d="M27 25c1-8 6-12 13-12s12 4 13 12c-4-3-8-4-13-4s-9 1-13 4z" fill={c} />,
  bun: (c) => <g fill={c}><circle cx="40" cy="9" r="6" /><path d="M26 28c0-10 6-15 14-15s14 5 14 15c-3-5-8-7-14-7s-11 2-14 7z" /></g>,
  curls: (c) => <g fill={c}>{[[29, 20], [35, 15], [42, 13], [49, 16], [53, 23], [27, 28], [54, 30]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="6" />)}</g>,
  long: (c) => <path d="M25 30c-1-12 6-18 15-18s16 6 15 18v22c-3 2-6 2-8 0V28c-4-3-10-3-14 0v24c-2 2-5 2-8 0z" fill={c} />,
  bob: (c) => <path d="M25 31c-1-12 6-19 15-19s16 7 15 19c0 5-1 9-3 11-1-8-1-14-2-17-6-1-14-1-20 0-1 3-1 9-2 17-2-2-3-6-3-11z" fill={c} />,
};

function TopShape({ kind, c }: { kind: Top; c: string }) {
  return (
    <g>
      <path d="M24 52c0-6 5-10 10-10h12c5 0 10 4 10 10v34H24z" fill={c} />
      <rect x="15" y="46" width="9" height="34" rx="4.5" fill={c} />
      <rect x="56" y="46" width="9" height="34" rx="4.5" fill={c} />
      {kind === 'hoodie' && <path d="M32 42c2 6 14 6 16 0M37 50v9M43 50v9" stroke="rgba(0,0,0,.18)" strokeWidth="2" fill="none" strokeLinecap="round" />}
      {kind === 'jacket' && <path d="M40 44v42M33 44l7 10 7-10" stroke="rgba(0,0,0,.2)" strokeWidth="2" fill="none" />}
      {kind === 'sweater' && <path d="M24 80h32M15 76h9M56 76h9" stroke="rgba(255,255,255,.35)" strokeWidth="3" />}
      {kind === 'tee' && <path d="M15 58h9M56 58h9" stroke="rgba(0,0,0,.12)" strokeWidth="2" />}
    </g>
  );
}

function BottomShape({ kind, c }: { kind: Bottom; c: string }) {
  if (kind === 'skirt') return <path d="M25 84h30l5 24H20z" fill={c} />;
  const len = kind === 'shorts' ? 104 : 124;
  return <g fill={c}><rect x="26" y="84" width="13" height={len - 84} rx="3" /><rect x="41" y="84" width="13" height={len - 84} rx="3" /><rect x="26" y="84" width="28" height="10" /></g>;
}

export function CLANmate({ spec, beacon, size = 120, label }: { spec: CLANmateSpec; beacon?: BeaconState; size?: number; label?: string }) {
  const legsBare = spec.bottom === 'skirt' || spec.bottom === 'shorts';
  return (
    <span className="c-mate" data-state={beacon ?? 'available'} style={{ position: 'relative', display: 'inline-block', width: size * (80 / 140), height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={!label || undefined}>
      <svg viewBox="0 0 80 140" width="100%" height="100%" aria-hidden>
        <ellipse cx="40" cy="134" rx="22" ry="4" fill="rgba(29,35,32,.14)" />
        <g className="c-mate-body">
        {spec.backpack && <rect x="48" y="48" width="16" height="30" rx="6" fill={spec.backpack} />}
        {legsBare && <g fill={spec.skin}><rect x="28" y="96" width="9" height="30" rx="4" /><rect x="43" y="96" width="9" height="30" rx="4" /></g>}
        <BottomShape kind={spec.bottom} c={spec.bottomColor} />
        <g fill={spec.shoeColor}>
          <rect x="24" y={spec.shoes === 'boots' ? 116 : 122} width="16" height={spec.shoes === 'boots' ? 14 : 8} rx="4" />
          <rect x="40" y={spec.shoes === 'boots' ? 116 : 122} width="16" height={spec.shoes === 'boots' ? 14 : 8} rx="4" />
        </g>
        <rect x="35" y="36" width="10" height="10" rx="3" fill={spec.skin} />
        <TopShape kind={spec.top} c={spec.topColor} />
        <circle cx="19.5" cy="82" r="4" fill={spec.skin} /><circle cx="60.5" cy="82" r="4" fill={spec.skin} />
        {spec.backpack && <path d="M50 44v24" stroke={spec.backpack} strokeWidth="3" strokeLinecap="round" />}
        <circle cx="40" cy="28" r="14" fill={spec.skin} />
        {HAIR[spec.hair](spec.hairColor)}
        <g fill="#1d2320"><circle cx="35" cy="30" r="1.6" /><circle cx="45" cy="30" r="1.6" /></g>
        <g fill="#e98a7a" opacity=".45"><circle cx="31.5" cy="34" r="2.4" /><circle cx="48.5" cy="34" r="2.4" /></g>
        <path d="M37 36q3 3 6 0" fill="none" stroke="#603d32" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M26 54v26h5V52z" fill="#fff" opacity=".14" />
        {spec.accessory === 'glasses' && <g fill="none" stroke="#1d2320" strokeWidth="1.4"><circle cx="35" cy="30" r="4" /><circle cx="45" cy="30" r="4" /><path d="M39 30h2" /></g>}
        {spec.accessory === 'headphones' && <g fill="none" stroke="#2b2f2d" strokeWidth="3"><path d="M25 30a15 15 0 0 1 30 0" /><rect x="22" y="27" width="5" height="9" rx="2" fill="#2b2f2d" /><rect x="53" y="27" width="5" height="9" rx="2" fill="#2b2f2d" /></g>}
        {spec.accessory === 'cap' && <path d="M25 22c2-8 8-11 15-11s13 3 15 11zM40 21h22c0 3-2 4-5 4H40z" fill={spec.topColor} stroke="rgba(0,0,0,.15)" />}
        {spec.accessory === 'scarf' && <path d="M30 42h20v6H30zM44 46h6v14h-6z" fill="#e3a92f" />}
        {(beacon === 'studying' || beacon === 'focus') && <g transform="rotate(-8 40 75)"><rect x="26" y="69" width="28" height="20" rx="2" fill="var(--burgundy)" /><path d="M40 70v17M29 73h7M44 73h7" stroke="var(--surface)" strokeWidth="1.5" /></g>}
        {beacon === 'presenting' && <path d="M62 82l9-22" stroke={spec.skin} strokeWidth="6" strokeLinecap="round" />}
        {beacon === 'transfer' && <g className="c-mate-parcel"><rect x="49" y="65" width="20" height="15" rx="3" fill="var(--transfer)" /><path d="M54 72h10m-4-3 4 3-4 3" fill="none" stroke="var(--surface)" strokeWidth="1.5" /></g>}
        </g>
      </svg>
      {beacon && <span style={{ position: 'absolute', right: -size * 0.12, top: size * 0.22 }}><CLANBeacon state={beacon} size={Math.max(16, size * 0.2)} /></span>}
    </span>
  );
}
