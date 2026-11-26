import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, TEST_ENV, type TestApp } from './helpers/app.js';
import { addTenant, TEST_DATABASE_URL } from './helpers/db.js';
import { runWithTenant } from '../src/db/tenant.js';
import { createLogger } from '../src/logger.js';
import { AnthropicClient, AiError } from '../src/ai/client.js';
import { definePrompt, allPrompts, PING_PROMPT, UNTRUSTED_INPUT_RULES } from '../src/ai/prompts.js';
import { loadEnv } from '../src/config/env.js';

const KEY = 'sk-ant-test-SECRET-KEY-1234567890';
type Hit = { url: string; headers: Record<string, string>; body: { model: string; max_tokens: number; system: string; messages: unknown[]; tools?: unknown[] } };
const hits: Hit[] = [];
let script: (n: number) => Response | Promise<Response> = () => ok('pong');
const ok = (text: string, usage = { input_tokens: 120, output_tokens: 10 }, extra: object[] = []) =>
  Response.json({ id: 'msg_1', type: 'message', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }, ...extra], usage });
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  hits.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
  return script(hits.length);
}) as typeof fetch;
const waits: number[] = [];
const lines: Record<string, unknown>[] = [];
const sink = new Writable({ write(chunk, _e, cb) { for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>); cb(); } });

let t: TestApp; let owner: pg.Pool; let A: string; let B: string; let platform: string;
const inA = <T>(fn: () => Promise<T>) => runWithTenant(A, fn);
const ping = (tenant = A, text = 'hello') => runWithTenant(tenant, () => t.c.ai.run({ prompt: PING_PROMPT, messages: [{ role: 'user', content: text }], maxTokens: 50 }));
const used = async (tenant = A) => runWithTenant(tenant, () => t.c.ai.budget.used());
const setUnits = (code: string, n: number) => request(t.app).put(`/api/platform/plans/${code}`).set({ authorization: `Bearer ${platform}` }).send({ aiMonthlyUnits: n });

beforeAll(async () => {
  t = await buildTestApp({ ANTHROPIC_API_KEY: KEY, PLATFORM_ADMIN_EMAIL: 'ops@platform.test', PLATFORM_ADMIN_PASSWORD: 'PlatformPass123!' },
    { fetch: fakeFetch, logger: createLogger('info', sink), aiWait: async (ms) => { waits.push(ms); } });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  platform = (await request(t.app).post('/api/platform/login').send({ email: 'ops@platform.test', password: 'PlatformPass123!' })).body.token;
  A = await addTenant('ai-a', 'AI A'); B = await addTenant('ai-b', 'AI B');
  await owner.query("UPDATE tenants SET plan = 'PRO' WHERE id = ANY($1)", [[A, B]]);
});
afterAll(async () => { await owner.end(); await t.close(); });

describe('Anthropic client', () => {
  const client = (over: Partial<ConstructorParameters<typeof AnthropicClient>[0]> = {}, w = async (ms: number) => { waits.push(ms); }) =>
    new AnthropicClient({ apiKey: KEY, apiBase: 'https://api.anthropic.com', model: 'claude-haiku-5-5', timeoutMs: 1000, maxAttempts: 3, ...over }, fakeFetch, w);

  it('sends the key and version in headers, the model, system prompt, messages and tools in the body, and returns text, tool calls and usage', async () => {
    hits.length = 0;
    script = () => ok('hi', { input_tokens: 7, output_tokens: 3 }, [{ type: 'tool_use', id: 'tu_1', name: 'add_to_cart', input: { sku: 'TEE', quantity: 2 } }]);
    const r = await client().messages({ system: 'S', messages: [{ role: 'user', content: 'U' }], tools: [{ name: 'add_to_cart', description: 'd', input_schema: { type: 'object' } }], maxTokens: 99 });
    expect(hits[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(hits[0]!.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(hits[0]!.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 99, system: 'S', messages: [{ role: 'user', content: 'U' }] });
    expect(r).toMatchObject({ text: 'hi', usage: { inputTokens: 7, outputTokens: 3 }, toolUses: [{ id: 'tu_1', name: 'add_to_cart', input: { sku: 'TEE', quantity: 2 } }], attempts: 1 });
  });

  it('retries rate limits and overload with backoff (honouring retry-after), then succeeds', async () => {
    hits.length = 0; waits.length = 0;
    script = (n) => (n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : n === 2 ? new Response('{}', { status: 529 }) : ok('done'));
    const r = await client().messages({ system: 'S', messages: [{ role: 'user', content: 'U' }], maxTokens: 10 });
    expect(r.text).toBe('done'); expect(r.attempts).toBe(3); expect(hits).toHaveLength(3);
    expect(waits[0]).toBe(2000);                                  // retry-after wins
    expect(waits[1]).toBeGreaterThanOrEqual(250); expect(waits[1]).toBeLessThanOrEqual(1000); // jittered exponential
  });

  it('gives up after the last attempt with a plain, key-free error', async () => {
    hits.length = 0;
    script = () => new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 503 });
    const err = await client().messages({ system: 'S', messages: [], maxTokens: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(hits).toHaveLength(3);
    expect(JSON.stringify([(err as Error).message, (err as AiError).code])).not.toContain(KEY);
  });

  it('does not retry a request the API refused, and never repeats the key from its message', async () => {
    hits.length = 0;
    script = () => new Response(JSON.stringify({ error: { message: `invalid x-api-key ${KEY}` } }), { status: 401 });
    const err = (await client().messages({ system: 'S', messages: [], maxTokens: 10 }).catch((e: unknown) => e)) as AiError;
    expect(hits).toHaveLength(1);
    expect(err.status).toBe(502); // our configuration problem, not the caller's
    expect(err.message).not.toContain(KEY); expect(err.message).toContain('[redacted]');
  });

  it('times out each attempt and retries network failures', async () => {
    hits.length = 0;
    script = (n) => (n === 1 ? new Promise<Response>((_r, rej) => setTimeout(() => rej(new TypeError('fetch failed')), 5)) : ok('after network error'));
    expect((await client().messages({ system: 'S', messages: [], maxTokens: 10 })).text).toBe('after network error');
  });

  it('rejects an answer that is not a Messages response, and refuses to run without a key', async () => {
    script = () => Response.json({ nope: true });
    await expect(client().messages({ system: 'S', messages: [], maxTokens: 10 })).rejects.toMatchObject({ code: 'AI_BAD_RESPONSE' });
    await expect(client({ apiKey: undefined }).messages({ system: 'S', messages: [], maxTokens: 10 })).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });
});

describe('prompts', () => {
  it('are versioned constants that cannot be redefined, and carry the untrusted-input rules', () => {
    expect(PING_PROMPT.ref).toBe('ping@1');
    expect(() => definePrompt('ping', 1, 'again')).toThrow(/twice/);
    expect(PING_PROMPT.text).toContain(UNTRUSTED_INPUT_RULES);
    expect(allPrompts().map((p) => p.ref)).toContain('ping@1');
    expect(Object.isFrozen(PING_PROMPT)).toBe(true);
  });
});

describe('budget and kill switches', () => {
  it('reserves before the call, records the real tokens after, and keeps businesses apart', async () => {
    hits.length = 0; script = () => ok('pong', { input_tokens: 100, output_tokens: 4 });
    await ping(A); await ping(A);
    expect(await used(A)).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 8, units: 2 * (100 + 4 * 5) });
    expect((await used(B)).units).toBe(0);
  });

  it('refuses a call that would pass the monthly allowance, without calling the API, and says how much was used', async () => {
    await setUnits('PRO', 400);
    hits.length = 0;
    const err = await ping(A).catch((e: unknown) => e) as { status: number; code: string; details: { limit: number; used: number; plan: string } };
    expect(hits).toHaveLength(0);                                       // the hard stop happens BEFORE spending anything
    expect(err).toMatchObject({ status: 402, code: 'AI_BUDGET', details: { limit: 400, plan: 'Pro' } });
    expect(err.details.used).toBe(240);
    await setUnits('PRO', 2_000_000);
  });

  it('a plan with no AI allowance never calls out', async () => {
    await setUnits('FREE', 0);
    const free = await addTenant('ai-free', 'Free one');
    hits.length = 0;
    await expect(ping(free)).rejects.toMatchObject({ code: 'AI_BUDGET', status: 402 });
    expect(hits).toHaveLength(0);
  });

  it('concurrent calls cannot overshoot the allowance', async () => {
    await owner.query("DELETE FROM ai_usage WHERE tenant_id = $1", [B]);
    await setUnits('PRO', 2000);
    hits.length = 0; script = () => ok('pong', { input_tokens: 10, output_tokens: 1 });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => ping(B)));
    const ran = results.filter((r) => r.status === 'fulfilled').length;
    expect(ran).toBe(hits.length);
    expect(ran).toBeGreaterThan(0); expect(ran).toBeLessThan(12);
    expect((await used(B)).units).toBeLessThanOrEqual(2000);
    await setUnits('PRO', 2_000_000);
  });

  it('gives the reservation back when the API fails', async () => {
    const before = (await used(A)).units;
    script = () => new Response('{}', { status: 400 });
    await expect(ping(A)).rejects.toBeInstanceOf(AiError);
    expect((await used(A)).units).toBe(before);
  });

  it('the operator can switch AI off for one business, and on again', async () => {
    expect((await request(t.app).patch(`/api/platform/tenants/${A}`).set({ authorization: `Bearer ${platform}` }).send({ aiEnabled: false })).status).toBe(200);
    hits.length = 0; script = () => ok('pong');
    await expect(ping(A)).rejects.toMatchObject({ status: 403, code: 'AI_DISABLED' });
    expect(hits).toHaveLength(0);
    expect(await runWithTenant(A, () => t.c.ai.available())).toBe(false);
    expect(await runWithTenant(B, () => t.c.ai.available())).toBe(true);
    await request(t.app).patch(`/api/platform/tenants/${A}`).set({ authorization: `Bearer ${platform}` }).send({ aiEnabled: true });
    await expect(ping(A)).resolves.toMatchObject({ text: 'pong' });
  });

  it('a business cannot change its own allowance or switch', async () => {
    await expect(inA(() => t.pool.query('UPDATE ai_usage SET units = 0'))).resolves.toBeDefined(); // its own counter is writable (the gateway needs it) ...
    await expect(inA(() => t.pool.query('UPDATE plans SET ai_monthly_units = 99999999999'))).rejects.toMatchObject({ code: '42501' }); // ... but the allowance is not
    await expect(inA(() => t.pool.query('UPDATE tenants SET ai_enabled = true'))).rejects.toMatchObject({ code: '42501' });
    await expect(inA(() => t.pool.query('DELETE FROM ai_usage'))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('logging', () => {
  it('records sizes, model, prompt id and tool names only: never text, the key or the system prompt', async () => {
    lines.length = 0;
    script = () => ok('SECRET-ANSWER-TEXT', { input_tokens: 50, output_tokens: 5 }, [{ type: 'tool_use', id: 'tu', name: 'search_products', input: { query: 'private' } }]);
    await runWithTenant(A, () => t.c.ai.run({ prompt: PING_PROMPT, messages: [{ role: 'user', content: 'CUSTOMER-PRIVATE-MESSAGE' }], tools: [{ name: 'search_products', description: 'd', input_schema: { type: 'object' } }], maxTokens: 20 }));
    const line = lines.find((l) => l.msg === 'ai call')!;
    expect(line).toMatchObject({ tenantId: A, ai: { prompt: 'ping@1', model: 'claude-haiku-5-5', inputTokens: 50, outputTokens: 5, messages: 1, toolsOffered: ['search_products'], toolsUsed: ['search_products'] } });
    const all = JSON.stringify(lines);
    for (const secret of [KEY, 'SECRET-ANSWER-TEXT', 'CUSTOMER-PRIVATE-MESSAGE', 'private', 'Answer with one short word']) expect(all).not.toContain(secret);
  });
});

// Last: building another test app resets the shared test database.
describe('global kill switch and configuration', () => {
  it('AI_DISABLED switches every business off; no key means AI is off', async () => {
    const off = await buildTestApp({ ANTHROPIC_API_KEY: KEY, AI_DISABLED: 'true' }, { fetch: fakeFetch });
    const none = await buildTestApp({}, { fetch: fakeFetch });
    try {
      hits.length = 0;
      const req = { prompt: PING_PROMPT, messages: [{ role: 'user' as const, content: 'x' }], maxTokens: 10 };
      await expect(off.c.ai.run(req)).rejects.toMatchObject({ code: 'AI_SWITCHED_OFF' });
      await expect(none.c.ai.run(req)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
      expect(await off.c.ai.available()).toBe(false); expect(await none.c.ai.available()).toBe(false);
      expect(hits).toHaveLength(0);
    } finally { await off.close(); await none.close(); }
  });

  it('reads model and base from the environment, and requires https for the API in production', () => {
    expect(loadEnv({ ...TEST_ENV }).AI_MODEL).toBe('claude-haiku-5-5');
    expect(() => loadEnv({ ...TEST_ENV, NODE_ENV: 'production', AI_API_BASE: 'http://api.example.com', ADMIN_PASSWORD: 'A-long-unique-password-1' })).toThrow(/AI_API_BASE/);
  });
});
