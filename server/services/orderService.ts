import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';
import type { OrderDoc, OrderStatus } from '../types.ts';
import { decrementStock, getProductById, restoreStock } from './productService.ts';
import { getSettings } from './settingsService.ts';

export const orderStatusSchema = z.enum([
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]);

export const createOrderInputSchema = z.object({
  customerId: z.string().min(1),
  conversationId: z.string().min(1),
  messengerId: z.string().min(1),
  customerName: z.string().trim().min(2).max(120),
  phoneNumber: z.string().trim().min(6).max(32),
  deliveryAddress: z.string().trim().min(5).max(500),
  productId: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  source: z.enum(['messenger_ai', 'admin_manual', 'test_simulator']),
  summaryHash: z.string().optional(),
});

function buildOrderNumber(): string {
  const now = new Date();
  const datePart = `${now.getFullYear().toString().slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `ORD-${datePart}-${rand}`;
}

export function computeDraftSummaryHash(params: {
  conversationId: string;
  productId: string;
  quantity: number;
  phoneNumber: string;
  deliveryAddress: string;
}): string {
  const payload = `${params.conversationId}|${params.productId}|${params.quantity}|${params.phoneNumber.trim()}|${params.deliveryAddress.trim().toLowerCase()}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export async function createValidatedOrder(
  input: z.infer<typeof createOrderInputSchema>,
): Promise<{ order: OrderDoc; deduplicated: boolean }> {
  const { orders } = getCollections();
  const settings = await getSettings();

  const product = await getProductById(input.productId);
  if (!product) {
    throw new Error('Selected product no longer exists.');
  }
  if (!product.isActive) {
    throw new Error(`Product "${product.name}" is currently unavailable.`);
  }
  if (product.stock < input.quantity) {
    throw new Error(`Insufficient stock for "${product.name}". Only ${product.stock} left.`);
  }

  // Idempotency key guards against duplicate order creation from retries or double confirmations
  const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const idempotencySource = input.summaryHash
    ? `${input.conversationId}:${input.summaryHash}`
    : `${input.conversationId}:${product._id}:${input.quantity}:${input.phoneNumber.trim()}:${timeBucket}`;
  const idempotencyKey = createHash('sha256').update(idempotencySource).digest('hex').slice(0, 32);

  const existingDup = await orders.findOne({ idempotencyKey });
  if (existingDup) {
    return { order: existingDup, deduplicated: true };
  }

  const decremented = await decrementStock(product._id, input.quantity);
  if (!decremented) {
    throw new Error(`Unable to reserve stock for "${product.name}". Please check availability.`);
  }

  const unitPrice = product.price;
  const lineTotal = Number((unitPrice * input.quantity).toFixed(2));
  const deliveryCharge = Number(settings.deliveryCharge || 0);
  const totalAmount = Number((lineTotal + deliveryCharge).toFixed(2));
  const now = new Date();

  try {
    const order = await orders.insertOne({
      orderNumber: buildOrderNumber(),
      customerId: input.customerId,
      conversationId: input.conversationId,
      messengerId: input.messengerId,
      customerName: input.customerName,
      phoneNumber: input.phoneNumber,
      deliveryAddress: input.deliveryAddress,
      items: [
        {
          productId: product._id,
          productName: product.name,
          quantity: input.quantity,
          unitPrice,
          lineTotal,
        },
      ],
      subtotal: lineTotal,
      deliveryCharge,
      totalAmount,
      status: 'pending',
      idempotencyKey,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    });

    return { order, deduplicated: false };
  } catch (err) {
    // Restore reserved stock on insert failure unless duplicate key returned the existing order
    await restoreStock(product._id, input.quantity);
    const dupCheck = await orders.findOne({ idempotencyKey });
    if (dupCheck) {
      return { order: dupCheck, deduplicated: true };
    }
    throw err;
  }
}

export async function listOrders(opts?: { status?: OrderStatus | 'all'; search?: string }): Promise<OrderDoc[]> {
  const { orders } = getCollections();
  const filter: Record<string, unknown> = {};

  if (opts?.status && opts.status !== 'all') {
    filter.status = opts.status;
  }

  if (opts?.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { orderNumber: { $regex: escaped, $options: 'i' } },
      { customerName: { $regex: escaped, $options: 'i' } },
      { phoneNumber: { $regex: escaped, $options: 'i' } },
    ];
  }

  return orders.find(filter, { sort: { createdAt: -1 }, limit: 200 });
}

export async function getOrderById(id: string): Promise<OrderDoc | null> {
  const { orders } = getCollections();
  return orders.findOne({ _id: id });
}

export async function updateOrderStatus(id: string, nextStatus: OrderStatus): Promise<OrderDoc | null> {
  const { orders } = getCollections();
  const current = await orders.findOne({ _id: id });
  if (!current) return null;

  const updated = await orders.findOneAndUpdate(
    { _id: id },
    { $set: { status: nextStatus, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );

  // Restore inventory if moving from an active status to cancelled
  if (updated && current.status !== 'cancelled' && nextStatus === 'cancelled') {
    for (const item of current.items) {
      await restoreStock(item.productId, item.quantity);
    }
  }

  return updated;
}
