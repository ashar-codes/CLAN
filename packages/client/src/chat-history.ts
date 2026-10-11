import type { ChatMessageView } from '@classroom/protocol';

/** Merge host history, live delivery and duplicate retries without changing the message domain. */
export function mergeChatMessages(list: ChatMessageView[], add: ChatMessageView[]) {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** Catch up to a captured host cursor, including gaps longer than the API's 200-message page. */
export async function catchUpChat(after: number, target: number, page: (after: number) => Promise<ChatMessageView[]>, receive: (messages: ChatMessageView[]) => void) {
  let cursor = after;
  while (cursor < target) {
    const messages = await page(cursor);
    const next = messages.at(-1)?.seq ?? cursor;
    if (next <= cursor) throw new Error('Chat history did not advance. Reconnect to retry.');
    receive(messages);
    cursor = next;
  }
}
