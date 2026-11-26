import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
let staff: string;
beforeAll(async () => { t = await buildTestApp(); staff = await t.token('staff'); });
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

describe('suppliers', () => {
  it('CRUD + search', async () => {
    const s = await request(t.app).post('/api/suppliers').set(auth(staff)).send({ name: 'Acme Textiles', email: 'sales@acme.test', phone: '+15550001' });
    expect(s.status).toBe(201);
    expect(s.body).toEqual({ id: expect.any(String), name: 'Acme Textiles', email: 'sales@acme.test', phone: '+15550001', notes: '', leadTimeDays: 7 });
    expect((await request(t.app).post('/api/suppliers').set(auth(staff)).send({ name: 'X', email: 'bad' })).status).toBe(400);
    const found = await request(t.app).get('/api/suppliers?search=acme').set(auth(staff));
    expect(found.body).toHaveLength(1);
  });
});

describe('customers', () => {
  it('CRUD; manual channel by default', async () => {
    const c = await request(t.app).post('/api/customers').set(auth(staff)).send({ name: 'Jane Doe', phone: '+15550002' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Jane Doe', phone: '+15550002', email: null, channel: 'manual', channelUserId: null });
    const p = await request(t.app).patch(`/api/customers/${c.body.id}`).set(auth(staff)).send({ email: 'jane@x.test' });
    expect(p.body.email).toBe('jane@x.test');
  });

  it('findOrCreateByChannel is idempotent per channel user', async () => {
    const a = await t.c.customers.findOrCreateByChannel('whatsapp', '15551234567', 'Sam');
    const b = await t.c.customers.findOrCreateByChannel('whatsapp', '15551234567', 'Samuel');
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ channel: 'whatsapp', channelUserId: '15551234567', name: 'Sam', phone: '+15551234567' });
    const tg = await t.c.customers.findOrCreateByChannel('telegram', '987', undefined);
    expect(tg.name).toBe('telegram user 987');
    expect(tg.phone).toBeNull();
  });
});
