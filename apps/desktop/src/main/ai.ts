// CLAN Intelligence for the desktop shell (main process). Provider credentials live in OS-protected storage (Electron
// safeStorage), one file per provider endpoint, and are read only when a request goes to that endpoint. The renderer
// never sees a key (only "a credential is saved"). Generation streams to the window; every run can be cancelled.
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { deterministicProvider, openAICompatible, type AIProvider } from '@classroom/protocol';
import type { ClanApp, ProviderSettings } from '@clan/core';

const Id = z.uuid();
/** Per-endpoint credential store. Keys never go to SQLite, logs, diagnostics or the renderer. */
export class Credentials {
  private dir = join(app.getPath('userData'), 'keys');
  private file = (endpoint: string) => join(this.dir, `ai-${createHash('sha256').update(endpoint.replace(/\/+$/, '')).digest('hex').slice(0, 24)}.enc`);
  private ok() { if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer has no secure key storage, so CLAN will not store an AI credential.'); }
  has(endpoint: string) { return !!endpoint && existsSync(this.file(endpoint)); }
  get(endpoint: string): string | null { if (!this.has(endpoint)) return null; try { return safeStorage.decryptString(readFileSync(this.file(endpoint))); } catch { return null; } }
  set(endpoint: string, key: string) { this.ok(); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); writeFileSync(this.file(endpoint), safeStorage.encryptString(key), { mode: 0o600 }); }
  delete(endpoint: string) { rmSync(this.file(endpoint), { force: true }); }
}

/** Settings → provider (or none). The deterministic provider exists only for automated tests (CLAN_AI_PROVIDER=deterministic). */
export function providerFactory(creds: Credentials) {
  const test = process.env.CLAN_AI_PROVIDER === 'deterministic';
  return (s: ProviderSettings): AIProvider | null => {
    if (s.kind === 'openai-compatible' && s.baseUrl && s.model) {
      try { return openAICompatible({ baseUrl: s.baseUrl, model: s.model, embeddingModel: s.embeddingModel, label: s.label || new URL(s.baseUrl).host, apiKey: () => creds.get(s.baseUrl) }); } catch { return null; }
    }
    if (s.kind === 'local') return test ? deterministicProvider({ delayMs: 15 }) : null; // no on-device model ships yet
    return null;
  };
}

const Include = z.object({ notes: z.boolean(), resources: z.boolean(), saved: z.boolean(), classroom: z.boolean(), chat: z.boolean(), study: z.boolean(), diary: z.boolean() }).partial();
const Scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }), z.object({ kind: z.literal('course'), courseId: Id, topicId: Id.nullable().optional() }),
  z.object({ kind: z.literal('lecture'), courseId: Id, lectureId: Id }), z.object({ kind: z.literal('exam'), examId: Id }),
  z.object({ kind: z.literal('note'), noteId: Id, courseId: Id.nullable().optional(), lectureId: Id.nullable().optional() }), z.object({ kind: z.literal('resource'), refId: Id }),
  z.object({ kind: z.literal('saved'), savedId: Id }), z.object({ kind: z.literal('clan'), clanId: Id, threadId: Id.nullable().optional() }),
  z.object({ kind: z.literal('search'), hits: z.array(z.object({ module: z.string().max(20), entityId: z.string().max(64) })).max(50) }),
]);
const Action = z.enum(['ask', 'askDocument', 'explain', 'summarize', 'simplify', 'questions', 'chatSummary', 'flashcards', 'quiz', 'compare', 'prepareLecture', 'examPlan']);
const Request = z.object({ action: Action, scope: Scope, include: Include.optional(), question: z.string().max(4000).optional(), selection: z.string().max(20_000).optional(),
  agent: z.string().max(40).optional(), conversationId: Id.nullable().optional(), count: z.number().int().min(1).max(40).optional(), deckId: Id.nullable().optional() });

export function registerAI(c: ClanApp, creds: Credentials) {
  const me = { kind: 'user' as const, userId: c.me };
  const handle = (ch: string, f: (...a: unknown[]) => unknown) => ipcMain.handle(ch, (_e, ...a) => f(...a));
  const runs = new Map<string, AbortController>();
  const endpoint = () => c.ai.settings(me).provider.baseUrl;

  handle('ai:status', () => ({ ...c.ai.status(me), hasKey: creds.has(endpoint()), localAvailable: process.env.CLAN_AI_PROVIDER === 'deterministic', secureStorage: safeStorage.isEncryptionAvailable() }));
  handle('ai:settings', () => c.ai.settings(me));
  handle('ai:setSettings', (raw) => c.ai.setSettings(me, raw));
  handle('ai:agents', () => c.ai.agents().map((a) => ({ id: a.id, name: a.name, reads: a.reads, proposals: a.proposals, cannot: a.cannot })));
  /** Credential for the configured endpoint only; replacing overwrites, deleting removes the file. */
  handle('ai:setKey', (key) => { const e = endpoint(); if (!e) throw new Error('Choose a provider address first.'); creds.set(e, z.string().trim().min(1).max(500).parse(key)); });
  handle('ai:deleteKey', () => { const e = endpoint(); if (e) creds.delete(e); });

  handle('ai:preview', (raw) => c.ai.preview(me, Request.pick({ action: true, scope: true, include: true, agent: true }).parse(raw)));
  handle('ai:run', async (runId, raw) => {
    const id = Id.parse(runId), req = Request.parse(raw), ctl = new AbortController();
    runs.set(id, ctl);
    const w = BrowserWindow.getAllWindows()[0];
    try { return await c.ai.run(me, req, { signal: ctl.signal, onDelta: (text) => w?.webContents.send('ai:delta', { runId: id, text }) }); } finally { runs.delete(id); }
  });
  handle('ai:cancel', (runId) => runs.get(Id.parse(runId))?.abort());
  handle('ai:search', (q, raw) => c.ai.search(me, z.string().max(500).parse(q), raw ? Scope.parse(raw) : { kind: 'global' }));

  handle('ai:proposals', (status) => c.ai.proposals.list(me, z.enum(['pending', 'accepted', 'dismissed', 'expired', 'all']).optional().parse(status)));
  handle('ai:accept', (id, edited) => c.ai.proposals.accept(me, Id.parse(id), edited === undefined ? undefined : z.unknown().parse(edited)));
  handle('ai:dismiss', (id) => c.ai.proposals.dismiss(me, Id.parse(id)));
  handle('ai:answerQuiz', (id, raw) => c.ai.answerQuiz(me, Id.parse(id), z.array(z.object({ i: z.number().int().min(0).max(50), answer: z.string().max(2000), selfCorrect: z.boolean().optional() })).max(50).parse(raw)));
  handle('ai:analyzePaper', (refId, examId) => c.ai.analyzePaper(me, Id.parse(refId), { examId: Id.nullable().optional().parse(examId) }));
  handle('ai:confirmPaperTopic', (qid, topicId) => c.ai.confirmPaperTopic(me, Id.parse(qid), Id.nullable().parse(topicId)));
  handle('ai:proposeScope', (refId, examId) => c.ai.proposeScopeFromPaper(me, Id.parse(refId), Id.parse(examId)));
  handle('ai:examGaps', (examId) => c.ai.examGaps(me, Id.parse(examId)));
  handle('ai:conversations', () => c.ai.conversations(me));
  handle('ai:turns', (id) => c.ai.turns(me, Id.parse(id)));
  handle('ai:deleteHistory', () => c.ai.deleteHistory(me));
  handle('ai:usage', () => c.ai.usage(me));
  /** Opens a cited file only if this person may read it, and only text/PDF documents (never executables). */
  handle('ai:openFile', async (refId) => {
    const f = c.files.get(me, Id.parse(refId)), o = f && c.store.object(f.objectId);
    if (!f || !o) throw new Error('That file is not available.');
    if (!/\.(pdf|txt|md|markdown)$/i.test(f.name)) { shell.showItemInFolder(o.location); return; }
    const err = await shell.openPath(o.location); if (err) throw new Error(err);
  });
  handle('ai:rebuild', () => { c.ai.index.rebuild(); return c.ai.index.size(); });
  // housekeeping: drop index entries unused for 60 days (they re-index on demand)
  setTimeout(() => c.ai.index.gc(), 30_000).unref();
}
