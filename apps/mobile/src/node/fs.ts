// `node:fs` / `node:fs/promises` for @clan/core on the phone: the handful of file calls core makes (Resource Store,
// sync transfers, AI text extraction), on expo-file-system. Paths are file:// URIs inside the app's sandbox.
import { Directory, File, FileMode, Paths } from 'expo-file-system';

const CHUNK = 256 * 1024;
const isDir = (p: string) => { try { return new Directory(p).exists; } catch { return false; } };
const fail = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });

export async function mkdir(p: string, _o?: { recursive?: boolean }) { const d = new Directory(p); if (!d.exists) d.create({ intermediates: true, idempotent: true }); }
export async function copyFile(from: string, to: string) { new File(from).copySync(new File(to)); }
export async function rename(from: string, to: string) { const f = new File(from); if (!f.exists) throw fail('ENOENT', from); f.moveSync(new File(to)); }
export async function rm(p: string, o?: { force?: boolean; recursive?: boolean }) {
  try { if (isDir(p)) new Directory(p).delete(); else { const f = new File(p); if (f.exists) f.delete(); else if (!o?.force) throw fail('ENOENT', p); } }
  catch (e) { if (!o?.force) throw e; }
}
export async function stat(p: string) { const f = new File(p); if (!f.exists) throw fail('ENOENT', p); return { size: f.size ?? 0, isFile: () => true }; }
class FileBytes extends Uint8Array { toString(enc?: 'utf8') { return enc ? new TextDecoder().decode(this) : super.toString(); } }
export async function readFile(p: string) { const b = new File(p).bytesSync(); return new FileBytes(b.buffer as ArrayBuffer, b.byteOffset, b.length); }
export async function statfs(_p: string) { return { bavail: Paths.availableDiskSpace, bsize: 1 }; }

async function* chunks(p: string, start = 0) {
  const h = new File(p).open(FileMode.ReadOnly);
  try { h.offset = start; for (;;) { const b = h.readBytes(CHUNK); if (!b.length) return; yield b; } } finally { h.close(); }
}
export function createReadStream(p: string, o?: { start?: number }) { return chunks(p, o?.start ?? 0); }

/** Resource Store's scoped orphan cleanup: file only, no recursive deletion and no swallowed native failure. */
export function unlinkSync(p: string) {
  if (isDir(p)) throw fail('EISDIR', p);
  const f = new File(p); if (!f.exists) throw fail('ENOENT', p);
  f.delete();
}

/** `open(path, 'a' | 'r')`: append writes for resumable downloads, reads for hashing. */
export async function open(p: string, mode: 'a' | 'r' = 'r') {
  const f = new File(p);
  if (mode === 'a' && !f.exists) f.create({ intermediates: true });
  const h = f.open(mode === 'a' ? FileMode.Append : FileMode.ReadOnly);
  return {
    async write(b: Uint8Array) { h.writeBytes(b); return { bytesWritten: b.length }; },
    async close() { h.close(); },
    createReadStream: () => chunks(p),
  };
}
export const promises = { mkdir, copyFile, rename, rm, stat, readFile, statfs, open };
