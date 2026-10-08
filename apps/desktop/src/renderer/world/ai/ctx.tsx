// The tiny, eagerly loaded part of CLAN Intelligence: places call `useAI().open(...)`; the sheet itself (and every other
// AI component) is a lazy chunk, so startup does not pay for it. AIHost wraps every screen (CLAN world and live rooms).
import { createContext, lazy, Suspense, useContext, useRef, useState, type ReactNode } from 'react';
import type { Action, AIScope, Include } from '../../../shared.ts';
import { api } from '../../App.tsx';

export type AIOpen =
  | { mode: 'run'; title: string; action: Action; scope: AIScope; question?: string; selection?: string; include?: Partial<Include>; ask?: boolean; deckId?: string | null;
      /** Note actions: where the student chooses to put the result (never automatic). */
      onText?(text: string, how: 'insert' | 'append' | 'new'): void }
  | { mode: 'paper'; title: string; refId: string; examId?: string | null }
  | { mode: 'coach'; title: string; examId: string };
type Nav = (open: Record<string, unknown>) => void;
export type AICtx = { open(o: AIOpen): void; nav: { current: Nav | null } };
const AIContext = createContext<AICtx>({ open: () => {}, nav: { current: null } });
export const useAI = () => useContext(AIContext);
const Sheet = lazy(() => import('./Sheet.tsx'));

export function AIHost({ children }: { children: ReactNode }) {
  const [o, setO] = useState<AIOpen | null>(null);
  const nav = useRef<Nav | null>(null);
  const openSource = (t: Record<string, unknown> | null) => {
    if (!t) return;
    if (t.module === 'files') { void api.ai.openFile(String(t.refId)); return; }
    if (nav.current) { nav.current(t); setO(null); }
  };
  return (
    <AIContext.Provider value={{ open: setO, nav }}>
      {children}
      {o && <Suspense fallback={<div className="ai-sheet card" role="status">Loading CLAN…</div>}><Sheet o={o} onClose={() => setO(null)} openSource={openSource} /></Suspense>}
    </AIContext.Provider>
  );
}
