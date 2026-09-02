import type { AgentId, HarnessBus, Mailbox } from '../core/index.ts';

export type MailboxRecipient = AgentId | 'director' | 'admin' | `coordinator:${string}`;
export type MailboxSender = AgentId | 'director' | 'admin' | 'operator' | `coordinator:${string}`;

export interface Mailboxes {
  forRecipient(recipient: MailboxRecipient, sender?: MailboxSender): Mailbox;
  register(recipient: MailboxRecipient, notify: (from: string, text: string) => void | Promise<void>): () => void;
  send(from: MailboxSender, to: MailboxRecipient, text: string): void;
  drain(recipient: MailboxRecipient): readonly { readonly from: string; readonly text: string; readonly at: number }[];
  pending(recipient: MailboxRecipient): number;
  installPolicy(policy: (from: MailboxSender, to: MailboxRecipient) => boolean): void;
}

export function createMailboxes(bus: HarnessBus, now: () => number = Date.now): Mailboxes {
  const queues = new Map<string, { from: string; text: string; at: number }[]>();
  const listeners = new Map<string, Set<(from: string, text: string) => void | Promise<void>>>();
  let policy: (from: MailboxSender, to: MailboxRecipient) => boolean = () => true;

  const api: Mailboxes = {
    forRecipient(recipient, sender = recipient): Mailbox {
      return {
        send(to, text): void { api.send(sender, to, text); },
        drain(): readonly { readonly from: string; readonly text: string; readonly at: number }[] {
          return api.drain(recipient);
        },
        pending(): number { return api.pending(recipient); }
      };
    },
    register(recipient, notify) {
      const set = listeners.get(recipient) ?? new Set();
      set.add(notify);
      listeners.set(recipient, set);
      return () => { set.delete(notify); };
    },
    send(from, to, text): void {
      if (!policy(from, to)) throw new Error('cross-team messaging is disabled in this run');
      const message = { from, text, at: now() };
      const queue = queues.get(to) ?? [];
      queue.push(message);
      queues.set(to, queue);
      bus.emit('agent.message', { from, to, text });
      for (const notify of listeners.get(to) ?? []) {
        Promise.resolve(notify(from, text)).catch((error) => {
          bus.emit('log', {
            level: 'warn', scope: 'mailbox', message: `Delivery notification for ${to} failed`,
            data: { error: error instanceof Error ? error.message : String(error) }
          });
        });
      }
    },
    drain(recipient) {
      const queue = queues.get(recipient) ?? [];
      queues.set(recipient, []);
      return queue.slice();
    },
    pending(recipient): number { return queues.get(recipient)?.length ?? 0; },
    installPolicy(next): void { policy = next; }
  };
  return api;
}
