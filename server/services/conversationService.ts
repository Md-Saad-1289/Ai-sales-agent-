import { getCollections } from '../db/mongo.ts';
import type {
  ConversationDoc,
  DraftOrderState,
  MessageDoc,
  MessageSender,
} from '../types.ts';

const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinMessagingWindow(lastCustomerMessageAt: Date | string): boolean {
  const ts =
    lastCustomerMessageAt instanceof Date
      ? lastCustomerMessageAt.getTime()
      : new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= MESSAGING_WINDOW_MS;
}

export async function upsertConversation(params: {
  customerId: string;
  messengerId: string;
  customerName: string;
}): Promise<ConversationDoc> {
  const { conversations } = getCollections();
  const existing = await conversations.findOne({ messengerId: params.messengerId });
  const now = new Date();

  if (existing) {
    if (existing.customerName !== params.customerName && !params.customerName.startsWith('Customer ')) {
      const updated = await conversations.findOneAndUpdate(
        { _id: existing._id },
        { $set: { customerName: params.customerName, updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (updated) return updated;
    }
    return existing;
  }

  return conversations.insertOne({
    customerId: params.customerId,
    messengerId: params.messengerId,
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

  return conversations.find(query, { sort: { lastMessageAt: -1 }, limit: 100 });
}

export async function getConversationById(id: string): Promise<ConversationDoc | null> {
  const { conversations } = getCollections();
  return conversations.findOne({ _id: id });
}

export async function getConversationMessages(conversationId: string, limit = 100): Promise<MessageDoc[]> {
  const { messages } = getCollections();
  return messages.find({ conversationId }, { sort: { createdAt: 1 }, limit });
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
  aiMetadata?: MessageDoc['aiMetadata'];
}): Promise<MessageDoc> {
  const { messages, conversations } = getCollections();
  const now = new Date();

  const msg = await messages.insertOne({
    conversationId: params.conversationId,
    customerId: params.customerId,
    messengerId: params.messengerId,
    sender: params.sender,
    text: params.text,
    externalMessageId: params.externalMessageId,
    deliveryStatus: params.deliveryStatus,
    deliveryError: params.deliveryError,
    aiMetadata: params.aiMetadata,
    createdAt: now,
  });

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

  await conversations.updateOne({ _id: params.conversationId }, updateOp);
  return msg;
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

  return conversations.findOneAndUpdate(
    { _id: conversationId },
    { $set: updateFields },
    { returnDocument: 'after' },
  );
}

export async function markConversationRead(conversationId: string): Promise<void> {
  const { conversations } = getCollections();
  await conversations.updateOne(
    { _id: conversationId },
    { $set: { unreadCount: 0, updatedAt: new Date() } },
  );
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
