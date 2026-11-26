export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) { super(400, 'VALIDATION_ERROR', message, details); }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') { super(401, 'UNAUTHORIZED', message); }
}
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') { super(403, 'FORBIDDEN', message); }
}
export class NotFoundError extends AppError {
  constructor(entity = 'Resource') { super(404, 'NOT_FOUND', `${entity} not found`); }
}
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) { super(409, 'CONFLICT', message, details); }
}
export class NotConfiguredError extends AppError {
  constructor(feature: string) { super(501, 'NOT_CONFIGURED', `${feature} is not configured`); }
}

export class InsufficientStockError extends AppError {
  constructor(details: { sku?: string; available: number; requested: number }) {
    super(409, 'INSUFFICIENT_STOCK', `Insufficient stock${details.sku ? ` for ${details.sku}` : ''}: ${details.available} available, ${details.requested} requested`, details);
  }
}

/** The business's plan does not allow more of something. Nothing is deleted; the caller gets the numbers to show an upgrade prompt. */
export class PlanLimitError extends AppError {
  constructor(details: { metric: string; limit: number; used: number; plan: string }) {
    super(402, 'PLAN_LIMIT', `Your ${details.plan} plan allows ${details.limit} ${details.metric.replace('_', ' ')}. Upgrade to add more.`, details);
  }
}
