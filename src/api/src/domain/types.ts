export type Role = 'admin' | 'staff' | 'viewer';
export type ChannelName = 'whatsapp' | 'messenger' | 'instagram' | 'telegram';
export type OrderChannel = ChannelName | 'web' | 'manual';
export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FULFILLED' | 'CANCELLED';
export type PaymentMethod = 'COD' | 'ONLINE';
export type PaymentStatus = 'UNPAID' | 'PAID' | 'REFUND_DUE' | 'REFUNDED';
export type MovementType = 'IN' | 'OUT' | 'ADJUST' | 'TRANSFER_IN' | 'TRANSFER_OUT';
export interface User { id: string; email: string; name: string; role: Role; createdAt: string }
export interface AuthUser { id: string; email: string; role: Role }
export interface Category { id: string; name: string }
export interface Product { id: string; sku: string; name: string; description: string; categoryId: string | null;
  unit: string; priceCents: number; reorderLevel: number; reorderQuantity: number; preferredSupplierId: string | null; imageUrl: string | null;
  attributes: Record<string, string>; isActive: boolean; totalQuantity: number; createdAt: string; updatedAt: string }
export interface Warehouse { id: string; code: string; name: string; address: string }
export interface StockLevel { productId: string; sku: string; productName: string; warehouseId: string; warehouseCode: string; quantity: number }
export interface StockMovement { id: string; productId: string; sku: string; warehouseId: string; warehouseCode: string;
  type: MovementType; quantityDelta: number; balanceAfter: number; reason: string; reference: string | null;
  userId: string | null; createdAt: string }
export interface Supplier { id: string; name: string; email: string | null; phone: string | null; notes: string }
export interface Customer { id: string; name: string; phone: string | null; email: string | null; channel: OrderChannel | string; channelUserId: string | null }
export interface OrderItem { productId: string; sku: string; name: string; quantity: number; unitPriceCents: number }
export interface Order { id: string; number: number; customerId: string; customerName: string; channel: OrderChannel;
  status: OrderStatus; warehouseId: string | null; totalCents: number; notes: string; items: OrderItem[]; createdAt: string; updatedAt: string;
  paymentMethod: PaymentMethod; paymentStatus: PaymentStatus; publicToken: string }
export interface AlertRecipient { channel: ChannelName; to: string }
export interface CustomFieldDef { key: string; label: string; type: 'text' | 'number' | 'select'; options?: string[] }
export interface Settings { businessName: string; currency: string; whatsappNumber: string; defaultWarehouseId: string | null;
  alertRecipients: AlertRecipient[]; customFields: CustomFieldDef[]; payments: PaymentSettings }
export interface ChannelMessage { id: string; channel: ChannelName; direction: 'in' | 'out'; externalUser: string; text: string; status: string; createdAt: string }
/** `action` is the id of a tapped button / list row / quick reply (docs/3_SCHEMAS.md §3.12); absent for typed text. */
export interface InboundMessage { channel: ChannelName; from: string; text: string; action?: string; externalId?: string; senderName?: string }
export type RealtimeEvent =
  | { type: 'stock.changed'; productId: string; sku: string; warehouseId: string; quantity: number; totalQuantity: number }
  | { type: 'stock.low'; productId: string; sku: string; name: string; totalQuantity: number; reorderLevel: number }
  | { type: 'order.created' | 'order.updated'; orderId: string; number: number; status: OrderStatus }
  | { type: 'message.received'; channel: ChannelName; from: string; text: string }
  | { type: 'payment.updated'; orderId: string; number: number; paymentStatus: PaymentStatus };
export interface DashboardStats { productCount: number; totalUnits: number; stockValueCents: number;
  lowStockCount: number; pendingOrders: number; ordersToday: number }
export interface Payment { id: string; orderId: string; provider: 'razorpay'; providerRef: string; referenceId: string;
  status: 'CREATED' | 'PAID' | 'EXPIRED' | 'CANCELLED'; amountCents: number; currency: string; shortUrl: string;
  providerPaymentId: string | null; expiresAt: string; createdAt: string }
export interface PaymentSettings { onlineEnabled: boolean; codEnabled: boolean; linkExpiryMinutes: number }
/** CLOSED = closed short: partly received and the rest will not arrive. */
export type PurchaseStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
export interface PurchaseOrderItem { id: string; productId: string; sku: string; name: string; quantity: number; receivedQuantity: number; unitCostCents: number }
export interface PurchaseOrder { id: string; number: number; supplierId: string; supplierName: string; status: PurchaseStatus; warehouseId: string;
  expectedDate: string | null; notes: string; totalCents: number; items: PurchaseOrderItem[]; createdBy: string | null; createdAt: string; updatedAt: string }
export type BillStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'VOID';
export interface BillPayment { id: string; amountCents: number; requestId: string; method: string; paidAt: string }
export interface Bill { id: string; number: number; supplierId: string; supplierName: string; purchaseOrderId: string | null; status: BillStatus;
  totalCents: number; paidCents: number; dueDate: string; createdAt: string; payments: BillPayment[] }
export interface PayablesRow { supplierId: string; supplierName: string; openCents: number; overdueCents: number; billCount: number }
export interface Payables { suppliers: PayablesRow[]; totalOpenCents: number; totalOverdueCents: number }
