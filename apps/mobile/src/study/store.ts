// Phone Study persistence: one JSON document in the app's documents folder (offline, on this phone only).
import { useCallback, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { EMPTY, S, type StudyState } from './model';

const dir = () => new Directory(Paths.document, 'CLAN');
const file = () => new File(dir(), 'study.json');
export function loadStudy(): StudyState {
  try { const f = file(); if (!f.exists) return EMPTY; const v = JSON.parse(f.textSync()) as StudyState; return v?.v === 1 ? { ...EMPTY, ...v } : EMPTY; } catch { return EMPTY; }
}
function save(s: StudyState) { const d = dir(); if (!d.exists) d.create({ intermediates: true }); file().write(JSON.stringify(s)); }

/** `apply(f)` runs a pure model step with the current time and a fresh id source, then persists. Errors come back as text. */
export function useStudy() {
  const [s, setS] = useState<StudyState>(loadStudy);
  const apply = useCallback((f: (s: StudyState, c: { now: number; id(): string }) => StudyState): string | null => {
    try { const next = f(loadStudy(), { now: Date.now(), id: randomUUID }); save(next); setS(next); return null; } catch (e) { return (e as Error).message; }
  }, []);
  return [s, apply] as const;
}

/** In a Classroom: keep the host's latest assignment list (projection) and give the Classroom a linked course once. */
export function recordAssignments(clanId: string, clanName: string, list: Parameters<typeof S.seenAssignments>[4]) {
  try { save(S.seenAssignments(loadStudy(), { now: Date.now(), id: randomUUID }, clanId, clanName, list)); } catch { /* projection only; never blocks the class */ }
}
