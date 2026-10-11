import { describe, expect, it } from 'vitest';
import { canOpenFile, previewImageMime, previewKind, TEXT_PREVIEW_BYTES } from '@classroom/client';

describe('passive file preview boundaries', () => {
  it('keeps scripts, HTML/SVG, macro documents and disguised extensions out of viewers', () => {
    for (const name of ['a.exe', 'a.html', 'a.svg', 'a.docm', 'a.pdf.exe', 'a.ps1', 'a.zip', 'README']) {
      expect(canOpenFile(name)).toBe(false); expect(previewKind(name)).toBe('metadata');
    }
    expect(canOpenFile('notes.PDF')).toBe(true); expect(previewKind('notes.md')).toBe('text');
    expect(TEXT_PREVIEW_BYTES).toBeLessThan(1024 * 1024);
  });
  it('refuses renamed HTML and truncated/malformed images', () => {
    expect(previewImageMime(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
    for (let n = 0; n < 33; n++) expect(previewImageMime(new Uint8Array(n))).toBeNull();
    expect(previewImageMime(new Uint8Array([255,216,255,224,255,255]))).toBeNull();
  });
  it('rejects excessive dimensions and animation while accepting a bounded PNG header', () => {
    const bytes = new Uint8Array(45), v = new DataView(bytes.buffer);
    bytes.set([137,80,78,71,13,10,26,10]); v.setUint32(8,13); v.setUint32(12,0x49484452); v.setUint32(16,400); v.setUint32(20,300); v.setUint32(37,0x49454e44);
    expect(previewImageMime(bytes)).toBe('image/png');
    v.setUint32(16,100_000); expect(previewImageMime(bytes)).toBeNull();
    v.setUint32(16,400); v.setUint32(37,0x6163544c); expect(previewImageMime(bytes)).toBeNull();
  });
});
