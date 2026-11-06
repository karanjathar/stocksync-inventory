// Single source of truth: the API's domain contracts (docs/3_SCHEMAS.md). Type-only, erased at build.
export type * from '../../../api/src/domain/types.js';
import type { OrderStatus, PaymentMethod, PaymentStatus } from '../../../api/src/domain/types.js';

export interface PublicProduct {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  unit: string;
  imageUrl: string | null;
  attributes: Record<string, string>;
  categoryId: string | null;
  inStock: boolean;
  available: number;
}

/** Server-priced cart (tax and discounts included): what the customer will actually pay. */
export interface CartQuote { subtotalCents: number; taxCents: number; discountCents: number; totalCents: number; inclusive: boolean }
export interface PublicCatalog {
  settings: { businessName: string; currency: string; whatsappNumber: string; paymentMethods: PaymentMethod[] };
  products: PublicProduct[];
}

export interface PublicOrderStatus {
  number: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  totalCents: number;
  currency: string;
  items: { name: string; quantity: number }[];
  paymentUrl?: string;
}

export interface PaymentsConfig { razorpayConfigured: boolean; onlineAvailable: boolean; codEnabled: boolean; reason?: string }

export interface PlacedOrder { number: number; status: OrderStatus; totalCents: number; paymentMethod: PaymentMethod; token: string; paymentUrl?: string }

export interface ChannelStatus { name: 'whatsapp' | 'messenger' | 'instagram' | 'telegram'; configured: boolean }
