import type pg from 'pg';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { Invoice, Order } from '../domain/types.js';
import { formatMoney } from './money.js';
import type { OrdersService } from './orders.js';
import type { SettingsService } from './settings.js';

/** Escapes text for HTML element content and quoted attributes. Every user-controlled value goes through this. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

const pct = (bp: number): string => `${bp % 100 === 0 ? bp / 100 : (bp / 100).toFixed(2)}%`;
const day = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

// Print styling only: no scripts and no external resources, so a document works offline and cannot call out.
const CSS = `
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; padding: 24px; position: relative; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 18px 0 6px; }
  .row { display: flex; justify-content: space-between; gap: 24px; } .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border-bottom: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 280px; margin-top: 12px; } .totals td { border: 0; padding: 3px 8px; }
  .totals tr.grand td { border-top: 2px solid #111; font-weight: 700; font-size: 15px; }
  .void { position: absolute; top: 38%; left: 12%; font-size: 120px; font-weight: 800; color: rgba(200,0,0,.18); transform: rotate(-20deg); pointer-events: none; }
  .group { break-inside: avoid; margin-bottom: 14px; } .bin { background: #fafafa; font-weight: 600; }
  @media print { body { padding: 0; } }`;

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

export function renderInvoice(inv: Invoice): string {
  const m = (c: number) => esc(formatMoney(c, inv.currency));
  const rows = inv.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="num">${l.quantity}</td><td class="num">${m(l.unitPriceCents)}</td>
    <td class="num">${l.discountCents ? m(l.discountCents) : '–'}</td><td class="num">${pct(l.taxRateBp)}</td><td class="num">${m(l.taxCents)}</td><td class="num">${m(l.totalCents)}</td></tr>`).join('');
  return page(`Invoice ${inv.number}`, `
    ${inv.status === 'VOID' ? '<div class="void">VOID</div>' : ''}
    <div class="row"><div><h1>${esc(inv.seller.businessName)}</h1>
      <div class="muted">${esc(inv.seller.address).replace(/\n/g, '<br>')}</div>
      ${inv.seller.taxId ? `<div>Tax ID: ${esc(inv.seller.taxId)}</div>` : ''}
      ${inv.seller.whatsappNumber ? `<div>WhatsApp: ${esc(inv.seller.whatsappNumber)}</div>` : ''}</div>
      <div style="text-align:right"><h1>${inv.seller.taxId ? 'TAX INVOICE' : 'INVOICE'}</h1><div><strong>${esc(inv.number)}</strong></div>
      <div>Date: ${day(inv.issuedAt)}</div><div class="muted">Order #${inv.orderNumber}</div></div></div>
    <h2>Bill to</h2><div>${esc(inv.customer.name)}</div>
    ${inv.customer.phone ? `<div class="muted">${esc(inv.customer.phone)}</div>` : ''}${inv.customer.email ? `<div class="muted">${esc(inv.customer.email)}</div>` : ''}
    <table><thead><tr><th>SKU</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Discount</th><th class="num">Tax %</th><th class="num">Tax</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="totals"><tbody>
      <tr><td>Subtotal</td><td class="num">${m(inv.subtotalCents)}</td></tr>
      ${inv.discountCents ? `<tr><td>Discount</td><td class="num">−${m(inv.discountCents)}</td></tr>` : ''}
      <tr><td>Tax</td><td class="num">${m(inv.taxCents)}</td></tr>
      <tr class="grand"><td>Total</td><td class="num">${m(inv.totalCents)}</td></tr></tbody></table>
    ${inv.inclusive ? '<p class="muted">Prices include tax.</p>' : ''}
    ${inv.status === 'VOID' ? `<p><strong>This invoice was voided${inv.voidedAt ? ` on ${day(inv.voidedAt)}` : ''}.</strong></p>` : ''}
    <p class="muted">Thank you for your business.</p>`);
}

export function renderPackingSlip(order: Order, warehouseCode: string | null, businessName: string): string {
  const rows = order.items.map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="num">${i.quantity}</td><td>☐</td></tr>`).join('');
  return page(`Packing slip #${order.number}`, `
    <div class="row"><div><h1>Packing slip</h1><div class="muted">${esc(businessName)}</div></div>
      <div style="text-align:right"><h1>#${order.number}</h1><div>${day(order.createdAt)}</div>${warehouseCode ? `<div class="muted">Warehouse ${esc(warehouseCode)}</div>` : ''}</div></div>
    <h2>Ship to</h2><div>${esc(order.customerName)}</div>
    ${order.notes ? `<h2>Notes</h2><div>${esc(order.notes)}</div>` : ''}
    <table><thead><tr><th>SKU</th><th>Item</th><th class="num">Qty</th><th>Packed</th></tr></thead><tbody>${rows}</tbody></table>`);
}

interface PickLine { sku: string; name: string; quantity: number; orders: { number: number; customer: string; quantity: number }[] }

/** Builds the HTML documents that need data from several tables. */
export class DocumentsService {
  constructor(private readonly pool: pg.Pool, private readonly orders: OrdersService, private readonly settings: SettingsService) {}

  async packingSlip(orderId: string): Promise<string> {
    const order = await this.orders.get(orderId);
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED') throw new ConflictError('A cancelled order has nothing to pack');
    const s = await this.settings.get();
    const wh = order.warehouseId ?? s.defaultWarehouseId;
    const code = wh ? (await this.pool.query<{ code: string }>('SELECT code FROM warehouses WHERE id = $1', [wh])).rows[0]?.code ?? null : null;
    return renderPackingSlip(order, code, s.businessName);
  }

  /** One pick list for several open orders: warehouse, then bin, then product with the total to pick and who needs what. */
  async picklist(orderIds: string[]): Promise<string> {
    const s = await this.settings.get();
    const orders: Order[] = [];
    for (const id of orderIds) {
      const o = await this.orders.get(id);
      if (!o) throw new NotFoundError('Order');
      orders.push(o);
    }
    const closed = orders.filter((o) => o.status !== 'PENDING' && o.status !== 'CONFIRMED');
    if (closed.length) throw new ConflictError(`Only open orders can be picked (not: ${closed.map((o) => `#${o.number} ${o.status}`).join(', ')})`);

    const whOf = (o: Order) => o.warehouseId ?? s.defaultWarehouseId;
    const whIds = [...new Set(orders.map(whOf).filter((x): x is string => Boolean(x)))];
    const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId)))];
    const { rows: whs } = await this.pool.query<{ id: string; code: string }>('SELECT id, code FROM warehouses WHERE id = ANY($1::uuid[])', [whIds]);
    const { rows: bins } = await this.pool.query<{ productId: string; warehouseId: string; bin: string | null }>(
      'SELECT product_id AS "productId", warehouse_id AS "warehouseId", bin FROM stock_levels WHERE product_id = ANY($1::uuid[]) AND warehouse_id = ANY($2::uuid[])', [productIds, whIds]);
    const code = new Map(whs.map((w) => [w.id, w.code]));
    const binOf = new Map(bins.map((b) => [`${b.productId}|${b.warehouseId}`, b.bin]));

    const groups = new Map<string, Map<string, Map<string, PickLine>>>();
    for (const o of orders) {
      const wh = whOf(o);
      const whLabel = wh ? code.get(wh) ?? 'Unknown warehouse' : 'No warehouse';
      for (const i of o.items) {
        const bin = (wh && binOf.get(`${i.productId}|${wh}`)) || 'Unassigned bin';
        const byBin = groups.get(whLabel) ?? new Map<string, Map<string, PickLine>>();
        const byProduct = byBin.get(bin) ?? new Map<string, PickLine>();
        const line = byProduct.get(i.productId) ?? { sku: i.sku, name: i.name, quantity: 0, orders: [] };
        line.quantity += i.quantity;
        line.orders.push({ number: o.number, customer: o.customerName, quantity: i.quantity });
        byProduct.set(i.productId, line);
        byBin.set(bin, byProduct);
        groups.set(whLabel, byBin);
      }
    }
    const binOrder = (a: string, b: string) => (a === 'Unassigned bin' ? 1 : b === 'Unassigned bin' ? -1 : a.localeCompare(b, 'en', { numeric: true }));
    const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([wh, byBin]) => `
      <div class="group"><h2>Warehouse ${esc(wh)}</h2><table><thead><tr><th>Bin</th><th>SKU</th><th>Item</th><th class="num">Pick</th><th>For orders</th></tr></thead><tbody>
      ${[...byBin.entries()].sort(([a], [b]) => binOrder(a, b)).map(([bin, products]) =>
        [...products.values()].sort((a, b) => a.sku.localeCompare(b.sku)).map((p, idx) => `<tr${idx === 0 ? ' class="bin"' : ''}><td>${idx === 0 ? esc(bin) : ''}</td><td>${esc(p.sku)}</td><td>${esc(p.name)}</td>
          <td class="num">${p.quantity}</td><td>${p.orders.map((x) => `#${x.number} ${esc(x.customer)} ×${x.quantity}`).join('<br>')}</td></tr>`).join('')).join('')}
      </tbody></table></div>`).join('');
    if (!sections) throw new ValidationError('Nothing to pick');
    return page('Pick list', `<div class="row"><div><h1>Pick list</h1><div class="muted">${esc(s.businessName)}</div></div><div style="text-align:right">${orders.length} order${orders.length === 1 ? '' : 's'}<br>${new Date().toISOString().slice(0, 10)}</div></div>${sections}`);
  }
}
