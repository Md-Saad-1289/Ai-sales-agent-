import { getCollections } from '../db/mongo.ts';
import type { KnowledgeCategory, KnowledgeEntryDoc, MemoryScriptDoc } from '../types.ts';
import { recordAuditLog } from './auditService.ts';
import { emitRealtimeEvent } from './realtimeService.ts';
import { getSettings } from './settingsService.ts';

export const KNOWLEDGE_CATEGORIES: KnowledgeCategory[] = [
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

const DEFAULT_TOKEN_BUDGET = 650;

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeInstructionLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function listApprovedKnowledgeEntries(opts?: {
  category?: KnowledgeCategory | 'all';
  search?: string;
  status?: 'approved' | 'archived' | 'all';
}): Promise<KnowledgeEntryDoc[]> {
  const { knowledge_entries } = getCollections();
  const filter: Record<string, unknown> = {};

  if (!opts?.status || opts.status === 'approved') {
    filter.status = 'approved';
  } else if (opts.status === 'archived') {
    filter.status = 'archived';
  }

  if (opts?.category && opts.category !== 'all') {
    filter.category = opts.category;
  }

  if (opts?.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { title: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } },
      { rules: { $regex: escaped, $options: 'i' } },
      { tags: { $regex: escaped, $options: 'i' } },
      { source: { $regex: escaped, $options: 'i' } },
    ];
  }

  return knowledge_entries.find(filter, { sort: { priority: -1, updatedAt: -1 }, limit: 300 });
}

export async function getActiveMemoryScript(): Promise<MemoryScriptDoc> {
  const { memory_scripts } = getCollections();
  const active = await memory_scripts.findOne({ isActive: true });
  if (active) return active;
  return compileShortMemoryScript({ tokenBudget: DEFAULT_TOKEN_BUDGET, actorId: 'system', actorType: 'system' });
}

export async function listMemoryScriptVersions(limit = 20): Promise<MemoryScriptDoc[]> {
  const { memory_scripts } = getCollections();
  return memory_scripts.find({}, { sort: { version: -1 }, limit });
}

export async function compileShortMemoryScript(opts?: {
  tokenBudget?: number;
  actorType?: 'admin' | 'system';
  actorId?: string;
  actorEmail?: string;
}): Promise<MemoryScriptDoc> {
  const { knowledge_entries, memory_scripts } = getCollections();
  const tokenBudget = Math.min(2000, Math.max(200, opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET));
  const maxChars = tokenBudget * 4;

  // Strictly read ONLY approved Master Memory entries — never pending proposals or archived items
  const approvedEntries = await knowledge_entries.find(
    { status: 'approved' },
    { sort: { priority: -1, updatedAt: -1 }, limit: 250 },
  );

  const settings = await getSettings();

  const sectionBuckets: Record<'ROLE' | 'BEHAVIOR' | 'SALES RULES' | 'COMMUNICATION' | 'AUTHORITY', string[]> = {
    ROLE: [
      `Act as a professional human-like sales representative for ${settings.businessName} on Facebook Messenger.`,
    ],
    BEHAVIOR: [],
    'SALES RULES': [],
    COMMUNICATION: [],
    AUTHORITY: [
      'Follow approved business rules.',
      'Never invent product prices, stock, features, or policies.',
      'Ask for order confirmation before creating orders.',
      'Escalate unresolved complaints or explicit requests to a human agent.',
    ],
  };

  const seenNormalized = new Set<string>();
  const usedEntryIds: string[] = [];

  const pushUnique = (
    bucket: keyof typeof sectionBuckets,
    line: string,
    entryId?: string,
  ): void => {
    const clean = line.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    const norm = normalizeInstructionLine(clean);
    if (!norm || seenNormalized.has(norm)) return;
    seenNormalized.add(norm);
    sectionBuckets[bucket].push(clean);
    if (entryId && !usedEntryIds.includes(entryId)) {
      usedEntryIds.push(entryId);
    }
  };

  for (const line of sectionBuckets.AUTHORITY) {
    seenNormalized.add(normalizeInstructionLine(line));
  }
  seenNormalized.add(normalizeInstructionLine(sectionBuckets.ROLE[0]));

  // Compile behavioral, communication, sales strategy, and policy rules — exclude full product catalogs
  const priorityCategories: KnowledgeCategory[] = [
    'Communication Rules',
    'Sales Behavior',
    'Customer Handling',
    'Sales Strategies',
    'Business Policies',
    'Delivery Policies',
    'Payment Policies',
    'Warranty & Return Policies',
  ];

  const sortedEntries = [...approvedEntries]
    .filter((entry) => entry.category !== 'Product Knowledge')
    .sort((a, b) => {
      if ((b.priority ?? 5) !== (a.priority ?? 5)) {
        return (b.priority ?? 5) - (a.priority ?? 5);
      }
      const ai = priorityCategories.indexOf(a.category);
      const bi = priorityCategories.indexOf(b.category);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  for (const entry of sortedEntries) {
    const targetBucket: keyof typeof sectionBuckets =
      entry.category === 'Communication Rules'
        ? 'COMMUNICATION'
        : entry.category === 'Customer Handling'
          ? 'BEHAVIOR'
          : entry.category === 'Sales Behavior' || entry.category === 'Sales Strategies'
            ? 'SALES RULES'
            : 'AUTHORITY';

    const items = entry.rules.length > 0 ? entry.rules : [entry.description || entry.title];
    for (const rule of items) {
      pushUnique(targetBucket, rule, entry._id);
    }
  }

  // Fallback foundational behavioral cues when Master Memory has few communication entries
  if (sectionBuckets.BEHAVIOR.length === 0) {
    pushUnique('BEHAVIOR', 'Be polite, natural, and helpful; understand customer budget and needs.');
  }
  if (sectionBuckets.COMMUNICATION.length === 0) {
    pushUnique('COMMUNICATION', 'Keep responses concise and natural; match the configured language rules.');
  }

  const renderScript = (limits: Record<keyof typeof sectionBuckets, number>): string => {
    const parts: string[] = [
      'ROLE:',
      sectionBuckets.ROLE[0],
      '',
      'BEHAVIOR:',
      ...sectionBuckets.BEHAVIOR.slice(0, limits.BEHAVIOR).map((l) => `- ${l}`),
      '',
      'SALES RULES:',
      ...(sectionBuckets['SALES RULES'].length > 0
        ? sectionBuckets['SALES RULES'].slice(0, limits['SALES RULES']).map((l) => `- ${l}`)
        : ['- Guide customers clearly using verified database details.']),
      '',
      'COMMUNICATION:',
      ...sectionBuckets.COMMUNICATION.slice(0, limits.COMMUNICATION).map((l) => `- ${l}`),
      '',
      'AUTHORITY:',
      ...sectionBuckets.AUTHORITY.slice(0, limits.AUTHORITY).map((l) => `- ${l}`),
    ];
    return parts.join('\n').trim();
  };

  const limits: Record<keyof typeof sectionBuckets, number> = {
    ROLE: 1,
    BEHAVIOR: sectionBuckets.BEHAVIOR.length,
    'SALES RULES': sectionBuckets['SALES RULES'].length,
    COMMUNICATION: sectionBuckets.COMMUNICATION.length,
    AUTHORITY: sectionBuckets.AUTHORITY.length,
  };

  let scriptText = renderScript(limits);
  while (scriptText.length > maxChars) {
    // Trim lowest-urgency overflow evenly from SALES RULES -> BEHAVIOR -> AUTHORITY -> COMMUNICATION
    if (limits['SALES RULES'] > 2) {
      limits['SALES RULES']--;
    } else if (limits.BEHAVIOR > 2) {
      limits.BEHAVIOR--;
    } else if (limits.AUTHORITY > 3) {
      limits.AUTHORITY--;
    } else if (limits.COMMUNICATION > 1) {
      limits.COMMUNICATION--;
    } else {
      scriptText = scriptText.slice(0, maxChars).trimEnd();
      break;
    }
    scriptText = renderScript(limits);
  }

  const latest = await memory_scripts.find({}, { sort: { version: -1 }, limit: 1 });
  const nextVersion = (latest[0]?.version ?? 0) + 1;

  await memory_scripts.updateMany({ isActive: true }, { $set: { isActive: false } });

  const created = await memory_scripts.insertOne({
    version: nextVersion,
    scriptText,
    tokenBudget,
    estimatedTokens: estimateTokenCount(scriptText),
    sourceEntryCount: usedEntryIds.length,
    entryIdsUsed: usedEntryIds,
    isManualEdit: false,
    isActive: true,
    createdAt: new Date(),
  });

  if (opts?.actorId && opts.actorId !== 'system') {
    await recordAuditLog({
      actorType: opts.actorType ?? 'admin',
      actorId: opts.actorId,
      actorEmail: opts.actorEmail,
      action: 'REGENERATE_MEMORY_SCRIPT',
      targetType: 'memory_script',
      targetId: created._id,
      summary: `Compiled Short Memory Script v${created.version} (${created.estimatedTokens}/${created.tokenBudget} est. tokens)`,
      details: { version: created.version, sourceEntryCount: created.sourceEntryCount },
    });
  }

  emitRealtimeEvent('memory:script_updated', { script: created });
  return created;
}

export async function saveManualMemoryScriptEdit(params: {
  scriptText: string;
  tokenBudget?: number;
  adminEmail: string;
  adminId: string;
}): Promise<MemoryScriptDoc> {
  const { memory_scripts } = getCollections();
  const clean = params.scriptText.trim();
  if (!clean) {
    throw new Error('Short Memory Script cannot be empty.');
  }

  const latest = await memory_scripts.find({}, { sort: { version: -1 }, limit: 1 });
  const nextVersion = (latest[0]?.version ?? 0) + 1;
  const budget = Math.min(2000, Math.max(200, params.tokenBudget ?? latest[0]?.tokenBudget ?? DEFAULT_TOKEN_BUDGET));

  await memory_scripts.updateMany({ isActive: true }, { $set: { isActive: false } });

  const created = await memory_scripts.insertOne({
    version: nextVersion,
    scriptText: clean,
    tokenBudget: budget,
    estimatedTokens: estimateTokenCount(clean),
    sourceEntryCount: latest[0]?.sourceEntryCount ?? 0,
    entryIdsUsed: latest[0]?.entryIdsUsed ?? [],
    isManualEdit: true,
    editedBy: params.adminEmail,
    isActive: true,
    createdAt: new Date(),
  });

  await recordAuditLog({
    actorType: 'admin',
    actorId: params.adminId,
    actorEmail: params.adminEmail,
    action: 'EDIT_MEMORY_SCRIPT',
    targetType: 'memory_script',
    targetId: created._id,
    summary: `Saved manual edit to Short Memory Script v${created.version}`,
    details: { version: created.version, estimatedTokens: created.estimatedTokens },
  });

  emitRealtimeEvent('memory:script_updated', { script: created });
  return created;
}
