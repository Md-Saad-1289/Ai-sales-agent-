import type {
  AdminUser,
  AuthBootstrapStatus,
  Conversation,
  Customer,
  EnvironmentStatus,
  Message,
  Order,
  OrderStatus,
  OverviewResponse,
  Product,
  Settings,
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
    request<{ settings: Settings; environment: EnvironmentStatus }>('/api/settings'),
  updateSettings: (
    body: Omit<Settings, '_id' | 'updatedAt'>,
  ) =>
    request<{ settings: Settings; environment: EnvironmentStatus }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  verifyFacebookConnection: () =>
    request<{ connected: boolean; pageId?: string; pageName?: string; error?: string }>(
      '/api/settings/verify-facebook',
      { method: 'POST' },
    ),
};
