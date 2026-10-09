// Visual Experience: Full (spatial + 3D on entry + motion), Reduced (2D places, gentle motion), Minimal (conventional panels).
// A per-device convenience (localStorage); the default follows the OS reduced-motion setting and WebGL availability.
import { useEffect, useState } from 'react';

export type Experience = 'full' | 'reduced' | 'minimal';
const KEY = 'clan.experience';

function auto(): Experience {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced';
  if (matchMedia('(max-width: 600px)').matches) return 'reduced';
  try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') ?? c.getContext('webgl'); if (!gl) return 'reduced'; gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { return 'reduced'; }
  return 'full';
}
const read = (): Experience | null => { try { const v = localStorage.getItem(KEY); return v === 'full' || v === 'reduced' || v === 'minimal' ? v : null; } catch { return null; } };

let current: Experience = read() ?? auto();
const subs = new Set<(e: Experience) => void>();
const apply = () => { document.documentElement.dataset.experience = current; };
apply();

export function setExperience(e: Experience | 'auto') {
  current = e === 'auto' ? auto() : e;
  try { if (e === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, e); } catch { /* private mode: session only */ }
  apply();
  subs.forEach((f) => f(current));
}
export const experienceIsAuto = () => read() === null;

export function useExperience(): Experience {
  const [e, setE] = useState(current);
  useEffect(() => {
    subs.add(setE);
    const media = matchMedia('(prefers-reduced-motion: reduce)'), small = matchMedia('(max-width: 600px)');
    const change = () => { if (experienceIsAuto()) setExperience('auto'); };
    media.addEventListener('change', change); small.addEventListener('change', change);
    return () => { subs.delete(setE); media.removeEventListener('change', change); small.removeEventListener('change', change); };
  }, []);
  return e;
}
