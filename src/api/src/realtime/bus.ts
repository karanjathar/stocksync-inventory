import { currentTenantId } from '../db/tenant.js';
import type { RealtimeEvent } from '../domain/types.js';

export type Listener = (e: RealtimeEvent) => void;
interface Subscription { fn: Listener; tenantId?: string }

/**
 * In-process pub/sub for dashboard events, scoped by business (D-022 moves this onto Postgres LISTEN/NOTIFY for several replicas).
 * An event belongs to the business whose context published it, or to `fallbackTenantId` when it carries none (single-business mode).
 * A subscriber with a tenant id hears only that business; one without hears everything (internal use). With no context and no fallback
 * an event reaches no tenant subscriber.
 */
export class EventBus {
  private readonly subs = new Set<Subscription>();

  constructor(private readonly fallbackTenantId?: string) {}

  subscribe(fn: Listener, tenantId?: string): () => void {
    const sub: Subscription = { fn, ...(tenantId ? { tenantId } : {}) };
    this.subs.add(sub);
    return () => { this.subs.delete(sub); };
  }

  publish(e: RealtimeEvent): void {
    const tenant = currentTenantId() ?? this.fallbackTenantId;
    for (const s of this.subs) {
      if (s.tenantId !== undefined && s.tenantId !== tenant) continue;
      try { s.fn(e); } catch { /* a broken subscriber must not affect others */ }
    }
  }

  get size(): number {
    return this.subs.size;
  }
}
