// Decorative placement of real discovery results only; no physical distances or anonymous demo blips.
export function Radar({ items, onSelect }: { items: { id: string; name: string; kind: string; verified?: boolean }[]; onSelect(id: string): void }) {
  return <div className="clan-radar" aria-label="Discovery radar"><div className="radar-sweep" aria-hidden />
    {[1, 2, 3].map((n) => <div key={n} className="radar-ring" style={{ width: `${n * 30}%`, height: `${n * 30}%` }} aria-hidden />)}
    {items.slice(0, 16).map((x, i) => { const a = i * 2.399, r = 18 + i % 3 * 10; return <button key={x.id} className={`radar-peer ${x.verified ? 'verified' : ''}`} style={{ left: `${50 + Math.cos(a) * r}%`, top: `${50 + Math.sin(a) * r}%` }} onClick={() => onSelect(x.id)} aria-label={`${x.name}, ${x.kind}`}><span aria-hidden>{x.verified ? '✓' : x.kind === 'Person' ? '●' : '▦'}</span><small>{x.name.slice(0, 24)}</small></button>; })}
    <span className="radar-count">{items.length} discovered</span>
  </div>;
}
