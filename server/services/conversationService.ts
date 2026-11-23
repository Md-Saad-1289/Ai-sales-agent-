import { randomUUID } from 'node:crypto';
import { getCollections } from '../db/mongo.ts';
import type {
  ConversationDoc,
  DraftOrderState,
  MessageDoc,
  MessageSender,
  MessageSource,
} from '../types.ts';
import { emitRealtimeEvent } from './realtimeService.ts';

const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinMessagingWindow(lastCustomerMessageAt: Date | string): boolean {
  const ts =
    lastCustomerMessageAt instanceof Date
      ? lastCustomerMessageAt.getTime()
      : new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= MESSAGING_WINDOW_MS;
}

export function normalizeMessageDoc(doc: Partial<MessageDoc> & { _id: string }): MessageDoc {
  const sender = (doc.sender_type ?? doc.sender ?? 'customer') as MessageSender;
  const text = doc.message_text ?? doc.text ?? '';
  const deliveryStatus = (doc.delivery_status ?? doc.deliveryStatus ?? 'received') as MessageDoc['deliveryStatus'];
  const createdAt = doc.createdAt
    ? doc.createdAt instanceof Date
      ? doc.createdAt
      : new Date(doc.createdAt)
    : doc.timestamp
      ? doc.timestamp instanceof Date
        ? doc.timestamp
        : new Date(doc.timestamp)
      : new Date();
  const conversationId = doc.conversationId ?? doc.conversation_id ?? '';
  const customerId = doc.customerId ?? doc.customer_id ?? '';
  const source: MessageSource =
    doc.source === 'dashboard' || doc.source === 'messenger'
      ? doc.source
      : sender === 'admin' || doc.messengerId?.startsWith('sim_')
        ? 'dashboard'
        : 'messenger';

  return {
    _id: doc._id,
    message_id: doc.message_id ?? doc._id,
    conversationId,
    conversation_id: conversationId,
    customerId,
    customer_id: customerId,
    messengerId: doc.messengerId ?? '',
    sender,
    sender_type: sender,
    text,
    message_text: text,
    externalMessageId: doc.externalMessageId,
    deliveryStatus,
    delivery_status: deliveryStatus,
    deliveryError: doc.deliveryError,
    source,
    aiMetadata: doc.aiMetadata,
    createdAt,
    timestamp: createdAt,
  };
}

export async function upsertConversation(params: {
  customerId: string;
  messengerId: string;
  pageId?: string;
  customerName: string;
}): Promise<ConversationDoc> {
  const { conversations } = getCollections();
  const cleanPageId = params.pageId?.trim() || undefined;

  async function syncExisting(existing: ConversationDoc): Promise<ConversationDoc> {
    const updates: Record<string, unknown> = {};
    if (existing.customerId !== params.customerId) {
      updates.customerId = params.customerId;
    }
    if (
      params.customerName &&
      existing.customerName !== params.customerName &&
      !params.customerName.startsWith('Customer ')
    ) {
      updates.customerName = params.customerName;
    }
    if (cleanPageId && !existing.pageId) {
      updates.pageId = cleanPageId;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      const updated = await conversations.findOneAndUpdate(
        { _id: existing._id },
        { $set: updates },
        { returnDocument: 'after' },
      );
      if (updated) return updated;
    }
    return existing;
  }

  const existing = await conversations.findOne({ messengerId: params.messengerId });
  if (existing) {
    return syncExisting(existing);
  }

  const now = new Date();
  try {
    const created = await conversations.insertOne({
      customerId: params.customerId,
      messengerId: params.messengerId,
      pageId: cleanPageId,
      customerName: params.customerName,
      aiEnabled: true,
      humanTakeover: false,
      lastMessageText: '',
      lastMessageSender: 'customer',
      lastMessageAt: now,
      lastCustomerMessageAt: now,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    emitRealtimeEvent('conversation:updated', { conversation: created });
    return created;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      const raced = await conversations.findOne({ messengerId: params.messengerId });
      if (raced) return syncExisting(raced);
    }
    throw err;
  }
}

export async function listConversations(opts?: {
  filter?: 'all' | 'ai_active' | 'human_takeover';
  search?: string;
}): Promise<ConversationDoc[]> {
  const { conversations } = getCollections();
  const query: Record<string, unknown> = {};

  if (opts?.filter === 'ai_active') {
    query.aiEnabled = true;
    query.humanTakeover = false;
  } else if (opts?.filter === 'human_takeover') {
    query.humanTakeover = true;
  }

  if (opts?.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { customerName: { $regex: escaped, $options: 'i' } },
      { messengerId: { $regex: escaped, $options: 'i' } },
      { lastMessageText: { $regex: escaped, $options: 'i' } },
    ];
  }

  return conversations.find(query, { sort: { lastMessageAt: -1 }, limit: 150 });
}

export async function getConversationById(id: string): Promise<ConversationDoc | null> {
  const { conversations } = getCollections();
  return conversations.findOne({ _id: id });
}

export async function getConversationMessages(
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ messages: MessageDoc[]; hasMore: boolean; nextCursor: string | null }> {
  const { messages } = getCollections();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const filter: Record<string, unknown> = { conversationId };

  if (opts.before) {
    const beforeDate = new Date(opts.before);
    if (!Number.isNaN(beforeDate.getTime())) {
      filter.createdAt = { $lt: beforeDate };
    }
  }

  // Fetch newest N+1 messages in descending order, then reverse into chronological ascending order
  const raw = await messages.find(filter, { sort: { createdAt: -1 }, limit: limit + 1 });
  const hasMore = raw.length > limit;
  const page = hasMore ? raw.slice(0, limit) : raw;
  const chronological = page.reverse().map((m) => normalizeMessageDoc(m));
  const nextCursor =
    hasMore && chronological.length > 0
      ? chronological[0].createdAt.toISOString()
      : null;

  return {
    messages: chronological,
    hasMore,
    nextCursor,
  };
}

export async function findMessageByExternalId(externalMessageId: string): Promise<MessageDoc | null> {
  const cleanId = externalMessageId.trim();
  if (!cleanId) return null;
  const { messages } = getCollections();
  const found = await messages.findOne({ externalMessageId: cleanId });
  return found ? normalizeMessageDoc(found) : null;
}

export async function addMessage(params: {
  conversationId: string;
  customerId: string;
  messengerId: string;
  sender: MessageSender;
  text: string;
  externalMessageId?: string;
  deliveryStatus: MessageDoc['deliveryStatus'];
  deliveryError?: string;
  source?: MessageSource;
  aiMetadata?: MessageDoc['aiMetadata'];
  timestamp?: Date;
}): Promise<MessageDoc> {
  const { messages, conversations } = getCollections();
  const cleanExtId = params.externalMessageId?.trim() || undefined;

  if (cleanExtId) {
    const existing = await messages.findOne({ externalMessageId: cleanExtId });
    if (existing) {
      return normalizeMessageDoc(existing);
    }
  }

  // Guarantee monotonically increasing timestamp per conversation so same-ms replies order properly
  const conv = await conversations.findOne({ _id: params.conversationId });
  const prevTs = conv?.lastMessageAt ? new Date(conv.lastMessageAt).getTime() : 0;
  const candidateTs = params.timestamp ? params.timestamp.getTime() : Date.now();
  const now = new Date(Math.max(candidateTs, prevTs + 1));

  const msgId = randomUUID();
  const source: MessageSource =
    params.source ??
    (params.sender === 'admin' || params.messengerId.startsWith('sim_') ? 'dashboard' : 'messenger');

  const docToInsert: Omit<MessageDoc, '_id'> & { _id: string } = {
    _id: msgId,
    message_id: msgId,
    conversationId: params.conversationId,
    conversation_id: params.conversationId,
    customerId: params.customerId,
    customer_id: params.customerId,
    messengerId: params.messengerId,
    sender: params.sender,
    sender_type: params.sender,
    text: params.text,
    message_text: params.text,
    deliveryStatus: params.deliveryStatus,
    delivery_status: params.deliveryStatus,
    source,
    createdAt: now,
    timestamp: now,
  };

  if (cleanExtId) {
    docToInsert.externalMessageId = cleanExtId;
  }
  if (params.deliveryError) {
    docToInsert.deliveryError = params.deliveryError;
  }
  if (params.aiMetadata) {
    docToInsert.aiMetadata = params.aiMetadata;
  }

  let inserted: MessageDoc;
  try {
    inserted = await messages.insertOne(docToInsert);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000 && cleanExtId) {
      const existing = await messages.findOne({ externalMessageId: cleanExtId });
      if (existing) {
        return normalizeMessageDoc(existing);
      }
    }
    throw err;
  }

  const normalized = normalizeMessageDoc(inserted);

  const convUpdate: Record<string, unknown> = {
    lastMessageText: params.text.slice(0, 240),
    lastMessageSender: params.sender,
    lastMessageAt: now,
    updatedAt: now,
  };

  if (params.sender === 'customer') {
    convUpdate.lastCustomerMessageAt = now;
  } else {
    convUpdate.unreadCount = 0;
  }

  const updateOp: Record<string, unknown> = { $set: convUpdate };
  if (params.sender === 'customer') {
    updateOp.$inc = { unreadCount: 1 };
  }

  const updatedConv = await conversations.findOneAndUpdate(
    { _id: params.conversationId },
    updateOp,
    { returnDocument: 'after' },
  );

  emitRealtimeEvent('message:created', {
    conversationId: params.conversationId,
    message: normalized,
    conversation: updatedConv ?? undefined,
  });
  if (updatedConv) {
    emitRealtimeEvent('conversation:updated', { conversation: updatedConv });
  }

  return normalized;
}

export async function setConversationAIState(
  conversationId: string,
  params: { aiEnabled: boolean; humanTakeover: boolean; handoverReason?: string },
): Promise<ConversationDoc | null> {
  const { conversations } = getCollections();
  const updateFields: Record<string, unknown> = {
    aiEnabled: params.aiEnabled,
    humanTakeover: params.humanTakeover,
    updatedAt: new Date(),
  };
  if (params.handoverReason !== undefined) {
    updateFields.handoverReason = params.handoverReason;
  }

  const updated = await conversations.findOneAndUpdate(
    { _id: conversationId },
    { $set: updateFields },
    { returnDocument: 'after' },
  );

  if (updated) {
    emitRealtimeEvent('conversation:updated', { conversation: updated });
  }

  return updated;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { conversations } = getCollections();
  const updated = await conversations.findOneAndUpdate(
    { _id: conversationId, unreadCount: { $gt: 0 } },
    { $set: { unreadCount: 0, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (updated) {
    emitRealtimeEvent('conversation:updated', { conversation: updated });
  }
}

export async function updateConversationDraftOrder(
  conversationId: string,
  draftOrder: DraftOrderState | null,
): Promise<void> {
  const { conversations } = getCollections();
  if (draftOrder === null) {
    await conversations.updateOne(
      { _id: conversationId },
      { $unset: { draftOrder: '' }, $set: { updatedAt: new Date() } },
    );
  } else {
    await conversations.updateOne(
      { _id: conversationId },
      { $set: { draftOrder, updatedAt: new Date() } },
    );
  }
}
