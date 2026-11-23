export type NavSection =
  | 'overview'
  | 'conversations'
  | 'training'
  | 'knowledge'
  | 'products'
  | 'orders'
  | 'settings';

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
  pageId?: string;
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
  message_id?: string;
  conversationId: string;
  conversation_id?: string;
  customerId?: string;
  customer_id?: string;
  sender: 'customer' | 'ai' | 'admin';
  sender_type?: 'customer' | 'ai' | 'admin';
  text: string;
  message_text?: string;
  deliveryStatus: 'received' | 'sent' | 'failed' | 'simulated';
  delivery_status?: 'received' | 'sent' | 'failed' | 'simulated';
  deliveryError?: string;
  source?: 'messenger' | 'dashboard';
  aiMetadata?: {
    intent?: string;
    action?: string;
    language?: string;
    recommendedProductIds?: string[];
  };
  createdAt: string;
  timestamp?: string;
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

export type KnowledgeCategory =
  | 'Sales Behavior'
  | 'Communication Rules'
  | 'Customer Handling'
  | 'Product Knowledge'
  | 'Business Policies'
  | 'Delivery Policies'
  | 'Payment Policies'
  | 'Warranty & Return Policies'
  | 'Sales Strategies'
  | 'Frequently Asked Questions'
  | 'Other Business Knowledge';

export type KnowledgeClassification = 'NEW' | 'DUPLICATE' | 'MODIFIED' | 'CONFLICT' | 'UNCERTAIN';
export type ProposalAction = 'ADD' | 'UPDATE' | 'REPLACE' | 'MERGE' | 'ARCHIVE' | 'DELETE_REQUEST';
export type ProposalStatus = 'pending_approval' | 'approved' | 'rejected' | 'clarification_requested';

export interface KnowledgeSourceRef {
  sourceId?: string;
  filename?: string;
  pageOrSheet?: string;
  sectionOrRow?: string;
  extractedAt?: string;
}

export interface ProposalDiffItem {
  field: string;
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  oldValue?: string;
  newValue?: string;
}

export interface KnowledgeProposal {
  _id: string;
  sessionId?: string;
  messageId?: string;
  sourceId?: string;
  proposalType: 'knowledge' | 'product';
  action: ProposalAction;
  classification: KnowledgeClassification;
  status: ProposalStatus;
  targetEntryId?: string;
  targetProductId?: string;
  existingSnapshot?: Record<string, unknown>;
  proposedEntry?: {
    category: KnowledgeCategory;
    title: string;
    description: string;
    rules: string[];
    tags?: string[];
    priority?: number;
  };
  proposedProduct?: {
    name: string;
    brand?: string;
    category?: string;
    price?: number;
    stock?: number;
    warranty?: string;
    description?: string;
    features?: string[];
    isActive?: boolean;
  };
  missingFields?: string[];
  diffSummary: ProposalDiffItem[];
  similarityScore?: number;
  reason: string;
  originalSource?: string;
  newSource: string;
  sourceRef?: KnowledgeSourceRef;
  clarificationNote?: string;
  createdBy: 'ai' | 'admin';
  reviewedBy?: string;
  reviewedAt?: string;
  executionResultId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntry {
  _id: string;
  stableKey: string;
  category: KnowledgeCategory;
  title: string;
  description: string;
  rules: string[];
  tags: string[];
  priority: number;
  status: 'approved' | 'archived';
  version: number;
  currentVersionId: string;
  source: string;
  sourceRef?: KnowledgeSourceRef;
  relatedIds: string[];
  createdBy: string;
  approvedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface KnowledgeVersion {
  _id: string;
  entryId: string;
  version: number;
  category: KnowledgeCategory;
  title: string;
  description: string;
  rules: string[];
  source: string;
  sourceRef?: KnowledgeSourceRef;
  changeReason: string;
  proposalId?: string;
  changedBy: string;
  action: string;
  createdAt: string;
}

export interface KnowledgeSource {
  _id: string;
  sessionId?: string;
  filename: string;
  mimeType: string;
  fileType: 'pdf' | 'txt' | 'csv' | 'docx' | 'xlsx';
  sizeBytes: number;
  status: 'queued' | 'extracting' | 'chunking' | 'analyzing' | 'completed' | 'failed';
  totalChunks: number;
  processedChunks: number;
  extractedItemsCount: number;
  proposalsCreatedCount: number;
  duplicatesSkippedCount: number;
  conflictsDetectedCount: number;
  error?: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TrainingSession {
  _id: string;
  title: string;
  lastMessagePreview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrainingMessage {
  _id: string;
  sessionId: string;
  role: 'admin' | 'ai' | 'system';
  text: string;
  intent?: string;
  sourceId?: string;
  proposalIds?: string[];
  gapSuggestions?: Array<{
    topic: string;
    category: KnowledgeCategory;
    reason: string;
    suggestedPrompt: string;
  }>;
  createdAt: string;
}

export interface MemoryScript {
  _id: string;
  version: number;
  scriptText: string;
  tokenBudget: number;
  estimatedTokens: number;
  sourceEntryCount: number;
  entryIdsUsed: string[];
  isManualEdit: boolean;
  editedBy?: string;
  isActive: boolean;
  createdAt: string;
}

export interface AuditLog {
  _id: string;
  actorType: 'admin' | 'ai' | 'system';
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

