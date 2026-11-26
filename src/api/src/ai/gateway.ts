import type { Logger } from 'pino';
import type { Queryable } from '../db/pool.js';
import { AiBudget, unitsFor } from './budget.js';
import { AiError, type AnthropicClient, type AiMessage, type AiResponse, type AiTool } from './client.js';
import type { Prompt } from './prompts.js';

export interface GatewayRequest { prompt: Prompt; messages: AiMessage[]; tools?: AiTool[]; maxTokens: number; model?: string }

/**
 * The only way the app talks to the model. It refuses when AI is switched off (globally or for this business) or not configured, reserves the
 * worst-case cost against the business's monthly allowance BEFORE calling, settles the real usage afterwards, and logs only sizes and tool names.
 * Must run inside the business's context.
 */
export class AiGateway {
  constructor(private readonly db: Queryable, private readonly client: AnthropicClient, readonly budget: AiBudget, private readonly globalOff: boolean, private readonly logger: Logger) {}

  async available(): Promise<boolean> {
    if (this.globalOff || !this.client.isConfigured()) return false;
    return (await this.db.query<{ on: boolean }>('SELECT ai_enabled AS "on" FROM tenants WHERE id = current_tenant()')).rows[0]?.on === true;
  }

  async run(req: GatewayRequest): Promise<AiResponse> {
    if (this.globalOff) throw new AiError(503, 'AI_SWITCHED_OFF', 'AI assistance is switched off');
    if (!this.client.isConfigured()) throw new AiError(501, 'AI_NOT_CONFIGURED', 'AI is not configured');
    if (!(await this.available())) throw new AiError(403, 'AI_DISABLED', 'AI assistance is switched off for this business');

    const chars = req.prompt.text.length + JSON.stringify(req.messages).length + (req.tools ? JSON.stringify(req.tools).length : 0);
    const reserved = unitsFor(Math.ceil(chars / 3), req.maxTokens); // generous: about 3 characters per token, and the whole output allowance
    await this.budget.reserve(reserved);
    const started = Date.now();
    try {
      const res = await this.client.messages({ system: req.prompt.text, messages: req.messages, maxTokens: req.maxTokens, ...(req.tools ? { tools: req.tools } : {}), ...(req.model ? { model: req.model } : {}) });
      await this.budget.settle(reserved, res.usage);
      this.logger.info({ ai: { prompt: req.prompt.ref, model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, messages: req.messages.length,
        toolsOffered: req.tools?.map((t) => t.name) ?? [], toolsUsed: res.toolUses.map((t) => t.name), attempts: res.attempts, ms: Date.now() - started, stop: res.stopReason } }, 'ai call');
      return res;
    } catch (err) {
      await this.budget.release(reserved).catch(() => undefined);
      this.logger.warn({ ai: { prompt: req.prompt.ref, ms: Date.now() - started, code: err instanceof AiError ? err.code : 'ERROR' } }, 'ai call failed');
      throw err;
    }
  }
}
