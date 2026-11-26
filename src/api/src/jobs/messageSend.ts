import type { ChannelHub } from '../channels/hub.js';
import type { JobQueue } from './queue.js';

/** `message.send`: delivers a stored outbound message; the retry schedule is the queue's backoff. */
export function registerMessageSend(queue: JobQueue, hub: ChannelHub): void {
  queue.register('message.send', async (job) => {
    const messageId = job.payload.messageId;
    if (typeof messageId !== 'string') return;
    await hub.deliver(messageId, { finalAttempt: job.attempts >= job.maxAttempts });
  });
}
