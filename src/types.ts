export type NavSection = 'overview' | 'conversations' | 'products' | 'orders' | 'settings';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

export interface AdminUser {
  email: string;
  name: string;
  role: 'admin';
}

export interface AuthBootstrapStatus {
  needsSetup: boolean;
  envPasscodeConfigured: boolean;
  envEmailHint?: string;
}

export interface Product {
  _id: string;
  name: string;
  price: number;
  stock: number;
  description: string;
  features: string[];
  images: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  _id: string;
  messengerId: string;
  name: string;
  profilePic?: string;
  phone?: string;
  address?: string;
  preferences: string[];
  buyingIntent: 'unknown' | 'browsing' | 'comparing' | 'ready_to_buy' | 'support';
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  _id: string;
  customerId: string;
  messengerId: string;
  customerName: string;
  aiEnabled: boolean;
  humanTakeover: boolean;
  handoverReason?: string;
  lastMessageText: string;
  lastMessageSender: 'customer' | 'ai' | 'admin';
  lastMessageAt: string;
  lastCustomerMessageAt: string;
  unreadCount: number;
}

export interface Message {
  _id: string;
  conversationId: string;
  sender: 'customer' | 'ai' | 'admin';
  text: string;
  deliveryStatus: 'received' | 'sent' | 'failed' | 'simulated';
  deliveryError?: string;
  aiMetadata?: {
    intent?: string;
    action?: string;
    language?: string;
    recommendedProductIds?: string[];
  };
  createdAt: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  _id: string;
  orderNumber: string;
  customerId: string;
  conversationId: string;
  messengerId: string;
  customerName: string;
  phoneNumber: string;
  deliveryAddress: string;
  items: OrderItem[];
  subtotal: number;
  deliveryCharge: number;
  totalAmount: number;
  status: OrderStatus;
  source: 'messenger_ai' | 'admin_manual' | 'test_simulator';
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  _id: string;
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
  updatedAt: string;
}

export interface EnvironmentStatus {
  databaseMode: 'mongodb' | 'memory';
  databaseError: string | null;
  geminiConfigured: boolean;
  metaPageTokenConfigured: boolean;
  metaAppSecretConfigured: boolean;
  metaVerifyTokenConfigured: boolean;
  appUrl: string;
}

export interface OverviewResponse {
  metrics: {
    totalConversations: number;
    confirmedOrders: number;
    pendingOrders: number;
    aiGlobalEnabled: boolean;
    geminiConfigured: boolean;
    facebookPageConnected: boolean;
    facebookPageName: string;
    currency: string;
  };
  recentConversations: Conversation[];
  recentOrders: Order[];
}
