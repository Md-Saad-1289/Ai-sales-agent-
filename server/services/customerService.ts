import { getCollections } from '../db/mongo.ts';
import type { BuyingIntent, CustomerDoc, OrderDoc } from '../types.ts';

export async function upsertCustomerByMessengerId(params: {
  messengerId: string;
  pageId?: string;
  name?: string;
  profilePic?: string;
}): Promise<CustomerDoc> {
  const { customers } = getCollections();
  const cleanName = params.name?.trim();
  const cleanPageId = params.pageId?.trim() || undefined;

  async function syncExisting(existing: CustomerDoc): Promise<CustomerDoc> {
    const now = new Date();
    const updates: Record<string, unknown> = {};
    if (cleanName && existing.name.startsWith('Customer ')) {
      updates.name = cleanName;
    }
    if (params.profilePic && !existing.profilePic) {
      updates.profilePic = params.profilePic;
    }
    if (cleanPageId && !existing.pageId) {
      updates.pageId = cleanPageId;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = now;
      const updated = await customers.findOneAndUpdate(
        { _id: existing._id },
        { $set: updates },
        { returnDocument: 'after' },
      );
      if (updated) return updated;
    }
    return existing;
  }

  const existing = await customers.findOne({ messengerId: params.messengerId });
  if (existing) {
    return syncExisting(existing);
  }

  const now = new Date();
  try {
    return await customers.insertOne({
      messengerId: params.messengerId,
      pageId: cleanPageId,
      name: cleanName || `Customer ${params.messengerId.slice(-6)}`,
      profilePic: params.profilePic,
      preferences: [],
      buyingIntent: 'unknown',
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      const raced = await customers.findOne({ messengerId: params.messengerId });
      if (raced) return syncExisting(raced);
    }
    throw err;
  }
}

export async function updateCustomerInsights(
  customerId: string,
  insights: {
    name?: string;
    phone?: string;
    address?: string;
    buyingIntent?: BuyingIntent;
    newPreferences?: string[];
  },
): Promise<void> {
  const { customers } = getCollections();
  const setFields: Record<string, unknown> = { updatedAt: new Date() };
  if (insights.name) setFields.name = insights.name;
  if (insights.phone) setFields.phone = insights.phone;
  if (insights.address) setFields.address = insights.address;
  if (insights.buyingIntent) setFields.buyingIntent = insights.buyingIntent;

  const updateDoc: Record<string, unknown> = { $set: setFields };
  if (insights.newPreferences && insights.newPreferences.length > 0) {
    const cleanPrefs = insights.newPreferences
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.length <= 80);
    if (cleanPrefs.length > 0) {
      updateDoc.$addToSet = { preferences: { $each: cleanPrefs } };
    }
  }

  await customers.updateOne({ _id: customerId }, updateDoc);
}

export async function getCustomerProfileWithOrders(customerId: string): Promise<{
  customer: CustomerDoc | null;
  orders: OrderDoc[];
}> {
  const { customers, orders } = getCollections();
  const customer = await customers.findOne({ _id: customerId });
  if (!customer) return { customer: null, orders: [] };
  const customerOrders = await orders.find(
    { customerId },
    { sort: { createdAt: -1 }, limit: 20 },
  );
  return { customer, orders: customerOrders };
}
