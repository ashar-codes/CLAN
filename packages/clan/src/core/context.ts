// AI Context API (boundary only: no model providers, no agent execution). An agent asks for context on behalf of a
// user; the broker answers with references the user could read anyway, within the agent's scopes. Modules marked
// `private` (Diary) answer DENIED unless the user granted that module to AI explicitly.
import { userOf, type Permissions, type Principal, type Scope } from './permissions.ts';

/** A pointer to content plus a short excerpt; never a copy of a whole entity. */
export type AIContextReference = { module: string; entityId: string; title: string; excerpt: string; scope: Scope };
export type ContextRequest = { module: string; query?: string; ids?: string[]; limit?: number };
export type ContextResult = { status: 'OK'; items: AIContextReference[] } | { status: 'DENIED'; reason: string };
export type ContextProvider = {
  module: string;
  sensitivity: 'normal' | 'private';
  /** Items owned by / shared with `userId`. The broker re-checks every item's scope. */
  read(userId: string, req: ContextRequest): AIContextReference[];
};

export const AI_GRANTEE = 'ai';

export class ContextBroker {
  private perms: Permissions;
  private providers = new Map<string, ContextProvider>();
  constructor(perms: Permissions) { this.perms = perms; }
  register(p: ContextProvider) { this.providers.set(p.module, p); }

  request(p: Principal, req: ContextRequest): ContextResult {
    const prov = this.providers.get(req.module);
    if (!prov) return { status: 'DENIED', reason: `No context available from ${req.module}.` };
    if (p.kind === 'agent' && !p.scopes.includes(`${req.module}:read`)) return { status: 'DENIED', reason: `Agent lacks ${req.module}:read.` };
    if (prov.sensitivity === 'private' && !this.perms.hasGrant(userOf(p), AI_GRANTEE, req.module)) return { status: 'DENIED', reason: `${req.module} is private; the user has not shared it with AI.` };
    const items = prov.read(userOf(p), { ...req, limit: Math.min(req.limit ?? 20, 50) }).filter((i) => i.module === req.module && this.perms.canRead(p, i.scope));
    return { status: 'OK', items };
  }
}
