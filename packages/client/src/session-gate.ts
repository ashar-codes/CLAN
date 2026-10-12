import type { ServerMessage } from '@classroom/protocol';

type Hello = Extract<ServerMessage, { t: 'hello' }>;
type Hooks = {
  verify(hello: Hello): Promise<void>;
  message(message: ServerMessage): void;
  failed(error: Error): void;
};
/** Keep classroom projections and outgoing controls behind the asynchronous host-authority check.
 * Every reconnect hello and approval is checked in wire order; a failure permanently closes this gate. */
export class SessionGate {
  private queue = Promise.resolve();
  private hello: Hello | null = null;
  private stopped = false;
  private pending = 0;
  private ready = false;
  private checksPending = 0;
  private readonly hooks: Hooks;
  constructor(hooks: Hooks) { this.hooks = hooks; }
  get confirmed() { return this.ready && !this.stopped && this.checksPending === 0; }
  stop() { this.stopped = true; this.ready = false; }
  push(message: ServerMessage): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (++this.pending > 256) {
      this.stop(); this.hooks.failed(new Error('Too many messages before host verification.'));
      return Promise.resolve();
    }
    // Disable sends immediately when a new host statement arrives, even while older messages are queued.
    const check = message.t === 'hello' || message.t === 'class.state' || message.t === 'member.status' && message.status === 'approved';
    if (check) { this.ready = false; this.checksPending++; }
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (message.t === 'hello') this.hello = message;
      else if (message.t === 'class.state' && this.hello) this.hello = { ...this.hello, classroom: message.classroom };
      else if (message.t === 'member.status' && this.hello) this.hello = { ...this.hello, status: message.status };
      if (message.t === 'hello' || message.t === 'class.state' || message.t === 'member.status' && message.status === 'approved') {
        if (!this.hello) throw new Error('The host did not introduce this session.');
        await this.hooks.verify(this.hello);
        if (this.stopped) return;
        this.ready = true;
      }
      if (!this.ready && message.t !== 'pong') throw new Error('The host has not been verified.');
      this.hooks.message(message);
    }).catch((error: unknown) => {
      if (this.stopped) return;
      this.stop(); this.hooks.failed(error instanceof Error ? error : new Error('Host verification failed.'));
    }).finally(() => { this.pending--; if (check) this.checksPending--; });
    return this.queue;
  }
}
