// Ask CLAN on the phone: core's AI module (same permission-aware retrieval, grounded answers, citations and
// proposals as the desktop). Without a provider it still shows the matching passages from your own material.
// The provider key lives only in the Keychain / Android Keystore, keyed by its address; it never enters the database,
// never syncs, and is sent only to that address.
import { useState } from 'react';
import { Text } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { RunResult } from '@clan/core';
import { phoneClan, me } from '../core/clan';
import { act, Btn, Card, Err, Field, Muted, Row, useC, useData } from '../ui/kit';

export const aiKeyName = (baseUrl: string) => `clan.ai.key.${baseUrl.replace(/[^A-Za-z0-9]/g, '').slice(0, 80)}`;
export const readAiKey = (baseUrl: string) => SecureStore.getItemAsync(aiKeyName(baseUrl), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });

export function AskTab() {
  const c = useC();
  const settings = useData(() => phoneClan().ai.settings(me()));
  const proposals = useData(() => phoneClan().ai.proposals.list(me())) ?? [];
  const [q, setQ] = useState(''), [busy, setBusy] = useState(false), [res, setRes] = useState<RunResult | null>(null), [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<{ baseUrl: string; model: string; key: string } | null>(null);
  if (!settings) return null;
  const pv = settings.provider;
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setRes(await phoneClan().ai.run(me(), { action: 'ask', scope: { kind: 'global' }, question: q })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <Card title="Ask CLAN" tone="ai">
        <Muted>{pv.kind === 'none' ? 'No AI provider: you get the matching passages from your own notes, courses and cards.' : `Using ${pv.label || pv.model} (needs internet).`}</Muted>
        <Field label="Your question" value={q} onChange={setQ} multiline placeholder="What did I write about deadlocks?" />
        <Btn primary label={busy ? 'Asking…' : 'Ask'} disabled={!q.trim() || busy} onPress={() => void ask()} />
        <Err msg={err} />
      </Card>
      {res && (
        <Card title={res.answer ? 'Answer' : 'From your material'}>
          {res.message && <Muted>{res.message}</Muted>}
          {res.answer?.material.map((m, i) => <Text key={i} style={{ color: c.text }}>{m.text} <Text style={{ color: c.ai }}>{m.cites.map((n) => `[${n}]`).join('')}</Text></Text>)}
          {res.answer?.notFound && <Muted>Your sources don’t answer that.</Muted>}
          {(res.answer ? res.citations : res.passages).map((x) => <Muted key={x.n} small>[{x.n}] {x.label} — {x.excerpt.slice(0, 160)}</Muted>)}
        </Card>
      )}
      {proposals.map((p) => (
        <Card key={p.id} title={`Suggestion: ${p.kind}`} tone="ai">
          <Muted>{p.explanation}</Muted>
          <Muted small>Nothing changes unless you accept.</Muted>
          <Row><Btn small primary label="Accept" onPress={() => setErr(act(() => phoneClan().ai.proposals.accept(me(), p.id)))} /><Btn small label="Dismiss" onPress={() => setErr(act(() => phoneClan().ai.proposals.dismiss(me(), p.id)))} /></Row>
        </Card>
      ))}
      <Card title="AI provider">
        {cfg ? (<>
          <Field label="Provider address" value={cfg.baseUrl} onChange={(baseUrl) => setCfg({ ...cfg, baseUrl })} placeholder="https://api.example.com/v1" autoCapitalize="none" keyboardType="url" />
          <Field label="Model" value={cfg.model} onChange={(model) => setCfg({ ...cfg, model })} autoCapitalize="none" />
          <Field label="API key" value={cfg.key} onChange={(key) => setCfg({ ...cfg, key })} secureTextEntry autoCapitalize="none" placeholder="Stored in this phone's secure storage" />
          <Row>
            <Btn primary label="Save provider" disabled={!/^https:\/\//.test(cfg.baseUrl) || !cfg.model.trim()} onPress={async () => {
              if (cfg.key) await SecureStore.setItemAsync(aiKeyName(cfg.baseUrl), cfg.key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
              setErr(act(() => phoneClan().ai.setSettings(me(), { provider: { kind: 'openai-compatible', baseUrl: cfg.baseUrl, model: cfg.model, label: '', embeddingModel: null } }))); setCfg(null);
            }} />
            <Btn label="Cancel" onPress={() => setCfg(null)} />
          </Row>
        </>) : (
          <Row>
            <Btn small label={pv.kind === 'none' ? 'Set up a provider' : 'Change provider'} onPress={() => setCfg({ baseUrl: pv.baseUrl, model: pv.model, key: '' })} />
            {pv.kind !== 'none' && <Btn small danger label="Turn off AI" onPress={async () => { await SecureStore.deleteItemAsync(aiKeyName(pv.baseUrl)); setErr(act(() => phoneClan().ai.setSettings(me(), { provider: { kind: 'none' } }))); }} />}
          </Row>
        )}
        <Muted small>The key never leaves this phone except to that address. Diary is never read by AI unless you allow it on this device.</Muted>
      </Card>
    </>
  );
}
