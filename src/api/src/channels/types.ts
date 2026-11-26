import type { ChannelName } from '../domain/types.js';
import type { BotReply } from './reply.js';

export interface ChannelAdapter {
  readonly name: ChannelName;
  isConfigured(): boolean;
  /** Resolve with the provider's message id when it returns one. */
  send(to: string, text: string): Promise<string | void>;
  /** Rich reply; adapters without it get renderPlain() text via the hub. */
  sendReply?(to: string, reply: BotReply): Promise<string | void>;
}

export class ChannelError extends Error {
  constructor(channel: ChannelName, readonly status: number, detail: string) {
    super(`${channel} API responded ${status}: ${detail}`);
    this.name = 'ChannelError';
  }
  /** 429 and 5xx are worth retrying; other 4xx will fail the same way again. */
  get retryable(): boolean { return this.status === 429 || this.status >= 500; }
}

/** Network failures and timeouts (not ChannelError) are retryable. */
export function isRetryable(err: unknown): boolean {
  return err instanceof ChannelError ? err.retryable : true;
}

/** POSTs JSON and throws a ChannelError (never containing credentials) on non-2xx. */
export async function postJson(
  channel: ChannelName,
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
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
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}
