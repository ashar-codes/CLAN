// The phone's pre-core study.json (read once by core/migrate.ts; the phone now stores study data in @clan/core).
import { Directory, File, Paths } from 'expo-file-system';
import { EMPTY, type StudyState } from './model';

const file = () => new File(new Directory(Paths.document, 'CLAN'), 'study.json');
export function loadStudy(): StudyState {
  try { const f = file(); if (!f.exists) return EMPTY; const v = JSON.parse(f.textSync()) as StudyState; return v?.v === 1 ? { ...EMPTY, ...v } : EMPTY; } catch { return EMPTY; }
}
