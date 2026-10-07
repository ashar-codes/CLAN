// Who may read what. Two scopes exist: a person's Personal Space and a CLAN. Agents (AI) act on behalf of a user and
// only within their explicit scopes. Sensitive modules also need an explicit, revocable grant.
import type { Db, ModuleSchema } from './db.ts';

export type Principal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentId: string; onBehalfOf: string; scopes: string[] };
export type Scope = { kind: 'personal'; ownerId: string } | { kind: 'clan'; clanId: string };

/** Implemented by the CLANs module; injected by the composition root (core never imports modules). */
export interface MembershipQuery {
  isActiveMember(clanId: string, userId: string): boolean;
  clansOf(userId: string): string[];
}

export const permissionsSchema: ModuleSchema = {
  module: 'permissions', prefix: 'core',
  migrations: [`
    CREATE TABLE core_grants (user_id TEXT NOT NULL, grantee TEXT NOT NULL, resource TEXT NOT NULL, granted_at INTEGER NOT NULL, expires_at INTEGER,
      PRIMARY KEY (user_id, grantee, resource));
  `],
};

export const userOf = (p: Principal) => (p.kind === 'user' ? p.userId : p.onBehalfOf);

export class Permissions {
  private db: Db; private members: MembershipQuery; private now: () => number;
  constructor(db: Db, members: MembershipQuery, now = () => Date.now()) { this.db = db; this.members = members; this.now = now; }

  canRead(p: Principal, scope: Scope): boolean {
    const u = userOf(p);
    return scope.kind === 'personal' ? scope.ownerId === u : this.members.isActiveMember(scope.clanId, u);
  }
  clansOf(p: Principal) { return this.members.clansOf(userOf(p)); }
  /** Agents need `<module>:read`; users can always read what their scopes allow. */
  agentMay(p: Principal, module: string) { return p.kind === 'user' || p.scopes.includes(`${module}:read`); }

  grant(userId: string, grantee: string, resource: string, expiresAt?: number) {
    this.db.prepare(`INSERT INTO core_grants (user_id, grantee, resource, granted_at, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET granted_at = excluded.granted_at, expires_at = excluded.expires_at`).run(userId, grantee, resource, this.now(), expiresAt ?? null);
  }
  revoke(userId: string, grantee: string, resource: string) {
    this.db.prepare('DELETE FROM core_grants WHERE user_id = ? AND grantee = ? AND resource = ?').run(userId, grantee, resource);
  }
  hasGrant(userId: string, grantee: string, resource: string) {
    const g = this.db.prepare('SELECT expires_at e FROM core_grants WHERE user_id = ? AND grantee = ? AND resource = ?').get(userId, grantee, resource) as { e: number | null } | undefined;
    return !!g && (g.e === null || g.e > this.now());
  }
}
