// Passive file views only: text stays text; executable/document formats never enter an embedded browser.
export const TEXT_PREVIEW_BYTES = 256 * 1024;
export const IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const OPEN = new Set(['pdf', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods']);
export const fileExtension = (name: string) => (/^.+\.([^.]+)$/.exec(name.split(/[\\/]/).at(-1) ?? '')?.[1] ?? '').toLowerCase();
export const canOpenFile = (name: string) => OPEN.has(fileExtension(name));
export const previewKind = (name: string): 'text' | 'image' | 'metadata' => ['txt', 'md', 'csv'].includes(fileExtension(name)) ? 'text' : ['png', 'jpg', 'jpeg'].includes(fileExtension(name)) ? 'image' : 'metadata';
export type FilePreview = { kind: 'text'; text: string } | { kind: 'image'; uri: string } | { kind: 'metadata'; reason: string };
const dimensions = (w: number, h: number) => w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 12_000_000;
/** Verify raster headers and bound decoded dimensions; HTML/SVG or animated PNG never become a preview. */
export function previewImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length > IMAGE_PREVIEW_BYTES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) {
    if (v.getUint32(8) !== 13 || v.getUint32(12) !== 0x49484452 || !dimensions(v.getUint32(16), v.getUint32(20))) return null;
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = v.getUint32(offset), tag = v.getUint32(offset + 4);
      if (length > bytes.length - offset - 12 || tag === 0x6163544c) return null; // acTL: animated PNG
      if (tag === 0x49454e44) return 'image/png'; // IEND
      offset += length + 12;
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const tag = bytes[offset++];
      if (tag === 0xda || tag === 0xd9 || tag === undefined || offset + 2 > bytes.length) return null;
      const length = v.getUint16(offset);
      if (length < 2 || length > bytes.length - offset) return null;
      if ([0xc0, 0xc1, 0xc2].includes(tag)) return length >= 8 && dimensions(v.getUint16(offset + 5), v.getUint16(offset + 3)) ? 'image/jpeg' : null;
      offset += length;
    }
  }
  return null;
}
