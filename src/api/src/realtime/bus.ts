import { currentTenantId } from '../db/tenant.js';
import type { RealtimeEvent } from '../domain/types.js';

export type Listener = (e: RealtimeEvent) => void;
interface Subscription { fn: Listener; tenantId?: string }

/**
 * In-process pub/sub for dashboard events, scoped by business. With a transport (PgBus, D-022) events also reach the other replicas.
 * An event belongs to the business whose context published it, or to `fallbackTenantId` when it carries none (single-business mode).
 * A subscriber with a tenant id hears only that business; one without hears everything (internal use). With no context and no fallback
 * an event reaches no tenant subscriber.
 */
export class EventBus {
  private readonly subs = new Set<Subscription>();
  private transport?: (tenantId: string, e: RealtimeEvent) => void;

  constructor(private readonly fallbackTenantId?: string) {}

  subscribe(fn: Listener, tenantId?: string): () => void {
    const sub: Subscription = { fn, ...(tenantId ? { tenantId } : {}) };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  /** Forwards every published event of a known business to other replicas (PgBus). Local delivery stays immediate and does not depend on it. */
  setTransport(send: (tenantId: string, e: RealtimeEvent) => void): void { this.transport = send; }

  publish(e: RealtimeEvent): void {
    const tenant = currentTenantId() ?? this.fallbackTenantId;
    this.deliver(tenant, e);
    if (tenant !== undefined) { try { this.transport?.(tenant, e); } catch { /* the network must never break a request */ } }
  }

  /** An event that happened on another replica: delivered to this replica's subscribers of that business only, and never sent on again. */
  deliverRemote(tenantId: string, e: RealtimeEvent): void { this.deliver(tenantId, e); }

  private deliver(tenant: string | undefined, e: RealtimeEvent): void {
    for (const s of this.subs) {
      if (s.tenantId !== undefined && s.tenantId !== tenant) continue;
      try { s.fn(e); } catch { /* a broken subscriber must not affect others */ }
    }
  }

  get size(): number {
    return this.subs.size;
  }
}
