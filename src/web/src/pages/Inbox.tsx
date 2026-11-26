import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { subscribeEvents } from '../api/events';
import { useAction, useApi } from '../hooks';
import { dateTime } from '../format';
import { Badge, Card, Empty, ErrorBanner, Page } from '../components/ui';
import type { ChannelMessage, ChannelName } from '../api/types';

/** Outbound delivery state: ⏳ sending · ✓ sent · ✓✓ delivered · ✓✓ read · failed (with reason and Retry). */
function DeliveryStatus({ m, onRetry, busy }: { m: ChannelMessage; onRetry: (id: string) => void; busy: boolean }) {
  const label = `Message ${m.text.slice(0, 40)} status`;
  switch (m.status) {
    case 'queued': return <span aria-label={label}>⏳ Sending…</span>;
    case 'sent': case 'ok': return <span aria-label={label}>✓ Sent</span>;
    case 'delivered': return <span aria-label={label}>✓✓ Delivered</span>;
    case 'read': return <span aria-label={label}><Badge tone="info">✓✓ Read</Badge></span>;
    case 'skipped': return <span aria-label={label}><Badge tone="warn">Not sent — channel not configured</Badge></span>;
    default: return (
      <span aria-label={label}>
        <Badge tone="bad">Failed</Badge> {m.errorMessage ?? m.errorCode ?? 'unknown error'}{' '}
        <button type="button" className="small" disabled={busy} onClick={() => onRetry(m.id)}>Retry</button>
      </span>
    );
  }
}

interface Conversation { key: string; channel: ChannelName; user: string; messages: ChannelMessage[]; last: ChannelMessage }

export function Inbox() {
  const messages = useApi<ChannelMessage[]>('/messages?limit=500');
  const [selected, setSelected] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const action = useAction();
  const { reload } = messages;

  useEffect(() => subscribeEvents((e) => { if (e.type === 'message.received' || e.type === 'message.status') reload(); }), [reload]);

  const conversations = useMemo(() => {
    const map = new Map<string, Conversation>();
    for (const m of [...(messages.data ?? [])].reverse()) { // oldest → newest
      const key = `${m.channel}:${m.externalUser}`;
      const c = map.get(key) ?? { key, channel: m.channel, user: m.externalUser, messages: [], last: m };
      c.messages.push(m);
      c.last = m;
      map.set(key, c);
    }
    return [...map.values()].sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt));
  }, [messages.data]);

  const active = conversations.find((c) => c.key === selected);

  const retry = async (id: string) => { if (await action.run(() => api(`/messages/${id}/retry`, { method: 'POST' }))) reload(); };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!active || !reply.trim()) return;
    const ok = await action.run(() => api('/messages/send', { body: { channel: active.channel, to: active.user, text: reply.trim() } }));
    if (ok) { setReply(''); reload(); }
  };

  return (
    <Page title="Inbox">
      <ErrorBanner error={messages.error ?? action.error} />
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(220px, 320px) 1fr' }}>
        <Card title="Conversations">
          {conversations.length ? (
            <div className="grid" style={{ gap: 6 }}>
              {conversations.map((c) => (
                <button key={c.key} className={c.key === selected ? 'primary' : ''} style={{ textAlign: 'left', whiteSpace: 'normal' }} onClick={() => setSelected(c.key)}>
                  <strong>{c.channel} · {c.user}</strong>
                  <div className="small" style={{ opacity: 0.8 }}>{c.last.text.slice(0, 60)}</div>
                </button>
              ))}
            </div>
          ) : <Empty>{messages.loading ? 'Loading…' : 'No messages yet. Chats from WhatsApp, Messenger, Instagram and Telegram appear here.'}</Empty>}
        </Card>
        <Card title={active ? `${active.channel} · ${active.user}` : 'Messages'}>
          {active ? (
            <>
              <div className="chat">
                {active.messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.direction}`}>
                    {m.text}
                    <small>{dateTime(m.createdAt)} {m.direction === 'out' && <DeliveryStatus m={m} onRetry={retry} busy={action.busy} />}</small>
                  </div>
                ))}
              </div>
              <form className="row" onSubmit={send} style={{ marginTop: 12 }}>
                <input aria-label="Reply" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Type a reply…" style={{ flex: 1 }} />
                <button className="primary" type="submit" disabled={action.busy || !reply.trim()}>Send</button>
              </form>
            </>
          ) : <Empty>Select a conversation.</Empty>}
        </Card>
      </div>
    </Page>
  );
}
