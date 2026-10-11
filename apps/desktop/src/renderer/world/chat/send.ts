// "Send to one CLANmate": upload (or host import) with that person as the only audience, then a direct message that
// carries the file. The same resource/transfer system as the table — only the audience differs.
import { api } from '../../App.tsx';
import type { PersonActions } from '../LiveRoom.tsx';
import type { ChatState } from './useChat.ts';

export function personSender(chat: ChatState, onMessage: (handle: string) => void, canSendFiles: boolean): PersonActions {
  return {
    onMessage, canSendFiles,
    async onSend(handle, name, files) {
      const sent = files?.length ? await api.chat.sendDropped(chat.conn, files, handle) : await api.chat.sendPicked(chat.conn, handle);
      for (const r of sent) if (!('pending' in r)) await chat.post({ kind: 'direct', to: handle }, '', { attachment: { kind: 'file', resourceId: r.id } });
      if (sent.some((r) => 'pending' in r)) return 'File sent for teacher approval.';
      const who = name.split(' ')[0];
      return sent.length ? `Sent ${sent.length === 1 ? sent[0]!.name : `${sent.length} files`} to ${who} only` : 'Nothing was sent.';
    },
  };
}
