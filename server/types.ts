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
  pageId?: string;
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
  pageId?: string;
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

export type MessageSource = 'messenger' | 'dashboard';

export interface MessageDoc {
  _id: string;
  message_id: string;
  conversationId: string;
  conversation_id: string;
  customerId: string;
  customer_id: string;
  messengerId: string;
  sender: MessageSender;
  sender_type: MessageSender;
  text: string;
  message_text: string;
  externalMessageId?: string;
  deliveryStatus: 'received' | 'sent' | 'failed' | 'simulated';
  delivery_status: 'received' | 'sent' | 'failed' | 'simulated';
  deliveryError?: string;
  source: MessageSource;
  aiMetadata?: {
    intent?: string;
    action?: string;
    language?: string;
    recommendedProductIds?: string[];
  };
  createdAt: Date;
  timestamp: Date;
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

export type GeminiKeyStatus = 'active' | 'rate_limited' | 'invalid' | 'disabled';

export interface StoredGeminiApiKey {
  id: string;
  label: string;
  maskedKey: string;
  encryptedKey: string;
  keyHash: string;
  isActive: boolean;
  status: GeminiKeyStatus;
  cooldownUntil?: Date;
  lastError?: string;
  lastUsedAt?: Date;
  requestCount: number;
  createdAt: Date;
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
  geminiApiKeys?: StoredGeminiApiKey[];
  activeGeminiKeyId?: string;
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

export interface SessionDoc {
  _id: string;
  tokenHash: string;
  userId: string;
  email: string;
  name: string;
  role: 'admin';
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemSecretDoc {
  _id: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
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

export type KnowledgeClassification =
  | 'NEW'
  | 'DUPLICATE'
  | 'MODIFIED'
  | 'CONFLICT'
  | 'UNCERTAIN';

export type ProposalAction =
  | 'ADD'
  | 'UPDATE'
  | 'REPLACE'
  | 'MERGE'
  | 'ARCHIVE'
  | 'DELETE_REQUEST';

export type ProposalStatus =
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'clarification_requested';

export type TrainingIntent =
  | 'new_knowledge'
  | 'new_behavioral_rule'
  | 'rule_modification'
  | 'product_create'
  | 'product_update'
  | 'policy_update'
  | 'delete_request'
  | 'general_question'
  | 'knowledge_conflict';

export interface KnowledgeSourceRef {
  sourceId?: string;
  filename?: string;
  pageOrSheet?: string;
  sectionOrRow?: string;
  extractedAt?: Date;
}

export interface KnowledgeStructuredProductData {
  productName?: string;
  brand?: string;
  category?: string;
  price?: number;
  warranty?: string;
  stock?: number;
  features?: string[];
  description?: string;
  source?: string;
}

export interface KnowledgeEntryDoc {
  _id: string;
  stableKey: string;
  category: KnowledgeCategory;
  title: string;
  description: string;
  rules: string[];
  structuredData?: Record<string, unknown>;
  tags: string[];
  keywords: string[];
  priority: number;
  status: 'approved' | 'archived';
  version: number;
  currentVersionId: string;
  source: string;
  sourceRef?: KnowledgeSourceRef;
  relatedIds: string[];
  createdBy: string;
  approvedBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt?: Date;
}

export interface KnowledgeVersionDoc {
  _id: string;
  entryId: string;
  version: number;
  category: KnowledgeCategory;
  title: string;
  description: string;
  rules: string[];
  structuredData?: Record<string, unknown>;
  source: string;
  sourceRef?: KnowledgeSourceRef;
  changeReason: string;
  proposalId?: string;
  changedBy: string;
  action: ProposalAction | 'RESTORE' | 'MANUAL_EDIT';
  createdAt: Date;
}

export interface ProposalDiffItem {
  field: string;
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  oldValue?: string;
  newValue?: string;
}

export interface ProposedKnowledgePayload {
  category: KnowledgeCategory;
  title: string;
  description: string;
  rules: string[];
  structuredData?: Record<string, unknown>;
  tags?: string[];
  priority?: number;
}

export interface ProposedProductPayload {
  name: string;
  brand?: string;
  category?: string;
  price?: number;
  stock?: number;
  warranty?: string;
  description?: string;
  features?: string[];
  isActive?: boolean;
}

export interface KnowledgeProposalDoc {
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
  proposedEntry?: ProposedKnowledgePayload;
  proposedProduct?: ProposedProductPayload;
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
  reviewedAt?: Date;
  executionResultId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeSourceDoc {
  _id: string;
  sessionId?: string;
  filename: string;
  mimeType: string;
  fileType: 'pdf' | 'txt' | 'csv' | 'docx' | 'xlsx';
  sizeBytes: number;
  sha256: string;
  status: 'queued' | 'extracting' | 'chunking' | 'analyzing' | 'completed' | 'failed';
  totalChunks: number;
  processedChunks: number;
  extractedItemsCount: number;
  proposalsCreatedCount: number;
  duplicatesSkippedCount: number;
  conflictsDetectedCount: number;
  error?: string;
  uploadedBy: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface KnowledgeChunkDoc {
  _id: string;
  sourceId: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  filename: string;
  pageOrSheet: string;
  sectionOrRow: string;
  extractedAt: Date;
  status: 'pending' | 'processed' | 'failed';
  error?: string;
  createdAt: Date;
}

export interface MemoryScriptDoc {
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
  createdAt: Date;
}

export interface TrainingSessionDoc {
  _id: string;
  title: string;
  createdBy: string;
  ownerEmail: string;
  lastMessagePreview: string;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TrainingMessageDoc {
  _id: string;
  sessionId: string;
  role: 'admin' | 'ai' | 'system';
  text: string;
  intent?: TrainingIntent;
  sourceId?: string;
  proposalIds?: string[];
  gapSuggestions?: Array<{
    topic: string;
    category: KnowledgeCategory;
    reason: string;
    suggestedPrompt: string;
  }>;
  createdAt: Date;
}

export interface AuditLogDoc {
  _id: string;
  actorType: 'admin' | 'ai' | 'system';
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType: 'knowledge_entry' | 'knowledge_proposal' | 'product' | 'memory_script' | 'knowledge_source';
  targetId: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

