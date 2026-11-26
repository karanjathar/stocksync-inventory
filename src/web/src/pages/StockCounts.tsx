import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { dateTime } from '../format';
import { Badge, Card, Empty, ErrorBanner, Field, Page } from '../components/ui';
import { Scanner } from '../components/Scanner';
import { offlineQueue } from '../offlineQueue';
import type { Product, StockCount, Warehouse } from '../api/types';

type Summary = Omit<StockCount, 'lines'>;
interface Line { productId: string; sku: string; name: string; counted: number; system: number | null }
const TONE = { OPEN: 'warn', SUBMITTED: 'good', CANCELLED: 'bad' } as const;

const toLines = (c: StockCount): Line[] => c.lines.map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, counted: l.countedQuantity, system: l.systemQuantity }));

export function StockCounts() {
  const { can } = useAuth();
  const canWrite = can('staff');
  const counts = useApi<Summary[]>('/stock-counts');
  const warehouses = useApi<Warehouse[]>('/warehouses');
  const products = useApi<Pick<Product, 'id' | 'sku' | 'name' | 'barcode'>[]>('/products');
  const [warehouseId, setWarehouseId] = useState('');
  const [active, setActive] = useState<StockCount | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [dirty, setDirty] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [attachTo, setAttachTo] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const action = useAction();
  const countsRef = useRef<Summary[]>([]);
  countsRef.current = counts.data ?? [];
  const [waiting, setWaiting] = useState(0);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const refreshWaiting = () => { offlineQueue.size().then(setWaiting).catch(() => setWaiting(0)); };
  const sync = async () => {
    if (navigator.onLine === false) return;
    const res = await offlineQueue.flush(async (item) => { await api(`/stock-counts/${item.countId}/lines`, { method: 'PUT', body: { lines: item.lines } }); });
    refreshWaiting();
    if (res.conflicts.length) {
      const numbers = new Map(countsRef.current.map((c) => [c.id, c.number]));
      setSyncNote(res.conflicts.map((c) => `Count #${numbers.get(c.countId) ?? '?'} could not be synced: ${c.message}`).join(' · '));
    }
    if (res.sent.length) { counts.reload(); setSyncNote((n) => n ?? 'Offline counts synced.'); setActive((a) => { if (a && res.sent.includes(a.id)) void openCount(a.id); return a; }); }
  };
  // Flush on load and whenever the connection returns.
  useEffect(() => {
    refreshWaiting();
    void sync();
    const onOnline = () => { void sync(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const show = (c: StockCount) => { setActive(c); setLines(toLines(c)); setDirty(false); };
  useEffect(() => { setUnknown(null); setNote(null); }, [active?.id]);

  const start = async () => {
    const c = await action.run(() => api<StockCount>('/stock-counts', { body: { warehouseId } }));
    if (c) { show(c); counts.reload(); }
  };
  const openCount = async (id: string) => { const c = await action.run(() => api<StockCount>(`/stock-counts/${id}`)); if (c) show(c); };

  const addProduct = (p: { id: string; sku: string; name: string }) => {
    setLines((ls) => ls.some((l) => l.productId === p.id)
      ? ls.map((l) => (l.productId === p.id ? { ...l, counted: l.counted + 1 } : l))
      : [...ls, { productId: p.id, sku: p.sku, name: p.name, counted: 1, system: null }]);
    setDirty(true);
  };

  const onScan = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    setUnknown(null);
    const local = products.data?.find((p) => p.barcode?.toUpperCase() === code); // instant, and works without a connection
    if (local) { addProduct(local); return; }
    if (navigator.onLine === false) { setUnknown(code); return; }
    try {
      addProduct(await api<Product>(`/products/by-barcode/${encodeURIComponent(code)}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setUnknown(code); else action.setError(e instanceof Error ? e.message : 'Scan failed');
    }
  };

  const attach = async () => {
    const p = products.data?.find((x) => x.id === attachTo);
    if (!p || !unknown) return;
    const saved = await action.run(() => api<Product>(`/products/${p.id}`, { method: 'PATCH', body: { barcode: unknown } }));
    if (saved) { addProduct(p); setUnknown(null); setAttachTo(''); products.reload(); }
  };

  const save = async (): Promise<StockCount | undefined> => {
    if (!active) return undefined;
    if (!lines.length) return active;
    const body = lines.map((l) => ({ productId: l.productId, countedQuantity: l.counted }));
    const keepOnDevice = async (): Promise<undefined> => {
      await offlineQueue.add(active.id, body);
      setDirty(false); refreshWaiting();
      setNote('No connection: your counts are saved on this device and will sync automatically.');
      return undefined;
    };
    if (navigator.onLine === false) return keepOnDevice();
    // A failed request (not an error answer from the server) means the connection is gone: keep the counts on the device instead.
    const c = await action.run(async () => {
      try {
        return await api<StockCount>(`/stock-counts/${active.id}/lines`, { method: 'PUT', body: { lines: body } });
      } catch (e) {
        if (e instanceof TypeError) { await keepOnDevice(); return undefined; }
        throw e;
      }
    });
    if (c) { show(c); setNote('Counts saved.'); }
    return c;
  };

  const submit = async () => {
    if (!active) return;
    if (navigator.onLine === false) {
      if (dirty) await save(); // keep the latest numbers on the device
      action.setError('You are offline. Your counts are saved on this device; submit once you are back online.');
      return;
    }
    await sync(); // anything captured offline must reach the server before the count is submitted
    if ((await offlineQueue.size()) > 0) { action.setError('Some counts are still waiting to sync. Try again in a moment.'); return; }
    const saved = dirty ? await save() : active;
    if (!saved) return;
    const changed = saved.lines.filter((l) => l.variance !== 0).length;
    if (!window.confirm(`Submit count #${saved.number}? ${changed} product${changed === 1 ? '' : 's'} will be corrected in stock.`)) return;
    const done = await action.run(() => api<StockCount>(`/stock-counts/${saved.id}/submit`, { body: {} }));
    if (done) { show(done); setNote(`Count #${done.number} submitted: stock now matches what you counted.`); counts.reload(); }
  };

  const cancel = async () => {
    if (!active || !window.confirm(`Cancel count #${active.number}?`)) return;
    const done = await action.run(() => api<StockCount>(`/stock-counts/${active.id}/cancel`, { body: {} }));
    if (done) { show(done); counts.reload(); }
  };

  const isOpen = active?.status === 'OPEN';
  return (
    <Page title="Stock counts" actions={active && <button onClick={() => setActive(null)}>← All counts</button>}>
      <ErrorBanner error={action.error ?? counts.error} />
      {waiting > 0 && (
        <div className="banner" role="status">
          {waiting} count{waiting === 1 ? '' : 's'} waiting to sync <button className="small" onClick={() => void sync()}>Sync now</button>
        </div>
      )}
      {syncNote && <div className="banner">{syncNote}</div>}
      {note && <div className="banner ok" role="status">{note}</div>}
      {!active && (
        <>
          {canWrite && (
            <Card title="Start a count">
              <div className="row">
                <Field label="Warehouse">
                  <select aria-label="Warehouse" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                    <option value="">— choose —</option>{warehouses.data?.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                  </select>
                </Field>
                <button className="primary" disabled={!warehouseId || action.busy} onClick={start}>Start count</button>
              </div>
            </Card>
          )}
          <Card>
            {counts.data?.length ? (
              <table>
                <thead><tr><th>Count</th><th>Warehouse</th><th>Status</th><th className="num">Products</th><th>Started</th></tr></thead>
                <tbody>
                  {counts.data.map((c) => (
                    <tr key={c.id}>
                      <td><button className="small" onClick={() => void openCount(c.id)}>#{c.number}</button></td>
                      <td>{c.warehouseCode}</td><td><Badge tone={TONE[c.status]}>{c.status}</Badge></td>
                      <td className="num">{c.lineCount}</td><td className="small muted">{dateTime(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>{counts.loading ? 'Loading…' : 'No counts yet. Start one to check what is really on the shelf.'}</Empty>}
          </Card>
        </>
      )}
      {active && (
        <>
          <Card title={`Count #${active.number} · ${active.warehouseCode} · ${active.status.toLowerCase()}`}>
            {isOpen && canWrite && (
              <>
                <Scanner onScan={(code) => void onScan(code)} />
                {unknown && (
                  <div className="banner error" role="alert">
                    No product has barcode {unknown}.
                    <div className="row" style={{ marginTop: 6 }}>
                      <select aria-label="Attach to product" value={attachTo} onChange={(e) => setAttachTo(e.target.value)}>
                        <option value="">Attach to product…</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                      </select>
                      <button className="small primary" disabled={!attachTo || action.busy} onClick={attach}>Attach barcode</button>
                    </div>
                  </div>
                )}
              </>
            )}
            {lines.length ? (
              <table>
                <thead><tr><th>Product</th><th className="num">Counted</th><th className="num">In system</th><th className="num">Difference</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.productId}>
                      <td>{l.name} <span className="muted small">{l.sku}</span></td>
                      <td className="num">{isOpen && canWrite
                        ? <input type="number" min={0} aria-label={`Counted ${l.sku}`} style={{ width: 90 }} value={l.counted}
                            onChange={(e) => { setLines((ls) => ls.map((x) => (x.productId === l.productId ? { ...x, counted: Math.max(0, Math.floor(Number(e.target.value) || 0)) } : x))); setDirty(true); }} />
                        : l.counted}</td>
                      <td className="num">{l.system ?? '—'}</td>
                      <td className="num">{l.system === null ? '—' : l.counted - l.system}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>Nothing counted yet.{isOpen && canWrite ? ' Scan a product to begin.' : ''}</Empty>}
            {isOpen && canWrite && (
              <div className="row" style={{ marginTop: 8 }}>
                <button disabled={action.busy || !lines.length} onClick={() => void save()}>Save counts</button>
                <button className="primary" disabled={action.busy || !lines.length} onClick={() => void submit()}>Submit count</button>
                <button className="danger" disabled={action.busy} onClick={() => void cancel()}>Cancel count</button>
              </div>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
