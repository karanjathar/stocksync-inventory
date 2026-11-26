import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { CREDENTIAL_KINDS, CREDENTIAL_SCHEMAS, type CredentialKind } from '../../services/channelCredentials.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const kindSchema = z.object({ kind: z.enum(CREDENTIAL_KINDS as [CredentialKind, ...CredentialKind[]]) });

/** Admin-only, write-only credential management for the signed-in business. Secrets are never returned: only whether each is set and its last four characters. */
export function channelConfigRoutes(c: Container): Router {
  const r = Router();
  r.use(requireRole('admin'));
  r.get('/', async (req, res) => {
    const base = c.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    const tenantId = currentUser(req).tenantId;
    res.json({
      tenantId, enabled: c.channelCredentials.enabled,
      urls: { meta: `${base}/webhooks/meta/${tenantId}`, telegram: `${base}/webhooks/telegram/${tenantId}`, razorpay: `${base}/webhooks/razorpay/${tenantId}` },
      kinds: await c.channelCredentials.summary(),
    });
  });
  r.put('/:kind', async (req, res) => {
    const { kind } = parse(kindSchema, req.params);
    await c.channelCredentials.set(kind, parse(CREDENTIAL_SCHEMAS[kind], req.body)); // validated here: a bad body is a 400, never a 500
    res.json({ kind, configured: true });
  });
  r.delete('/:kind', async (req, res) => {
    const { kind } = parse(kindSchema, req.params);
    await c.channelCredentials.remove(kind);
    res.status(204).end();
  });
  return r;
}
