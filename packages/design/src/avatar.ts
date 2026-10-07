// Default look for a person who hasn't customised their CLANmate yet: stable for the same seed (their display name, the
// one thing every surface knows), varied across people.
// Purely decorative — it encodes nothing about the person (no names, photos or inferred traits).
import type { CLANmateSpec, Hair, Top, Bottom, Accessory } from './clanmate.tsx';

const SKIN = ['#f3d2b8', '#e8b896', '#d9a07a', '#b97e57', '#8d5a3b', '#5c3a26'];
const HAIR: Hair[] = ['crop', 'bun', 'curls', 'long', 'buzz', 'bob'];
const HAIR_C = ['#1d1410', '#2b1d16', '#4a2f22', '#6b3a1f', '#9a6a3a', '#c9a36b'];
const TOPS: Top[] = ['hoodie', 'tee', 'jacket', 'sweater'];
const BOTTOMS: Bottom[] = ['jeans', 'trousers', 'skirt', 'shorts'];
const CLOTH = ['#2d6ccc', '#2f8f5b', '#d6502b', '#8a2d48', '#f0b02f', '#138a87', '#3a4560', '#e9e2d4'];
const ACC: Accessory[] = [null, null, 'glasses', 'headphones', 'scarf', 'cap'];

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function mateFor(seed: string): CLANmateSpec {
  let h = hash(seed || 'clan');
  const pick = <T,>(a: readonly T[]) => { const v = a[h % a.length]!; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return v; };
  const top = pick(CLOTH);
  return {
    skin: pick(SKIN), hair: pick(HAIR), hairColor: pick(HAIR_C), top: pick(TOPS), topColor: top, bottom: pick(BOTTOMS),
    bottomColor: pick(['#2e3b55', '#3b2f2a', '#5b6474', '#1f2a40']), shoes: pick(['sneakers', 'boots'] as const), shoeColor: pick(['#f5efe4', '#2b2f2d', '#7a4e33']),
    accessory: pick(ACC), backpack: pick([null, '#f0b02f', '#2f8f5b', '#8a2d48', '#2d6ccc']),
  };
}
