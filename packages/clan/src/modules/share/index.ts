// Share-to-CLAN: one entry point for "send this somewhere" from any surface (OS share sheet, clan:// links, drag-drop,
// Quick Capture). Every share creates or references a canonical item in its own module; nothing is duplicated.
import { userOf, type Principal } from '../../core/permissions.ts';
import type { Capture } from '../capture/index.ts';
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

/** Strict parser for clan://capture links (shared with mobile; lives in the wire protocol). */
export { parseIntake } from '@classroom/protocol';

export class Share {
  private clans: Clans; private files: Files; private notes: Notes; private saved: Saved; private capture: Capture;
  constructor(m: { clans: Clans; files: Files; notes: Notes; saved: Saved; capture: Capture }) { this.clans = m.clans; this.files = m.files; this.notes = m.notes; this.saved = m.saved; this.capture = m.capture; }

  async share(p: Principal, input: ShareInput, target: ShareTarget): Promise<ShareResult> {
    if (target.kind === 'person') return { status: 'unsupported', reason: 'Sending to one person happens inside a live CLAN room (CLANmate › Send).' };
    const clanId = target.kind === 'clan' ? target.clanId : null;
    if (clanId && !this.clans.isActiveMember(clanId, userOf(p))) throw new Error('Not a member of that CLAN.');
    if (target.kind === 'inbox' || target.kind === 'course') {
      // A course is one of your Courses: the item is created privately and referenced from the course.
      const item = await this.capture.capture(p, input.kind === 'url' ? { kind: 'link', url: input.url, title: input.title, note: input.note }
        : input.kind === 'text' ? { kind: 'text', text: input.title ? `${input.title}\n${input.text}` : input.text } : { kind: 'file', path: input.path, name: input.name, mime: input.mime },
        target.kind === 'course' ? { courseId: target.courseId } : undefined);
      return { status: 'ok', module: item.module, id: item.entityId };
    }
    switch (input.kind) {
      case 'url': {
        const item = this.saved.add(p, { url: input.url, title: input.title, note: input.note, collectionId: target.kind === 'saved' ? target.collectionId : undefined });
        if (clanId) this.saved.share(p, item.id, clanId);
        return { status: 'ok', module: 'saved', id: item.id };
      }
      case 'text': {
        if (target.kind === 'saved') return { status: 'unsupported', reason: 'Saved holds links; text becomes a note.' };
        const note = this.notes.create(p, { title: input.title ?? input.text.split('\n')[0]!.slice(0, 80), body: input.text });
        if (clanId) this.notes.share(p, note.id, clanId);
        return { status: 'ok', module: 'notes', id: note.id };
      }
      default: {
        if (target.kind === 'saved') return { status: 'unsupported', reason: 'Saved holds links; files go to your files or a CLAN.' };
        const scope = clanId ? { kind: 'clan' as const, clanId } : { kind: 'personal' as const, ownerId: userOf(p) };
        const f = await this.files.add(p, input.path, input.name, scope, input.mime);
        return { status: 'ok', module: 'files', id: f.refId };
      }
    }
  }
}
