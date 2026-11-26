import type { ChannelName } from '../domain/types.js';
import type { BotReply } from './reply.js';

export interface ChannelAdapter {
  readonly name: ChannelName;
  isConfigured(): boolean;
  /** Resolve with the provider's message id when it returns one. */
  send(to: string, text: string): Promise<string | void>;
  /** Rich reply; adapters without it get renderPlain() text via the hub. */
  sendReply?(to: string, reply: BotReply): Promise<string | void>;
  /** Approved message template (WhatsApp): the only way to start a conversation outside the 24-hour window. */
  sendTemplate?(to: string, template: TemplateMessage): Promise<string | void>;
}

export interface TemplateMessage { name: string; language: string; params: string[] }

export class ChannelError extends Error {
  /** `providerCode` is the provider's own error code (e.g. Meta 131047 = re-engagement required). */
  constructor(channel: ChannelName, readonly status: number, detail: string, readonly providerCode?: number) {
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
    let providerCode: number | undefined;
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: number }; description?: string };
      detail = j.error?.message ?? j.description ?? detail;
      providerCode = typeof j.error?.code === 'number' ? j.error.code : undefined;
    } catch {
      /* non-JSON body */
    }
    throw new ChannelError(channel, res.status, detail.slice(0, 200), providerCode);
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}
