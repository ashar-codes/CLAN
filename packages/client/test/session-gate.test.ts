import { expect, it, vi } from 'vitest';
import type { ServerMessage } from '@classroom/protocol';
import { SessionGate } from '../src/session-gate.ts';

const hello = (status = 'approved') => ({ t: 'hello', status, classroom: { sessionId: 'session', clanId: 'clan' } }) as unknown as Extract<ServerMessage, { t: 'hello' }>;
const resources = { t: 'resources', resources: [] } satisfies ServerMessage;

it('holds projections and sends until verification finishes, preserving wire order', async () => {
  let finish!: () => void;
  const verified = new Promise<void>((r) => { finish = r; });
  const messages: string[] = [], failed = vi.fn();
  const gate = new SessionGate({ verify: () => verified, message: (m) => messages.push(m.t), failed });
  const first = gate.push(hello()), second = gate.push(resources);
  await Promise.resolve();
  expect(gate.confirmed).toBe(false); expect(messages).toEqual([]);
  finish(); await first; await second;
  expect(messages).toEqual(['hello', 'resources']); expect(gate.confirmed).toBe(true); expect(failed).not.toHaveBeenCalled();
});

it('a rejected host never reaches projections and permanently closes the gate', async () => {
  const message = vi.fn(), failed = vi.fn();
  const gate = new SessionGate({ verify: async () => { throw new Error('stale host'); }, message, failed });
  await Promise.all([gate.push(hello()), gate.push(resources)]);
  await gate.push(hello());
  expect(message).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce(); expect(gate.confirmed).toBe(false);
});

it('approval is verified before exposing data to a previously pending member', async () => {
  const seen: string[] = [], failed = vi.fn();
  const gate = new SessionGate({ verify: async (h) => { if (h.status === 'approved') throw new Error('forged proof'); }, message: (m) => seen.push(m.t), failed });
  await gate.push(hello('pending'));
  await Promise.all([gate.push({ t: 'member.status', status: 'approved' }), gate.push(resources)]);
  expect(seen).toEqual(['hello']); expect(failed).toHaveBeenCalledOnce(); expect(gate.confirmed).toBe(false);
});

it('reconnect and class state changes must pass verification again', async () => {
  const verify = vi.fn(async () => {}), message = vi.fn(), failed = vi.fn();
  const gate = new SessionGate({ verify, message, failed });
  await gate.push(hello());
  await gate.push({ t: 'class.state', classroom: hello().classroom });
  verify.mockRejectedValueOnce(new Error('old epoch'));
  await Promise.all([gate.push(hello()), gate.push(resources)]);
  expect(verify).toHaveBeenCalledTimes(3); expect(message).toHaveBeenCalledTimes(2); expect(failed).toHaveBeenCalledOnce();
});

it('closing while verification is pending discards its late result', async () => {
  let finish!: () => void;
  const message = vi.fn(), failed = vi.fn();
  const gate = new SessionGate({ verify: () => new Promise<void>((r) => { finish = r; }), message, failed });
  const task = gate.push(hello()); await Promise.resolve(); gate.stop(); finish(); await task;
  expect(message).not.toHaveBeenCalled(); expect(gate.confirmed).toBe(false);
});

it('an unverified host cannot grow an unbounded message queue', async () => {
  const failed = vi.fn(), message = vi.fn();
  const gate = new SessionGate({ verify: async () => {}, message, failed });
  const tasks = [gate.push(hello()), ...Array.from({ length: 256 }, () => gate.push(resources))];
  await Promise.all(tasks);
  expect(failed).toHaveBeenCalledOnce(); expect(message).not.toHaveBeenCalled(); expect(gate.confirmed).toBe(false);
});

it('pauses permission controls and coalesces completion telemetry until current authority is verified', async () => {
  let finish!: () => void;
  let slow = false;
  const readiness: boolean[] = [], reports: string[] = [];
  const gate = new SessionGate({ verify: () => slow ? new Promise<void>(r => finish = r) : Promise.resolve(), message: () => {}, failed: () => {}, readyChanged: ready => readiness.push(ready) });
  await gate.push(hello()); expect(gate.confirmed).toBe(true);
  slow = true; const changing = gate.push({ t: 'class.state', classroom: hello().classroom }); await Promise.resolve();
  expect(readiness.at(-1)).toBe(false);
  gate.afterVerified('transfer:one', () => reports.push('downloading'));
  gate.afterVerified('transfer:one', () => reports.push('completed'));
  expect(reports).toEqual([]); finish(); await changing;
  expect(reports).toEqual(['completed']); expect(readiness.at(-1)).toBe(true);
});

it('stale authority discards deferred telemetry instead of sending it to an unverified host', async () => {
  let reject!: (error: Error) => void;
  const action = vi.fn(), failed = vi.fn();
  const gate = new SessionGate({ verify: () => new Promise<void>((_, r) => reject = r), message: () => {}, failed });
  const pending = gate.push(hello()); await Promise.resolve();
  expect(gate.afterVerified('transfer:one', action)).toBe(true);
  reject(new Error('stale host')); await pending;
  expect(action).not.toHaveBeenCalled(); expect(gate.afterVerified('transfer:two', action)).toBe(false);
  expect(failed).toHaveBeenCalledOnce();
});

it('bounds deferred telemetry and discards it on stop', async () => {
  let finish!: () => void;
  const action = vi.fn();
  const gate = new SessionGate({ verify: () => new Promise<void>(r => finish = r), message: () => {}, failed: () => {} });
  const pending = gate.push(hello()); await Promise.resolve();
  for (let i = 0; i < 64; i++) expect(gate.afterVerified(`transfer:${i}`, action)).toBe(true);
  expect(gate.afterVerified('transfer:overflow', action)).toBe(false);
  expect(gate.afterVerified('transfer:0', action)).toBe(true);
  gate.stop(); finish(); await pending;
  expect(action).not.toHaveBeenCalled();
});
