import { z } from 'zod';
import { AppError } from '../domain/errors.js';

/** An AI problem the API can show as it is (status and code reach the caller; messages never contain the key). */
export class AiError extends AppError {
  constructor(status: number, code: string, message: string) { super(status, code, message); }
}

export interface AiConfig { apiKey?: string | undefined; apiBase: string; model: string; timeoutMs: number; maxAttempts: number }
export interface AiTool { name: string; description: string; input_schema: Record<string, unknown> }
export type AiMessage = { role: 'user' | 'assistant'; content: string | AiBlock[] };
export type AiBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export interface AiRequest { system: string; messages: AiMessage[]; tools?: AiTool[]; maxTokens: number; model?: string }
export interface AiResponse {
  stopReason: string; text: string; toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  usage: { inputTokens: number; outputTokens: number }; content: AiBlock[]; attempts: number; model: string;
}

const response = z.object({
  content: z.array(z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  ])),
  stop_reason: z.string().nullable(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  model: z.string().optional(),
});

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

/**
 * Anthropic Messages API over fetch (injectable for tests). Retries rate limits, overload and network failures with exponential backoff and jitter
 * (honouring `retry-after`), gives every attempt its own timeout, and never lets the API key reach an error message or log.
 */
export class AnthropicClient {
  constructor(private readonly cfg: AiConfig, private readonly fetchFn: typeof fetch = fetch, private readonly wait: (ms: number) => Promise<void> = sleep) {}

  isConfigured(): boolean { return Boolean(this.cfg.apiKey); }
  get model(): string { return this.cfg.model; }

  /** Removes the key from any text before it can be stored, thrown or logged. */
  private scrub(text: string): string {
    const key = this.cfg.apiKey;
    return (key ? text.split(key).join('[redacted]') : text).slice(0, 300);
  }

  async messages(req: AiRequest): Promise<AiResponse> {
    if (!this.cfg.apiKey) throw new AiError(501, 'AI_NOT_CONFIGURED', 'AI is not configured');
    const body = JSON.stringify({ model: req.model ?? this.cfg.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, ...(req.tools?.length ? { tools: req.tools } : {}) });
    let lastStatus = 0; let lastCode = 'AI_UNAVAILABLE';
    for (let attempt = 1; attempt <= this.cfg.maxAttempts; attempt++) {
      let retryAfterMs = 0;
      try {
        const res = await this.fetchFn(`${this.cfg.apiBase.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST', body, signal: AbortSignal.timeout(this.cfg.timeoutMs),
          headers: { 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        });
        if (res.ok) {
          const parsed = response.safeParse(await res.json().catch(() => null));
          if (!parsed.success) throw new AiError(502, 'AI_BAD_RESPONSE', 'The AI service sent an unexpected answer');
          const blocks = parsed.data.content;
          return {
            stopReason: parsed.data.stop_reason ?? 'unknown', model: parsed.data.model ?? req.model ?? this.cfg.model, attempts: attempt, content: blocks,
            text: blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
            toolUses: blocks.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [])),
            usage: { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens },
          };
        }
        lastStatus = res.status;
        const detail = this.scrub(String(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? res.statusText));
        lastCode = res.status === 429 ? 'AI_RATE_LIMITED' : res.status >= 500 ? 'AI_UNAVAILABLE' : 'AI_REJECTED';
        if (!RETRYABLE.has(res.status)) throw new AiError(res.status === 401 || res.status === 403 ? 502 : res.status, lastCode, `AI request refused (${res.status}): ${detail}`);
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 20_000);
      } catch (err) {
        if (err instanceof AiError) throw err;
        lastStatus = 0; lastCode = 'AI_UNAVAILABLE'; // timeout or network failure
      }
      if (attempt < this.cfg.maxAttempts) await this.wait(retryAfterMs || Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
    }
    throw new AiError(lastStatus === 429 ? 429 : 503, lastCode, `The AI service did not answer after ${this.cfg.maxAttempts} attempts`);
  }
}
