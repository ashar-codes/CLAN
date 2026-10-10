import { afterEach, expect, it, vi } from 'vitest';
import type { WbOp } from '@classroom/protocol';
import { PendingOps } from '../src/board/PendingOps.ts';

const op = (id: string): WbOp => ({ t: 'del', id, obj: '85ca05c0-1407-4331-9598-ff60066e104e', clock: 1 });
afterEach(() => vi.useRealTimers());

it('retries the same operation ID after a dropped send, then stops after durable acknowledgment', () => {
  vi.useFakeTimers();
  const sent: string[] = [], q = new PendingOps((o) => sent.push(o.id), 5000);
  q.enqueue(op('df806fbb-6b33-423d-b816-54ea8cd44e73'));
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(5000);
  expect(sent).toEqual([sent[0], sent[0]]);
  q.confirm([sent[0]!]);
  vi.advanceTimersByTime(20000);
  expect(sent).toHaveLength(2);
  q.close();
});

it('resends unacknowledged operations on reconnect; duplicate or delayed acknowledgments are harmless', () => {
  vi.useFakeTimers();
  const sent: string[] = [], q = new PendingOps((o) => sent.push(o.id), 5000);
  const a = '37ce55c1-9ac8-4f0f-a7d5-aa4846c77fd6', b = '6adb333a-0143-45b6-8b55-993124d603e7';
  q.enqueue(op(a)); q.enqueue(op(b));
  q.confirm([a]); q.confirm([a]); // echo after ack, or a duplicate ack
  q.resend(); // host replay/snapshot on a new connection
  expect(sent).toEqual([a, b, b]);
  q.confirm([b]); // delayed acknowledgment after reconnect
  vi.advanceTimersByTime(10000);
  expect(sent).toHaveLength(3);
  q.close();
});

it('retains an operation when socket send throws, and drops rejected IDs without bypassing permissions', () => {
  vi.useFakeTimers();
  let fail = true; const sent: string[] = [];
  const q = new PendingOps((o) => { if (fail) throw new Error('socket closing'); sent.push(o.id); }, 5000);
  const id = '548ca71f-e5ae-42e1-9537-047993e1570b';
  q.enqueue(op(id)); fail = false;
  vi.advanceTimersByTime(5000);
  expect(sent).toEqual([id]);
  q.confirm([id]); // wb.nack: caller also requests a fresh authorized state
  vi.advanceTimersByTime(10000);
  expect(sent).toHaveLength(1);
  q.close();
});
