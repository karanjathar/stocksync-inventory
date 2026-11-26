import pino, { type DestinationStream, type Logger } from 'pino';
import { currentTenantId } from './db/tenant.js';

/** Every line logged while a business's request, job or event is being handled carries its `tenantId` automatically (and none when there is no business). */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, mixin: () => { const tenantId = currentTenantId(); return tenantId ? { tenantId } : {}; } }, destination);
}

/** Application Insights telemetry processor: tags every request, dependency and exception with the business it was for. */
export function tenantTelemetry(envelope: { data?: { baseData?: object } }): boolean {
  const tenantId = currentTenantId();
  const base = envelope.data?.baseData as { properties?: Record<string, unknown> } | undefined;
  if (tenantId && base) base.properties = { ...base.properties, tenantId };
  return true;
}
