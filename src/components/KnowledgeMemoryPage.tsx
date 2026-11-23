import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Clock,
  Edit3,
  FileCode,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Trash2,
} from 'lucide-react';
import { api, subscribeRealtimeEvents } from '../lib/api';
import type {
  AuditLog,
  KnowledgeCategory,
  KnowledgeEntry,
  KnowledgeProposal,
  KnowledgeVersion,
  MemoryScript,
} from '../types';
import { ProposalCard } from './ProposalCard';

const CATEGORIES: KnowledgeCategory[] = [
  'Sales Behavior',
  'Communication Rules',
  'Customer Handling',
  'Product Knowledge',
  'Business Policies',
  'Delivery Policies',
  'Payment Policies',
  'Warranty & Return Policies',
  'Sales Strategies',
  'Frequently Asked Questions',
  'Other Business Knowledge',
];

type TabId = 'master' | 'script' | 'proposals' | 'audit';

function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function KnowledgeMemoryPage() {
  const [tab, setTab] = useState<TabId>('master');

  // Master Memory state
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailEntry, setDetailEntry] = useState<KnowledgeEntry | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [related, setRelated] = useState<KnowledgeEntry[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<KnowledgeCategory | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'approved' | 'archived'>('approved');
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Edit & Delete confirmation state
  const [editingEntry, setEditingEntry] = useState(false);
  const [editCategory, setEditCategory] = useState<KnowledgeCategory>('Other Business Knowledge');
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRulesText, setEditRulesText] = useState('');
  const [editPriority, setEditPriority] = useState(3);
  const [editReason, setEditReason] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmChecked, setDeleteConfirmChecked] = useState(false);
  const [deleteReason, setDeleteReason] = useState('');

  // Layer B Short Memory Script state
  const [activeScript, setActiveScript] = useState<MemoryScript | null>(null);
  const [scriptVersions, setScriptVersions] = useState<MemoryScript[]>([]);
  const [scriptText, setScriptText] = useState('');
  const [tokenBudget, setTokenBudget] = useState(900);
  const [savingScript, setSavingScript] = useState(false);

  // Proposals state
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [proposalFilter, setProposalFilter] = useState<'pending_approval' | 'all'>('pending_approval');

  // Audit Log state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await api.listKnowledge({
        category: categoryFilter,
        status: statusFilter,
        search: search.trim() || undefined,
      });
      setEntries(res.entries);
      if (res.entries.length > 0 && !res.entries.some((e) => e._id === selectedId)) {
        setSelectedId(res.entries[0]._id);
      } else if (res.entries.length === 0) {
        setSelectedId(null);
        setDetailEntry(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge memory.');
    } finally {
      setLoadingList(false);
    }
  }, [categoryFilter, statusFilter, search, selectedId]);

  const loadEntryDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await api.getKnowledgeDetail(id);
      setDetailEntry(res.entry);
      setVersions(res.versions);
      setRelated(res.related);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load entry detail.');
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const loadScript = useCallback(async () => {
    try {
      const res = await api.getMemoryScript();
      setActiveScript(res.activeScript);
      setScriptVersions(res.versions);
      setScriptText(res.activeScript.scriptText);
      setTokenBudget(res.activeScript.tokenBudget);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load short memory script.');
    }
  }, []);

  const loadProposals = useCallback(async () => {
    try {
      const res = await api.listProposals(
        proposalFilter === 'pending_approval' ? { status: 'pending_approval' } : undefined,
      );
      setProposals(res.proposals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load proposals.');
    }
  }, [proposalFilter]);

  const loadAuditLogs = useCallback(async () => {
    try {
      const res = await api.listAuditLogs(80);
      setAuditLogs(res.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit logs.');
    }
  }, []);

  useEffect(() => {
    if (tab === 'master') void loadEntries();
    else if (tab === 'script') void loadScript();
    else if (tab === 'proposals') void loadProposals();
    else if (tab === 'audit') void loadAuditLogs();
  }, [tab, loadEntries, loadScript, loadProposals, loadAuditLogs]);

  useEffect(() => {
    if (tab === 'master' && selectedId) {
      void loadEntryDetail(selectedId);
    }
  }, [tab, selectedId, loadEntryDetail]);

  useEffect(() => {
    const unsub = subscribeRealtimeEvents({
      onKnowledgeUpdated: () => {
        if (tab === 'master') void loadEntries();
      },
      onMemoryScriptUpdated: ({ script }) => {
        setActiveScript(script);
        setScriptText(script.scriptText);
      },
      onTrainingProposalCreated: () => {
        if (tab === 'proposals') void loadProposals();
      },
    });
    return unsub;
  }, [tab, loadEntries, loadProposals]);

  function openEditModal() {
    if (!detailEntry) return;
    setEditCategory(detailEntry.category);
    setEditTitle(detailEntry.title);
    setEditDescription(detailEntry.description);
    setEditRulesText(detailEntry.rules.join('\n'));
    setEditPriority(detailEntry.priority);
    setEditReason('');
    setEditingEntry(true);
  }

  async function handleSaveEntry() {
    if (!detailEntry) return;
    const rules = editRulesText
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    if (!editTitle.trim() || !editDescription.trim() || rules.length === 0) {
      setError('Title, description, and at least one rule are required.');
      return;
    }
    setSavingEntry(true);
    setError(null);
    try {
      await api.updateKnowledgeEntry(detailEntry._id, {
        category: editCategory,
        title: editTitle.trim(),
        description: editDescription.trim(),
        rules,
        priority: editPriority,
        changeReason: editReason.trim() || 'Manual admin edit',
      });
      setEditingEntry(false);
      await loadEntries();
      await loadEntryDetail(detailEntry._id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update entry.');
    } finally {
      setSavingEntry(false);
    }
  }

  async function handleConfirmDelete() {
    if (!detailEntry || !deleteConfirmChecked) return;
    setSavingEntry(true);
    setError(null);
    try {
      await api.deleteKnowledgeEntry(detailEntry._id, deleteReason.trim() || undefined);
      setDeleteModalOpen(false);
      setDeleteConfirmChecked(false);
      setDeleteReason('');
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive entry.');
    } finally {
      setSavingEntry(false);
    }
  }

  async function handleRestoreEntry(id: string) {
    setSavingEntry(true);
    setError(null);
    try {
      await api.restoreKnowledgeEntry(id);
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore entry.');
    } finally {
      setSavingEntry(false);
    }
  }

  async function handleRegenerateScript() {
    setSavingScript(true);
    setError(null);
    try {
      const res = await api.regenerateMemoryScript(tokenBudget);
      setActiveScript(res.activeScript);
      setScriptText(res.activeScript.scriptText);
      await loadScript();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate script.');
    } finally {
      setSavingScript(false);
    }
  }

  async function handleSaveScript() {
    setSavingScript(true);
    setError(null);
    try {
      const res = await api.updateMemoryScript(scriptText, tokenBudget);
      setActiveScript(res.activeScript);
      await loadScript();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save script.');
    } finally {
      setSavingScript(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Top Segmented Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex bg-white border border-slate-200/90 rounded-lg p-1 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          {(
            [
              { id: 'master', label: 'Master Memory (Layer A)' },
              { id: 'script', label: 'Short Memory Script (Layer B)' },
              { id: 'proposals', label: 'Pending Proposals' },
              { id: 'audit', label: 'Audit Log' },
            ] as Array<{ id: TabId; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                tab === item.id
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-1.5">
            {error}
          </div>
        )}
      </div>

      {/* TAB 1: MASTER MEMORY (LAYER A) */}
      {tab === 'master' && (
        <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_3px_rgba(15,23,42,0.04)] overflow-hidden min-h-[540px] grid grid-cols-1 lg:grid-cols-12">
          {/* Left Filter & List */}
          <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-200/80 flex flex-col">
            <div className="p-3.5 border-b border-slate-200/80 space-y-2.5">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search rules, policies, tags..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50/70 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as KnowledgeCategory | 'all')}
                  className="flex-1 px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-500"
                >
                  <option value="all">All 11 Categories</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <div className="inline-flex border border-slate-200 rounded-lg p-0.5 bg-slate-50">
                  <button
                    type="button"
                    onClick={() => setStatusFilter('approved')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md cursor-pointer ${
                      statusFilter === 'approved' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                    }`}
                  >
                    Active
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter('archived')}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md cursor-pointer ${
                      statusFilter === 'archived' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
                    }`}
                  >
                    Archived
                  </button>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto subtle-scroll divide-y divide-slate-100 max-h-[540px]">
              {loadingList ? (
                <div className="py-12 flex justify-center">
                  <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : entries.length === 0 ? (
                <div className="py-12 px-4 text-center text-xs text-slate-500">
                  No {statusFilter === 'archived' ? 'archived' : 'approved'} knowledge entries
                  match the current filter.
                </div>
              ) : (
                entries.map((entry) => {
                  const selected = entry._id === selectedId;
                  return (
                    <button
                      key={entry._id}
                      type="button"
                      onClick={() => setSelectedId(entry._id)}
                      className={`w-full text-left p-3.5 transition-colors cursor-pointer ${
                        selected ? 'bg-blue-50/70' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="font-medium text-blue-700 truncate">{entry.category}</span>
                        <span className="font-mono tabular-nums shrink-0">
                          v{entry.version} · P{entry.priority}
                        </span>
                      </div>
                      <p className="text-[13px] font-semibold text-slate-900 mt-1 line-clamp-1">
                        {entry.title}
                      </p>
                      <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">
                        {entry.description}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Entry Inspector */}
          <div className="lg:col-span-7 p-5 overflow-y-auto subtle-scroll max-h-[640px]">
            {loadingDetail ? (
              <div className="h-full flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !detailEntry ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                Select a knowledge entry to inspect its rules, provenance, and version history.
              </div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                      <span className="text-blue-700 font-semibold">{detailEntry.category}</span>
                      <span>·</span>
                      <span>v{detailEntry.version}</span>
                      <span>·</span>
                      <span>Priority {detailEntry.priority}</span>
                      <span>·</span>
                      <span>{detailEntry.status === 'archived' ? 'Archived' : 'Approved'}</span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-900">{detailEntry.title}</h3>
                  </div>

                  <div className="flex items-center gap-2">
                    {detailEntry.status === 'approved' ? (
                      <>
                        <button
                          type="button"
                          onClick={openEditModal}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteModalOpen(true);
                            setDeleteConfirmChecked(false);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 rounded-lg cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={savingEntry}
                        onClick={() => void handleRestoreEntry(detailEntry._id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore Entry
                      </button>
                    )}
                  </div>
                </div>

                {/* Edit form inline */}
                {editingEntry && (
                  <div className="border border-slate-200 rounded-xl p-4 bg-slate-50/70 space-y-3">
                    <h4 className="text-xs font-semibold text-slate-900">Edit Approved Entry</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          Category
                        </label>
                        <select
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value as KnowledgeCategory)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-600 mb-1">
                          Priority (1–5)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={editPriority}
                          onChange={(e) => setEditPriority(Number(e.target.value) || 3)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Title
                      </label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Description
                      </label>
                      <textarea
                        rows={2}
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Rules (one per line)
                      </label>
                      <textarea
                        rows={4}
                        value={editRulesText}
                        onChange={(e) => setEditRulesText(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Change Reason
                      </label>
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        placeholder="Why is this entry being updated?"
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingEntry(false)}
                        className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingEntry}
                        onClick={() => void handleSaveEntry()}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md cursor-pointer disabled:opacity-50"
                      >
                        {savingEntry ? 'Saving...' : 'Save New Version'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Delete explicit confirmation dialog inline */}
                {deleteModalOpen && (
                  <div className="border border-red-200 bg-red-50/70 rounded-xl p-4 space-y-2.5">
                    <div className="flex items-start gap-2 text-red-900">
                      <Archive className="w-4 h-4 mt-0.5 shrink-0" />
                      <div className="text-xs">
                        <p className="font-semibold">Archive & Remove from Active Memory</p>
                        <p className="text-red-700 mt-0.5">
                          Archived entries remain recoverable in the Archived tab and preserve
                          immutable version history.
                        </p>
                      </div>
                    </div>
                    <input
                      type="text"
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="Reason for deletion/archive (optional)"
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-red-200 rounded-md"
                    />
                    <label className="flex items-center gap-2 text-xs text-red-900 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteConfirmChecked}
                        onChange={(e) => setDeleteConfirmChecked(e.target.checked)}
                        className="rounded border-red-300 text-red-600"
                      />
                      <span>Confirm archiving &ldquo;{detailEntry.title}&rdquo;</span>
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setDeleteModalOpen(false)}
                        className="px-3 py-1.5 text-xs text-slate-700 bg-white border border-slate-200 rounded-md cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!deleteConfirmChecked || savingEntry}
                        onClick={() => void handleConfirmDelete()}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md cursor-pointer disabled:opacity-40"
                      >
                        Confirm Delete
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-3 text-xs">
                  <div>
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                      Description
                    </h4>
                    <p className="text-slate-700 leading-relaxed">{detailEntry.description}</p>
                  </div>

                  <div>
                    <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                      Operational Rules
                    </h4>
                    <ul className="space-y-1.5 list-disc pl-4 text-slate-800">
                      {detailEntry.rules.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50/70 border border-slate-200/80 rounded-lg p-3 text-[11.5px]">
                    <div>
                      <span className="text-slate-400 block">Source Provenance</span>
                      <span className="font-medium text-slate-800">{detailEntry.source}</span>
                      {detailEntry.sourceRef?.pageOrSheet && (
                        <span className="block font-mono text-slate-500 mt-0.5">
                          {detailEntry.sourceRef.pageOrSheet}
                          {detailEntry.sourceRef.sectionOrRow
                            ? ` · ${detailEntry.sourceRef.sectionOrRow}`
                            : ''}
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-slate-400 block">Approved By</span>
                      <span className="font-medium text-slate-800">{detailEntry.approvedBy}</span>
                      <span className="block text-slate-500 tabular-nums mt-0.5">
                        Updated {formatDateTime(detailEntry.updatedAt)}
                      </span>
                    </div>
                  </div>

                  {related.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                        Related Knowledge
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {related.map((rel) => (
                          <button
                            key={rel._id}
                            type="button"
                            onClick={() => setSelectedId(rel._id)}
                            className="text-left p-2.5 rounded-lg border border-slate-200 hover:border-blue-300 bg-white cursor-pointer"
                          >
                            <p className="text-[11px] text-blue-700 font-medium">{rel.category}</p>
                            <p className="text-xs font-semibold text-slate-900 truncate mt-0.5">
                              {rel.title}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Immutable Version History */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-2">
                      <History className="w-3.5 h-3.5 text-slate-400" />
                      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Version History ({versions.length})
                      </h4>
                    </div>
                    <div className="border border-slate-200/80 rounded-lg divide-y divide-slate-100">
                      {versions.map((v) => (
                        <div key={v._id} className="p-3 text-[11.5px] space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-semibold text-slate-800">
                              v{v.version} · {v.action}
                            </span>
                            <span className="text-slate-400 tabular-nums">
                              {formatDateTime(v.createdAt)} · {v.changedBy}
                            </span>
                          </div>
                          <p className="text-slate-600">{v.changeReason}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: SHORT MEMORY SCRIPT (LAYER B) */}
      {tab === 'script' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-8 bg-white border border-slate-200/90 rounded-xl p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <FileCode className="w-4 h-4 text-blue-600" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Compiled Core Short Memory Script
                  </h3>
                  <p className="text-xs text-slate-500">
                    Compact runtime instruction set injected into every Messenger AI reply
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-slate-600 flex items-center gap-1.5">
                  Token budget:
                  <input
                    type="number"
                    min={200}
                    max={2500}
                    step={50}
                    value={tokenBudget}
                    onChange={(e) => setTokenBudget(Number(e.target.value) || 900)}
                    className="w-20 px-2 py-1 text-xs font-mono border border-slate-200 rounded-md tabular-nums"
                  />
                </label>
                <button
                  type="button"
                  disabled={savingScript}
                  onClick={() => void handleRegenerateScript()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate
                </button>
              </div>
            </div>

            {activeScript && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 font-mono tabular-nums">
                <span>Version v{activeScript.version}</span>
                <span>·</span>
                <span>
                  ~{activeScript.estimatedTokens} / {activeScript.tokenBudget} tokens
                </span>
                <span>·</span>
                <span>{activeScript.sourceEntryCount} approved entries</span>
                <span>·</span>
                <span>{activeScript.isManualEdit ? 'Manual edit' : 'Auto-compiled'}</span>
              </div>
            )}

            <textarea
              rows={16}
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              className="w-full p-3.5 text-xs font-mono leading-relaxed bg-slate-50/70 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />

            <div className="flex justify-end">
              <button
                type="button"
                disabled={savingScript}
                onClick={() => void handleSaveScript()}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer disabled:opacity-50"
              >
                {savingScript ? 'Saving...' : 'Save Manual Script Version'}
              </button>
            </div>
          </div>

          <div className="lg:col-span-4 bg-white border border-slate-200/90 rounded-xl p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              Script Version History
            </div>
            <div className="divide-y divide-slate-100 max-h-[480px] overflow-y-auto subtle-scroll">
              {scriptVersions.map((sv) => (
                <button
                  key={sv._id}
                  type="button"
                  onClick={() => setScriptText(sv.scriptText)}
                  className="w-full text-left py-2.5 px-2 hover:bg-slate-50 rounded-md cursor-pointer"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-slate-800">
                      v{sv.version} {sv.isActive ? '(Active)' : ''}
                    </span>
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      ~{sv.estimatedTokens} tok
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {sv.isManualEdit ? `Edited by ${sv.editedBy || 'admin'}` : 'Auto-compiled'} ·{' '}
                    {formatDateTime(sv.createdAt)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: PROPOSALS QUEUE */}
      {tab === 'proposals' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="inline-flex bg-white border border-slate-200 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setProposalFilter('pending_approval')}
                className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
                  proposalFilter === 'pending_approval' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                Pending Review
              </button>
              <button
                type="button"
                onClick={() => setProposalFilter('all')}
                className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${
                  proposalFilter === 'all' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                All Proposals
              </button>
            </div>
          </div>

          {proposals.length === 0 ? (
            <div className="bg-white border border-slate-200/90 rounded-xl p-10 text-center text-xs text-slate-500">
              No proposals in this view. Teach the AI in Training Studio to generate new proposals.
            </div>
          ) : (
            <div className="space-y-3">
              {proposals.map((prop) => (
                <ProposalCard
                  key={prop._id}
                  proposal={prop}
                  onUpdated={(updated) => {
                    setProposals((prev) => prev.map((p) => (p._id === updated._id ? updated : p)));
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: AUDIT LOG */}
      {tab === 'audit' && (
        <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_3px_rgba(15,23,42,0.04)] overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200/80 flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-slate-900">
              Knowledge & Memory Audit Trail
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200/80 text-[11px] font-medium text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Time</th>
                  <th className="px-4 py-2.5">Actor</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Target</th>
                  <th className="px-4 py-2.5">Summary</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No audit events recorded yet.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log._id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-2.5 text-slate-500 tabular-nums whitespace-nowrap">
                        {formatDateTime(log.createdAt)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-700 whitespace-nowrap">
                        {log.actorType}: {log.actorEmail || log.actorId}
                      </td>
                      <td className="px-4 py-2.5 font-mono font-medium text-slate-900 whitespace-nowrap">
                        {log.action}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 whitespace-nowrap">
                        {log.targetType}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{log.summary}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
