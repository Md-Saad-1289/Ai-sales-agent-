import { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Edit3,
  HelpCircle,
  Package,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import type { KnowledgeCategory, KnowledgeProposal } from '../types';

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

interface ProposalCardProps {
  proposal: KnowledgeProposal;
  onUpdated: (updated: KnowledgeProposal) => void;
  compact?: boolean;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function classificationTone(classification: KnowledgeProposal['classification']): string {
  switch (classification) {
    case 'CONFLICT':
      return 'text-red-700 font-semibold';
    case 'MODIFIED':
      return 'text-amber-700 font-semibold';
    case 'UNCERTAIN':
      return 'text-amber-700 font-medium';
    case 'DUPLICATE':
      return 'text-slate-500 font-medium';
    default:
      return 'text-blue-700 font-semibold';
  }
}

function statusLabel(status: KnowledgeProposal['status']): string {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    case 'clarification_requested':
      return 'Clarification Requested';
    default:
      return 'Pending Approval';
  }
}

function statusTone(status: KnowledgeProposal['status']): string {
  switch (status) {
    case 'approved':
      return 'text-emerald-700';
    case 'rejected':
      return 'text-slate-500';
    case 'clarification_requested':
      return 'text-amber-700';
    default:
      return 'text-blue-700';
  }
}

export function ProposalCard({ proposal, onUpdated, compact = false }: ProposalCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteChecked, setDeleteChecked] = useState(false);

  const [clarifyNote, setClarifyNote] = useState(proposal.clarificationNote || '');
  const [rejectReason, setRejectReason] = useState('');

  // Edit form fields (Knowledge)
  const [kCategory, setKCategory] = useState<KnowledgeCategory>(
    proposal.proposedEntry?.category ?? 'Other Business Knowledge',
  );
  const [kTitle, setKTitle] = useState(proposal.proposedEntry?.title ?? '');
  const [kDescription, setKDescription] = useState(proposal.proposedEntry?.description ?? '');
  const [kRulesText, setKRulesText] = useState(
    (proposal.proposedEntry?.rules ?? []).join('\n'),
  );
  const [kPriority, setKPriority] = useState<number>(proposal.proposedEntry?.priority ?? 3);

  // Edit form fields (Product)
  const [pName, setPName] = useState(proposal.proposedProduct?.name ?? '');
  const [pBrand, setPBrand] = useState(proposal.proposedProduct?.brand ?? '');
  const [pCategory, setPCategory] = useState(proposal.proposedProduct?.category ?? '');
  const [pPrice, setPPrice] = useState(
    proposal.proposedProduct?.price !== undefined ? String(proposal.proposedProduct.price) : '',
  );
  const [pStock, setPStock] = useState(
    proposal.proposedProduct?.stock !== undefined ? String(proposal.proposedProduct.stock) : '',
  );
  const [pWarranty, setPWarranty] = useState(proposal.proposedProduct?.warranty ?? '');
  const [pDescription, setPDescription] = useState(proposal.proposedProduct?.description ?? '');
  const [pFeaturesText, setPFeaturesText] = useState(
    (proposal.proposedProduct?.features ?? []).join(', '),
  );
  const [editReason, setEditReason] = useState(proposal.reason);

  const isPending =
    proposal.status === 'pending_approval' || proposal.status === 'clarification_requested';
  const isDeleteRequest = proposal.action === 'DELETE_REQUEST' || proposal.action === 'ARCHIVE';

  const titleText =
    proposal.proposalType === 'product'
      ? proposal.proposedProduct?.name || 'Product Proposal'
      : proposal.proposedEntry?.title || 'Knowledge Proposal';

  const categoryText =
    proposal.proposalType === 'product'
      ? proposal.proposedProduct?.category || 'Product Catalog'
      : proposal.proposedEntry?.category || 'Knowledge';

  async function handleApprove() {
    if (isDeleteRequest && !confirmingDelete) {
      setConfirmingDelete(true);
      setDeleteChecked(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.approveProposal(proposal._id, {
        confirmDelete: isDeleteRequest ? deleteChecked : undefined,
        targetEntryId: proposal.targetEntryId,
      });
      setConfirmingDelete(false);
      onUpdated(res.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.rejectProposal(proposal._id, rejectReason.trim() || undefined);
      setRejecting(false);
      onUpdated(res.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleClarify() {
    if (!clarifyNote.trim()) {
      setError('Enter a clarification question or note.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.clarifyProposal(proposal._id, clarifyNote.trim());
      setClarifying(false);
      onUpdated(res.proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clarification request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveEdit() {
    setBusy(true);
    setError(null);
    try {
      if (proposal.proposalType === 'knowledge') {
        const rules = kRulesText
          .split('\n')
          .map((r) => r.trim())
          .filter(Boolean);
        if (!kTitle.trim() || !kDescription.trim() || rules.length === 0) {
          setError('Title, description, and at least one rule are required.');
          setBusy(false);
          return;
        }
        const res = await api.editProposal(proposal._id, {
          reason: editReason.trim() || proposal.reason,
          proposedEntry: {
            category: kCategory,
            title: kTitle.trim(),
            description: kDescription.trim(),
            rules,
            tags: proposal.proposedEntry?.tags,
            priority: kPriority,
          },
        });
        setEditing(false);
        onUpdated(res.proposal);
      } else {
        if (!pName.trim()) {
          setError('Product name is required.');
          setBusy(false);
          return;
        }
        const parsedPrice = pPrice.trim() ? Number(pPrice) : undefined;
        const parsedStock = pStock.trim() ? Number(pStock) : undefined;
        const res = await api.editProposal(proposal._id, {
          reason: editReason.trim() || proposal.reason,
          proposedProduct: {
            name: pName.trim(),
            brand: pBrand.trim() || undefined,
            category: pCategory.trim() || undefined,
            price: parsedPrice !== undefined && Number.isFinite(parsedPrice) ? parsedPrice : undefined,
            stock: parsedStock !== undefined && Number.isFinite(parsedStock) ? parsedStock : undefined,
            warranty: pWarranty.trim() || undefined,
            description: pDescription.trim() || undefined,
            features: pFeaturesText
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean),
            isActive: proposal.proposedProduct?.isActive ?? true,
          },
        });
        setEditing(false);
        onUpdated(res.proposal);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBusy(false);
    }
  }

  const showComparison =
    proposal.action === 'UPDATE' ||
    proposal.action === 'REPLACE' ||
    proposal.action === 'MERGE' ||
    proposal.classification === 'MODIFIED' ||
    proposal.classification === 'CONFLICT' ||
    Boolean(proposal.existingSnapshot);

  return (
    <div className="bg-white border border-slate-200/90 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
            <span className={classificationTone(proposal.classification)}>
              {proposal.classification}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-700 font-medium">{proposal.action}</span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-600">{categoryText}</span>
            {proposal.similarityScore !== undefined && proposal.similarityScore > 0 && (
              <>
                <span className="text-slate-300">·</span>
                <span className="text-slate-500 tabular-nums">
                  {Math.round(proposal.similarityScore * 100)}% match
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {proposal.proposalType === 'product' && (
              <Package className="w-4 h-4 text-blue-600 shrink-0" />
            )}
            <h4 className="text-[13.5px] font-semibold text-slate-900 leading-snug">
              {titleText}
            </h4>
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] shrink-0">
          <span className={`font-medium ${statusTone(proposal.status)}`}>
            {statusLabel(proposal.status)}
          </span>
          <span className="text-slate-300">·</span>
          <span className="text-slate-400 tabular-nums">{formatDateTime(proposal.createdAt)}</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3 text-xs">
        <p className="text-slate-700 leading-relaxed">{proposal.reason}</p>

        {/* Source Provenance */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 bg-slate-50/80 border border-slate-200/70 rounded-lg px-3 py-2">
          {proposal.originalSource && (
            <div>
              <span className="text-slate-400">Existing source: </span>
              <span className="text-slate-700 font-medium">{proposal.originalSource}</span>
            </div>
          )}
          <div>
            <span className="text-slate-400">New source: </span>
            <span className="text-slate-700 font-medium">{proposal.newSource}</span>
          </div>
          {proposal.sourceRef?.pageOrSheet && (
            <div>
              <span className="text-slate-400">Location: </span>
              <span className="text-slate-700 font-mono">
                {proposal.sourceRef.pageOrSheet}
                {proposal.sourceRef.sectionOrRow ? ` · ${proposal.sourceRef.sectionOrRow}` : ''}
              </span>
            </div>
          )}
        </div>

        {/* Missing Fields warning for incomplete product/knowledge */}
        {proposal.missingFields && proposal.missingFields.length > 0 && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50/70 text-amber-800 text-[11.5px]">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Missing fields: </span>
              <span className="font-mono">{proposal.missingFields.join(', ')}</span>
              <span> — use Edit Proposal before approving if needed.</span>
            </div>
          </div>
        )}

        {/* Side-by-side comparison for conflicts / modifications */}
        {showComparison && proposal.diffSummary.length > 0 && (
          <div className="border border-slate-200/90 rounded-lg overflow-hidden">
            <div className="grid grid-cols-12 bg-slate-50 border-b border-slate-200/80 px-3 py-1.5 text-[11px] font-medium text-slate-500">
              <div className="col-span-3">Field</div>
              <div className="col-span-4">Existing</div>
              <div className="col-span-5">Proposed</div>
            </div>
            <div className="divide-y divide-slate-100">
              {proposal.diffSummary.map((item, idx) => (
                <div key={`${item.field}-${idx}`} className="grid grid-cols-12 px-3 py-2 gap-2 text-[11.5px]">
                  <div className="col-span-3 font-medium text-slate-700 capitalize">
                    {item.field}
                    <span className="block text-[10px] font-mono text-slate-400">
                      {item.changeType}
                    </span>
                  </div>
                  <div className="col-span-4 text-slate-500 break-words whitespace-pre-wrap">
                    {item.oldValue || '—'}
                  </div>
                  <div
                    className={`col-span-5 break-words whitespace-pre-wrap ${
                      item.changeType === 'removed'
                        ? 'text-red-700 line-through'
                        : item.changeType === 'modified'
                          ? 'text-amber-800 font-medium'
                          : item.changeType === 'added'
                            ? 'text-blue-800 font-medium'
                            : 'text-slate-700'
                    }`}
                  >
                    {item.newValue || '—'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Standard view when NEW and not editing */}
        {!editing && !showComparison && proposal.proposalType === 'knowledge' && proposal.proposedEntry && (
          <div className="space-y-2">
            <p className="text-slate-600">{proposal.proposedEntry.description}</p>
            {proposal.proposedEntry.rules.length > 0 && (
              <ul className="space-y-1 pl-4 list-disc text-slate-700">
                {proposal.proposedEntry.rules.map((rule, idx) => (
                  <li key={idx}>{rule}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {!editing && !showComparison && proposal.proposalType === 'product' && proposal.proposedProduct && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50/70 border border-slate-200/70 rounded-lg p-3">
            <div>
              <span className="text-[10.5px] text-slate-400 block">Price</span>
              <span className="font-mono font-medium text-slate-900 tabular-nums">
                {proposal.proposedProduct.price !== undefined ? proposal.proposedProduct.price : '—'}
              </span>
            </div>
            <div>
              <span className="text-[10.5px] text-slate-400 block">Stock</span>
              <span className="font-mono font-medium text-slate-900 tabular-nums">
                {proposal.proposedProduct.stock !== undefined ? proposal.proposedProduct.stock : '—'}
              </span>
            </div>
            <div>
              <span className="text-[10.5px] text-slate-400 block">Brand</span>
              <span className="text-slate-800">{proposal.proposedProduct.brand || '—'}</span>
            </div>
            <div>
              <span className="text-[10.5px] text-slate-400 block">Warranty</span>
              <span className="text-slate-800">{proposal.proposedProduct.warranty || '—'}</span>
            </div>
            {!compact && proposal.proposedProduct.description && (
              <div className="col-span-2 sm:col-span-4 pt-1 border-t border-slate-200/60 text-slate-600">
                {proposal.proposedProduct.description}
              </div>
            )}
          </div>
        )}

        {proposal.clarificationNote && proposal.status === 'clarification_requested' && (
          <div className="px-3 py-2 rounded-lg bg-amber-50/60 border border-amber-200 text-amber-900 text-[11.5px]">
            <span className="font-medium">Clarification requested: </span>
            {proposal.clarificationNote}
          </div>
        )}

        {/* Inline Edit Form */}
        {editing && (
          <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/60 space-y-2.5">
            {proposal.proposalType === 'knowledge' ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Category
                    </label>
                    <select
                      value={kCategory}
                      onChange={(e) => setKCategory(e.target.value as KnowledgeCategory)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
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
                      value={kPriority}
                      onChange={(e) => setKPriority(Number(e.target.value) || 3)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Title</label>
                  <input
                    type="text"
                    value={kTitle}
                    onChange={(e) => setKTitle(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Description
                  </label>
                  <textarea
                    rows={2}
                    value={kDescription}
                    onChange={(e) => setKDescription(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Rules (one per line)
                  </label>
                  <textarea
                    rows={3}
                    value={kRulesText}
                    onChange={(e) => setKRulesText(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Product Name
                    </label>
                    <input
                      type="text"
                      value={pName}
                      onChange={(e) => setPName(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Brand
                    </label>
                    <input
                      type="text"
                      value={pBrand}
                      onChange={(e) => setPBrand(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Price
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={pPrice}
                      onChange={(e) => setPPrice(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Stock
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={pStock}
                      onChange={(e) => setPStock(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Category
                    </label>
                    <input
                      type="text"
                      value={pCategory}
                      onChange={(e) => setPCategory(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Warranty
                    </label>
                    <input
                      type="text"
                      value={pWarranty}
                      onChange={(e) => setPWarranty(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Description
                  </label>
                  <textarea
                    rows={2}
                    value={pDescription}
                    onChange={(e) => setPDescription(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    Features (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={pFeaturesText}
                    onChange={(e) => setPFeaturesText(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Change Reason
              </label>
              <input
                type="text"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-md border border-slate-200 bg-white cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveEdit()}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md cursor-pointer disabled:opacity-50"
              >
                {busy ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        )}

        {/* Delete explicit confirmation */}
        {confirmingDelete && (
          <div className="border border-red-200 bg-red-50/70 rounded-lg p-3 space-y-2.5">
            <div className="flex items-start gap-2 text-red-800">
              <Trash2 className="w-4 h-4 mt-0.5 shrink-0" />
              <div className="text-xs">
                <p className="font-semibold">Confirm Knowledge Archive / Deletion</p>
                <p className="text-red-700 mt-0.5">
                  This will archive the targeted knowledge entry and remove it from active customer
                  AI memory. You can restore it later from Knowledge Memory.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-red-900 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteChecked}
                onChange={(e) => setDeleteChecked(e.target.checked)}
                className="rounded border-red-300 text-red-600 focus:ring-red-500"
              />
              <span>I explicitly confirm archiving this knowledge entry</span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 bg-white rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!deleteChecked || busy}
                onClick={() => void handleApprove()}
                className="px-3 py-1 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md disabled:opacity-40 cursor-pointer"
              >
                Confirm Archive
              </button>
            </div>
          </div>
        )}

        {/* Clarification input */}
        {clarifying && (
          <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/70 space-y-2">
            <label className="block text-[11px] font-medium text-slate-600">
              Clarification question or instruction
            </label>
            <input
              type="text"
              value={clarifyNote}
              onChange={(e) => setClarifyNote(e.target.value)}
              placeholder="e.g., Specify whether warranty covers water damage"
              className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setClarifying(false)}
                className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 bg-white rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleClarify()}
                className="px-3 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md cursor-pointer disabled:opacity-50"
              >
                Save Clarification
              </button>
            </div>
          </div>
        )}

        {/* Reject input */}
        {rejecting && (
          <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/70 space-y-2">
            <label className="block text-[11px] font-medium text-slate-600">
              Rejection reason (optional)
            </label>
            <input
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g., Outdated policy or incorrect price"
              className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="px-2.5 py-1 text-xs text-slate-600 border border-slate-200 bg-white rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleReject()}
                className="px-3 py-1 text-xs font-medium text-white bg-slate-800 hover:bg-slate-900 rounded-md cursor-pointer disabled:opacity-50"
              >
                Confirm Reject
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-[11.5px] text-red-700">{error}</p>}

        {/* Action Bar */}
        {isPending && !editing && !confirmingDelete && (
          <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setClarifying(false);
                  setRejecting(false);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer"
              >
                <Edit3 className="w-3 h-3" />
                Edit Proposal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setClarifying((v) => !v);
                  setRejecting(false);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer"
              >
                <HelpCircle className="w-3 h-3" />
                Clarify
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRejecting((v) => !v);
                  setClarifying(false);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11.5px] font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer"
              >
                <X className="w-3 h-3" />
                Reject
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleApprove()}
                className={`inline-flex items-center gap-1 px-3 py-1.5 text-[11.5px] font-medium text-white rounded-md cursor-pointer disabled:opacity-50 ${
                  isDeleteRequest
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <Check className="w-3 h-3" />
                {busy
                  ? 'Applying...'
                  : isDeleteRequest
                    ? 'Review Delete'
                    : 'Approve'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
