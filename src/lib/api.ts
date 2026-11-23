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

let inMemoryToken: string | null = null;
let onUnauthorizedHandler: (() => void) | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorizedHandler = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (res.status === 401 && inMemoryToken) {
    inMemoryToken = null;
    onUnauthorizedHandler?.();
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

export const api = {
  getAuthStatus: () => request<AuthBootstrapStatus>('/api/auth/status'),
  claimAdmin: (body: { email: string; name: string; password: string }) =>
    request<{ token: string; admin: AdminUser }>('/api/auth/claim', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  login: (body: { email?: string; password: string }) =>
    request<{ token: string; admin: AdminUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
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
  getConversationDetail: (id: string) =>
    request<{
      conversation: Conversation;
      withinMessagingWindow: boolean;
      messages: Message[];
      customer: Customer | null;
      customerOrders: Order[];
    }>(`/api/conversations/${encodeURIComponent(id)}`),
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
