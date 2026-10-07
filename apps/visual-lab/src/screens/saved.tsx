// Saved board: collections as columns; drag cards between them. Links and metadata only — nothing is downloaded.
import { useState } from 'react';
import { SavedCard } from '@clan/design';
import { COLLECTIONS } from '../demo/fixtures.ts';
import type { Lab } from '../main.tsx';

export function Saved({ lab }: { lab: Lab }) {
  const [over, setOver] = useState<string | null>(null);
  const [cols, setCols] = useState(COLLECTIONS);
  const move = (id: string, col: string) => lab.setSaved(lab.saved.map((s) => (s.id === id ? { ...s, col } : s)));
  return (
    <div className="saved">
      <div className="row between pad-x"><div><span className="c-eyebrow">Saved</span><h1 className="c-title">Your board</h1></div>
        <button className="c-btn" onClick={() => { const n = `Collection ${cols.length - 3}`; setCols([...cols, n]); }}>+ Collection</button></div>
      <div className="board-cols">
        {cols.map((col) => {
          const items = lab.saved.filter((s) => s.col === col);
          return (
            <section key={col} className={`col ${over === col ? 'over' : ''} ${col === 'Inbox' ? 'inbox' : ''}`} aria-label={col}
              onDragOver={(e) => { e.preventDefault(); setOver(col); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); move(e.dataTransfer.getData('text/clan-saved'), col); }}>
              <header><b>{col}</b><span className="c-chip">{items.length}</span></header>
              {items.map((s) => <div key={s.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/clan-saved', s.id)} className="drag"><SavedCard {...s} /></div>)}
              {!items.length && <p className="muted small empty">Drop links here</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
