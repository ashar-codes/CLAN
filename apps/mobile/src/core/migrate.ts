// One-time move of the phone's pre-core JSON files (study.json, inbox.json) into @clan/core. The originals are
// renamed, not deleted, until the next release.
import { Directory, File, Paths } from 'expo-file-system';
import { loadStudy } from '../study/store';
import { phoneChanges } from '../sync/records';
import { phoneClan, me } from './clan';

export async function migrateOldPhoneData() {
  const dir = new Directory(Paths.document, 'CLAN');
  const study = new File(dir, 'study.json'), inbox = new File(dir, 'inbox.json');
  const c = phoneClan();
  if (study.exists) {
    c.sync.importLocal(phoneChanges(loadStudy(), new Map(), { now: Date.now(), device: c.sync.self().fp }));
    study.moveSync(new File(dir, 'study.json.migrated'));
  }
  if (inbox.exists) {
    let items: ({ kind: 'url'; url: string; title?: string } | { kind: 'text'; text: string })[] = [];
    try { items = JSON.parse(inbox.textSync()); } catch { /* unreadable: leave it */ }
    for (const it of items.reverse()) {
      try { await c.capture.capture(me(), it.kind === 'url' ? { kind: 'link', url: it.url, title: it.title } : { kind: 'text', text: it.text }); } catch { /* skip invalid */ }
    }
    inbox.moveSync(new File(dir, 'inbox.json.migrated'));
  }
}
