import { getCollections } from '../db/mongo.ts';
import type { KnowledgeCategory, KnowledgeEntryDoc, MessageDoc } from '../types.ts';
import { computeSimilarityScore, normalizeText } from './knowledgeEngineService.ts';

export interface RetrievedKnowledgeResult {
  detectedIntents: string[];
  entries: Array<{
    id: string;
    category: KnowledgeCategory;
    title: string;
    description: string;
    rules: string[];
    source: string;
    score: number;
  }>;
}

const INTENT_RULES: Array<{
  intent: string;
  patterns: RegExp[];
  boostCategories: KnowledgeCategory[];
}> = [
  {
    intent: 'warranty_return',
    patterns: [/warrant/i, /guarant/i, /return/i, /refund/i, /replac/i, /damage/i, /ওয়ারেন্টি/i, /রিটার্ন/i, /ফেরত/i, /নষ্ট/i],
    boostCategories: ['Warranty & Return Policies', 'Product Knowledge'],
  },
  {
    intent: 'delivery',
    patterns: [/deliver/i, /ship/i, /courier/i, /charge/i, /dhaka/i, /days/i, /ডেলিভারি/i, /কুরিয়ার/i, /চার্জ/i, /কবে/i],
    boostCategories: ['Delivery Policies', 'Business Policies'],
  },
  {
    intent: 'payment',
    patterns: [/pay/i, /bkash/i, /nagad/i, /rocket/i, /cod/i, /cash on/i, /advance/i, /পেমেন্ট/i, /বিকাশ/i, /নগদ/i, /ক্যাশ/i],
    boostCategories: ['Payment Policies', 'Business Policies'],
  },
  {
    intent: 'price_objection',
    patterns: [/expensive/i, /high/i, /discount/i, /less/i, /cheap/i, /kom/i, /beshi/i, /দাম বেশি/i, /ডিসকাউন্ট/i, /কম/i],
    boostCategories: ['Sales Behavior', 'Sales Strategies', 'Customer Handling'],
  },
  {
    intent: 'product_inquiry',
    patterns: [/price/i, /spec/i, /feature/i, /stock/i, /original/i, /authentic/i, /দাম/i, /ফিচার/i, /স্টক/i, /আছে/i],
    boostCategories: ['Product Knowledge', 'Frequently Asked Questions'],
  },
];

export async function retrieveRelevantApprovedKnowledge(params: {
  latestMessage: string;
  recentMessages?: MessageDoc[];
  limit?: number;
}): Promise<RetrievedKnowledgeResult> {
  const { knowledge_entries } = getCollections();

  // Strictly retrieve ONLY approved Master Memory entries (pending proposals NEVER leak here)
  const approvedEntries = await knowledge_entries.find(
    { status: 'approved' },
    { sort: { priority: -1, updatedAt: -1 }, limit: 250 },
  );

  if (approvedEntries.length === 0) {
    return { detectedIntents: [], entries: [] };
  }

  const recentCustomerContext = (params.recentMessages ?? [])
    .slice(-4)
    .map((m) => m.text || m.message_text || '')
    .join(' ');
  const combinedQuery = `${params.latestMessage} ${recentCustomerContext}`.trim();
  const normalizedQuery = normalizeText(combinedQuery);
  const queryTokens = normalizedQuery.split(' ').filter((t) => t.length >= 2);

  const detectedIntents: string[] = [];
  const boostedCategories = new Set<KnowledgeCategory>();

  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((rx) => rx.test(combinedQuery))) {
      detectedIntents.push(rule.intent);
      for (const cat of rule.boostCategories) {
        boostedCategories.add(cat);
      }
    }
  }

  const scored: Array<{ entry: KnowledgeEntryDoc; score: number }> = [];

  for (const entry of approvedEntries) {
    const docText = `${entry.title} ${entry.description} ${entry.rules.join(' ')} ${entry.tags.join(' ')} ${entry.category}`;
    const normDoc = normalizeText(docText);

    // Keyword overlap score (works across Bangla, English, and Banglish terms)
    let keywordHits = 0;
    for (const tok of queryTokens) {
      if (normDoc.includes(tok)) {
        keywordHits++;
      }
    }
    const keywordScore = queryTokens.length > 0 ? Math.min(1, keywordHits / Math.min(4, queryTokens.length)) : 0;
    const semanticScore = computeSimilarityScore(combinedQuery, docText);
    const intentBoost = boostedCategories.has(entry.category) ? 0.35 : 0;
    const priorityBoost = ((entry.priority ?? 5) / 10) * 0.1;

    const totalScore = Number((keywordScore * 0.45 + semanticScore * 0.35 + intentBoost + priorityBoost).toFixed(3));

    if (totalScore >= 0.16 || boostedCategories.has(entry.category)) {
      scored.push({ entry, score: totalScore });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const maxItems = Math.min(8, Math.max(1, params.limit ?? 6));

  return {
    detectedIntents,
    entries: scored.slice(0, maxItems).map(({ entry, score }) => ({
      id: entry._id,
      category: entry.category,
      title: entry.title,
      description: entry.description,
      rules: entry.rules,
      source: entry.source,
      score,
    })),
  };
}
