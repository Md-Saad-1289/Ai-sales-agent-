import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Bot,
  FileSpreadsheet,
  FileText,
  Lightbulb,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  User,
} from 'lucide-react';
import { api, subscribeRealtimeEvents } from '../lib/api';
import type {
  KnowledgeProposal,
  KnowledgeSource,
  TrainingMessage,
  TrainingSession,
} from '../types';
import { ProposalCard } from './ProposalCard';

function formatShortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TrainingStudioPage() {
  const [sessions, setSessions] = useState<TrainingSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TrainingMessage[]>([]);
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);

  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [streamingReply, setStreamingReply] = useState('');
  const [analyzingGaps, setAnalyzingGaps] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedSessionRef = useRef<string | null>(selectedSessionId);
  selectedSessionRef.current = selectedSessionId;

  const loadSessions = useCallback(async (selectFirst = false) => {
    try {
      const res = await api.listTrainingSessions();
      setSessions(res.sessions);
      if ((selectFirst || !selectedSessionRef.current) && res.sessions.length > 0) {
        setSelectedSessionId(res.sessions[0]._id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load training sessions.');
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  const loadSessionDetail = useCallback(async (sessionId: string, silent = false) => {
    if (!silent) {
      setLoadingDetail(true);
      setError(null);
    }
    try {
      const res = await api.getTrainingSessionDetail(sessionId);
      if (selectedSessionRef.current !== sessionId) return;
      setMessages(res.messages);
      setProposals(res.proposals);
      setSources(res.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session details.');
    } finally {
      if (!silent) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions(true);
  }, [loadSessions]);

  useEffect(() => {
    if (selectedSessionId) {
      void loadSessionDetail(selectedSessionId);
    }
  }, [selectedSessionId, loadSessionDetail]);

  useEffect(() => {
    const unsub = subscribeRealtimeEvents({
      onTrainingSourceUpdated: ({ source }) => {
        if (source.sessionId && source.sessionId !== selectedSessionRef.current) return;
        setSources((prev) => {
          const exists = prev.some((s) => s._id === source._id);
          return exists ? prev.map((s) => (s._id === source._id ? source : s)) : [source, ...prev];
        });
        if (source.status === 'completed' && selectedSessionRef.current) {
          void loadSessionDetail(selectedSessionRef.current, true);
        }
      },
      onTrainingProposalCreated: ({ proposal }) => {
        if (proposal.sessionId && proposal.sessionId !== selectedSessionRef.current) return;
        setProposals((prev) => {
          const exists = prev.some((p) => p._id === proposal._id);
          return exists ? prev.map((p) => (p._id === proposal._id ? proposal : p)) : [...prev, proposal];
        });
      },
    });
    return unsub;
  }, [loadSessionDetail]);

  // Fallback polling while any source is processing
  useEffect(() => {
    const activeSources = sources.filter(
      (s) => s.status !== 'completed' && s.status !== 'failed',
    );
    if (activeSources.length === 0) return;
    const timer = setInterval(() => {
      if (selectedSessionRef.current) {
        void loadSessionDetail(selectedSessionRef.current, true);
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [sources, loadSessionDetail]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingReply]);

  async function handleNewSession() {
    setError(null);
    try {
      const res = await api.createTrainingSession();
      setSessions((prev) => [res.session, ...prev]);
      setSelectedSessionId(res.session._id);
      setMessages([]);
      setProposals([]);
      setSources([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create session.');
    }
  }

  async function submitTrainingPrompt(rawText: string) {
    const trimmed = rawText.trim();
    if (!trimmed || !selectedSessionId || sending) return;

    setSending(true);
    setError(null);
    setStreamingReply('');

    const optimisticUser: TrainingMessage = {
      _id: `temp-${Date.now()}`,
      sessionId: selectedSessionId,
      role: 'admin',
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setInputText('');

    try {
      const result = await api.sendTrainingMessageStream(selectedSessionId, trimmed, (delta) => {
        setStreamingReply((prev) => prev + delta);
      });

      setStreamingReply('');
      setMessages((prev) => {
        const filtered = prev.filter((m) => m._id !== optimisticUser._id);
        return [...filtered, result.userMessage, result.aiMessage];
      });
      if (result.proposals.length > 0) {
        setProposals((prev) => {
          const map = new Map(prev.map((p) => [p._id, p]));
          for (const p of result.proposals) map.set(p._id, p);
          return Array.from(map.values());
        });
      }
      void loadSessions(false);
    } catch (err) {
      setStreamingReply('');
      setMessages((prev) => prev.filter((m) => m._id !== optimisticUser._id));
      setInputText(trimmed);
      setError(err instanceof Error ? err.message : 'Failed to process training message.');
    } finally {
      setSending(false);
    }
  }

  function handleFormSubmit(e: FormEvent) {
    e.preventDefault();
    void submitTrainingPrompt(inputText);
  }

  async function handleFileSelect(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !selectedSessionId) return;
    const file = fileList[0];
    setUploadingFile(true);
    setError(null);
    try {
      const res = await api.uploadTrainingFile(selectedSessionId, file);
      setSources((prev) => [res.source, ...prev]);
      await loadSessionDetail(selectedSessionId, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File upload failed.');
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRunGapAnalysis() {
    if (!selectedSessionId || analyzingGaps) return;
    setAnalyzingGaps(true);
    setError(null);
    try {
      const res = await api.runTrainingGapAnalysis(selectedSessionId);
      setMessages((prev) => [...prev, res.message]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gap analysis failed.');
    } finally {
      setAnalyzingGaps(false);
    }
  }

  function handleProposalUpdated(updated: KnowledgeProposal) {
    setProposals((prev) => prev.map((p) => (p._id === updated._id ? updated : p)));
  }

  const proposalsById = new Map(proposals.map((p) => [p._id, p]));
  const pendingCount = proposals.filter(
    (p) => p.status === 'pending_approval' || p.status === 'clarification_requested',
  ).length;

  return (
    <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_3px_rgba(15,23,42,0.04)] overflow-hidden h-[calc(100vh-8.5rem)] min-h-[540px] flex">
      {/* Left Session Rail */}
      <div className="hidden md:flex w-64 border-r border-slate-200/80 flex-col bg-slate-50/40 shrink-0">
        <div className="p-3 border-b border-slate-200/80 space-y-2">
          <button
            type="button"
            onClick={() => void handleNewSession()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            New Training Session
          </button>
          <button
            type="button"
            disabled={!selectedSessionId || analyzingGaps}
            onClick={() => void handleRunGapAnalysis()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
          >
            <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
            {analyzingGaps ? 'Checking gaps...' : 'Analyze Knowledge Gaps'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto subtle-scroll p-2 space-y-1">
          {loadingSessions ? (
            <div className="py-8 flex justify-center">
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            sessions.map((s) => {
              const active = s._id === selectedSessionId;
              return (
                <button
                  key={s._id}
                  type="button"
                  onClick={() => setSelectedSessionId(s._id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
                    active
                      ? 'bg-blue-50/90 text-blue-900 border border-blue-200/70'
                      : 'hover:bg-slate-100/80 text-slate-700 border border-transparent'
                  }`}
                >
                  <p className="text-xs font-medium truncate">{s.title}</p>
                  <p className="text-[11px] text-slate-500 truncate mt-0.5">
                    {s.lastMessagePreview || 'Empty session'}
                  </p>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Main Messaging Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <div className="px-4 py-3 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-2 bg-white shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 truncate">
                AI Training Studio
              </h2>
              <p className="text-[11px] text-slate-500 truncate">
                Teach rules, upload PDF/CSV/DOCX/XLSX documents, and approve knowledge changes before they go live
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500 tabular-nums">
              {pendingCount} pending {pendingCount === 1 ? 'proposal' : 'proposals'}
            </span>
            <button
              type="button"
              onClick={() => void handleNewSession()}
              className="md:hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>
            <button
              type="button"
              disabled={!selectedSessionId || analyzingGaps}
              onClick={() => void handleRunGapAnalysis()}
              className="md:hidden inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 border border-slate-200 rounded-md cursor-pointer"
            >
              <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
              Gaps
            </button>
          </div>
        </div>

        {/* Active File Upload Status Strip */}
        {sources.length > 0 && (
          <div className="px-4 py-2 bg-slate-50/70 border-b border-slate-200/80 flex flex-wrap gap-3 text-[11px]">
            {sources.slice(0, 3).map((src) => {
              const inProgress = src.status !== 'completed' && src.status !== 'failed';
              return (
                <div
                  key={src._id}
                  className="flex items-center gap-2 px-2.5 py-1 bg-white border border-slate-200/80 rounded-md"
                >
                  {src.fileType === 'csv' || src.fileType === 'xlsx' ? (
                    <FileSpreadsheet className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  ) : (
                    <FileText className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  )}
                  <span className="font-medium text-slate-800 max-w-[140px] truncate">
                    {src.filename}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-500 tabular-nums">{formatBytes(src.sizeBytes)}</span>
                  <span className="text-slate-400">·</span>
                  {inProgress ? (
                    <span className="text-blue-600 font-medium tabular-nums">
                      {src.status} ({src.processedChunks}/{src.totalChunks || '?'})
                    </span>
                  ) : src.status === 'failed' ? (
                    <span className="text-red-600 font-medium">
                      Failed{src.error ? `: ${src.error}` : ''}
                    </span>
                  ) : (
                    <span className="text-emerald-700 font-medium tabular-nums">
                      {src.proposalsCreatedCount} proposals · {src.duplicatesSkippedCount} duplicates
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Messages Feed */}
        <div className="flex-1 overflow-y-auto subtle-scroll p-4 space-y-4 bg-[#f8fafc]/60">
          {loadingDetail ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="max-w-xl mx-auto my-8 bg-white border border-slate-200/90 rounded-xl p-6 space-y-4 text-center">
              <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mx-auto">
                <Bot className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-900">
                  Start Training Your Sales Agent
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Describe sales rules, delivery or warranty policies, add products, or attach a PDF,
                  CSV, DOCX, TXT, or XLSX file. Every change stays a structured proposal until you
                  approve it.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {[
                  'Always explain our 7-day replacement warranty before confirming any order.',
                  'Customers who say the price is too high should receive a value-focused explanation before any discount is discussed.',
                  'Delivery inside Dhaka takes 24-48 hours (70 BDT) and outside Dhaka takes 3-5 days (130 BDT).',
                ].map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => void submitTrainingPrompt(sample)}
                    className="text-left text-[11.5px] text-slate-700 bg-slate-50 hover:bg-blue-50 hover:text-blue-800 border border-slate-200 rounded-lg px-3 py-2 transition-colors cursor-pointer max-w-sm"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const isAdmin = msg.role === 'admin';
              const attachedProposals = (msg.proposalIds ?? [])
                .map((id) => proposalsById.get(id))
                .filter((p): p is KnowledgeProposal => Boolean(p));

              return (
                <div key={msg._id} className="space-y-2.5">
                  <div className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] lg:max-w-[72%] rounded-xl px-4 py-2.5 text-[13px] leading-relaxed ${
                        isAdmin
                          ? 'bg-blue-600 text-white'
                          : msg.role === 'system'
                            ? 'bg-slate-100 border border-slate-200 text-slate-700'
                            : 'bg-white border border-slate-200/90 text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.03)]'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1 text-[10.5px] opacity-80">
                        {isAdmin ? (
                          <User className="w-3 h-3" />
                        ) : (
                          <Bot className="w-3 h-3 text-blue-600" />
                        )}
                        <span className="font-medium">
                          {isAdmin ? 'You' : msg.role === 'system' ? 'Document Processor' : 'Training AI'}
                        </span>
                        <span>·</span>
                        <span className="tabular-nums">{formatShortTime(msg.createdAt)}</span>
                        {msg.intent && !isAdmin && (
                          <>
                            <span>·</span>
                            <span className="font-mono">{msg.intent}</span>
                          </>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                    </div>
                  </div>

                  {/* Inline Proposal Cards */}
                  {attachedProposals.length > 0 && (
                    <div className="max-w-[92%] lg:max-w-[82%] space-y-2.5 pl-1">
                      {attachedProposals.map((prop) => (
                        <ProposalCard
                          key={prop._id}
                          proposal={prop}
                          onUpdated={handleProposalUpdated}
                        />
                      ))}
                    </div>
                  )}

                  {/* Gap Suggestion Quick Prompts */}
                  {msg.gapSuggestions && msg.gapSuggestions.length > 0 && (
                    <div className="max-w-[92%] lg:max-w-[82%] pl-1 space-y-2">
                      {msg.gapSuggestions.map((gap, idx) => (
                        <div
                          key={`${gap.topic}-${idx}`}
                          className="bg-white border border-slate-200/90 rounded-lg p-3 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900">
                              {gap.topic}{' '}
                              <span className="font-normal text-slate-500">· {gap.category}</span>
                            </p>
                            <p className="text-[11.5px] text-slate-600 mt-0.5">{gap.reason}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setInputText(gap.suggestedPrompt)}
                            className="px-2.5 py-1.5 text-[11.5px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer shrink-0"
                          >
                            Use Prompt
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Live streaming AI bubble */}
          {streamingReply && (
            <div className="flex justify-start">
              <div className="max-w-[85%] lg:max-w-[72%] rounded-xl px-4 py-2.5 text-[13px] leading-relaxed bg-white border border-slate-200/90 text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="flex items-center gap-1.5 mb-1 text-[10.5px] text-slate-500">
                  <Bot className="w-3 h-3 text-blue-600" />
                  <span className="font-medium">Training AI</span>
                  <span>·</span>
                  <span>Streaming...</span>
                </div>
                <p className="whitespace-pre-wrap">{streamingReply}</p>
              </div>
            </div>
          )}

          {sending && !streamingReply && (
            <div className="flex justify-start">
              <div className="rounded-xl px-4 py-2.5 bg-white border border-slate-200/90 text-xs text-slate-500 flex items-center gap-2">
                <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                Analyzing instruction and checking existing knowledge...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Error strip */}
        {error && (
          <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-xs text-red-700 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-700 font-medium underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={handleFormSubmit}
          className="p-3 border-t border-slate-200/80 bg-white flex items-end gap-2 shrink-0"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.csv,.docx,.xlsx"
            className="hidden"
            onChange={(e) => void handleFileSelect(e.target.files)}
          />
          <button
            type="button"
            disabled={!selectedSessionId || uploadingFile}
            onClick={() => fileInputRef.current?.click()}
            title="Upload PDF, CSV, TXT, DOCX, or XLSX"
            className="p-2.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <textarea
            rows={1}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submitTrainingPrompt(inputText);
              }
            }}
            placeholder={
              uploadingFile
                ? 'Uploading document...'
                : 'Teach a sales rule, policy, or product update... (Enter to send, Shift+Enter for new line)'
            }
            disabled={!selectedSessionId || sending}
            className="flex-1 resize-none px-3.5 py-2.5 text-[13px] bg-slate-50/70 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 max-h-32"
          />

          <button
            type="submit"
            disabled={!selectedSessionId || sending || !inputText.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
