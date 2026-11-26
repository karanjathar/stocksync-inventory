import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp, type TestApp } from './helpers/app.js';

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(); });
afterAll(async () => { await t.close(); });
const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });

describe('settings', () => {
  it('returns defaults', async () => {
    const res = await request(t.app).get('/api/settings').set(auth(await t.token('viewer')));
    expect(res.body).toEqual({
      businessName: 'StockSync', currency: 'USD', whatsappNumber: '', defaultWarehouseId: null, alertRecipients: [], customFields: [],
      payments: { onlineEnabled: true, codEnabled: true, linkExpiryMinutes: 1440 }, // Release 2
      whatsappTemplates: {}, maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 365 }, // Release 3
      gst: { legalName: '', gstin: '', address: '', stateCode: '', invoicePrefix: 'INV', pricesIncludeTax: true }, // Release 4
    });
  });

  it('only admins update; partial updates merge and persist', async () => {
    const staff = await t.token('staff');
    expect((await request(t.app).put('/api/settings').set(auth(staff)).send({ currency: 'EUR' })).status).toBe(403);
    const admin = await t.token('admin');
    const res = await request(t.app).put('/api/settings').set(auth(admin)).send({
      businessName: 'Corner Shop', currency: 'inr',
      alertRecipients: [{ channel: 'whatsapp', to: '15550001111' }],
      customFields: [{ key: 'color', label: 'Colour', type: 'select', options: ['red', 'blue'] }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ businessName: 'Corner Shop', currency: 'INR', whatsappNumber: '' });
    const again = await t.c.settings.get();
    expect(again.alertRecipients).toEqual([{ channel: 'whatsapp', to: '15550001111' }]);
    expect(again.customFields[0]!.key).toBe('color');
  });

  it('validates values', async () => {
    const admin = await t.token('admin');
    for (const body of [
      { currency: 'DOLLARS' },
      { alertRecipients: [{ channel: 'fax', to: '1' }] },
      { customFields: [{ key: 'bad key!', label: 'x', type: 'text' }] },
      { defaultWarehouseId: '00000000-0000-0000-0000-000000000000' },
    ]) {
      expect((await request(t.app).put('/api/settings').set(auth(admin)).send(body)).status).toBe(400);
    }
  });
});

describe('Release 3 settings (T59)', () => {
  it('stores template mappings and maintenance values', async () => {
    const admin = await t.token('admin');
    const body = {
      whatsappTemplates: { order_confirmed: { name: 'order_confirmed_v1', language: 'en', params: ['orderNumber', 'total'] } },
      maintenance: { unpaidOrderTtlHours: 24, chatRetentionDays: 0 },
    };
    const res = await request(t.app).put('/api/settings').set(auth(admin)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(body);
    expect(await t.c.settings.get()).toMatchObject(body);
  });

  it('rejects invalid template mappings and maintenance values', async () => {
    const admin = await t.token('admin');
    for (const body of [
      { whatsappTemplates: { not_an_event: { name: 'x', language: 'en', params: [] } } },
      { whatsappTemplates: { order_confirmed: { name: 'Bad Name!', language: 'en', params: [] } } },
      { whatsappTemplates: { order_confirmed: { name: 'ok_name', language: 'english', params: [] } } },
      { whatsappTemplates: { order_confirmed: { name: 'ok_name', language: 'en', params: ['nope'] } } },
      { maintenance: { unpaidOrderTtlHours: 0, chatRetentionDays: 365 } },
      { maintenance: { unpaidOrderTtlHours: 48, chatRetentionDays: 4000 } },
    ]) {
      expect((await request(t.app).put('/api/settings').set(auth(admin)).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});
