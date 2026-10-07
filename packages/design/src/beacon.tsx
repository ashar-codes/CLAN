// CLAN Beacon: an open "C" ring (CLAN's mark) beside a person, never above the head. State = colour + glyph, so it
// never depends on colour alone.
import type { ReactNode } from 'react';
export type BeaconState = 'available' | 'studying' | 'focus' | 'presenting' | 'transfer' | 'away';
export const BEACON_STATES: BeaconState[] = ['available', 'studying', 'focus', 'presenting', 'transfer', 'away'];
export const BEACON_LABEL: Record<BeaconState, string> = {
  available: 'Available', studying: 'Studying', focus: 'Focus — do not disturb', presenting: 'Presenting', transfer: 'Sending files', away: 'Away',
};

const GLYPH: Record<BeaconState, ReactNode> = {
  available: <circle cx="12" cy="12" r="3" fill="currentColor" />,
  studying: <path d="M8 9.5h8M8 12h8M8 14.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  focus: <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" strokeWidth="2" />,
  presenting: <path d="M9.5 9.2a4 4 0 0 0 0 5.6M14.5 9.2a4 4 0 0 1 0 5.6M12 11v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />,
  transfer: <path d="M9 12h6m-2.4-2.6L15 12l-2.4 2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none" />,
  away: <path d="M10 12h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
};

export function CLANBeacon({ state, size = 22, title }: { state: BeaconState; size?: number; title?: string }) {
  const ring = state === 'focus' ? 'M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18' : 'M18.4 5.6A9 9 0 1 0 18.4 18.4';
  return (
    <svg className={`c-beacon c-beacon-${state}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title ?? BEACON_LABEL[state]}
      style={{ color: `var(--beacon-${state})`, flex: 'none' }}>
      <circle cx="12" cy="12" r="11" fill="var(--surface)" />
      <path className="c-beacon-ring" d={ring} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"
        strokeDasharray={state === 'away' ? '2.5 3.5' : undefined} />
      {GLYPH[state]}
    </svg>
  );
}
