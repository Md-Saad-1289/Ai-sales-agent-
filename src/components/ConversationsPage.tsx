import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Bot,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Send,
  User,
  UserCheck,
  X,
} from 'lucide-react';
import { api, subscribeRealtimeEvents } from '../lib/api';
import type { Conversation, Customer, Message, Order } from '../types';

interface ConversationsPageProps {
  initialConversationId?: string | null;
}

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function upsertSortedConversation(list: Conversation[], updated: Conversation): Conversation[] {
  const idx = list.findIndex((c) => c._id === updated._id);
  const next = idx === -1 ? [updated, ...list] : list.map((c) => (c._id === updated._id ? updated : c));
  return [...next].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );
}

function mergeMessageUnique(list: Message[], incoming: Message): Message[] {
  const incomingId = incoming.message_id || incoming._id;
  if (list.some((m) => (m.message_id || m._id) === incomingId)) {
    return list.map((m) => ((m.message_id || m._id) === incomingId ? incoming : m));
  }
  return [...list, incoming].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export function ConversationsPage({ initialConversationId }: ConversationsPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId || null);
  const [filter, setFilter] = useState<'all' | 'ai_active' | 'human_takeover'>('all');
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(true);

  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerOrders, setCustomerOrders] = useState<Order[]>([]);
  const [withinWindow, setWithinWindow] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [togglingAI, setTogglingAI] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test AI Agent modal state
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testSenderName, setTestSenderName] = useState('Arafat Rahman');
  const [testSenderId, setTestSenderId] = useState('sim_arafat_01');
  const [testMessage, setTestMessage] = useState('');
  const [sendingTest, setSendingTest] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const filterRef = useRef(filter);
  const searchRef = useRef(search);
  const detailSeqRef = useRef(0);
  const skipNextAutoScrollRef = useRef(false);

  selectedIdRef.current = selectedId;
  filterRef.current = filter;
  searchRef.current = search;

  const loadList = useCallback(async (preserveSelection = true) => {
    try {
      const res = await api.listConversations({
        filter: filterRef.current,
        search: searchRef.current.trim() || undefined,
      });
      setConversations(res.conversations);
      if (!preserveSelection && res.conversations.length > 0 && !selectedIdRef.current) {
        setSelectedId(res.conversations[0]._id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    const seq = ++detailSeqRef.current;
    if (!silent) {
      setLoadingDetail(true);
      setError(null);
    }
    try {
      const res = await api.getConversationDetail(id, { limit: 100 });
      if (seq !== detailSeqRef.current || selectedIdRef.current !== id) return;
      setActiveConv(res.conversation);
      setMessages(res.messages);
      setHasMoreMessages(res.hasMore);
      setNextCursor(res.nextCursor);
      setCustomer(res.customer);
      setCustomerOrders(res.customerOrders);
      setWithinWindow(res.withinMessagingWindow);
    } catch (err) {
      if (!silent && seq === detailSeqRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load conversation.');
      }
    } finally {
      if (!silent && seq === detailSeqRef.current) {
        setLoadingDetail(false);
      }
    }
  }, []);

  async function handleLoadOlder() {
    if (!selectedId || !nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await api.getConversationDetail(selectedId, { limit: 50, before: nextCursor });
      if (selectedIdRef.current !== selectedId) return;
      skipNextAutoScrollRef.current = true;
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.message_id || m._id));
        const older = res.messages.filter((m) => !existingIds.has(m.message_id || m._id));
        return [...older, ...prev];
      });
      setHasMoreMessages(res.hasMore);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load earlier messages.');
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadList(false);
    }, search ? 200 : 0);
    return () => clearTimeout(timer);
  }, [filter, search, loadList]);

  useEffect(() => {
    if (initialConversationId) {
      setSelectedId(initialConversationId);
    }
  }, [initialConversationId]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId);
    } else {
      setActiveConv(null);
      setMessages([]);
      setHasMoreMessages(false);
      setNextCursor(null);
      setCustomer(null);
      setCustomerOrders([]);
    }
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    const unsubscribe = subscribeRealtimeEvents({
      onMessageCreated: ({ conversationId, message, conversation }) => {
        if (conversation) {
          const matchesFilter =
            filterRef.current === 'all' ||
            (filterRef.current === 'ai_active' && conversation.aiEnabled && !conversation.humanTakeover) ||
            (filterRef.current === 'human_takeover' && conversation.humanTakeover);
          const q = searchRef.current.trim().toLowerCase();
          const matchesSearch =
            !q ||
            conversation.customerName.toLowerCase().includes(q) ||
            conversation.messengerId.toLowerCase().includes(q) ||
            conversation.lastMessageText.toLowerCase().includes(q);

          if (matchesFilter && matchesSearch) {
            setConversations((prev) => upsertSortedConversation(prev, conversation));
          } else {
            setConversations((prev) => prev.filter((c) => c._id !== conversation._id));
          }
        } else {
          void loadList(true);
        }

        if (selectedIdRef.current === conversationId) {
          setMessages((prev) => mergeMessageUnique(prev, message));
          if (conversation) {
            setActiveConv(conversation);
            setWithinWindow(true);
          }
        }
      },
      onConversationUpdated: ({ conversation }) => {
        const matchesFilter =
          filterRef.current === 'all' ||
          (filterRef.current === 'ai_active' && conversation.aiEnabled && !conversation.humanTakeover) ||
          (filterRef.current === 'human_takeover' && conversation.humanTakeover);

        if (matchesFilter) {
          setConversations((prev) => upsertSortedConversation(prev, conversation));
        } else {
          setConversations((prev) => prev.filter((c) => c._id !== conversation._id));
        }

        if (selectedIdRef.current === conversation._id) {
          setActiveConv(conversation);
        }
      },
      onOrderCreated: ({ order }) => {
        if (selectedIdRef.current === order.conversationId) {
          setCustomerOrders((prev) => {
            if (prev.some((o) => o._id === order._id)) return prev;
            return [order, ...prev];
          });
        }
      },
      onReconnect: () => {
        void loadList(true);
        if (selectedIdRef.current) {
          void loadDetail(selectedIdRef.current, true);
        }
      },
    });

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadList(true);
        if (selectedIdRef.current) {
          void loadDetail(selectedIdRef.current, true);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const fallbackPoll = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadList(true);
        if (selectedIdRef.current) {
          void loadDetail(selectedIdRef.current, true);
        }
      }
    }, 15000);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(fallbackPoll);
    };
  }, [loadList, loadDetail]);

  async function handleToggleAI(enableAI: boolean) {
    if (!activeConv) return;
    setTogglingAI(true);
    setError(null);
    try {
      const res = await api.toggleConversationAI(activeConv._id, {
        aiEnabled: enableAI,
        humanTakeover: !enableAI,
      });
      setActiveConv(res.conversation);
      setConversations((prev) =>
        prev.map((c) => (c._id === res.conversation._id ? res.conversation : c)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update AI state.');
    } finally {
      setTogglingAI(false);
    }
  }

  async function handleSendManualReply(e: FormEvent) {
    e.preventDefault();
    if (!activeConv || !replyText.trim()) return;
    setSendingReply(true);
    setError(null);
    try {
      const res = await api.sendAdminMessage(activeConv._id, replyText.trim());
      setMessages((prev) => mergeMessageUnique(prev, res.message));
      setActiveConv(res.conversation);
      setConversations((prev) => upsertSortedConversation(prev, res.conversation));
      setReplyText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reply.');
    } finally {
      setSendingReply(false);
    }
  }

  async function handleSendTestMessage(e: FormEvent) {
    e.preventDefault();
    if (!testMessage.trim()) return;
    setSendingTest(true);
    setError(null);
    try {
      const res = await api.sendTestCustomerMessage({
        senderId: testSenderId.trim() || 'sim_test_customer',
        senderName: testSenderName.trim() || 'Test Customer',
        text: testMessage.trim(),
      });
      setTestMessage('');
      setTestModalOpen(false);
      await loadList(true);
      setSelectedId(res.conversationId);
      await loadDetail(res.conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run AI test.');
    } finally {
      setSendingTest(false);
    }
  }

  const visibleConversations = conversations.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      c.customerName.toLowerCase().includes(q) ||
      c.messengerId.toLowerCase().includes(q) ||
      c.lastMessageText.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4">
      {error && (
        <div className="px-4 py-2.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-700 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="bg-white border border-slate-200/90 rounded-xl overflow-hidden h-[calc(100vh-8.75rem)] min-h-[540px] flex shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        {/* Left Panel: Conversation List */}
        <div
          className={`w-full md:w-80 border-r border-slate-200/80 flex flex-col shrink-0 ${
            selectedId ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="p-3.5 border-b border-slate-200/80 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
              <button
                type="button"
                onClick={() => setTestModalOpen(true)}
                title="Test AI Agent"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors cursor-pointer shrink-0"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
                <span>Test</span>
              </button>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200/60 rounded-lg">
              {(
                [
                  { id: 'all', label: 'All' },
                  { id: 'ai_active', label: 'AI Active' },
                  { id: 'human_takeover', label: 'Human' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  className={`flex-1 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    filter === tab.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 subtle-scroll">
            {loadingList ? (
              <div className="p-4 space-y-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : visibleConversations.length === 0 ? (
              <div className="p-8 text-center">
                <MessageSquare className="w-5 h-5 text-slate-300 mx-auto mb-2" />
                <p className="text-xs font-medium text-slate-700">No conversations</p>
                <p className="text-xs text-slate-500 mt-1">
                  Connect your Page webhook or click Test to simulate a customer chat.
                </p>
                <button
                  type="button"
                  onClick={() => setTestModalOpen(true)}
                  className="mt-3.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
                >
                  Test AI Agent
                </button>
              </div>
            ) : (
              visibleConversations.map((conv) => {
                const isSelected = conv._id === selectedId;
                return (
                  <button
                    key={conv._id}
                    type="button"
                    onClick={() => setSelectedId(conv._id)}
                    className={`w-full px-3.5 py-3 text-left transition-colors flex items-start gap-3 cursor-pointer ${
                      isSelected ? 'bg-blue-50/75' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 mt-0.5 ${
                        isSelected
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-700 border border-slate-200/80'
                      }`}
                    >
                      {getInitials(conv.customerName)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-slate-900 truncate">
                          {conv.customerName}
                        </span>
                        <span className="text-[11px] font-mono text-slate-400 tabular-nums shrink-0">
                          {formatShortTime(conv.lastMessageAt)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {conv.lastMessageText || 'No messages yet'}
                      </p>
                      <div className="flex items-center justify-between mt-1 text-[11px]">
                        <span
                          className={
                            conv.humanTakeover
                              ? 'text-amber-700 font-medium'
                              : conv.aiEnabled
                                ? 'text-blue-600'
                                : 'text-slate-500'
                          }
                        >
                          {conv.humanTakeover
                            ? 'Human takeover'
                            : conv.aiEnabled
                              ? 'AI active'
                              : 'AI paused'}
                        </span>
                        {conv.unreadCount > 0 && (
                          <span className="font-mono font-semibold text-blue-600 tabular-nums">
                            {conv.unreadCount} new
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Center Panel: Active Thread */}
        <div
          className={`flex-1 flex flex-col min-w-0 ${
            selectedId ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!activeConv ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-slate-50/40">
              <MessageSquare className="w-7 h-7 text-slate-300 mb-2.5" />
              <p className="text-sm font-medium text-slate-700">Select a conversation</p>
              <p className="text-xs text-slate-500 mt-1">
                Choose a thread from the left or simulate a customer message.
              </p>
              <button
                type="button"
                onClick={() => setTestModalOpen(true)}
                className="mt-4 px-3.5 py-2 text-xs font-medium text-blue-600 bg-white border border-blue-200 hover:bg-blue-50 rounded-lg transition-colors cursor-pointer"
              >
                Simulate Customer Message
              </button>
            </div>
          ) : (
            <>
              {/* Thread Header */}
              <div className="px-5 py-3.5 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3 bg-white">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="Back to conversations"
                    className="md:hidden p-1.5 text-slate-500 hover:text-slate-900 rounded-md cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 text-slate-700 text-[11px] font-semibold hidden sm:flex items-center justify-center shrink-0">
                    {getInitials(activeConv.customerName)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-slate-900 truncate">
                        {activeConv.customerName}
                      </h2>
                      <span className="text-slate-300" aria-hidden="true">·</span>
                      <span className="text-xs font-mono text-slate-500 truncate">
                        {activeConv.messengerId}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {withinWindow ? 'Within 24h Messenger window' : '24h window expired'}
                      {activeConv.handoverReason ? ` · ${activeConv.handoverReason}` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {activeConv.aiEnabled && !activeConv.humanTakeover ? (
                    <button
                      type="button"
                      disabled={togglingAI}
                      onClick={() => void handleToggleAI(false)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Human Takeover</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={togglingAI}
                      onClick={() => void handleToggleAI(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <Bot className="w-3.5 h-3.5" />
                      <span>Resume AI</span>
                    </button>
                  )}

                  {activeConv.messengerId.startsWith('sim_') && (
                    <button
                      type="button"
                      onClick={() => {
                        setTestSenderId(activeConv.messengerId);
                        setTestSenderName(activeConv.customerName);
                        setTestModalOpen(true);
                      }}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                    >
                      Send as Customer
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setShowProfile((v) => !v)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
                      showProfile
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <User className="w-3.5 h-3.5" />
                    <span>Customer</span>
                  </button>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4 bg-slate-50/50 subtle-scroll">
                {hasMoreMessages && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      disabled={loadingOlder}
                      onClick={() => void handleLoadOlder()}
                      className="px-3 py-1 text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer disabled:opacity-50"
                    >
                      {loadingOlder ? 'Loading...' : 'Load earlier messages'}
                    </button>
                  </div>
                )}
                {loadingDetail && messages.length === 0 ? (
                  <div className="space-y-3">
                    <div className="h-12 w-2/3 bg-slate-100 rounded-xl animate-pulse" />
                    <div className="h-12 w-2/3 ml-auto bg-slate-100 rounded-xl animate-pulse" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-8">No messages in this thread.</p>
                ) : (
                  messages.map((msg) => {
                    const senderType = msg.sender_type ?? msg.sender;
                    const msgText = msg.message_text ?? msg.text;
                    const msgTime = msg.timestamp ?? msg.createdAt;
                    const msgDelivery = msg.delivery_status ?? msg.deliveryStatus;
                    const isCustomer = senderType === 'customer';
                    return (
                      <div
                        key={msg.message_id || msg._id}
                        className={`flex flex-col ${isCustomer ? 'items-start' : 'items-end'}`}
                      >
                        <div className="flex items-center gap-1.5 mb-1 px-1 text-[11px] text-slate-500">
                          <span className="font-medium">
                            {isCustomer
                              ? activeConv.customerName
                              : senderType === 'ai'
                                ? 'AI Sales Agent'
                                : 'Admin'}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">{formatShortTime(msgTime)}</span>
                          {msgDelivery === 'failed' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-red-600">Delivery failed</span>
                            </>
                          )}
                        </div>
                        <div
                          className={`max-w-[76%] px-4 py-2.5 text-[13.5px] whitespace-pre-wrap leading-relaxed ${
                            isCustomer
                              ? 'bg-white border border-slate-200/90 text-slate-900 rounded-2xl rounded-tl-sm shadow-[0_1px_2px_rgba(15,23,42,0.03)]'
                              : senderType === 'ai'
                                ? 'bg-blue-600 text-white rounded-2xl rounded-tr-sm shadow-[0_1px_2px_rgba(37,99,235,0.2)]'
                                : 'bg-slate-900 text-white rounded-2xl rounded-tr-sm'
                          }`}
                        >
                          {msgText}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Reply Composer */}
              <form
                onSubmit={handleSendManualReply}
                className="p-3.5 border-t border-slate-200/80 bg-white flex items-center gap-2.5"
              >
                <input
                  type="text"
                  value={replyText}
                  disabled={!withinWindow || sendingReply}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder={
                    withinWindow
                      ? 'Reply manually (pauses AI automatically)...'
                      : 'Meta 24-hour messaging window expired'
                  }
                  className="flex-1 px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 disabled:opacity-60"
                />
                <button
                  type="submit"
                  disabled={!withinWindow || sendingReply || !replyText.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg shadow-[0_1px_2px_rgba(37,99,235,0.25)] transition-colors cursor-pointer shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{sendingReply ? 'Sending...' : 'Send'}</span>
                </button>
              </form>
            </>
          )}
        </div>

        {/* Right Panel: Customer Profile & Purchase History */}
        {activeConv && showProfile && (
          <aside className="w-72 border-l border-slate-200/80 bg-white flex flex-col overflow-y-auto shrink-0 subtle-scroll">
            <div className="px-4 py-3.5 border-b border-slate-200/80 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-900">Customer Profile</h3>
              <button
                type="button"
                onClick={() => setShowProfile(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="p-4 space-y-5 text-xs">
              <div className="space-y-1">
                <p className="text-slate-500">Name</p>
                <p className="text-sm font-medium text-slate-900">{customer?.name || activeConv.customerName}</p>
                <p className="font-mono text-slate-500">ID: {activeConv.messengerId}</p>
              </div>

              {customer?.phone && (
                <div className="space-y-0.5">
                  <p className="text-slate-500">Phone</p>
                  <p className="font-mono text-slate-900 tabular-nums">{customer.phone}</p>
                </div>
              )}

              {customer?.address && (
                <div className="space-y-0.5">
                  <p className="text-slate-500">Address</p>
                  <p className="text-slate-800 leading-relaxed">{customer.address}</p>
                </div>
              )}

              <div className="space-y-1 border-t border-slate-200/80 pt-4">
                <p className="text-slate-500">Buying Intent</p>
                <p className="font-medium text-slate-900 capitalize">
                  {(customer?.buyingIntent || 'unknown').replace(/_/g, ' ')}
                </p>
              </div>

              <div className="space-y-1.5 border-t border-slate-200/80 pt-4">
                <p className="text-slate-500">Preferences</p>
                {customer && customer.preferences.length > 0 ? (
                  <p className="text-slate-800 leading-relaxed">
                    {customer.preferences.join(' · ')}
                  </p>
                ) : (
                  <p className="text-slate-400">No preferences captured yet.</p>
                )}
              </div>

              <div className="space-y-2 border-t border-slate-200/80 pt-4">
                <p className="text-slate-500">Purchase History</p>
                {customerOrders.length === 0 ? (
                  <p className="text-slate-400">No past orders.</p>
                ) : (
                  <div className="space-y-2.5">
                    {customerOrders.map((ord) => (
                      <div key={ord._id} className="pb-2.5 border-b border-slate-100 last:border-b-0">
                        <div className="flex justify-between font-mono text-slate-900 tabular-nums">
                          <span>{ord.orderNumber}</span>
                          <span>{ord.totalAmount}</span>
                        </div>
                        <p className="text-slate-500 capitalize mt-0.5">
                          {ord.status} · {new Date(ord.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* Test AI Agent Modal */}
      {testModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md shadow-lg">
            <div className="px-6 py-4 border-b border-slate-200/80 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Simulate Customer Message</h2>
              <button
                type="button"
                onClick={() => setTestModalOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSendTestMessage} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Customer Name
                  </label>
                  <input
                    type="text"
                    required
                    value={testSenderName}
                    onChange={(e) => setTestSenderName(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Test Sender ID
                  </label>
                  <input
                    type="text"
                    required
                    value={testSenderId}
                    onChange={(e) => setTestSenderId(e.target.value)}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Customer Message
                </label>
                <textarea
                  rows={3}
                  required
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder="ভাইয়া, ২০০০ টাকার মধ্যে কোনো প্রোডাক্ট আছে?"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>
              <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-200/80">
                <button
                  type="button"
                  onClick={() => setTestModalOpen(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sendingTest}
                  className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg shadow-[0_1px_2px_rgba(37,99,235,0.25)] cursor-pointer"
                >
                  {sendingTest ? 'Running AI...' : 'Send Message'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
