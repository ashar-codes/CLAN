// Modules that are designed but not built in this phase: types and interfaces only, so other modules and the shell can
// depend on stable shapes. No implementation exists; nothing may pretend otherwise.
import { z } from 'zod';
import { defineEvent } from '../core/events.ts';
import type { Principal, Scope } from '../core/permissions.ts';

// Chat is a real module now: modules/chat (and the wire types in @classroom/protocol chat.ts).

// Courses, Tasks, Exams, Flashcards, Reminders and Study Sessions are real modules now (see docs/STUDY.md).

// Recordings (audio/video live in the Resource Store; this holds metadata + a ref)
export type Recording = { id: string; scope: Scope; title: string; refId: string; durationMs: number; recordedAt: number };
export interface RecordingsModule { list(p: Principal, scope: Scope): Recording[] }

// Whiteboard (live in a CLAN room; same wall surface as screen sharing). Screen sharing itself: modules/screenshare.
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
