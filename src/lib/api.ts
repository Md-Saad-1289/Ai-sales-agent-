import type {
  AdminUser,
  AuditLog,
  AuthBootstrapStatus,
  Conversation,
  Customer,
  EnvironmentStatus,
  GeminiApiKeySummary,
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeProposal,
  KnowledgeSource,
  KnowledgeVersion,
  MemoryScript,
  Message,
  Order,
  OrderStatus,
  OverviewResponse,
  Product,
  Settings,
  TrainingMessage,
  TrainingSession,
} from '../types';

let onUnauthorizedHandler: (() => void) | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorizedHandler = handler;
}

async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'X-Requested-With': 'PageFlowUI',
        },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('X-Requested-With', 'PageFlowUI');

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  const isAuthEndpoint =
    path.startsWith('/api/auth/login') ||
    path.startsWith('/api/auth/claim') ||
    path.startsWith('/api/auth/refresh') ||
    path.startsWith('/api/auth/me') ||
    path.startsWith('/api/auth/status');

  if (res.status === 401 && allowRetry && !isAuthEndpoint) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, init, false);
    }
    onUnauthorizedHandler?.();
  }

  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(errMsg);
  }

  return data as T;
}

export interface RealtimeHandlers {
  onMessageCreated?: (payload: {
    conversationId: string;
    message: Message;
    conversation?: Conversation;
  }) => void;
  onConversationUpdated?: (payload: { conversation: Conversation }) => void;
  onOrderCreated?: (payload: { order: Order }) => void;
  onOrderUpdated?: (payload: { order: Order }) => void;
  onTrainingSourceUpdated?: (payload: { source: KnowledgeSource }) => void;
  onTrainingProposalCreated?: (payload: { proposal: KnowledgeProposal }) => void;
  onKnowledgeUpdated?: (payload: { entry: KnowledgeEntry }) => void;
  onMemoryScriptUpdated?: (payload: { script: MemoryScript }) => void;
  onReconnect?: () => void;
}

export function subscribeRealtimeEvents(handlers: RealtimeHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    return () => undefined;
  }

  let es: EventSource | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let hadDisconnect = false;

  const connect = () => {
    if (closed) return;
    es = new EventSource('/api/events/stream', { withCredentials: true });

    es.onopen = () => {
      if (hadDisconnect) {
        hadDisconnect = false;
        handlers.onReconnect?.();
      }
    };

    es.addEventListener('message:created', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          conversationId: string;
          message: Message;
          conversation?: Conversation;
        };
        handlers.onMessageCreated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('conversation:updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { conversation: Conversation };
        handlers.onConversationUpdated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('order:created', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { order: Order };
        handlers.onOrderCreated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('order:updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { order: Order };
        handlers.onOrderUpdated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('training:source_updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { source: KnowledgeSource };
        handlers.onTrainingSourceUpdated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('training:proposal_created', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { proposal: KnowledgeProposal };
        handlers.onTrainingProposalCreated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('knowledge:updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { entry: KnowledgeEntry };
        handlers.onKnowledgeUpdated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.addEventListener('memory:script_updated', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { script: MemoryScript };
        handlers.onMemoryScriptUpdated?.(data);
      } catch {
        // Ignore malformed event payload
      }
    });

    es.onerror = () => {
      hadDisconnect = true;
      es?.close();
      es = null;
      if (!closed && !reconnectTimer) {
        reconnectTimer = setTimeout(async () => {
          reconnectTimer = null;
          if (closed) return;
          // Refresh access cookie if SSE disconnected because access token expired
          await refreshSession();
          connect();
        }, 3000);
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    es?.close();
    es = null;
  };
}

export const api = {
  getAuthStatus: () => request<AuthBootstrapStatus>('/api/auth/status'),
  getMe: async (): Promise<AdminUser | null> => {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-Requested-With': 'PageFlowUI',
      },
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new Error(`Session check failed (${res.status})`);
    }
    const data = (await res.json()) as { admin?: AdminUser };
    return data.admin ?? null;
  },
  claimAdmin: (body: { email: string; name: string; password: string }) =>
    request<{ admin: AdminUser }>('/api/auth/claim', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { email?: string; password: string }) =>
    request<{ admin: AdminUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    }),
  getOverview: () => request<OverviewResponse>('/api/overview'),
  listProducts: (params?: { search?: string; activeOnly?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.activeOnly) qs.set('active', 'true');
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ products: Product[] }>(`/api/products${suffix}`);
  },
  createProduct: (body: Omit<Product, '_id' | 'createdAt' | 'updatedAt'>) =>
    request<{ product: Product }>('/api/products', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProduct: (id: string, body: Omit<Product, '_id' | 'createdAt' | 'updatedAt'>) =>
    request<{ product: Product }>(`/api/products/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteProduct: (id: string) =>
    request<{ deleted: boolean }>(`/api/products/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  listConversations: (params?: { filter?: 'all' | 'ai_active' | 'human_takeover'; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.filter) qs.set('filter', params.filter);
    if (params?.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ conversations: Conversation[] }>(`/api/conversations${suffix}`);
  },
  getConversationDetail: (id: string, opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.before) qs.set('before', opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{
      conversation: Conversation;
      withinMessagingWindow: boolean;
      messages: Message[];
      hasMore: boolean;
      nextCursor: string | null;
      customer: Customer | null;
      customerOrders: Order[];
    }>(`/api/conversations/${encodeURIComponent(id)}${suffix}`);
  },
  toggleConversationAI: (id: string, body: { aiEnabled: boolean; humanTakeover?: boolean }) =>
    request<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(id)}/ai`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  sendAdminMessage: (id: string, text: string) =>
    request<{ message: Message; conversation: Conversation }>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ text }),
      },
    ),
  sendTestCustomerMessage: (body: { senderId?: string; senderName?: string; text: string }) =>
    request<{
      conversationId: string;
      customerId: string;
      aiReplied: boolean;
      replyText?: string;
      handoverTriggered?: boolean;
      createdOrder?: Order;
    }>('/api/conversations/test-message', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listOrders: (params?: { status?: OrderStatus | 'all'; search?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ orders: Order[] }>(`/api/orders${suffix}`);
  },
  updateOrderStatus: (id: string, status: OrderStatus) =>
    request<{ order: Order }>(`/api/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  getSettings: () =>
    request<{
      settings: Settings;
      environment: EnvironmentStatus;
      geminiKeys?: {
        keys: GeminiApiKeySummary[];
        activeKeyId: string | null;
        envKeyPresent: boolean;
      };
    }>('/api/settings'),
  updateSettings: (
    body: Omit<Settings, '_id' | 'updatedAt'>,
  ) =>
    request<{ settings: Settings; environment: EnvironmentStatus }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  listGeminiKeys: () =>
    request<{
      keys: GeminiApiKeySummary[];
      activeKeyId: string | null;
      envKeyPresent: boolean;
      environment: EnvironmentStatus;
    }>('/api/settings/gemini-keys'),
  addGeminiKey: (body: { apiKey: string; label?: string; makePrimary?: boolean }) =>
    request<{
      key: GeminiApiKeySummary;
      keys: GeminiApiKeySummary[];
      activeKeyId: string | null;
      envKeyPresent: boolean;
      environment: EnvironmentStatus;
    }>('/api/settings/gemini-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateGeminiKey: (
    id: string,
    body: { label?: string; isActive?: boolean; makePrimary?: boolean; resetStatus?: boolean },
  ) =>
    request<{
      keys: GeminiApiKeySummary[];
      activeKeyId: string | null;
      envKeyPresent: boolean;
      environment: EnvironmentStatus;
    }>(`/api/settings/gemini-keys/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  testGeminiKey: (id: string) =>
    request<{
      ok: boolean;
      status: GeminiApiKeySummary['status'];
      message: string;
      keys: GeminiApiKeySummary[];
      activeKeyId: string | null;
      envKeyPresent: boolean;
      environment: EnvironmentStatus;
    }>(`/api/settings/gemini-keys/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  deleteGeminiKey: (id: string) =>
    request<{
      keys: GeminiApiKeySummary[];
      activeKeyId: string | null;
      envKeyPresent: boolean;
      environment: EnvironmentStatus;
    }>(`/api/settings/gemini-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  verifyFacebookConnection: () =>
    request<{ connected: boolean; pageId?: string; pageName?: string; error?: string }>(
      '/api/settings/verify-facebook',
      { method: 'POST' },
    ),

  // --- Training Studio ---
  listTrainingSessions: () => request<{ sessions: TrainingSession[] }>('/api/training/sessions'),
  createTrainingSession: (title?: string) =>
    request<{ session: TrainingSession }>('/api/training/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  getTrainingSessionDetail: (id: string) =>
    request<{
      session: TrainingSession;
      messages: TrainingMessage[];
      proposals: KnowledgeProposal[];
      sources: KnowledgeSource[];
    }>(`/api/training/sessions/${encodeURIComponent(id)}`),
  runTrainingGapAnalysis: (sessionId: string) =>
    request<{ message: TrainingMessage }>(
      `/api/training/sessions/${encodeURIComponent(sessionId)}/gaps`,
      { method: 'POST' },
    ),
  sendTrainingMessageStream: async (
    sessionId: string,
    text: string,
    onDelta: (chunk: string) => void,
  ): Promise<{
    userMessage: TrainingMessage;
    aiMessage: TrainingMessage;
    proposals: KnowledgeProposal[];
  }> => {
    const doFetch = () =>
      fetch(`/api/training/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'PageFlowUI',
        },
        body: JSON.stringify({ text }),
      });

    let res = await doFetch();
    if (res.status === 401) {
      const ok = await refreshSession();
      if (ok) res = await doFetch();
    }
    if (!res.ok) {
      const errBody = await res.text();
      let msg = `Training request failed (${res.status})`;
      try {
        const parsed = JSON.parse(errBody) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch {
        if (errBody) msg = errBody;
      }
      throw new Error(msg);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return request<{
        userMessage: TrainingMessage;
        aiMessage: TrainingMessage;
        proposals: KnowledgeProposal[];
      }>(`/api/training/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: {
      userMessage: TrainingMessage;
      aiMessage: TrainingMessage;
      proposals: KnowledgeProposal[];
    } | null = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        const lines = block.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const l of lines) {
          if (l.startsWith('event:')) eventName = l.slice(6).trim();
          else if (l.startsWith('data:')) dataLine += l.slice(5).trim();
        }
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine) as Record<string, unknown>;
        if (eventName === 'delta' && typeof parsed.delta === 'string') {
          onDelta(parsed.delta);
        } else if (eventName === 'error') {
          throw new Error(String(parsed.error || 'Training stream error.'));
        } else if (eventName === 'done') {
          finalResult = parsed as {
            userMessage: TrainingMessage;
            aiMessage: TrainingMessage;
            proposals: KnowledgeProposal[];
          };
        }
      }
    }

    if (!finalResult) {
      throw new Error('Training response stream closed unexpectedly.');
    }
    return finalResult;
  },
  uploadTrainingFile: async (sessionId: string, file: File): Promise<{ source: KnowledgeSource }> => {
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('file', file);

    const doUpload = () =>
      fetch('/api/training/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'PageFlowUI' },
        body: form,
      });

    let res = await doUpload();
    if (res.status === 401) {
      const ok = await refreshSession();
      if (ok) res = await doUpload();
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { source?: KnowledgeSource; error?: string }) : {};
    if (!res.ok || !data.source) {
      throw new Error(data.error || `Upload failed (${res.status})`);
    }
    return { source: data.source };
  },
  getTrainingSourceStatus: (sourceId: string) =>
    request<{ source: KnowledgeSource }>(`/api/training/sources/${encodeURIComponent(sourceId)}`),

  // --- Knowledge Memory & Proposals ---
  listKnowledge: (params?: {
    category?: KnowledgeCategory | 'all';
    status?: 'approved' | 'archived' | 'all';
    search?: string;
  }) => {
    const qs = new URLSearchParams();
    if (params?.category && params.category !== 'all') qs.set('category', params.category);
    if (params?.status) qs.set('status', params.status);
    if (params?.search) qs.set('search', params.search);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ entries: KnowledgeEntry[] }>(`/api/knowledge${suffix}`);
  },
  getKnowledgeCategories: () =>
    request<{ categories: Array<{ name: KnowledgeCategory; count: number }> }>('/api/knowledge/categories'),
  getKnowledgeDetail: (id: string) =>
    request<{ entry: KnowledgeEntry; versions: KnowledgeVersion[]; related: KnowledgeEntry[] }>(
      `/api/knowledge/${encodeURIComponent(id)}`,
    ),
  updateKnowledgeEntry: (
    id: string,
    body: {
      category: KnowledgeCategory;
      title: string;
      description: string;
      rules: string[];
      tags?: string[];
      priority?: number;
      changeReason?: string;
    },
  ) =>
    request<{ entry: KnowledgeEntry }>(`/api/knowledge/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteKnowledgeEntry: (id: string, reason?: string) =>
    request<{ entry: KnowledgeEntry }>(`/api/knowledge/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmDelete: true, entryIdConfirm: id, reason }),
    }),
  restoreKnowledgeEntry: (id: string) =>
    request<{ entry: KnowledgeEntry }>(`/api/knowledge/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),

  listProposals: (params?: { status?: string; sessionId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.sessionId) qs.set('sessionId', params.sessionId);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ proposals: KnowledgeProposal[] }>(`/api/proposals${suffix}`);
  },
  editProposal: (
    id: string,
    body: {
      reason?: string;
      proposedEntry?: KnowledgeProposal['proposedEntry'];
      proposedProduct?: KnowledgeProposal['proposedProduct'];
    },
  ) =>
    request<{ proposal: KnowledgeProposal }>(`/api/proposals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  approveProposal: (id: string, opts?: { confirmDelete?: boolean; targetEntryId?: string }) =>
    request<{ proposal: KnowledgeProposal; knowledgeEntry?: KnowledgeEntry; product?: Product }>(
      `/api/proposals/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      },
    ),
  rejectProposal: (id: string, reason?: string) =>
    request<{ proposal: KnowledgeProposal }>(`/api/proposals/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  clarifyProposal: (id: string, note: string) =>
    request<{ proposal: KnowledgeProposal }>(`/api/proposals/${encodeURIComponent(id)}/clarify`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  // --- Layer B: Short Memory Script ---
  getMemoryScript: () => request<{ activeScript: MemoryScript; versions: MemoryScript[] }>('/api/memory/script'),
  regenerateMemoryScript: (tokenBudget?: number) =>
    request<{ activeScript: MemoryScript }>('/api/memory/script/regenerate', {
      method: 'POST',
      body: JSON.stringify({ tokenBudget }),
    }),
  updateMemoryScript: (scriptText: string, tokenBudget?: number) =>
    request<{ activeScript: MemoryScript }>('/api/memory/script', {
      method: 'PUT',
      body: JSON.stringify({ scriptText, tokenBudget }),
    }),

  // --- Audit Logs ---
  listAuditLogs: (limit = 80) => request<{ logs: AuditLog[] }>(`/api/audit-logs?limit=${limit}`),
};
