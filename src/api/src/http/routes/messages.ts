import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ChannelError } from '../../channels/types.js';
import { AppError, ConflictError, NotFoundError } from '../../domain/errors.js';
import { idParam } from '../params.js';
import { requireRole } from '../middleware/auth.js';
import { parse } from '../validate.js';

const channel = z.enum(['whatsapp', 'messenger', 'instagram', 'telegram']);
const listSchema = z.object({ channel: channel.optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const sendSchema = z.object({ channel, to: z.string().trim().min(1).max(100), text: z.string().trim().min(1).max(4000) });

export function messageRoutes(c: Container): Router {
  const r = Router();
  // Customer chat content is personal data: staff and admins only.
  r.get('/', requireRole('staff'), async (req, res) => { res.json(await c.messages.list(parse(listSchema, req.query))); });
  r.post('/send', requireRole('staff'), async (req, res) => {
    const m = parse(sendSchema, req.body);
    try {
      await c.messenger.send(m.channel, m.to, m.text);
    } catch (err) {
      if (err instanceof ChannelError) throw new AppError(502, 'CHANNEL_ERROR', err.message);
      throw err;
    }
    res.status(202).json({ status: 'accepted' });
  });
  r.post('/:id/retry', requireRole('staff'), async (req, res) => {
    const outcome = await c.messages.requeueFailed(idParam(req));
    if (outcome === 'missing') throw new NotFoundError('Message');
    if (outcome === 'conflict') throw new ConflictError('Only failed outbound messages can be retried');
    res.status(202).json({ status: 'queued' });
  });
  return r;
}

export function channelRoutes(c: Container): Router {
  const r = Router();
  r.get('/', (_req, res) => { res.json(c.hub.status()); });
  return r;
}
