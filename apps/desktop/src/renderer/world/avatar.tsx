// Device-local appearance preference, like visual experience. Never changes identity or remote presence.
import { useEffect, useState } from 'react';
import { mateFor, type CLANmateSpec } from '@clan/design';
const KEY = 'clan.appearance.v1';
const EVENT = 'clan-appearance';
function read(name: string): CLANmateSpec {
  const base = mateFor(name);
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!v || typeof v !== 'object') return base;
    for (const k of ['skin', 'hairColor', 'topColor', 'bottomColor', 'shoeColor'] as const) if (/^#[\da-f]{6}$/i.test(v[k])) base[k] = v[k];
    for (const [k, choices] of Object.entries({ hair: ['crop','bun','curls','long','buzz','bob'], top: ['hoodie','tee','jacket','sweater'], bottom: ['jeans','skirt','shorts','trousers'], accessory: ['glasses','headphones','cap','scarf',null], shoes: ['sneakers','boots'] })) {
      if (choices.includes(v[k])) Object.assign(base, { [k]: v[k] });
    }
    if (v.backpack === null || /^#[\da-f]{6}$/i.test(v.backpack)) base.backpack = v.backpack;
  } catch { /* corrupt preference: use the generated look */ }
  return base;
}
export function useAvatar(name: string) {
  const [spec, set] = useState(() => read(name));
  useEffect(() => { const changed = () => set(read(name)); changed(); addEventListener(EVENT, changed); return () => removeEventListener(EVENT, changed); }, [name]);
  return [spec, (next: CLANmateSpec) => { set(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* session-only */ } dispatchEvent(new Event(EVENT)); }] as const;
}
export function AvatarEditor({ spec, onChange }: { spec: CLANmateSpec; onChange(s: CLANmateSpec): void }) {
  return <fieldset className="stack"><legend className="eyebrow">Your CLANmate</legend>
    <div className="form-grid">
      {([['hair','Hairstyle',['crop','bun','curls','long','buzz','bob']], ['top','Clothing',['hoodie','tee','jacket','sweater']], ['bottom','Bottoms',['jeans','skirt','shorts','trousers']], ['accessory','Accessory',['none','glasses','headphones','cap','scarf']], ['shoes','Shoes',['sneakers','boots']]] as const).map(([key,label,options]) => <label key={key}>{label}<select aria-label={label} value={spec[key] ?? 'none'} onChange={(e) => onChange({ ...spec, [key]: e.target.value === 'none' ? null : e.target.value })}>{options.map((o) => <option key={o}>{o}</option>)}</select></label>)}
      {([['skin','Skin tone'],['hairColor','Hair color'],['topColor','Clothing color'],['bottomColor','Bottoms color'],['shoeColor','Shoe color']] as const).map(([key,label]) => <label key={key}>{label}<input type="color" aria-label={label} value={spec[key]} onChange={(e) => onChange({ ...spec, [key]: e.target.value })} /></label>)}
    </div>
    <label><input type="checkbox" checked={!!spec.backpack} onChange={(e) => onChange({ ...spec, backpack: e.target.checked ? spec.topColor : null })} /> Backpack</label>
    <small className="muted">Saved on this device. Other CLAN members currently see your generated look.</small>
  </fieldset>;
}
