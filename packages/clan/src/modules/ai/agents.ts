// Constrained educational agents. An agent is a named set of read capabilities and proposal kinds; it never writes,
// never messages anyone, never runs in the background. Every request runs as an agent principal acting on behalf of one
// user, so module permission checks (agentMay) apply on top of the user's own access.
import type { ProposalKind } from '@classroom/protocol';
import type { Principal } from '../../core/permissions.ts';

export type SourceKind = 'notes' | 'resources' | 'saved' | 'classroom' | 'chat' | 'study' | 'recordings' | 'diary';
export const SOURCE_KINDS: SourceKind[] = ['notes', 'resources', 'saved', 'classroom', 'chat', 'study', 'recordings', 'diary'];
export type Action = 'ask' | 'askDocument' | 'explain' | 'summarize' | 'simplify' | 'questions' | 'chatSummary'
  | 'flashcards' | 'quiz' | 'compare' | 'prepareLecture' | 'pastPaper' | 'examPlan';
export type AgentDefinition = {
  id: string; name: string; owner: 'system' | string;
  reads: SourceKind[]; actions: Action[]; proposals: ProposalKind[];
  /** null = the configured default provider/model. */
  provider: string | null; model: string | null;
  /** Things it explicitly cannot do (shown to the student). */
  cannot: string[];
};
const NO = ['write to your data without your approval', 'message people', 'run in the background'];

export const AGENTS: AgentDefinition[] = [
  { id: 'guide', name: 'CLAN Guide', owner: 'system', reads: SOURCE_KINDS, actions: ['ask', 'askDocument', 'explain', 'summarize', 'simplify', 'questions', 'chatSummary'],
    proposals: ['APPEND_NOTE'], provider: null, model: null, cannot: ['read your Diary unless you allowed it', ...NO] },
  { id: 'note-coach', name: 'Note Coach', owner: 'system', reads: ['notes', 'resources', 'saved', 'classroom', 'study'], actions: ['compare'],
    proposals: ['APPEND_NOTE', 'CREATE_TASKS'], provider: null, model: null, cannot: ['read your Diary or chats', ...NO] },
  { id: 'quiz-master', name: 'Quiz Master', owner: 'system', reads: ['notes', 'resources', 'saved', 'classroom', 'study'], actions: ['quiz', 'flashcards'],
    proposals: ['CREATE_FLASHCARDS', 'UPDATE_TOPIC_CONFIDENCE'], provider: null, model: null, cannot: ['read your Diary or chats', 'change your topic marks by itself', ...NO] },
  { id: 'lecture-prep', name: 'Lecture Prep', owner: 'system', reads: ['notes', 'resources', 'saved', 'classroom', 'study', 'recordings'], actions: ['prepareLecture'],
    proposals: ['APPEND_NOTE', 'CREATE_FLASHCARDS', 'CREATE_TASKS'], provider: null, model: null, cannot: ['read your Diary or chats', 'invent a recording or transcript', ...NO] },
  { id: 'paper-analyst', name: 'Past-paper Analyst', owner: 'system', reads: ['resources', 'classroom', 'study'], actions: ['pastPaper'],
    proposals: ['ADD_EXAM_SCOPE'], provider: null, model: null, cannot: ['read scans without text', 'read your notes, Diary or chats', ...NO] },
  { id: 'exam-coach', name: 'Exam Coach', owner: 'system', reads: ['notes', 'resources', 'saved', 'classroom', 'study', 'recordings'], actions: ['examPlan', 'ask', 'explain', 'quiz', 'flashcards'],
    proposals: ['CREATE_STUDY_PLAN', 'CREATE_FLASHCARDS', 'UPDATE_TOPIC_CONFIDENCE'], provider: null, model: null,
    cannot: ['read your Diary', 'read unrelated courses', 'read your chats', 'change topic marks, tasks, reminders or exam dates by itself', ...NO] },
];
export const agentFor = (action: Action, preferred?: string) => {
  const a = (preferred && AGENTS.find((x) => x.id === preferred && x.actions.includes(action))) || AGENTS.find((x) => x.actions.includes(action));
  if (!a) throw new Error('No agent may do that.');
  return a;
};

const MODULE_SCOPES: Record<SourceKind, string[]> = {
  notes: ['notes:read'], resources: ['files:read'], saved: ['saved:read'], classroom: ['files:read', 'notes:read'], chat: ['chat:read'],
  study: ['courses:read', 'tasks:read', 'exams:read', 'flashcards:read', 'reminders:read', 'study:read'], recordings: ['recordings:read'], diary: ['diary:read'],
};
/** The agent principal for one request: the agent's reads ∩ what the student included (Diary also needs the grant, checked by the broker). */
export function principalFor(agent: AgentDefinition, userId: string, include: Record<SourceKind, boolean>): Principal & { kind: 'agent' } {
  const kinds = agent.reads.filter((k) => include[k]);
  return { kind: 'agent', agentId: agent.id, onBehalfOf: userId, scopes: [...new Set(kinds.flatMap((k) => MODULE_SCOPES[k]))] };
}
export const may = (p: Principal, scope: string) => p.kind === 'user' || p.scopes.includes(scope);
