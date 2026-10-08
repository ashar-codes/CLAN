// Me › AI (lazy): provider, model, credential (write-only), grounding preference, Diary permission, history, index.
import { useEffect, useState } from 'react';
import type { AISettings, AIStatus } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText } from '../useLoad.ts';

export default function AISettingsPanel() {
  const [s, setS] = useState<AISettings | null>(null);
  const [st, setSt] = useState<AIStatus | null>(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [diary, setDiary] = useState(false);
  const reload = () => { void api.ai.settings().then(setS); void api.ai.status().then(setSt); void api.clan.privacy().then((p) => setDiary(p.aiDiary)); };
  useEffect(reload, []);
  if (!s || !st) return null;
  const save = async (patch: Partial<AISettings>, note = 'Saved.') => { try { setS(await api.ai.setSettings(patch)); setSt(await api.ai.status()); setMsg(note); } catch (e) { setMsg(errText(e)); } };
  const pv = s.provider;
  return (
    <section className="stack ai-settings" aria-label="AI" data-testid="ai-settings">
      <span className="eyebrow ai">AI</span>
      <p className="muted small-text">{st.provider ? `Using ${st.provider.label} · ${st.provider.model}${st.provider.local ? ' (on this device)' : ' (needs internet)'}.` : 'No AI provider. Study, search and your material work without one.'}</p>
      <label>Provider
        <select value={pv.kind} aria-label="AI provider" onChange={(e) => void save({ provider: { ...pv, kind: e.target.value as AISettings['provider']['kind'] } })}>
          <option value="none">None</option><option value="openai-compatible">OpenAI-compatible endpoint (cloud or local gateway)</option>
          <option value="local" disabled={!st.localAvailable}>On this device{st.localAvailable ? ' (test model)' : ' — not installed yet'}</option>
        </select></label>
      {pv.kind === 'openai-compatible' && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void save({ provider: { kind: 'openai-compatible', label: String(f.get('label') || ''), baseUrl: String(f.get('baseUrl') || ''), model: String(f.get('model') || ''), embeddingModel: String(f.get('emb') || '') || null } }); }}>
          <input name="baseUrl" defaultValue={pv.baseUrl} placeholder="https://api.example.com/v1" aria-label="Provider address" />
          <input name="model" defaultValue={pv.model} placeholder="Model name" aria-label="Model" />
          <input name="emb" defaultValue={pv.embeddingModel ?? ''} placeholder="Embedding model (optional)" aria-label="Embedding model" />
          <input name="label" defaultValue={pv.label} placeholder="Display name (optional)" aria-label="Provider name" />
          <button>Save provider</button>
        </form>
      )}
      {pv.kind === 'openai-compatible' && pv.baseUrl && (
        <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await api.ai.setKey(key); setKey(''); reload(); setMsg('Credential saved in the system keychain.'); } catch (x) { setMsg(errText(x)); } }}>
          <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={st.hasKey ? 'Credential saved — enter a new one to replace' : 'API key'} aria-label="API key" />
          <button disabled={!key.trim()}>{st.hasKey ? 'Replace' : 'Save key'}</button>
          {st.hasKey && <button type="button" className="danger" onClick={async () => { await api.ai.deleteKey(); reload(); setMsg('Credential deleted.'); }}>Delete key</button>}
        </form>
      )}
      {!st.secureStorage && <p className="error small-text">This computer has no secure key storage; CLAN will not store a credential.</p>}
      <label className="check"><input type="checkbox" checked={!s.generalKnowledge} onChange={(e) => void save({ generalKnowledge: !e.target.checked })} /> Use only my CLAN sources</label>
      <p className="muted small-text">When off, answers may add a clearly separate “General explanation”. Study tasks (quizzes, cards, comparisons, plans) always use your sources only.</p>
      {pv.embeddingModel && <label className="check"><input type="checkbox" checked={s.useEmbeddings} onChange={(e) => void save({ useEmbeddings: e.target.checked })} /> Semantic search (sends passages to the embedding model)</label>}
      <label className="check"><input type="checkbox" checked={diary} onChange={async (e) => { await api.clan.setAiDiary(e.target.checked); reload(); }} /> Let AI read my Diary (only when I tick “Diary” for a request)</label>
      <p className="muted small-text">Local index: {st.index.sources} sources, {st.index.chunks} passages. It is rebuilt from your own data whenever needed.</p>
      <div className="row"><button className="small" onClick={async () => { await api.ai.rebuild(); reload(); setMsg('Index cleared; it rebuilds on the next request.'); }}>Rebuild index</button>
        <button className="small danger" onClick={async () => { await api.ai.deleteHistory(); setMsg('AI conversation history deleted.'); }}>Delete AI history</button></div>
      {msg && <p className="muted small-text" role="status">{msg}</p>}
    </section>
  );
}
