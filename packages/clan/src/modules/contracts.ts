// Modules that are designed but not built in this phase: types and interfaces only, so other modules and the shell can
// depend on stable shapes. No implementation exists; nothing may pretend otherwise.
import { z } from 'zod';
import { defineEvent } from '../core/events.ts';
import type { Principal, Scope } from '../core/permissions.ts';

// Chat
export type ChatThread = { id: string; scope: Scope; title: string | null; createdAt: number };
export type Message = { id: string; threadId: string; authorId: string; body: string; refs: { module: string; id: string }[]; sentAt: number };
export interface ChatModule { threads(p: Principal, clanId: string): ChatThread[]; post(p: Principal, threadId: string, body: string): Message }

// Tasks
export type Task = { id: string; ownerId: string; scope: Scope; title: string; dueAt: number | null; doneAt: number | null; ref?: { module: string; id: string } };
export interface TasksModule { list(p: Principal, scope: Scope): Task[]; create(p: Principal, t: Omit<Task, 'id' | 'doneAt'>): Task }

// Courses (a CLASSROOM CLAN can be linked to one Course; lectures are the floors of the campus building)
export type Course = { id: string; code: string; name: string; term: string | null; clanId: string | null; lectures: { id: string; title: string; at: number | null }[] };
export interface CoursesModule { mine(p: Principal): Course[] }

// Exams
export type Exam = { id: string; courseId: string | null; title: string; at: number; place: string | null; topics: { name: string; confidence: number }[] };
export const ExamCreated = defineEvent('ExamCreated', 1, z.object({ examId: z.string(), ownerId: z.string(), at: z.number().int() }));
export interface ExamsModule { upcoming(p: Principal, until: number): Exam[] }

// Flashcards
export type Flashcard = { id: string; deckId: string; front: string; back: string; dueAt: number; source?: { module: string; id: string } };
export interface FlashcardsModule { due(p: Principal, at: number): Flashcard[] }

// Recordings (audio/video live in the Resource Store; this holds metadata + a ref)
export type Recording = { id: string; scope: Scope; title: string; refId: string; durationMs: number; recordedAt: number };
export interface RecordingsModule { list(p: Principal, scope: Scope): Recording[] }

// Screen share + Whiteboard (live sessions in a CLAN or study room; media goes through the classroom MediaTransport)
export type ScreenShareSession = { id: string; clanId: string; presenterId: string; startedAt: number; endedAt: number | null };
export type WhiteboardStroke = { id: string; boardId: string; authorId: string; points: [number, number][]; color: string; width: number };
export interface ScreenShareModule { active(p: Principal, clanId: string): ScreenShareSession | null }
export interface WhiteboardModule { strokes(p: Principal, boardId: string, since: number): WhiteboardStroke[] }

// AI (assistants never read data directly; they go through core/context.ts ContextBroker with scoped agent principals)
export type AgentDefinition = { id: string; name: string; scopes: string[] };
export interface AIModule { agents(p: Principal): AgentDefinition[] }

// Profile (public face of a user inside CLANs; avatar = CLANmateSpec from @clan/design)
export type Profile = { userId: string; displayName: string; avatar: unknown; pronouns: string | null; visibleTo: 'clans' | 'nobody' };
export interface ProfileModule { get(p: Principal, userId: string): Profile | null }
