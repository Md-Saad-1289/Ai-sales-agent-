import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';
import type {
  KnowledgeCategory,
  KnowledgeEntryDoc,
  KnowledgeProposalDoc,
  KnowledgeVersionDoc,
  ProductDoc,
  ProposedKnowledgePayload,
  ProposedProductPayload,
} from '../types.ts';
import { recordAuditLog } from './auditService.ts';
import {
  buildStableKey,
  computeDiffSummary,
  computeSimilarityScore,
} from './knowledgeEngineService.ts';
import { compileShortMemoryScript } from './memoryCompilerService.ts';
import { createProduct, updateProduct } from './productService.ts';
import { emitRealtimeEvent } from './realtimeService.ts';

export interface AdminActor {
  actorType: 'admin';
  sub: string;
  email: string;
  name: string;
  role: 'admin';
}

export function assertAuthorizedAdminActor(actor: unknown): asserts actor is AdminActor {
  if (
    !actor ||
    typeof actor !== 'object' ||
    (actor as { actorType?: unknown }).actorType === 'ai' ||
    (actor as { role?: unknown }).role !== 'admin' ||
    !(actor as { email?: unknown }).email
  ) {
    throw new Error('Forbidden: Only an authenticated human administrator may approve or modify Master Memory.');
  }
}

export const editProposalSchema = z.object({
  reason: z.string().trim().min(2).max(500).optional(),
  proposedEntry: z
    .object({
      category: z.enum([
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
      ]),
      title: z.string().trim().min(2).max(160),
      description: z.string().trim().max(1200),
      rules: z.array(z.string().trim().min(1).max(400)).min(1).max(25),
      tags: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
      priority: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  proposedProduct: z
    .object({
      name: z.string().trim().min(1).max(160),
      brand: z.string().trim().max(100).optional(),
      category: z.string().trim().max(100).optional(),
      price: z.number().min(0).max(10000000).optional(),
      stock: z.number().int().min(0).max(1000000).optional(),
      warranty: z.string().trim().max(300).optional(),
      description: z.string().trim().max(2500).optional(),
      features: z.array(z.string().trim().min(1).max(160)).max(25).optional(),
      isActive: z.boolean().optional(),
    })
    .optional(),
});

export const editKnowledgeEntrySchema = z.object({
  category: z.enum([
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
  ]),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1200),
  rules: z.array(z.string().trim().min(1).max(400)).min(1).max(25),
  tags: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  changeReason: z.string().trim().min(2).max(400).optional(),
});

function buildKeywords(category: string, title: string, rules: string[], tags: string[]): string[] {
  const raw = `${category} ${title} ${rules.join(' ')} ${tags.join(' ')}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  return [...new Set(raw)].slice(0, 40);
}

async function linkRelatedEntries(entryId: string, category: KnowledgeCategory, title: string, rules: string[]): Promise<void> {
  const { knowledge_entries } = getCollections();
  const peers = await knowledge_entries.find({ status: 'approved', _id: { $ne: entryId } }, { limit: 100 });
  const text = `${title} ${rules.join(' ')}`;
  const related = peers
    .map((p) => ({
      id: p._id,
      score:
        computeSimilarityScore(text, `${p.title} ${p.rules.join(' ')}`) +
        (p.category === category ? 0.15 : 0),
    }))
    .filter((x) => x.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.id);

  await knowledge_entries.updateOne({ _id: entryId }, { $set: { relatedIds: related } });
}

export async function listProposals(opts?: {
  status?: KnowledgeProposalDoc['status'] | 'all';
  sessionId?: string;
}): Promise<KnowledgeProposalDoc[]> {
  const { knowledge_proposals } = getCollections();
  const filter: Record<string, unknown> = {};
  if (opts?.status && opts.status !== 'all') {
    filter.status = opts.status;
  }
  if (opts?.sessionId) {
    filter.sessionId = opts.sessionId;
  }
  return knowledge_proposals.find(filter, { sort: { createdAt: -1 }, limit: 200 });
}

export async function editProposal(
  proposalId: string,
  input: z.infer<typeof editProposalSchema>,
  actor: AdminActor,
): Promise<KnowledgeProposalDoc> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_proposals } = getCollections();
  const existing = await knowledge_proposals.findOne({ _id: proposalId });
  if (!existing) {
    throw new Error('Proposal not found.');
  }
  if (existing.status === 'approved' || existing.status === 'rejected') {
    throw new Error(`Proposal has already been ${existing.status}.`);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.reason) updates.reason = input.reason;

  if (existing.proposalType === 'knowledge' && input.proposedEntry) {
    updates.proposedEntry = input.proposedEntry;
    updates.diffSummary = computeDiffSummary({
      existing: existing.existingSnapshot ?? {},
      proposed: input.proposedEntry as unknown as Record<string, unknown>,
      fields: ['category', 'title', 'description', 'rules'],
    });
  } else if (existing.proposalType === 'product' && input.proposedProduct) {
    updates.proposedProduct = input.proposedProduct;
    const missing: string[] = [];
    if (input.proposedProduct.price === undefined) missing.push('price');
    if (input.proposedProduct.stock === undefined) missing.push('stock');
    if (!input.proposedProduct.description) missing.push('description');
    updates.missingFields = missing;
    updates.diffSummary = computeDiffSummary({
      existing: existing.existingSnapshot ?? {},
      proposed: input.proposedProduct as unknown as Record<string, unknown>,
      fields: ['name', 'price', 'stock', 'description', 'features'],
    });
  }

  const updated = await knowledge_proposals.findOneAndUpdate(
    { _id: proposalId },
    { $set: updates },
    { returnDocument: 'after' },
  );
  if (!updated) throw new Error('Failed to update proposal.');

  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
    action: 'EDIT_PROPOSAL',
    targetType: 'knowledge_proposal',
    targetId: proposalId,
    summary: `Edited proposal (${updated.proposalType}:${updated.action}) before review`,
  });

  emitRealtimeEvent('training:proposal_created', { proposal: updated });
  return updated;
}

export async function rejectProposal(
  proposalId: string,
  reason: string | undefined,
  actor: AdminActor,
): Promise<KnowledgeProposalDoc> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_proposals } = getCollections();

  const updated = await knowledge_proposals.findOneAndUpdate(
    { _id: proposalId, status: { $in: ['pending_approval', 'clarification_requested'] } },
    {
      $set: {
        status: 'rejected',
        clarificationNote: reason?.trim() || undefined,
        reviewedBy: actor.email,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const existing = await knowledge_proposals.findOne({ _id: proposalId });
    if (!existing) throw new Error('Proposal not found.');
    throw new Error(`Proposal is already ${existing.status}.`);
  }

  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
    action: 'REJECT_PROPOSAL',
    targetType: 'knowledge_proposal',
    targetId: proposalId,
    summary: `Rejected proposal: ${updated.proposedEntry?.title || updated.proposedProduct?.name || proposalId}`,
    details: { reason: reason || null },
  });

  emitRealtimeEvent('training:proposal_created', { proposal: updated });
  return updated;
}

export async function requestProposalClarification(
  proposalId: string,
  note: string,
  actor: AdminActor,
): Promise<KnowledgeProposalDoc> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_proposals } = getCollections();

  const cleanNote = note.trim();
  if (!cleanNote) throw new Error('Clarification note is required.');

  const updated = await knowledge_proposals.findOneAndUpdate(
    { _id: proposalId, status: { $in: ['pending_approval', 'clarification_requested'] } },
    {
      $set: {
        status: 'clarification_requested',
        clarificationNote: cleanNote,
        reviewedBy: actor.email,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    throw new Error('Proposal not found or already finalized.');
  }

  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
    action: 'CLARIFY_PROPOSAL',
    targetType: 'knowledge_proposal',
    targetId: proposalId,
    summary: `Requested clarification on proposal ${proposalId}`,
    details: { note: cleanNote },
  });

  emitRealtimeEvent('training:proposal_created', { proposal: updated });
  return updated;
}

export async function approveProposal(
  proposalId: string,
  actor: AdminActor,
  options?: { confirmDelete?: boolean; targetEntryId?: string },
): Promise<{
  proposal: KnowledgeProposalDoc;
  knowledgeEntry?: KnowledgeEntryDoc;
  product?: ProductDoc;
}> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_proposals, knowledge_entries, knowledge_versions } = getCollections();

  // Idempotent atomic claim: only transition from pending/clarification once
  const claimed = await knowledge_proposals.findOneAndUpdate(
    { _id: proposalId, status: { $in: ['pending_approval', 'clarification_requested'] } },
    {
      $set: {
        status: 'approved',
        reviewedBy: actor.email,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  if (!claimed) {
    const existing = await knowledge_proposals.findOne({ _id: proposalId });
    if (!existing) throw new Error('Proposal not found.');
    throw new Error(`Proposal cannot be approved (current status: ${existing.status}).`);
  }

  const revertClaim = async () => {
    await knowledge_proposals.updateOne(
      { _id: proposalId },
      { $set: { status: 'pending_approval', updatedAt: new Date() }, $unset: { reviewedBy: '', reviewedAt: '' } },
    );
  };

  try {
    // Handle Product Catalog Proposals
    if (claimed.proposalType === 'product') {
      const pData: ProposedProductPayload | undefined = claimed.proposedProduct;
      if (!pData || !pData.name) {
        throw new Error('Product proposal payload is incomplete.');
      }

      let resultProduct: ProductDoc;
      if (claimed.targetProductId && (claimed.action === 'UPDATE' || claimed.action === 'REPLACE' || claimed.action === 'MERGE')) {
        const existingSnap = claimed.existingSnapshot ?? {};
        const updatedProd = await updateProduct(claimed.targetProductId, {
          name: pData.name,
          price: pData.price ?? Number(existingSnap.price ?? 0),
          stock: pData.stock ?? Number(existingSnap.stock ?? 0),
          description: pData.description || String(existingSnap.description ?? ''),
          features:
            pData.features && pData.features.length > 0
              ? pData.features
              : Array.isArray(existingSnap.features)
                ? (existingSnap.features as string[])
                : [],
          images: [],
          isActive: pData.isActive ?? true,
        });
        if (!updatedProd) {
          throw new Error('Target catalog product could not be found.');
        }
        resultProduct = updatedProd;
      } else {
        if (pData.price === undefined) {
          throw new Error('Product price is required before approving creation. Use Edit Proposal to enter price.');
        }
        resultProduct = await createProduct({
          name: pData.name,
          price: Number(pData.price),
          stock: Number(pData.stock ?? 0),
          description: [pData.description, pData.warranty ? `Warranty: ${pData.warranty}` : '']
            .filter(Boolean)
            .join('\n'),
          features: pData.features ?? [],
          images: [],
          isActive: pData.isActive ?? true,
        });
      }

      const finalized = await knowledge_proposals.findOneAndUpdate(
        { _id: proposalId },
        { $set: { executionResultId: resultProduct._id, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

      await recordAuditLog({
        actorType: 'admin',
        actorId: actor.sub,
        actorEmail: actor.email,
        action: `APPROVE_PRODUCT_${claimed.action}`,
        targetType: 'product',
        targetId: resultProduct._id,
        summary: `Approved product proposal for "${resultProduct.name}" (${claimed.action})`,
        details: { proposalId, price: resultProduct.price, stock: resultProduct.stock },
      });

      emitRealtimeEvent('training:proposal_created', { proposal: finalized ?? claimed });
      return { proposal: finalized ?? claimed, product: resultProduct };
    }

    // Handle DELETE_REQUEST explicitly (AI only proposed; admin must select & explicitly confirm)
    if (claimed.action === 'DELETE_REQUEST' || claimed.action === 'ARCHIVE') {
      const targetId = options?.targetEntryId || claimed.targetEntryId;
      if (!targetId) {
        throw new Error('Target knowledge entry must be manually selected before deletion.');
      }
      if (!options?.confirmDelete) {
        throw new Error('Explicit delete confirmation is required.');
      }
      const deletedEntry = await archiveKnowledgeEntry({
        entryId: targetId,
        actor,
        confirmDelete: true,
        entryIdConfirm: targetId,
        reason: claimed.reason,
        proposalId,
      });

      const finalized = await knowledge_proposals.findOneAndUpdate(
        { _id: proposalId },
        { $set: { executionResultId: deletedEntry._id, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );

      return { proposal: finalized ?? claimed, knowledgeEntry: deletedEntry };
    }

    // Handle Knowledge ADD / UPDATE / REPLACE / MERGE
    const payload: ProposedKnowledgePayload | undefined = claimed.proposedEntry;
    if (!payload) {
      throw new Error('Proposal lacks structured knowledge payload.');
    }

    const now = new Date();
    let savedEntry: KnowledgeEntryDoc;

    if (
      claimed.targetEntryId &&
      (claimed.action === 'UPDATE' || claimed.action === 'REPLACE' || claimed.action === 'MERGE')
    ) {
      const existing = await knowledge_entries.findOne({ _id: claimed.targetEntryId });
      if (!existing) {
        throw new Error('Target Master Memory entry not found.');
      }

      const nextRules =
        claimed.action === 'MERGE'
          ? [...new Set([...existing.rules, ...payload.rules])]
          : payload.rules;
      const nextTags = [...new Set([...(existing.tags ?? []), ...(payload.tags ?? [])])];
      const nextVersion = existing.version + 1;

      const versionDoc = await knowledge_versions.insertOne({
        entryId: existing._id,
        version: nextVersion,
        category: payload.category,
        title: payload.title,
        description: payload.description,
        rules: nextRules,
        structuredData: payload.structuredData ?? existing.structuredData,
        source: claimed.newSource,
        sourceRef: claimed.sourceRef,
        changeReason: claimed.reason,
        proposalId,
        changedBy: actor.email,
        action: claimed.action,
        createdAt: now,
      });

      const updated = await knowledge_entries.findOneAndUpdate(
        { _id: existing._id },
        {
          $set: {
            category: payload.category,
            title: payload.title,
            description: payload.description,
            rules: nextRules,
            structuredData: payload.structuredData ?? existing.structuredData,
            tags: nextTags,
            keywords: buildKeywords(payload.category, payload.title, nextRules, nextTags),
            priority: payload.priority ?? existing.priority,
            status: 'approved',
            version: nextVersion,
            currentVersionId: versionDoc._id,
            source: claimed.newSource,
            sourceRef: claimed.sourceRef ?? existing.sourceRef,
            approvedBy: actor.email,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (!updated) throw new Error('Failed to update Master Memory entry.');
      savedEntry = updated;
    } else {
      const entryId = randomUUID();
      const versionId = randomUUID();
      const tags = payload.tags ?? [];

      await knowledge_versions.insertOne({
        _id: versionId,
        entryId,
        version: 1,
        category: payload.category,
        title: payload.title,
        description: payload.description,
        rules: payload.rules,
        structuredData: payload.structuredData,
        source: claimed.newSource,
        sourceRef: claimed.sourceRef,
        changeReason: claimed.reason,
        proposalId,
        changedBy: actor.email,
        action: 'ADD',
        createdAt: now,
      });

      savedEntry = await knowledge_entries.insertOne({
        _id: entryId,
        stableKey: buildStableKey(payload.category, payload.title),
        category: payload.category,
        title: payload.title,
        description: payload.description,
        rules: payload.rules,
        structuredData: payload.structuredData,
        tags,
        keywords: buildKeywords(payload.category, payload.title, payload.rules, tags),
        priority: payload.priority ?? 6,
        status: 'approved',
        version: 1,
        currentVersionId: versionId,
        source: claimed.newSource,
        sourceRef: claimed.sourceRef,
        relatedIds: [],
        createdBy: claimed.createdBy === 'admin' ? actor.email : 'ai_proposal',
        approvedBy: actor.email,
        createdAt: now,
        updatedAt: now,
      });
    }

    await linkRelatedEntries(savedEntry._id, savedEntry.category, savedEntry.title, savedEntry.rules);

    const finalized = await knowledge_proposals.findOneAndUpdate(
      { _id: proposalId },
      { $set: { executionResultId: savedEntry._id, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    await compileShortMemoryScript({
      actorType: 'admin',
      actorId: actor.sub,
      actorEmail: actor.email,
    });

    await recordAuditLog({
      actorType: 'admin',
      actorId: actor.sub,
      actorEmail: actor.email,
      action: `APPROVE_KNOWLEDGE_${claimed.action}`,
      targetType: 'knowledge_entry',
      targetId: savedEntry._id,
      summary: `Approved ${claimed.action} for "${savedEntry.title}" (v${savedEntry.version})`,
      details: { proposalId, category: savedEntry.category, version: savedEntry.version },
    });

    emitRealtimeEvent('knowledge:updated', { entry: savedEntry });
    emitRealtimeEvent('training:proposal_created', { proposal: finalized ?? claimed });

    return { proposal: finalized ?? claimed, knowledgeEntry: savedEntry };
  } catch (err) {
    await revertClaim();
    throw err;
  }
}

export async function getKnowledgeEntryDetail(entryId: string): Promise<{
  entry: KnowledgeEntryDoc;
  versions: KnowledgeVersionDoc[];
  related: KnowledgeEntryDoc[];
} | null> {
  const { knowledge_entries, knowledge_versions } = getCollections();
  const entry = await knowledge_entries.findOne({ _id: entryId });
  if (!entry) return null;

  const [versions, related] = await Promise.all([
    knowledge_versions.find({ entryId }, { sort: { version: -1 }, limit: 50 }),
    entry.relatedIds.length > 0
      ? knowledge_entries.find({ _id: { $in: entry.relatedIds }, status: 'approved' })
      : Promise.resolve([]),
  ]);

  return { entry, versions, related };
}

export async function editApprovedKnowledgeEntry(
  entryId: string,
  input: z.infer<typeof editKnowledgeEntrySchema>,
  actor: AdminActor,
): Promise<KnowledgeEntryDoc> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_entries, knowledge_versions } = getCollections();
  const existing = await knowledge_entries.findOne({ _id: entryId });
  if (!existing) throw new Error('Knowledge entry not found.');

  const now = new Date();
  const nextVersion = existing.version + 1;
  const nextTags = input.tags ?? existing.tags;

  const versionDoc = await knowledge_versions.insertOne({
    entryId,
    version: nextVersion,
    category: input.category,
    title: input.title,
    description: input.description,
    rules: input.rules,
    structuredData: existing.structuredData,
    source: existing.source,
    sourceRef: existing.sourceRef,
    changeReason: input.changeReason || 'Manual administrator update',
    changedBy: actor.email,
    action: 'MANUAL_EDIT',
    createdAt: now,
  });

  const updated = await knowledge_entries.findOneAndUpdate(
    { _id: entryId },
    {
      $set: {
        category: input.category,
        title: input.title,
        description: input.description,
        rules: input.rules,
        tags: nextTags,
        keywords: buildKeywords(input.category, input.title, input.rules, nextTags),
        priority: input.priority ?? existing.priority,
        version: nextVersion,
        currentVersionId: versionDoc._id,
        approvedBy: actor.email,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new Error('Failed to update knowledge entry.');

  await compileShortMemoryScript({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
  });

  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
    action: 'EDIT_KNOWLEDGE_ENTRY',
    targetType: 'knowledge_entry',
    targetId: entryId,
    summary: `Edited Master Memory "${updated.title}" -> v${updated.version}`,
    details: { changeReason: input.changeReason || 'Manual administrator update' },
  });

  emitRealtimeEvent('knowledge:updated', { entry: updated });
  return updated;
}

export async function archiveKnowledgeEntry(params: {
  entryId: string;
  actor: AdminActor;
  confirmDelete: boolean;
  entryIdConfirm: string;
  reason?: string;
  proposalId?: string;
}): Promise<KnowledgeEntryDoc> {
  assertAuthorizedAdminActor(params.actor);
  if (!params.confirmDelete || params.entryIdConfirm !== params.entryId) {
    throw new Error('Explicit confirmation matching the exact entry ID is required to delete knowledge.');
  }

  const { knowledge_entries, knowledge_versions } = getCollections();
  const existing = await knowledge_entries.findOne({ _id: params.entryId });
  if (!existing) throw new Error('Knowledge entry not found.');

  const now = new Date();
  const nextVersion = existing.version + 1;

  const versionDoc = await knowledge_versions.insertOne({
    entryId: existing._id,
    version: nextVersion,
    category: existing.category,
    title: existing.title,
    description: existing.description,
    rules: existing.rules,
    structuredData: existing.structuredData,
    source: existing.source,
    sourceRef: existing.sourceRef,
    changeReason: params.reason || 'Deleted/archived by administrator',
    proposalId: params.proposalId,
    changedBy: params.actor.email,
    action: 'ARCHIVE',
    createdAt: now,
  });

  const archived = await knowledge_entries.findOneAndUpdate(
    { _id: existing._id },
    {
      $set: {
        status: 'archived',
        version: nextVersion,
        currentVersionId: versionDoc._id,
        archivedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (!archived) throw new Error('Failed to archive knowledge entry.');

  await compileShortMemoryScript({
    actorType: 'admin',
    actorId: params.actor.sub,
    actorEmail: params.actor.email,
  });

  await recordAuditLog({
    actorType: 'admin',
    actorId: params.actor.sub,
    actorEmail: params.actor.email,
    action: 'DELETE_KNOWLEDGE_ENTRY',
    targetType: 'knowledge_entry',
    targetId: existing._id,
    summary: `Archived/deleted Master Memory "${existing.title}" (recoverable from Archive)`,
    details: { title: existing.title, category: existing.category, reason: params.reason || null },
  });

  emitRealtimeEvent('knowledge:updated', { entry: archived });
  return archived;
}

export async function restoreArchivedKnowledgeEntry(
  entryId: string,
  actor: AdminActor,
): Promise<KnowledgeEntryDoc> {
  assertAuthorizedAdminActor(actor);
  const { knowledge_entries, knowledge_versions } = getCollections();
  const existing = await knowledge_entries.findOne({ _id: entryId });
  if (!existing) throw new Error('Knowledge entry not found.');
  if (existing.status === 'approved') return existing;

  const now = new Date();
  const nextVersion = existing.version + 1;

  const versionDoc = await knowledge_versions.insertOne({
    entryId,
    version: nextVersion,
    category: existing.category,
    title: existing.title,
    description: existing.description,
    rules: existing.rules,
    structuredData: existing.structuredData,
    source: existing.source,
    sourceRef: existing.sourceRef,
    changeReason: 'Restored from archived version by administrator',
    changedBy: actor.email,
    action: 'RESTORE',
    createdAt: now,
  });

  const restored = await knowledge_entries.findOneAndUpdate(
    { _id: entryId },
    {
      $set: {
        status: 'approved',
        version: nextVersion,
        currentVersionId: versionDoc._id,
        updatedAt: now,
      },
      $unset: { archivedAt: '' },
    },
    { returnDocument: 'after' },
  );
  if (!restored) throw new Error('Failed to restore knowledge entry.');

  await compileShortMemoryScript({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
  });

  await recordAuditLog({
    actorType: 'admin',
    actorId: actor.sub,
    actorEmail: actor.email,
    action: 'RESTORE_KNOWLEDGE_ENTRY',
    targetType: 'knowledge_entry',
    targetId: entryId,
    summary: `Restored Master Memory "${restored.title}" -> v${restored.version}`,
  });

  emitRealtimeEvent('knowledge:updated', { entry: restored });
  return restored;
}
