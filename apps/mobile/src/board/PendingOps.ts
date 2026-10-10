import type { WbOp } from '@classroom/protocol';

/** Transport delivery only. The shared whiteboard reducer remains the source of truth. */
export class PendingOps {
  private ops = new Map<string, WbOp>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private send: (op: WbOp) => void, private retryMs = 5000) {}

  enqueue(op: WbOp) {
    this.ops.set(op.id, op);
    this.arm();
    this.trySend(op);
  }

  confirm(ids: readonly string[]) {
    for (const id of ids) this.ops.delete(id);
    if (!this.ops.size && this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  values() { return this.ops.values(); }

  resend() { for (const op of this.ops.values()) this.trySend(op); this.arm(); }

  close() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.ops.clear(); }

  private trySend(op: WbOp) {
    // A socket can close between its readyState check and send. Keep the op for retry.
    try { this.send(op); } catch { /* retained until an acknowledgment or reconnect */ }
  }

  private arm() {
    if (this.timer || !this.ops.size) return;
    this.timer = setTimeout(() => { this.timer = null; this.resend(); }, this.retryMs);
  }
}
