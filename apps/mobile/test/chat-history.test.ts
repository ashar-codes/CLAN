import { expect, it } from 'vitest';
import type { ChatMessageView } from '@classroom/protocol';
import { catchUpChat, mergeChatMessages } from '@classroom/client';

const messages = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: `message-${from + i}`, seq: from + i, body: `${from + i}` } as ChatMessageView));

it('catches up more than one server page after reconnect, without losing live messages or duplicating retries', async () => {
  const host = messages(1, 451), cursors: number[] = [];
  let local = [...messages(1, 5), ...messages(449, 451)]; // late live messages overlap the catch-up
  await catchUpChat(5, 451, async (after) => { cursors.push(after); return host.filter((m) => m.seq > after).slice(0, 200); }, (page) => { local = mergeChatMessages(local, page); });
  expect(cursors).toEqual([5, 205, 405]);
  expect(local.map((m) => m.seq)).toEqual(host.map((m) => m.seq));
});

it('keeps updated messages by ID and sorts prepended history with live arrivals', () => {
  const old = messages(51, 100), changed = { ...old[0]!, body: 'edited' };
  const merged = mergeChatMessages(old, [...messages(1, 50), changed, ...messages(101, 102)]);
  expect(merged).toHaveLength(102); expect(merged[50]!.body).toBe('edited');
  expect(merged.map((m) => m.seq)).toEqual(messages(1, 102).map((m) => m.seq));
});

it('stops at the captured host cursor and reports interrupted or non-advancing catch-up', async () => {
  let requests = 0;
  await catchUpChat(451, 451, async () => { requests++; return []; }, () => {});
  expect(requests).toBe(0);
  await expect(catchUpChat(5, 10, async () => messages(1, 5), () => {})).rejects.toThrow(/advance/);
  await expect(catchUpChat(5, 10, async () => { throw new Error('offline'); }, () => {})).rejects.toThrow('offline');
});

it('refreshes edits and removals in the loaded interval on reconnect, including unchanged sequence numbers', async () => {
  const host = messages(1, 75);
  host[54] = { ...host[54]!, body: 'edited while offline' };
  host[59] = { ...host[59]!, body: '', removed: { by: 'host', at: 100 } };
  let local = messages(51, 70);
  await catchUpChat(local[0]!.seq - 1, 75, async (after) => host.filter((m) => m.seq > after).slice(0, 200), (page) => { local = mergeChatMessages(local, page); });
  expect(local.find((m) => m.seq === 55)!.body).toBe('edited while offline');
  expect(local.find((m) => m.seq === 60)!.removed).toMatchObject({ by: 'host' });
  expect(local.at(-1)!.seq).toBe(75);
});
