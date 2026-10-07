// Share-to-CLAN: one entry point for "send this somewhere" from any surface (OS share sheet, drag-drop, Quick Capture).
// Every share creates a reference in the target module; nothing is duplicated.
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Clans } from '../clans/index.ts';
import type { Files } from '../files/index.ts';
import type { Notes } from '../notes/index.ts';
import type { Saved } from '../saved/index.ts';

export type ShareInput =
  | { kind: 'url'; url: string; title?: string; note?: string }
  | { kind: 'text'; text: string; title?: string }
  | { kind: 'file' | 'image'; path: string; name: string; mime?: string };
export type ShareTarget =
  | { kind: 'inbox' } | { kind: 'saved'; collectionId: string } | { kind: 'clan'; clanId: string }
  | { kind: 'course'; courseId: string } | { kind: 'person'; userId: string };
export type ShareResult =
  | { status: 'ok'; module: 'saved' | 'notes' | 'files'; id: string }
  | { status: 'unsupported'; reason: string };

export class Share {
  private clans: Clans; private files: Files; private notes: Notes; private saved: Saved;
  constructor(m: { clans: Clans; files: Files; notes: Notes; saved: Saved }) { this.clans = m.clans; this.files = m.files; this.notes = m.notes; this.saved = m.saved; }

  async share(p: Principal, input: ShareInput, target: ShareTarget): Promise<ShareResult> {
    if (target.kind === 'course') return { status: 'unsupported', reason: 'Courses are not built yet.' };
    if (target.kind === 'person') return { status: 'unsupported', reason: 'Send to a person uses a direct transfer from the Commons.' };
    if (target.kind === 'clan' && !this.clans.isActiveMember(target.clanId, userOf(p))) throw new Error('Not a member of that CLAN.');
    switch (input.kind) {
      case 'url': {
        const item = this.saved.add(p, { url: input.url, title: input.title, note: input.note, collectionId: target.kind === 'saved' ? target.collectionId : undefined });
        if (target.kind === 'clan') this.saved.share(p, item.id, target.clanId);
        return { status: 'ok', module: 'saved', id: item.id };
      }
      case 'text': {
        if (target.kind === 'saved') return { status: 'unsupported', reason: 'Saved holds links; text becomes a note.' };
        const note = this.notes.create(p, { title: input.title ?? input.text.split('\n')[0]!.slice(0, 80), body: input.text });
        if (target.kind === 'clan') this.notes.share(p, note.id, target.clanId);
        return { status: 'ok', module: 'notes', id: note.id };
      }
      default: {
        if (target.kind === 'saved') return { status: 'unsupported', reason: 'Saved holds links; files go to your files or a CLAN.' };
        const scope = target.kind === 'clan' ? { kind: 'clan' as const, clanId: target.clanId } : { kind: 'personal' as const, ownerId: userOf(p) };
        const f = await this.files.add(p, input.path, input.name, scope, input.mime);
        return { status: 'ok', module: 'files', id: f.refId };
      }
    }
  }
}
