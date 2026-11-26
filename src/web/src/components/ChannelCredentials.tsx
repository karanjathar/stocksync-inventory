import { useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { Badge, Card, ErrorBanner, Field } from './ui';

interface KindStatus { kind: string; configured: boolean; hint: string | null; source: 'saved' | 'server' | null }
interface Config { tenantId: string; enabled: boolean; urls: { meta: string; telegram: string; razorpay: string }; kinds: KindStatus[] }

/** Fields per kind. Every value is write-only: it is sent once, encrypted by the server, and never shown again (only the last four characters of one field). */
const KINDS: { kind: string; title: string; help: string; fields: { key: string; label: string; secret: boolean; placeholder?: string }[]; url?: 'meta' | 'telegram' | 'razorpay' }[] = [
  { kind: 'meta', title: 'Meta app (webhook security)', url: 'meta', help: 'From your Meta app: App secret (Settings → Basic) and a verify token you make up. Used for WhatsApp, Messenger and Instagram webhooks.',
    fields: [{ key: 'appSecret', label: 'App secret', secret: true }, { key: 'verifyToken', label: 'Verify token', secret: true }] },
  { kind: 'whatsapp', title: 'WhatsApp', help: 'WhatsApp → API Setup: the phone number ID and an access token.',
    fields: [{ key: 'phoneNumberId', label: 'Phone number ID', secret: false, placeholder: '1234567890' }, { key: 'token', label: 'Access token', secret: true }] },
  { kind: 'messenger', title: 'Messenger', help: 'The Facebook Page access token.', fields: [{ key: 'pageToken', label: 'Page access token', secret: true }] },
  { kind: 'instagram', title: 'Instagram', help: 'The Instagram page access token.', fields: [{ key: 'pageToken', label: 'Access token', secret: true }] },
  { kind: 'telegram', title: 'Telegram', url: 'telegram', help: 'The bot token from @BotFather and a webhook secret you make up (letters, digits, - and _).',
    fields: [{ key: 'botToken', label: 'Bot token', secret: true }, { key: 'webhookSecret', label: 'Webhook secret', secret: true }] },
  { kind: 'razorpay', title: 'Razorpay', url: 'razorpay', help: 'Razorpay → API keys: key id and secret, plus the webhook secret you set on the webhook.',
    fields: [{ key: 'keyId', label: 'Key ID', secret: false, placeholder: 'rzp_test_…' }, { key: 'keySecret', label: 'Key secret', secret: true }, { key: 'webhookSecret', label: 'Webhook secret', secret: true }] },
];

function KindForm({ spec, status, url, onChanged }: { spec: (typeof KINDS)[number]; status: KindStatus | undefined; url?: string; onChanged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const complete = spec.fields.every((f) => (values[f.key] ?? '').trim() !== '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await run(() => api(`/channel-config/${spec.kind}`, { method: 'PUT', body: Object.fromEntries(spec.fields.map((f) => [f.key, (values[f.key] ?? '').trim()])) }));
    if (ok) { setValues({}); setSaved(true); onChanged(); } // the secrets leave the page the moment they are saved
  };
  const remove = async () => {
    if (!window.confirm(`Remove the saved ${spec.title} credentials? ${spec.title} will stop working until you save them again.`)) return;
    if (await run(() => api(`/channel-config/${spec.kind}`, { method: 'DELETE' }).then(() => true))) { setSaved(false); onChanged(); }
  };

  return (
    <form onSubmit={save} aria-label={`${spec.title} credentials`} style={{ marginBottom: 18 }}>
      <div className="row">
        <strong>{spec.title}</strong>
        {status?.configured
          ? <Badge tone="good">{status.source === 'server' ? 'Set on the server' : `Saved${status.hint ? ` ••••${status.hint}` : ''}`}</Badge>
          : <Badge tone="neutral">Not set</Badge>}
      </div>
      <p className="small muted">{spec.help}</p>
      {url && <p className="small">Webhook URL: <code className="code-line">{url}</code></p>}
      <ErrorBanner error={error} />
      {saved && <div className="banner ok" role="status">Saved. For safety the values are no longer shown.</div>}
      <div className="form-grid">
        {spec.fields.map((f) => (
          <Field key={f.key} label={f.label}>
            <input aria-label={`${spec.title} ${f.label}`} type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder ?? (status?.configured ? 'Enter a new value to replace' : '')}
              value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
          </Field>
        ))}
      </div>
      <div className="row">
        <button className="primary small" type="submit" disabled={busy || !complete}>{status?.configured ? 'Replace' : 'Save'}</button>
        {status?.source === 'saved' && <button className="small danger" type="button" disabled={busy} onClick={() => void remove()}>Remove</button>}
      </div>
    </form>
  );
}

/** Admin-only card in Settings: each business keeps its own channel and payment credentials (encrypted on the server, write-only here). */
export function ChannelCredentials() {
  const cfg = useApi<Config>('/channel-config');
  if (cfg.error) return <Card title="Channel credentials"><p className="small muted">Could not load channel credentials: {cfg.error}</p></Card>;
  if (!cfg.data) return null;
  const { data } = cfg;
  return (
    <Card title="Channel credentials">
      <p className="small muted">Connect your own WhatsApp, Telegram, Messenger, Instagram and Razorpay accounts. Credentials are encrypted and can never be read back, only replaced or removed.</p>
      {!data.enabled && <div className="banner error" role="alert">Saving credentials is not set up on this server yet (the operator must configure ENCRYPTION_KEY).</div>}
      {KINDS.map((spec) => (
        <KindForm key={spec.kind} spec={spec} status={data.kinds.find((k) => k.kind === spec.kind)} url={spec.url ? data.urls[spec.url] : undefined} onChanged={cfg.reload} />
      ))}
    </Card>
  );
}
