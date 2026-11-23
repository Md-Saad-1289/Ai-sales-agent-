import { getCollections } from '../db/mongo.ts';
import type {
  ConversationDoc,
  CustomerDoc,
  MessageDoc,
  OrderDoc,
  ProductDoc,
  SettingsDoc,
} from '../types.ts';
import { getActiveCatalogForAI } from './productService.ts';
import { getSettings } from './settingsService.ts';

export interface ConversationContextBundle {
  settings: SettingsDoc;
  customer: CustomerDoc;
  conversation: ConversationDoc;
  recentMessages: MessageDoc[];
  recentOrders: OrderDoc[];
  activeProducts: ProductDoc[];
}

export function sanitizeUntrustedText(text: string): string {
  // Neutralize delimiter spoofing attempts in customer messages
  return text
    .replace(/<\/?customer_message>/gi, '[message]')
    .replace(/<\/?system_instructions>/gi, '[text]')
    .replace(/<\/?verified_catalog>/gi, '[text]')
    .trim()
    .slice(0, 2000);
}

export async function buildConversationContext(params: {
  conversationId: string;
  customerId: string;
}): Promise<ConversationContextBundle> {
  const { customers, conversations, messages, orders } = getCollections();

  const [settings, customer, conversation, recentMessages, recentOrders, activeProducts] =
    await Promise.all([
      getSettings(),
      customers.findOne({ _id: params.customerId }),
      conversations.findOne({ _id: params.conversationId }),
      messages.find({ conversationId: params.conversationId }, { sort: { createdAt: -1 }, limit: 18 }),
      orders.find({ customerId: params.customerId }, { sort: { createdAt: -1 }, limit: 5 }),
      getActiveCatalogForAI(),
    ]);

  if (!customer || !conversation) {
    throw new Error('Customer or conversation context missing.');
  }

  return {
    settings,
    customer,
    conversation,
    recentMessages: recentMessages.reverse(),
    recentOrders,
    activeProducts,
  };
}
