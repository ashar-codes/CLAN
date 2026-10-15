// Exported diagnostics are bounded and never carry keys, invites, QR payloads or long identifiers.
import { expect, it } from 'vitest';
import { DiscoveryDiagnostics } from '../src/diagnostics.ts';

it('records stage transitions, classifies failures with a hint, bounds events and sanitizes the export', () => {
  let t = 1_000;
  const d = new DiscoveryDiagnostics(() => t);
  d.set({ network: true, addresses: ['192.168.1.20'], listener: 7000 });
  d.set({ network: true, addresses: ['192.168.1.20'], listener: 7000 }); // no change → no extra event
  d.fail('unreachable', 'connect ETIMEDOUT key=Sllj0-WcwKYRlXJyxGpXFL4qabeXIDmSgCStR-FfcOM clan://p/abc?i=78841695a16647f3ac2560d163815427');
  for (let i = 0; i < 500; i++) { t++; d.event(`tick ${i}`); }
  const text = d.export({ app: 'CLAN', note: 'invite 78841695a16647f3ac2560d163815427' });
  expect(d.hint()).toMatch(/isolate devices/);
  expect(text).not.toMatch(/Sllj0-WcwKYRlXJyxGpXFL4qabeXIDmSgCStR-FfcOM|78841695a16647f3ac2560d163815427|clan:\/\/p\//);
  expect(text).toContain('[redacted]');
  expect(text.split('\n').filter((l) => / {2}tick /.test(l)).length).toBeLessThanOrEqual(200);
  expect(d.state.lastFailure).toBe('unreachable');
});
