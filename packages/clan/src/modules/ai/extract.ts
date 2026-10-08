// Local text extraction for the knowledge index: PDF (text layer, per page), plain text, Markdown (per heading).
// No OCR: a PDF without a text layer is reported as such instead of guessed at. PDF.js loads only when first needed.
import { readFile, stat } from 'node:fs/promises';

export type Section = { page: number | null; section: string | null; text: string };
export type Extracted = { status: 'ok' | 'no_text' | 'unsupported' | 'too_large' | 'error'; sections: Section[]; reason?: string };
export const MAX_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_SOURCE_CHARS = 400_000;

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
export function kindOf(name: string, mime: string): 'pdf' | 'text' | 'markdown' | null {
  const e = ext(name);
  if (e === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (e === 'md' || e === 'markdown' || mime === 'text/markdown') return 'markdown';
  if (e === 'txt' || e === 'text' || mime === 'text/plain') return 'text';
  return null;
}

export async function extractFile(path: string, name: string, mime: string): Promise<Extracted> {
  const kind = kindOf(name, mime);
  if (!kind) return { status: 'unsupported', sections: [], reason: 'CLAN can read PDF, text and Markdown files so far.' };
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) return { status: 'too_large', sections: [], reason: 'File is too large to read for AI (over 60 MB).' };
    const bytes = await readFile(path);
    if (kind === 'pdf') return await pdf(bytes);
    if (bytes.includes(0)) return { status: 'unsupported', sections: [], reason: 'This does not look like a text file.' };
    const text = bytes.toString('utf8').slice(0, MAX_SOURCE_CHARS);
    return kind === 'markdown' ? markdown(text) : { status: text.trim() ? 'ok' : 'no_text', sections: [{ page: null, section: null, text }] };
  } catch (e) { return { status: 'error', sections: [], reason: `Could not read the file (${(e as Error).message.slice(0, 120)}).` }; }
}

export function markdown(text: string): Extracted {
  const out: Section[] = []; let cur: Section = { page: null, section: null, text: '' };
  for (const line of text.split('\n')) {
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (h) { if (cur.text.trim()) out.push(cur); cur = { page: null, section: h[1]!.slice(0, 160), text: '' }; } else cur.text += `${line}\n`;
  }
  if (cur.text.trim()) out.push(cur);
  return { status: out.length ? 'ok' : 'no_text', sections: out };
}

async function pdf(bytes: Buffer): Promise<Extracted> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true });
  try {
    const doc = await task.promise;
    const sections: Section[] = []; let total = 0;
    for (let i = 1; i <= Math.min(doc.numPages, 2000) && total < MAX_SOURCE_CHARS; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('').replace(/[ \t]+/g, ' ').trim();
      total += text.length;
      if (text) sections.push({ page: i, section: null, text });
    }
    // A scan has (almost) no text layer: say so rather than inventing content.
    if (total < 20 * Math.max(1, doc.numPages) / 4 || !sections.length) return { status: 'no_text', sections: [], reason: 'This PDF has no readable text (it may be a scan). Text recognition (OCR) is not supported yet.' };
    return { status: 'ok', sections };
  } catch { return { status: 'error', sections: [], reason: 'This PDF could not be read (damaged or protected).' }; } finally { void task.destroy(); }
}

export type Chunk = { page: number | null; section: string | null; start: number; end: number; text: string };
/** ~1200-character chunks with 150 overlap, split on whitespace, never across pages/sections. Bounded per source. */
export function chunk(sections: Section[], size = 1200, overlap = 150, max = 400): Chunk[] {
  const out: Chunk[] = [];
  for (const s of sections) {
    const t = s.text;
    for (let start = 0; start < t.length && out.length < max;) {
      let end = Math.min(t.length, start + size);
      if (end < t.length) { const ws = t.lastIndexOf(' ', end); if (ws > start + size / 2) end = ws; }
      const text = t.slice(start, end).trim();
      if (text) out.push({ page: s.page, section: s.section, start, end, text });
      if (end >= t.length) break;
      start = Math.max(end - overlap, start + 1);
    }
  }
  return out;
}
