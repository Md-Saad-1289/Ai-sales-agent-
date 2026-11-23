import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getCollections } from '../db/mongo.ts';
import type { OrderDoc, WebhookEventDoc } from '../types.ts';
import { runAISalesAgent } from './aiOrchestrationService.ts';
import {
  addMessage,
  isWithinMessagingWindow,
  upsertConversation,
} from './conversationService.ts';
import { upsertCustomerByMessengerId } from './customerService.ts';
import { fetchMessengerUserProfile, sendMessengerText } from './messengerService.ts';
import { getSettings } from './settingsService.ts';

interface MetaMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
  postback?: {
    mid?: string;
    title?: string;
    payload?: string;
  };
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: MetaMessagingEvent[];
  }>;
}

export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appSecret) {
    // Reject unsigned webhooks in production if META_APP_SECRET is unset
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const providedHex = signatureHeader.slice('sha256='.length).trim();
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const providedBuf = Buffer.from(providedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (providedBuf.length === 0 || providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export async function enqueueMetaWebhookPayload(payload: MetaWebhookPayload): Promise<{
  enqueued: number;
  deduplicated: number;
}> {
  if (payload.object !== 'page' || !Array.isArray(payload.entry)) {
    return { enqueued: 0, deduplicated: 0 };
  }

  const { webhook_events } = getCollections();
  let enqueued = 0;
  let deduplicated = 0;

  for (const entry of payload.entry) {
    if (!Array.isArray(entry.messaging)) continue;
    for (const ev of entry.messaging) {
      if (ev.message?.is_echo) continue;

      const senderId = ev.sender?.id?.trim();
      const recipientId = ev.recipient?.id?.trim() || entry.id?.trim() || '';
      const text = ev.message?.text?.trim() || ev.postback?.title?.trim() || ev.postback?.payload?.trim();
      if (!senderId || !text) continue;

      const messageId = ev.message?.mid || ev.postback?.mid;
      const timestamp = Number(ev.timestamp || entry.time || Date.now());
      const eventId =
        messageId ||
        createHash('sha256')
          .update(`${senderId}:${recipientId}:${timestamp}:${text}`)
          .digest('hex');

      const now = new Date();
      try {
        await webhook_events.insertOne({
          eventId,
          senderId,
          recipientId,
          messageId,
          messageText: text,
          timestamp,
          rawPayload: ev as unknown as Record<string, unknown>,
          status: 'pending',
          attempts: 0,
          maxAttempts: 4,
          nextRetryAt: now,
          createdAt: now,
          updatedAt: now,
        });
        enqueued++;
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (code === 11000) {
          deduplicated++;
        } else {
          throw err;
        }
      }
    }
  }

  if (enqueued > 0) {
    // Trigger immediate background processing without blocking HTTP response to Meta
    setImmediate(() => {
      void drainWebhookQueue();
    });
  }

  return { enqueued, deduplicated };
}

export async function processCustomerTurn(params: {
  senderId: string;
  senderName?: string;
  text: string;
  externalMessageId?: string;
  sendToMessenger: boolean;
  source: 'messenger_ai' | 'test_simulator';
}): Promise<{
  conversationId: string;
  customerId: string;
  aiReplied: boolean;
  replyText?: string;
  handoverTriggered?: boolean;
  createdOrder?: OrderDoc;
  fallbackUsed?: boolean;
}> {
  const profile = params.sendToMessenger
    ? await fetchMessengerUserProfile(params.senderId)
    : {};

  const customer = await upsertCustomerByMessengerId({
    messengerId: params.senderId,
    name: params.senderName || profile.name,
    profilePic: profile.profilePic,
  });

  const conversation = await upsertConversation({
    customerId: customer._id,
    messengerId: customer.messengerId,
    customerName: customer.name,
  });

  // Store incoming customer message (deduplicated by externalMessageId if present)
  await addMessage({
    conversationId: conversation._id,
    customerId: customer._id,
    messengerId: customer.messengerId,
    sender: 'customer',
    text: params.text,
    externalMessageId: params.externalMessageId,
    deliveryStatus: 'received',
  });

  const settings = await getSettings();
  if (!settings.aiGlobalEnabled || !conversation.aiEnabled || conversation.humanTakeover) {
    return {
      conversationId: conversation._id,
      customerId: customer._id,
      aiReplied: false,
    };
  }

  // Re-check 24-hour messaging window before sending outbound automated reply
  if (params.sendToMessenger && !isWithinMessagingWindow(new Date())) {
    return {
      conversationId: conversation._id,
      customerId: customer._id,
      aiReplied: false,
    };
  }

  let replyText: string;
  let action = 'none';
  let language = 'english';
  let recommendedProductIds: string[] = [];
  let createdOrder: OrderDoc | undefined;
  let handoverTriggered = false;
  let fallbackUsed = false;

  try {
    const aiResult = await runAISalesAgent({
      conversationId: conversation._id,
      customerId: customer._id,
      latestCustomerMessage: params.text,
      source: params.source,
    });
    replyText = aiResult.replyText;
    action = aiResult.action;
    language = aiResult.detectedLanguage;
    recommendedProductIds = aiResult.recommendedProductIds;
    createdOrder = aiResult.createdOrder;
    handoverTriggered = aiResult.handoverTriggered;
  } catch (err) {
    console.error('[ai] AI orchestration error, using safe fallback:', err);
    fallbackUsed = true;
    replyText =
      settings.aiLanguageMode === 'bangla'
        ? 'মেসেজ করার জন্য ধন্যবাদ! আমাদের টিম শীঘ্রই আপনাকে রিপ্লাই দিবে।'
        : 'Thank you for messaging us! Our team has received your message and will get back to you shortly.';
  }

  let deliveryStatus: 'sent' | 'failed' | 'simulated' = params.sendToMessenger ? 'sent' : 'simulated';
  let deliveryError: string | undefined;
  let outboundMessageId: string | undefined;

  if (params.sendToMessenger) {
    try {
      const sendRes = await sendMessengerText({
        recipientId: customer.messengerId,
        text: replyText,
      });
      if (sendRes.skipped) {
        deliveryStatus = 'failed';
        deliveryError = sendRes.reason;
      } else {
        outboundMessageId = sendRes.messageId;
      }
    } catch (sendErr) {
      deliveryStatus = 'failed';
      deliveryError = sendErr instanceof Error ? sendErr.message : 'Messenger send failed';
    }
  }

  await addMessage({
    conversationId: conversation._id,
    customerId: customer._id,
    messengerId: customer.messengerId,
    sender: 'ai',
    text: replyText,
    externalMessageId: outboundMessageId,
    deliveryStatus,
    deliveryError,
    aiMetadata: {
      action,
      language,
      recommendedProductIds,
    },
  });

  return {
    conversationId: conversation._id,
    customerId: customer._id,
    aiReplied: true,
    replyText,
    handoverTriggered,
    createdOrder,
    fallbackUsed,
  };
}

let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;

async function processSingleJob(job: WebhookEventDoc): Promise<void> {
  const { webhook_events } = getCollections();

  try {
    if (!job.messageText) {
      await webhook_events.updateOne(
        { _id: job._id },
        { $set: { status: 'completed', updatedAt: new Date() } },
      );
      return;
    }

    await processCustomerTurn({
      senderId: job.senderId,
      text: job.messageText,
      externalMessageId: job.messageId,
      sendToMessenger: true,
      source: 'messenger_ai',
    });

    await webhook_events.updateOne(
      { _id: job._id },
      { $set: { status: 'completed', updatedAt: new Date() } },
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown worker error';
    const nextAttempt = job.attempts + 1;
    const isTerminal = nextAttempt >= job.maxAttempts;
    const backoffMs = Math.min(60000, 2000 * Math.pow(2, nextAttempt));

    await webhook_events.updateOne(
      { _id: job._id },
      {
        $set: {
          status: isTerminal ? 'failed' : 'pending',
          attempts: nextAttempt,
          nextRetryAt: new Date(Date.now() + backoffMs),
          lastError: errorMsg,
          updatedAt: new Date(),
        },
      },
    );
  }
}

export async function drainWebhookQueue(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const { webhook_events } = getCollections();
    const now = new Date();
    const dueJobs = await webhook_events.find(
      { status: 'pending', nextRetryAt: { $lte: now } },
      { sort: { createdAt: 1 }, limit: 10 },
    );

    for (const job of dueJobs) {
      const claimed = await webhook_events.findOneAndUpdate(
        { _id: job._id, status: 'pending' },
        { $set: { status: 'processing', updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (claimed) {
        await processSingleJob(claimed);
      }
    }
  } catch (err) {
    console.error('[queue] Error draining webhook queue:', err);
  } finally {
    workerRunning = false;
  }
}

export function startWebhookWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void drainWebhookQueue();
  }, 3000);
}

export function stopWebhookWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
