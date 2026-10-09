// `node:path` for @clan/core on the phone: only `join` (paths are file:// URIs; '/'-separated on both platforms).
export const join = (...parts: string[]) => {
  const s = parts.filter(Boolean).join('/'), m = /^[a-z]+:\/\//i.exec(s); // keep `file://` intact
  return m ? m[0] + s.slice(m[0].length).replace(/^\/+/, '/').replace(/\/{2,}/g, '/') : s.replace(/\/{2,}/g, '/');
};
export const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? '';
export const dirname = (p: string) => p.replace(/\/[^/]*\/?$/, '') || '/';
export const extname = (p: string) => { const b = basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export default { join, basename, dirname, extname };
