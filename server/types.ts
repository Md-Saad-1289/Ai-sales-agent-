export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export type MessageSender = 'customer' | 'ai' | 'admin';

export type BuyingIntent = 'unknown' | 'browsing' | 'comparing' | 'ready_to_buy' | 'support';

export type WebhookJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ProductDoc {
  _id: string;
  name: string;
  price: number;
  stock: number;
  description: string;
  features: string[];
  images: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerDoc {
  _id: string;
  messengerId: string;
  name: string;
  profilePic?: string;
  phone?: string;
  address?: string;
  preferences: string[];
  buyingIntent: BuyingIntent;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftOrderState {
  productId?: string;
  productName?: string;
  quantity?: number;
  customerName?: string;
  phoneNumber?: string;
  deliveryAddress?: string;
  summaryShownAt?: Date;
  summaryHash?: string;
}

export interface ConversationDoc {
  _id: string;
  customerId: string;
  messengerId: string;
  customerName: string;
  aiEnabled: boolean;
  humanTakeover: boolean;
  handoverReason?: string;
  lastMessageText: string;
  lastMessageSender: MessageSender;
  lastMessageAt: Date;
  lastCustomerMessageAt: Date;
  unreadCount: number;
  draftOrder?: DraftOrderState;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageDoc {
  _id: string;
  conversationId: string;
  customerId: string;
  messengerId: string;
  sender: MessageSender;
  text: string;
  externalMessageId?: string;
  deliveryStatus: 'received' | 'sent' | 'failed' | 'simulated';
  deliveryError?: string;
  aiMetadata?: {
    intent?: string;
    action?: string;
    language?: string;
    recommendedProductIds?: string[];
  };
  createdAt: Date;
}

export interface OrderItemDoc {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OrderDoc {
  _id: string;
  orderNumber: string;
  customerId: string;
  conversationId: string;
  messengerId: string;
  customerName: string;
  phoneNumber: string;
  deliveryAddress: string;
  items: OrderItemDoc[];
  subtotal: number;
  deliveryCharge: number;
  totalAmount: number;
  status: OrderStatus;
  idempotencyKey?: string;
  source: 'messenger_ai' | 'admin_manual' | 'test_simulator';
  createdAt: Date;
  updatedAt: Date;
}

export interface SettingsDoc {
  _id: string;
  key: 'primary';
  businessName: string;
  businessDescription: string;
  currency: string;
  deliveryCharge: number;
  deliveryChargeNote: string;
  returnPolicy: string;
  salesInstructions: string;
  aiTone: 'warm_professional' | 'concise_direct' | 'consultative';
  aiLanguageMode: 'auto_multilingual' | 'english' | 'bangla';
  aiGlobalEnabled: boolean;
  humanHandoverKeywords: string[];
  humanHandoverRules: string;
  facebookPageId: string;
  facebookPageName: string;
  updatedAt: Date;
}

export interface WebhookEventDoc {
  _id: string;
  eventId: string;
  senderId: string;
  recipientId: string;
  messageId?: string;
  messageText?: string;
  timestamp: number;
  rawPayload: Record<string, unknown>;
  status: WebhookJobStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDoc {
  _id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'admin';
  createdAt: Date;
  updatedAt: Date;
}
