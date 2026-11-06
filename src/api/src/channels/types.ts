import type { ChannelName } from '../domain/types.js';
import type { BotReply } from './reply.js';

export interface ChannelAdapter {
  readonly name: ChannelName;
  isConfigured(): boolean;
  send(to: string, text: string): Promise<void>;
  /** Rich reply; adapters without it get renderPlain() text via the hub. */
  sendReply?(to: string, reply: BotReply): Promise<void>;
}

export class ChannelError extends Error {
  constructor(channel: ChannelName, status: number, detail: string) {
    super(`${channel} API responded ${status}: ${detail}`);
    this.name = 'ChannelError';
  }
}

/** POSTs JSON and throws a ChannelError (never containing credentials) on non-2xx. */
export async function postJson(
  channel: ChannelName,
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<void> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { error?: { message?: string }; description?: string };
      detail = j.error?.message ?? j.description ?? detail;
    } catch {
      /* non-JSON body */
    }
    throw new ChannelError(channel, res.status, detail.slice(0, 200));
  }
}
