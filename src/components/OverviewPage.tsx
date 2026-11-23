import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  MessageSquare,
  Package,
} from 'lucide-react';
import { api, subscribeRealtimeEvents } from '../lib/api';
import type { NavSection, OverviewResponse } from '../types';

interface OverviewPageProps {
  onNavigate: (section: NavSection, conversationId?: string) => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OverviewPage({ onNavigate }: OverviewPageProps) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await api.getOverview();
      setData(res);
    } catch (err) {
      if (!silent) {
        setError(err instanceof Error ? err.message : 'Failed to load overview.');
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
    const unsubscribe = subscribeRealtimeEvents({
      onMessageCreated: () => void loadOverview(true),
      onConversationUpdated: () => void loadOverview(true),
      onOrderCreated: () => void loadOverview(true),
      onOrderUpdated: () => void loadOverview(true),
      onReconnect: () => void loadOverview(true),
    });
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadOverview(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const fallbackPoll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadOverview(true);
      }
    }, 15000);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(fallbackPoll);
    };
  }, [loadOverview]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200/90 rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="p-6 space-y-2.5">
              <div className="h-3.5 w-28 bg-slate-100 rounded animate-pulse" />
              <div className="h-7 w-16 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-5 flex items-center justify-between gap-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <p className="text-sm text-red-700">{error || 'Unable to load overview.'}</p>
        <button
          type="button"
          onClick={() => void loadOverview()}
          className="px-3.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
        >
          Retry
        </button>
      </div>
    );
  }

  const { metrics, recentConversations, recentOrders } = data;
  const aiStatusLabel = !metrics.geminiConfigured
    ? 'Missing API Key'
    : metrics.aiGlobalEnabled
      ? 'Active'
      : 'Paused';
  const aiStatusTone = !metrics.geminiConfigured
    ? 'text-red-700'
    : metrics.aiGlobalEnabled
      ? 'text-emerald-700'
      : 'text-amber-700';

  return (
    <div className="space-y-6">
      {/* 4 Essential Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200/90 rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">Total conversations</p>
            <MessageSquare className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2.5 font-display text-[26px] leading-none font-semibold text-slate-900 tabular-nums">
            {metrics.totalConversations}
          </p>
        </div>

        <div className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">Confirmed orders</p>
            <CheckCircle2 className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2.5 font-display text-[26px] leading-none font-semibold text-slate-900 tabular-nums">
            {metrics.confirmedOrders}
          </p>
        </div>

        <div className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">Pending orders</p>
            <Clock className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2.5 font-display text-[26px] leading-none font-semibold text-slate-900 tabular-nums">
            {metrics.pendingOrders}
          </p>
        </div>

        <div className="p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500">AI status</p>
            <Bot className="w-4 h-4 text-slate-400" />
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <span className={`font-display text-xl leading-none font-semibold ${aiStatusTone}`}>
              {aiStatusLabel}
            </span>
            <span className="text-xs text-slate-500 truncate">
              {metrics.facebookPageConnected
                ? metrics.facebookPageName || 'Page connected'
                : 'Page not connected'}
            </span>
          </div>
        </div>
      </div>

      {/* Recent Conversations & Recent Orders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-white border border-slate-200/90 rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="px-5 py-4 border-b border-slate-200/80 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Recent Conversations</h2>
            <button
              type="button"
              onClick={() => onNavigate('conversations')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 cursor-pointer"
            >
              <span>View all</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {recentConversations.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <MessageSquare className="w-6 h-6 text-slate-300 mx-auto mb-2.5" />
              <p className="text-sm font-medium text-slate-700">No conversations yet</p>
              <p className="text-xs text-slate-500 mt-1">
                Incoming Messenger threads or test simulations will appear here.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('conversations')}
                className="mt-4 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
              >
                Open Conversations
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-200/80">
              {recentConversations.map((conv) => (
                <button
                  key={conv._id}
                  type="button"
                  onClick={() => onNavigate('conversations', conv._id)}
                  className="w-full px-5 py-3.5 text-left hover:bg-slate-50/80 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="font-medium text-slate-900 truncate">{conv.customerName}</span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className={`text-xs ${conv.humanTakeover ? 'text-amber-700' : 'text-blue-600'}`}>
                        {conv.humanTakeover ? 'Human takeover' : conv.aiEnabled ? 'AI active' : 'AI paused'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {conv.lastMessageText || 'No messages'}
                    </p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono tabular-nums shrink-0">
                    {formatTime(conv.lastMessageAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="bg-white border border-slate-200/90 rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="px-5 py-4 border-b border-slate-200/80 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Recent Orders</h2>
            <button
              type="button"
              onClick={() => onNavigate('orders')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 cursor-pointer"
            >
              <span>View all</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {recentOrders.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Package className="w-6 h-6 text-slate-300 mx-auto mb-2.5" />
              <p className="text-sm font-medium text-slate-700">No orders placed yet</p>
              <p className="text-xs text-slate-500 mt-1">
                Confirmed orders collected by your AI Sales Agent will appear here.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('products')}
                className="mt-4 px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer"
              >
                Manage Products
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-200/80">
              {recentOrders.map((order) => (
                <button
                  key={order._id}
                  type="button"
                  onClick={() => onNavigate('orders')}
                  className="w-full px-5 py-3.5 text-left hover:bg-slate-50/80 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="font-mono text-xs font-medium text-slate-900 tabular-nums">
                        {order.orderNumber}
                      </span>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className="text-slate-700 truncate">{order.customerName}</span>
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {order.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ')}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-mono font-medium text-slate-900 tabular-nums">
                      {metrics.currency} {order.totalAmount}
                    </p>
                    <p className="text-xs text-slate-500 capitalize mt-0.5">{order.status}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
