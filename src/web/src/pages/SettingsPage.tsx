import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAction, useApi } from '../hooks';
import { useSettings } from '../settings';
import { Badge, Card, ErrorBanner, Field, Page } from '../components/ui';
import type { AlertRecipient, ChannelName, ChannelStatus, CustomFieldDef, PaymentsConfig, Settings, Warehouse } from '../api/types';

const CHANNELS: ChannelName[] = ['whatsapp', 'messenger', 'instagram', 'telegram'];
interface FieldDraft { key: string; label: string; type: CustomFieldDef['type']; options: string }

export function SettingsPage() {
  const loaded = useApi<Settings>('/settings');
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const channels = useApi<ChannelStatus[]>('/channels');
  const payConfig = useApi<PaymentsConfig>('/payments/config');
  const { reload: reloadGlobal } = useSettings();
  const [form, setForm] = useState<Settings | null>(null);
  const [fields, setFields] = useState<FieldDraft[]>([]);
  const [saved, setSaved] = useState(false);
  const { busy, error, run, setError } = useAction();

  useEffect(() => {
    if (!loaded.data) return;
    setForm(loaded.data);
    setFields(loaded.data.customFields.map((f) => ({ ...f, options: (f.options ?? []).join(', ') })));
  }, [loaded.data]);

  if (!form) return <Page title="Settings"><ErrorBanner error={loaded.error} /><p className="muted">Loading…</p></Page>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  const setRecipient = (i: number, patch: Partial<AlertRecipient>) =>
    set('alertRecipients', form.alertRecipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setField = (i: number, patch: Partial<FieldDraft>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  // Would customers still be able to pay with what is currently in the form? (Online needs the server keys, the switch, and INR.)
  const onlineUsable = form.payments.onlineEnabled && payConfig.data?.razorpayConfigured === true && form.currency === 'INR';
  const noPaymentMethod = payConfig.data !== undefined && !onlineUsable && !form.payments.codEnabled;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (!Number.isInteger(form.payments.linkExpiryMinutes) || form.payments.linkExpiryMinutes < 15) {
      setError('Payment link validity must be at least 15 minutes (a Razorpay requirement).');
      return;
    }
    const customFields: CustomFieldDef[] = fields.filter((f) => f.key.trim()).map((f) => ({
      key: f.key.trim(), label: f.label.trim() || f.key.trim(), type: f.type,
      ...(f.type === 'select' ? { options: f.options.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
    }));
    const body = { ...form, alertRecipients: form.alertRecipients.filter((r) => r.to.trim()), customFields };
    const ok = await run(() => api<Settings>('/settings', { method: 'PUT', body }));
    if (ok) { setSaved(true); reloadGlobal(); }
  };

  return (
    <Page title="Settings">
      <form className="grid" onSubmit={submit} aria-label="Settings">
        <ErrorBanner error={error} />
        {saved && <div className="banner ok">Settings saved — changes are live immediately.</div>}
        <Card title="Business">
          <div className="form-grid">
            <Field label="Business name"><input required value={form.businessName} onChange={(e) => set('businessName', e.target.value)} /></Field>
            <Field label="Currency" hint="ISO code, e.g. USD, EUR, INR"><input required maxLength={3} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></Field>
            <Field label="Public WhatsApp number" hint="Shown on the shop as “Order on WhatsApp” (international format, digits only)">
              <input inputMode="tel" value={form.whatsappNumber} onChange={(e) => set('whatsappNumber', e.target.value)} placeholder="15551234567" />
            </Field>
            <Field label="Default warehouse" hint="Used when confirming chat & web orders">
              <select value={form.defaultWarehouseId ?? ''} onChange={(e) => set('defaultWarehouseId', e.target.value || null)}>
                <option value="">— none —</option>
                {warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
              </select>
            </Field>
          </div>
        </Card>

        <Card title="Messaging channels">
          <div className="row">
            {channels.data?.map((c) => <Badge key={c.name} tone={c.configured ? 'good' : 'neutral'}>{c.name}</Badge>)}
          </div>
          <p className="small muted">Green channels have credentials configured on the server (see DEPLOYMENT_GUIDE.md). Webhook URLs: <code>/webhooks/meta</code> (WhatsApp, Messenger, Instagram) and <code>/webhooks/telegram</code>.</p>
        </Card>

        <Card title="Payments (Razorpay)">
          {payConfig.data && (payConfig.data.onlineAvailable
            ? <div className="banner ok">✅ Online payments are available.</div>
            : <div className="banner error">⚠️ {payConfig.data.reason ?? 'Online payments are unavailable.'}</div>)}
          {noPaymentMethod && (
            <div className="banner error">⚠️ No payment method would be available. Customers won't be able to place orders on the shop or in chat. Turn on cash on delivery, or fix online payments above.</div>
          )}
          <div className="grid" style={{ gap: 8 }}>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={form.payments.onlineEnabled}
              onChange={(e) => set('payments', { ...form.payments, onlineEnabled: e.target.checked })} /> Accept online payments (Razorpay)</label>
            <label className="row small"><input type="checkbox" style={{ width: 'auto' }} checked={form.payments.codEnabled}
              onChange={(e) => set('payments', { ...form.payments, codEnabled: e.target.checked })} /> Accept cash on delivery</label>
            <Field label="Payment link validity (minutes)" hint="At least 15. Customers can still ask for a fresh link after it expires.">
              <input type="number" inputMode="numeric" value={form.payments.linkExpiryMinutes}
                onChange={(e) => set('payments', { ...form.payments, linkExpiryMinutes: Number(e.target.value) })} />
            </Field>
          </div>
          <p className="small muted">In the Razorpay dashboard (Settings → Webhooks) add this URL and enable the events below, using the same secret as <code>RAZORPAY_WEBHOOK_SECRET</code>:</p>
          <code className="code-line">{`${window.location.origin}/webhooks/razorpay`}</code>
          <p className="small muted">Events: <code>payment_link.paid</code>, <code>payment_link.expired</code>, <code>payment_link.cancelled</code></p>
        </Card>

        <Card title="Low-stock alert recipients">
          {form.alertRecipients.map((r, i) => (
            <div className="form-grid" key={i} style={{ marginBottom: 8 }}>
              <Field label="Channel">
                <select aria-label={`Recipient ${i + 1} channel`} value={r.channel} onChange={(e) => setRecipient(i, { channel: e.target.value as ChannelName })}>
                  {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Send to" hint="WhatsApp number, Telegram chat id, or Messenger/Instagram user id">
                <input aria-label={`Recipient ${i + 1} address`} value={r.to} onChange={(e) => setRecipient(i, { to: e.target.value })} />
              </Field>
              <div><button type="button" className="small danger" onClick={() => set('alertRecipients', form.alertRecipients.filter((_, j) => j !== i))}>Remove</button></div>
            </div>
          ))}
          <button type="button" className="small" onClick={() => set('alertRecipients', [...form.alertRecipients, { channel: 'whatsapp', to: '' }])}>+ Add recipient</button>
        </Card>

        <Card title="Custom product fields">
          <p className="small muted">These appear on every product form and in product lists, so you can track sizes, colours, batch numbers, expiry dates and more without code changes.</p>
          {fields.map((f, i) => (
            <div className="form-grid" key={i} style={{ marginBottom: 8 }}>
              <Field label="Key"><input aria-label={`Field ${i + 1} key`} value={f.key} pattern="[a-z][a-z0-9_]*" onChange={(e) => setField(i, { key: e.target.value })} placeholder="color" /></Field>
              <Field label="Label"><input aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder="Colour" /></Field>
              <Field label="Type">
                <select aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldDraft['type'] })}>
                  <option value="text">text</option><option value="number">number</option><option value="select">select</option>
                </select>
              </Field>
              {f.type === 'select' && (
                <Field label="Options"><input aria-label={`Field ${i + 1} options`} value={f.options} onChange={(e) => setField(i, { options: e.target.value })} placeholder="red, blue, green" /></Field>
              )}
              <div><button type="button" className="small danger" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}>Remove</button></div>
            </div>
          ))}
          <button type="button" className="small" onClick={() => setFields((fs) => [...fs, { key: '', label: '', type: 'text', options: '' }])}>+ Add field</button>
        </Card>
        <div><button className="primary" type="submit" disabled={busy}>Save settings</button></div>
      </form>
    </Page>
  );
}
