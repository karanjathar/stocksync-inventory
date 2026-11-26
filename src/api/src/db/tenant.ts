import { AsyncLocalStorage } from 'node:async_hooks';

interface TenantStore { tenantId: string }
const storage = new AsyncLocalStorage<TenantStore>();

/** Runs `fn` (and everything it awaits) as one tenant. Database access inside it sees only that tenant's rows (D-019). */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

/** The tenant of the current request, job or webhook; undefined outside any tenant context. */
export function currentTenantId(): string | undefined {
  return storage.getStore()?.tenantId;
}
