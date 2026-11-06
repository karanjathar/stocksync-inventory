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
