// Phone lifecycle controller. Uses core/transfer APIs; screens never choose paths or mutate module databases.
import { phoneClan } from './core/clan';
import { discardClanOutbox } from './chat-outbox';
import { removeSessionCopies } from './transfers';

const active = new Map<string, Promise<{ retained: number }>>();
export function cleanupClanCopy(clanId: string, kind: 'remove' | 'delete') {
  const c = phoneClan();
  c.clans.requestCleanup(clanId, c.me, kind); // durable authorization before asynchronous file work
  const previous = active.get(clanId); if (previous) return previous;
  const task = (async () => {
    c.purgeClanProjection(clanId);
    discardClanOutbox(clanId);
    const copies = await removeSessionCopies(c.clans.localSessionsOf(clanId, c.me));
    for (const objectId of c.clans.cleanupObjects(clanId)) {
      if (c.store.collectOwned(objectId) === 'adopted') throw new Error('A hosted classroom file still needs authorized cleanup.');
    }
    c.clans.completeCleanup(clanId, c.me);
    return { retained: copies.retained };
  })().finally(() => active.delete(clanId));
  active.set(clanId, task); return task;
}
