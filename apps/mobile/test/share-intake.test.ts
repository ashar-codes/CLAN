// Share to CLAN: untrusted shared payloads become only valid capture inputs, with reasons for anything refused.
import { describe, expect, it } from 'vitest';
import { intakeItems, MAX_INTAKE_BYTES } from '../src/share/items.ts';

const share = (o: Partial<Parameters<typeof intakeItems>[0]>) => ({ text: null, subject: null, files: [], errors: [], ...o });

describe('share intake', () => {
  it('a shared link (with surrounding text) becomes a link + a text note; the subject titles the link', () => {
    expect(intakeItems(share({ text: 'Look at this https://example.com/a?b=1 great', subject: 'Lecture 4' })).items).toEqual([
      { kind: 'link', url: 'https://example.com/a?b=1', title: 'Lecture 4' }, { kind: 'text', text: 'Look at this  great' }]);
    expect(intakeItems(share({ text: 'https://example.com/x' })).items).toEqual([{ kind: 'link', url: 'https://example.com/x' }]);
  });
  it('refuses non-http links, control characters, foreign URIs and oversize files; caps at 10 files; keeps native errors', () => {
    expect(intakeItems(share({ text: 'javascript:alert(1)' })).items).toEqual([{ kind: 'text', text: 'javascript:alert(1)' }]); // text only, never a link
    const r = intakeItems(share({ text: 'a\u0000b', errors: ['x.pdf is over 200 MB.'], files: [
      { uri: 'content://evil/1', name: 'a.pdf', mime: 'application/pdf', size: 10 },
      { uri: 'file:///data/user/0/app/cache/share-in/1-b.pdf', name: '../../b.pdf', mime: 'application/pdf', size: 10 },
      { uri: 'file:///c', name: 'big.bin', mime: 'x', size: MAX_INTAKE_BYTES + 1 },
    ] }));
    expect(r.items).toEqual([{ kind: 'file', path: 'file:///data/user/0/app/cache/share-in/1-b.pdf', name: '.._.._b.pdf', mime: 'application/pdf' }]);
    expect(r.refused).toEqual(['x.pdf is over 200 MB.', 'That text can’t be saved (control characters or too long).', 'a.pdf: not a file this app received.', 'big.bin is over 200 MB.']);
    expect(intakeItems(share({ files: Array.from({ length: 15 }, (_, i) => ({ uri: `file:///f${i}`, name: `f${i}`, mime: 'x', size: 1 })) })).items).toHaveLength(10);
  });
});
