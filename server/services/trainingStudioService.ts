import { getCollections } from '../db/mongo.ts';
import type {
  KnowledgeProposalDoc,
  KnowledgeSourceDoc,
  TrainingIntent,
  TrainingMessageDoc,
  TrainingSessionDoc,
} from '../types.ts';
import { recordAuditLog } from './auditService.ts';
import { parseAndChunkDocument, sanitizeUntrustedDocumentText } from './documentParserService.ts';
import { executeWithGeminiStream } from './geminiClient.ts';
import {
  analyzeKnowledgeGaps,
  createProposalsFromExtractedItems,
  extractStructuredItemsFromText,
} from './knowledgeEngineService.ts';
import { emitRealtimeEvent } from './realtimeService.ts';
import { getSettings } from './settingsService.ts';

export async function listTrainingSessions(ownerEmail: string): Promise<TrainingSessionDoc[]> {
  const { training_sessions } = getCollections();
  return training_sessions.find({ ownerEmail }, { sort: { updatedAt: -1 }, limit: 50 });
}

export async function createTrainingSession(params: {
  title?: string;
  adminId: string;
  adminEmail: string;
}): Promise<TrainingSessionDoc> {
  const { training_sessions, training_messages } = getCollections();
  const now = new Date();
  const cleanTitle = params.title?.trim().slice(0, 120) || 'New Training Session';

  const session = await training_sessions.insertOne({
    title: cleanTitle,
    createdBy: params.adminId,
    ownerEmail: params.adminEmail,
    lastMessagePreview: 'Ready to learn rules, policies, or product knowledge.',
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
  });

  await training_messages.insertOne({
    sessionId: session._id,
    role: 'ai',
    text: 'Training Studio is ready. Teach me sales rules, policies, customer handling guidelines, or attach a PDF, TXT, CSV, DOCX, or XLSX file. Every change will be prepared as an approval proposal before entering Master Memory.',
    createdAt: now,
  });

  return session;
}

export async function getTrainingSessionDetail(sessionId: string): Promise<{
  session: TrainingSessionDoc;
  messages: TrainingMessageDoc[];
  proposals: KnowledgeProposalDoc[];
  sources: KnowledgeSourceDoc[];
} | null> {
  const { training_sessions, training_messages, knowledge_proposals, knowledge_sources } = getCollections();
  const session = await training_sessions.findOne({ _id: sessionId });
  if (!session) return null;

  const [messages, proposals, sources] = await Promise.all([
    training_messages.find({ sessionId }, { sort: { createdAt: 1 }, limit: 300 }),
    knowledge_proposals.find({ sessionId }, { sort: { createdAt: -1 }, limit: 200 }),
    knowledge_sources.find({ sessionId }, { sort: { createdAt: -1 }, limit: 50 }),
  ]);

  return { session, messages, proposals, sources };
}

function detectTrainingIntentHeuristic(text: string): TrainingIntent {
  const lower = text.toLowerCase();
  if (/\b(delete|remove|drop|erase)\b|মুছে|ডিলিট/.test(lower)) return 'delete_request';
  if (/\b(add|create|new)\b.*\b(product|item|catalog)\b|প্রোডাক্ট/.test(lower)) return 'product_create';
  if (/\b(update|change|price|stock)\b.*\b(product|price|stock)\b|দাম/.test(lower)) return 'product_update';
  if (/\b(warranty|delivery|return|refund|payment|policy)\b|ওয়ারেন্টি|ডেলিভারি|রিটার্ন/.test(lower)) {
    return 'policy_update';
  }
  if (/\b(always|never|must|when a customer|if customer|should receive|avoid)\b/.test(lower)) {
    return 'new_behavioral_rule';
  }
  if (/\?$/.test(text.trim())) return 'general_question';
  return 'new_knowledge';
}

export async function processTrainingChatTurn(params: {
  sessionId: string;
  adminId: string;
  adminEmail: string;
  text: string;
  onToken?: (chunk: string) => void;
}): Promise<{
  userMessage: TrainingMessageDoc;
  aiMessage: TrainingMessageDoc;
  proposals: KnowledgeProposalDoc[];
}> {
  const { training_sessions, training_messages, knowledge_entries, products } = getCollections();
  const session = await training_sessions.findOne({ _id: params.sessionId });
  if (!session) {
    throw new Error('Training session not found.');
  }

  const cleanUserText = sanitizeUntrustedDocumentText(params.text).slice(0, 4000);
  if (!cleanUserText) {
    throw new Error('Message text is required.');
  }

  const userNow = new Date();
  const userMessage = await training_messages.insertOne({
    sessionId: params.sessionId,
    role: 'admin',
    text: cleanUserText,
    createdAt: userNow,
  });

  const [history, approvedEntries, existingProducts, settings] = await Promise.all([
    training_messages.find({ sessionId: params.sessionId }, { sort: { createdAt: 1 }, limit: 16 }),
    knowledge_entries.find({ status: 'approved' }, { limit: 120 }),
    products.find({}, { limit: 100 }),
    getSettings(),
  ]);

  const intent = detectTrainingIntentHeuristic(cleanUserText);

  // Step 1: Extract structured proposals if the message teaches rules, policies, products, or deletion requests
  let proposals: KnowledgeProposalDoc[] = [];
  let duplicatesSkipped = 0;
  let conflictsDetected = 0;

  if (intent !== 'general_question') {
    const candidates = await extractStructuredItemsFromText({
      rawText: cleanUserText,
      sourceContext: `Training Studio chat session "${session.title}" by ${params.adminEmail}`,
      existingEntriesSummary: approvedEntries.map((e) => ({
        id: e._id,
        category: e.category,
        title: e.title,
      })),
      existingProductsSummary: existingProducts.map((p) => ({
        id: p._id,
        name: p.name,
        price: p.price,
      })),
    });

    if (candidates.length > 0) {
      const res = await createProposalsFromExtractedItems({
        candidates,
        sessionId: params.sessionId,
        messageId: userMessage._id,
        newSourceLabel: 'Training Studio Chat',
        sourceRef: {
          filename: `Training Session (${session.title})`,
          pageOrSheet: 'Interactive Chat',
          sectionOrRow: `Message ${userMessage._id.slice(0, 8)}`,
          extractedAt: new Date(),
        },
      });
      proposals = res.proposals;
      duplicatesSkipped = res.duplicatesSkipped;
      conflictsDetected = res.conflictsDetected;
    }
  }

  // Step 2: Stream concise, grounded conversational explanation + next-step guidance
  const proposalSummary = proposals.map((p) => ({
    action: p.action,
    classification: p.classification,
    type: p.proposalType,
    title: p.proposedEntry?.title || p.proposedProduct?.name || p.targetEntryId || 'Item',
    missingFields: p.missingFields ?? [],
    reason: p.reason,
  }));

  const systemInstruction = [
    `You are the AI Training Assistant for "${settings.businessName}" inside Training Studio.`,
    `You help the administrator teach business rules, communication style, policies, and product knowledge.`,
    `CRITICAL RULES:`,
    `- Never claim you have already permanently modified Master Memory or the Products catalog. All extracted changes are prepared strictly as PENDING APPROVAL PROPOSALS requiring admin confirmation.`,
    `- Acknowledge detected duplicates (${duplicatesSkipped}) or conflicts (${conflictsDetected}) clearly when present.`,
    `- If any product proposal has missing fields (like stock or description), politely ask if the admin wants to fill them in or edit the proposal card.`,
    `- Support Bangla, English, and Banglish naturally; reply in the language the admin wrote in, keeping the message clean, concise, and helpful.`,
  ].join('\n');

  const conversationSnippet = history
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
    .join('\n');

  const prompt = [
    `<approved_memory_count>${approvedEntries.length}</approved_memory_count>`,
    `<active_products_count>${existingProducts.length}</active_products_count>`,
    `<extracted_proposals>${JSON.stringify(proposalSummary)}</extracted_proposals>`,
    `<duplicates_skipped>${duplicatesSkipped}</duplicates_skipped>`,
    `<conflicts_detected>${conflictsDetected}</conflicts_detected>`,
    `<recent_training_chat>\n${conversationSnippet}\n</recent_training_chat>`,
    `<latest_admin_message>${cleanUserText}</latest_admin_message>`,
  ].join('\n\n');

  let aiReplyText = '';
  const stream = executeWithGeminiStream((ai, meta) =>
    ai.models.generateContentStream({
      model: meta.model,
      contents: prompt,
      config: { systemInstruction },
    }),
  );

  for await (const chunk of stream) {
    const piece = chunk.text ?? '';
    if (piece) {
      aiReplyText += piece;
      params.onToken?.(piece);
    }
  }

  aiReplyText = aiReplyText.trim();
  if (!aiReplyText) {
    aiReplyText =
      proposals.length > 0
        ? `Prepared ${proposals.length} proposal(s) for your review below. Nothing enters Master Memory until you approve.`
        : 'Understood. Let me know if you want to turn this into an approved rule or product proposal.';
    params.onToken?.(aiReplyText);
  }

  const aiNow = new Date(Math.max(Date.now(), userNow.getTime() + 1));
  const aiMessage = await training_messages.insertOne({
    sessionId: params.sessionId,
    role: 'ai',
    text: aiReplyText,
    intent,
    proposalIds: proposals.map((p) => p._id),
    createdAt: aiNow,
  });

  const nextTitle =
    session.title === 'New Training Session'
      ? cleanUserText.slice(0, 48) + (cleanUserText.length > 48 ? '...' : '')
      : session.title;

  await training_sessions.updateOne(
    { _id: params.sessionId },
    {
      $set: {
        title: nextTitle,
        lastMessagePreview: aiReplyText.slice(0, 140),
        updatedAt: aiNow,
      },
      $inc: { messageCount: 2 },
    },
  );

  return { userMessage, aiMessage, proposals };
}

export async function runProactiveGapCheck(params: {
  sessionId: string;
}): Promise<TrainingMessageDoc> {
  const { training_messages, training_sessions } = getCollections();
  const gaps = await analyzeKnowledgeGaps();

  const text =
    gaps.length === 0
      ? 'Your approved Master Memory covers core sales behavior, delivery, payment, warranty, and FAQ areas cleanly.'
      : `I reviewed your approved Master Memory and catalog and found ${gaps.length} potential knowledge gap(s) you can teach me next (nothing has been invented or added automatically):`;

  const msg = await training_messages.insertOne({
    sessionId: params.sessionId,
    role: 'ai',
    text,
    gapSuggestions: gaps,
    createdAt: new Date(),
  });

  await training_sessions.updateOne(
    { _id: params.sessionId },
    {
      $set: { lastMessagePreview: text.slice(0, 140), updatedAt: new Date() },
      $inc: { messageCount: 1 },
    },
  );

  return msg;
}

export async function enqueueTrainingFileUpload(params: {
  sessionId: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  adminId: string;
  adminEmail: string;
}): Promise<KnowledgeSourceDoc> {
  const { knowledge_sources, knowledge_chunks, training_sessions, training_messages } = getCollections();
  const session = await training_sessions.findOne({ _id: params.sessionId });
  if (!session) {
    throw new Error('Training session not found.');
  }

  const parsed = await parseAndChunkDocument({
    filename: params.filename,
    mimeType: params.mimeType,
    buffer: params.buffer,
  });

  const now = new Date();
  const source = await knowledge_sources.insertOne({
    sessionId: params.sessionId,
    filename: parsed.sanitizedFilename,
    mimeType: params.mimeType,
    fileType: parsed.fileType,
    sizeBytes: params.buffer.length,
    sha256: parsed.sha256,
    status: 'analyzing',
    totalChunks: parsed.chunks.length,
    processedChunks: 0,
    extractedItemsCount: 0,
    proposalsCreatedCount: 0,
    duplicatesSkippedCount: 0,
    conflictsDetectedCount: 0,
    uploadedBy: params.adminEmail,
    createdAt: now,
    updatedAt: now,
  });

  for (const ch of parsed.chunks) {
    await knowledge_chunks.insertOne({
      sourceId: source._id,
      chunkIndex: ch.chunkIndex,
      content: ch.content,
      contentHash: ch.contentHash,
      filename: ch.filename,
      pageOrSheet: ch.pageOrSheet,
      sectionOrRow: ch.sectionOrRow,
      extractedAt: ch.extractedAt,
      status: 'pending',
      createdAt: now,
    });
  }

  await training_messages.insertOne({
    sessionId: params.sessionId,
    role: 'admin',
    text: `Uploaded file: ${parsed.sanitizedFilename} (${parsed.fileType.toUpperCase()}, ${parsed.chunks.length} chunk(s))`,
    sourceId: source._id,
    createdAt: now,
  });

  await recordAuditLog({
    actorType: 'admin',
    actorId: params.adminId,
    actorEmail: params.adminEmail,
    action: 'UPLOAD_TRAINING_DOCUMENT',
    targetType: 'knowledge_source',
    targetId: source._id,
    summary: `Uploaded "${parsed.sanitizedFilename}" (${parsed.chunks.length} chunk(s)) for incremental analysis`,
  });

  emitRealtimeEvent('training:source_updated', { source });

  setImmediate(() => {
    void processKnowledgeSourceChunks(source._id, params.sessionId);
  });

  return source;
}

async function processKnowledgeSourceChunks(sourceId: string, sessionId: string): Promise<void> {
  const {
    knowledge_sources,
    knowledge_chunks,
    knowledge_entries,
    products,
    training_messages,
    training_sessions,
  } = getCollections();

  try {
    const source = await knowledge_sources.findOne({ _id: sourceId });
    if (!source) return;

    const chunks = await knowledge_chunks.find({ sourceId }, { sort: { chunkIndex: 1 } });
    const [approvedEntries, existingProducts] = await Promise.all([
      knowledge_entries.find({ status: 'approved' }, { limit: 150 }),
      products.find({}, { limit: 120 }),
    ]);

    const allCreatedProposals: KnowledgeProposalDoc[] = [];
    let extractedCount = 0;
    let duplicatesSkipped = 0;
    let conflictsDetected = 0;

    for (const chunk of chunks) {
      try {
        const candidates = await extractStructuredItemsFromText({
          rawText: chunk.content,
          sourceContext: `Document "${chunk.filename}" · ${chunk.pageOrSheet} · ${chunk.sectionOrRow}`,
          existingEntriesSummary: approvedEntries.map((e) => ({
            id: e._id,
            category: e.category,
            title: e.title,
          })),
          existingProductsSummary: existingProducts.map((p) => ({
            id: p._id,
            name: p.name,
            price: p.price,
          })),
        });

        extractedCount += candidates.length;

        if (candidates.length > 0) {
          const result = await createProposalsFromExtractedItems({
            candidates,
            sessionId,
            sourceId,
            newSourceLabel: `${chunk.filename} (${chunk.pageOrSheet}, ${chunk.sectionOrRow})`,
            sourceRef: {
              sourceId,
              filename: chunk.filename,
              pageOrSheet: chunk.pageOrSheet,
              sectionOrRow: chunk.sectionOrRow,
              extractedAt: chunk.extractedAt,
            },
          });
          allCreatedProposals.push(...result.proposals);
          duplicatesSkipped += result.duplicatesSkipped;
          conflictsDetected += result.conflictsDetected;
        }

        await knowledge_chunks.updateOne(
          { _id: chunk._id },
          { $set: { status: 'processed' } },
        );
      } catch (chunkErr) {
        await knowledge_chunks.updateOne(
          { _id: chunk._id },
          {
            $set: {
              status: 'failed',
              error: chunkErr instanceof Error ? chunkErr.message : 'Chunk analysis failed',
            },
          },
        );
      }

      const updatedSrc = await knowledge_sources.findOneAndUpdate(
        { _id: sourceId },
        {
          $inc: { processedChunks: 1 },
          $set: {
            extractedItemsCount: extractedCount,
            proposalsCreatedCount: allCreatedProposals.length,
            duplicatesSkippedCount: duplicatesSkipped,
            conflictsDetectedCount: conflictsDetected,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );
      if (updatedSrc) {
        emitRealtimeEvent('training:source_updated', { source: updatedSrc });
      }
    }

    const completedSrc = await knowledge_sources.findOneAndUpdate(
      { _id: sourceId },
      {
        $set: {
          status: 'completed',
          extractedItemsCount: extractedCount,
          proposalsCreatedCount: allCreatedProposals.length,
          duplicatesSkippedCount: duplicatesSkipped,
          conflictsDetectedCount: conflictsDetected,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );

    if (completedSrc) {
      emitRealtimeEvent('training:source_updated', { source: completedSrc });
    }

    const summaryLines = [
      `Finished analyzing "${source.filename}" across ${chunks.length} chunk(s).`,
      `• Proposals prepared for review: ${allCreatedProposals.length}`,
      `• Duplicates skipped automatically: ${duplicatesSkipped}`,
      conflictsDetected > 0 ? `• Conflicts needing side-by-side review: ${conflictsDetected}` : null,
      allCreatedProposals.length > 0
        ? `Review and approve each proposal card below before it enters Master Memory or Products.`
        : `All relevant items from this document already matched your existing Master Memory / Catalog.`,
    ].filter(Boolean);

    const summaryText = summaryLines.join('\n');
    await training_messages.insertOne({
      sessionId,
      role: 'ai',
      text: summaryText,
      sourceId,
      proposalIds: allCreatedProposals.map((p) => p._id),
      createdAt: new Date(),
    });

    await training_sessions.updateOne(
      { _id: sessionId },
      {
        $set: { lastMessagePreview: summaryText.slice(0, 140), updatedAt: new Date() },
        $inc: { messageCount: 2 },
      },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Document processing error.';
    const failedSrc = await knowledge_sources.findOneAndUpdate(
      { _id: sourceId },
      { $set: { status: 'failed', error: errMsg, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (failedSrc) {
      emitRealtimeEvent('training:source_updated', { source: failedSrc });
    }
    await training_messages.insertOne({
      sessionId,
      role: 'system',
      text: `Document processing failed: ${errMsg}`,
      sourceId,
      createdAt: new Date(),
    });
  }
}

export async function getKnowledgeSourceStatus(sourceId: string): Promise<KnowledgeSourceDoc | null> {
  const { knowledge_sources } = getCollections();
  return knowledge_sources.findOne({ _id: sourceId });
}
