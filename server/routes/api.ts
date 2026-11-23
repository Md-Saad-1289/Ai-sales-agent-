import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';
import type { KnowledgeCategory } from '../types.ts';
import { listAuditLogs } from '../services/auditService.ts';
import { MAX_UPLOAD_BYTES } from '../services/documentParserService.ts';
import { createProposalsFromExtractedItems } from '../services/knowledgeEngineService.ts';
import {
  compileShortMemoryScript,
  getActiveMemoryScript,
  KNOWLEDGE_CATEGORIES,
  listApprovedKnowledgeEntries,
  listMemoryScriptVersions,
  saveManualMemoryScriptEdit,
} from '../services/memoryCompilerService.ts';
import {
  type AdminActor,
  approveProposal,
  archiveKnowledgeEntry,
  editApprovedKnowledgeEntry,
  editKnowledgeEntrySchema,
  editProposal,
  editProposalSchema,
  getKnowledgeEntryDetail,
  listProposals,
  rejectProposal,
  requestProposalClarification,
  restoreArchivedKnowledgeEntry,
} from '../services/proposalService.ts';
import {
  createTrainingSession,
  enqueueTrainingFileUpload,
  getKnowledgeSourceStatus,
  getTrainingSessionDetail,
  listTrainingSessions,
  processTrainingChatTurn,
  runProactiveGapCheck,
} from '../services/trainingStudioService.ts';
import {
  type AuthenticatedRequest,
  claimAdminSchema,
  claimFirstAdmin,
  clearSessionCookies,
  getAuthBootstrapStatus,
  getRefreshCookieName,
  loginAdmin,
  loginSchema,
  parseCookies,
  requireAdmin,
  resolveOrRefreshAdmin,
  revokeSessionFromRequest,
  rotateRefreshSession,
  setSessionCookies,
} from '../services/authService.ts';
import {
  addMessage,
  getConversationById,
  getConversationMessages,
  isWithinMessagingWindow,
  listConversations,
  markConversationRead,
  setConversationAIState,
} from '../services/conversationService.ts';
import { getCustomerProfileWithOrders } from '../services/customerService.ts';
import { sendMessengerText, verifyFacebookPageConnection } from '../services/messengerService.ts';
import {
  listOrders,
  orderStatusSchema,
  updateOrderStatus,
} from '../services/orderService.ts';
import {
  createProduct,
  deleteProduct,
  listProducts,
  productInputSchema,
  updateProduct,
} from '../services/productService.ts';
import { attachSseClient } from '../services/realtimeService.ts';
import {
  getEnvironmentStatus,
  getSettings,
  updateSettings,
  updateSettingsSchema,
} from '../services/settingsService.ts';
import {
  enqueueMetaWebhookPayload,
  processCustomerTurn,
  verifyMetaSignature,
} from '../services/webhookService.ts';

export type RawBodyRequest = Request & { rawBody?: Buffer };

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

const trainingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 35,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Training request limit reached. Please wait a moment.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

function toAdminActor(req: AuthenticatedRequest): AdminActor {
  if (!req.admin || req.admin.role !== 'admin') {
    throw new Error('Forbidden: Admin authentication required.');
  }
  return {
    actorType: 'admin',
    sub: req.admin.sub,
    email: req.admin.email,
    name: req.admin.name,
    role: 'admin',
  };
}

function timingSafeMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createApiRouter() {
  const router = express.Router();

  // --- Health ---
  router.get('/health', (_req, res) => {
    res.json({ ok: true, env: getEnvironmentStatus() });
  });

  // --- Meta Messenger Webhooks (Public, Signature/Token Verified) ---
  router.get('/webhooks/messenger', webhookLimiter, (req: Request, res: Response) => {
    const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : '';
    const token = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
    const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';
    const expectedToken = process.env.META_VERIFY_TOKEN?.trim() || '';

    if (mode === 'subscribe' && expectedToken && token && timingSafeMatch(token, expectedToken)) {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
  });

  router.post('/webhooks/messenger', webhookLimiter, async (req: RawBodyRequest, res: Response) => {
    const signature = req.header('x-hub-signature-256');
    const rawBody = req.rawBody;

    if (!rawBody || !verifyMetaSignature(rawBody, signature)) {
      res.status(403).json({ error: 'Invalid webhook signature.' });
      return;
    }

    try {
      await enqueueMetaWebhookPayload(req.body as Record<string, unknown>);
      res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('[webhook] Failed to enqueue Meta payload:', err);
      res.status(500).json({ error: 'Webhook enqueue error.' });
    }
  });

  // --- Admin Auth ---
  router.get('/auth/status', async (_req, res) => {
    try {
      const status = await getAuthBootstrapStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load auth status.' });
    }
  });

  router.post('/auth/claim', authLimiter, async (req, res) => {
    const parsed = claimAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid setup input.' });
      return;
    }
    try {
      const result = await claimFirstAdmin(parsed.data);
      setSessionCookies(req, res, result.accessToken, result.refreshToken);
      res.status(201).json({ admin: result.admin });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Setup failed.' });
    }
  });

  router.post('/auth/login', authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid credentials.' });
      return;
    }
    try {
      const result = await loginAdmin(parsed.data);
      setSessionCookies(req, res, result.accessToken, result.refreshToken);
      res.json({ admin: result.admin });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  });

  router.post('/auth/refresh', authLimiter, async (req, res) => {
    try {
      const cookies = parseCookies(req);
      const rawRefresh = cookies[getRefreshCookieName()];
      if (!rawRefresh) {
        clearSessionCookies(req, res);
        res.status(401).json({ error: 'Refresh session not found.' });
        return;
      }
      const rotated = await rotateRefreshSession(rawRefresh);
      if (!rotated) {
        clearSessionCookies(req, res);
        res.status(401).json({ error: 'Refresh session expired or revoked.' });
        return;
      }
      setSessionCookies(req, res, rotated.accessToken, rotated.refreshToken);
      res.json({ admin: rotated.admin });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to refresh session.' });
    }
  });

  router.post('/auth/logout', async (req, res) => {
    try {
      await revokeSessionFromRequest(req);
    } catch {
      // Ignore cleanup errors on logout
    }
    clearSessionCookies(req, res);
    res.json({ ok: true });
  });

  router.get('/auth/me', async (req, res) => {
    try {
      const payload = await resolveOrRefreshAdmin(req, res);
      if (!payload) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }
      res.json({
        admin: {
          email: payload.email,
          name: payload.name,
          role: payload.role,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to verify session.' });
    }
  });

  // Realtime Server-Sent Events Stream (exempt from short API rate limiter)
  router.get('/events/stream', requireAdmin, (req, res) => {
    attachSseClient(req, res);
  });

  // --- Authenticated Admin Endpoints ---
  router.use(apiLimiter, requireAdmin);

  // Overview
  router.get('/overview', async (_req, res) => {
    try {
      const { conversations, orders } = getCollections();
      const [
        totalConversations,
        confirmedOrders,
        pendingOrders,
        settings,
        recentConversations,
        recentOrders,
      ] = await Promise.all([
        conversations.countDocuments({}),
        orders.countDocuments({ status: 'confirmed' }),
        orders.countDocuments({ status: 'pending' }),
        getSettings(),
        conversations.find({}, { sort: { lastMessageAt: -1 }, limit: 5 }),
        orders.find({}, { sort: { createdAt: -1 }, limit: 5 }),
      ]);

      const envStatus = getEnvironmentStatus();
      res.json({
        metrics: {
          totalConversations,
          confirmedOrders,
          pendingOrders,
          aiGlobalEnabled: settings.aiGlobalEnabled,
          geminiConfigured: envStatus.geminiConfigured,
          facebookPageConnected: Boolean(settings.facebookPageId && envStatus.metaPageTokenConfigured),
          facebookPageName: settings.facebookPageName,
          currency: settings.currency,
        },
        recentConversations,
        recentOrders,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load overview.' });
    }
  });

  // Products
  router.get('/products', async (req, res) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const activeOnly = req.query.active === 'true';
      const items = await listProducts({ search, activeOnly });
      res.json({ products: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load products.' });
    }
  });

  router.post('/products', async (req, res) => {
    const parsed = productInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid product payload.' });
      return;
    }
    try {
      const created = await createProduct(parsed.data);
      res.status(201).json({ product: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create product.' });
    }
  });

  router.put('/products/:id', async (req, res) => {
    const parsed = productInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid product payload.' });
      return;
    }
    try {
      const updated = await updateProduct(String(req.params.id), parsed.data);
      if (!updated) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      res.json({ product: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update product.' });
    }
  });

  router.delete('/products/:id', async (req, res) => {
    try {
      const deleted = await deleteProduct(String(req.params.id));
      if (!deleted) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      res.json({ deleted: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete product.' });
    }
  });

  // Conversations
  router.get('/conversations', async (req, res) => {
    try {
      const filterParam =
        req.query.filter === 'ai_active' || req.query.filter === 'human_takeover'
          ? req.query.filter
          : 'all';
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const items = await listConversations({ filter: filterParam, search });
      res.json({ conversations: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load conversations.' });
    }
  });

  router.get('/conversations/:id', async (req, res) => {
    try {
      const conversation = await getConversationById(String(req.params.id));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100;
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;

      if (!before) {
        await markConversationRead(conversation._id);
      }

      const [msgPage, customerProfile] = await Promise.all([
        getConversationMessages(conversation._id, { limit, before }),
        getCustomerProfileWithOrders(conversation.customerId),
      ]);

      res.json({
        conversation: before ? conversation : { ...conversation, unreadCount: 0 },
        withinMessagingWindow: isWithinMessagingWindow(conversation.lastCustomerMessageAt),
        messages: msgPage.messages,
        hasMore: msgPage.hasMore,
        nextCursor: msgPage.nextCursor,
        customer: customerProfile.customer,
        customerOrders: customerProfile.orders,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load conversation.' });
    }
  });

  router.patch('/conversations/:id/ai', async (req, res) => {
    const schema = z.object({
      aiEnabled: z.boolean(),
      humanTakeover: z.boolean().optional(),
      handoverReason: z.string().trim().max(240).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid AI toggle payload.' });
      return;
    }

    try {
      const humanTakeover = parsed.data.humanTakeover ?? !parsed.data.aiEnabled;
      const updated = await setConversationAIState(String(req.params.id), {
        aiEnabled: parsed.data.aiEnabled,
        humanTakeover,
        handoverReason: parsed.data.aiEnabled ? '' : parsed.data.handoverReason ?? 'Manual admin takeover',
      });
      if (!updated) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      res.json({ conversation: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update conversation.' });
    }
  });

  router.post('/conversations/:id/messages', async (req, res) => {
    const schema = z.object({
      text: z.string().trim().min(1).max(1900),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Message text is required.' });
      return;
    }

    try {
      const conversation = await getConversationById(String(req.params.id));
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }

      if (!isWithinMessagingWindow(conversation.lastCustomerMessageAt)) {
        res.status(400).json({
          error:
            'Meta 24-hour messaging window has expired for this conversation. You can reply once the customer sends a new message.',
        });
        return;
      }

      // Admin manual reply enforces human takeover and disables automatic AI replies until re-enabled
      await setConversationAIState(conversation._id, {
        aiEnabled: false,
        humanTakeover: true,
        handoverReason: 'Administrator took over conversation',
      });

      const isSimulated = conversation.messengerId.startsWith('sim_');
      let deliveryStatus: 'sent' | 'failed' | 'simulated' = isSimulated ? 'simulated' : 'sent';
      let deliveryError: string | undefined;
      let externalMessageId: string | undefined;

      if (!isSimulated) {
        try {
          const sendRes = await sendMessengerText({
            recipientId: conversation.messengerId,
            text: parsed.data.text,
          });
          if (sendRes.skipped) {
            deliveryStatus = 'failed';
            deliveryError = sendRes.reason;
          } else {
            externalMessageId = sendRes.messageId;
          }
        } catch (sendErr) {
          deliveryStatus = 'failed';
          deliveryError = sendErr instanceof Error ? sendErr.message : 'Messenger send failed';
        }
      }

      const message = await addMessage({
        conversationId: conversation._id,
        customerId: conversation.customerId,
        messengerId: conversation.messengerId,
        sender: 'admin',
        text: parsed.data.text,
        externalMessageId,
        deliveryStatus,
        deliveryError,
        source: 'dashboard',
      });

      const refreshed = await getConversationById(conversation._id);
      res.status(201).json({ message, conversation: refreshed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send reply.' });
    }
  });

  // Live AI Sales Agent Test Endpoint (uses real Gemini + real MongoDB catalog & orders)
  router.post('/conversations/test-message', async (req, res) => {
    const schema = z.object({
      senderId: z.string().trim().min(3).max(80).optional(),
      senderName: z.string().trim().min(1).max(80).optional(),
      text: z.string().trim().min(1).max(1500),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Message text is required.' });
      return;
    }

    try {
      const rawSender = parsed.data.senderId || 'sim_test_customer';
      const senderId = rawSender.startsWith('sim_') ? rawSender : `sim_${rawSender}`;
      const result = await processCustomerTurn({
        senderId,
        senderName: parsed.data.senderName || 'Test Customer',
        text: parsed.data.text,
        sendToMessenger: false,
        source: 'test_simulator',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Test simulation failed.' });
    }
  });

  // Orders
  router.get('/orders', async (req, res) => {
    try {
      const statusParam =
        typeof req.query.status === 'string' && req.query.status !== 'all'
          ? orderStatusSchema.safeParse(req.query.status)
          : null;
      if (statusParam && !statusParam.success) {
        res.status(400).json({ error: 'Invalid order status filter.' });
        return;
      }
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const items = await listOrders({
        status: statusParam ? statusParam.data : 'all',
        search,
      });
      res.json({ orders: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load orders.' });
    }
  });

  router.patch('/orders/:id/status', async (req, res) => {
    const parsed = z.object({ status: orderStatusSchema }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid order status.' });
      return;
    }
    try {
      const updated = await updateOrderStatus(String(req.params.id), parsed.data.status);
      if (!updated) {
        res.status(404).json({ error: 'Order not found.' });
        return;
      }
      res.json({ order: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update order status.' });
    }
  });

  // Settings
  router.get('/settings', async (_req, res) => {
    try {
      const settings = await getSettings();
      res.json({
        settings,
        environment: getEnvironmentStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load settings.' });
    }
  });

  router.put('/settings', async (req, res) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid settings payload.' });
      return;
    }
    try {
      const settings = await updateSettings(parsed.data);
      res.json({
        settings,
        environment: getEnvironmentStatus(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save settings.' });
    }
  });

  router.post('/settings/verify-facebook', async (_req, res) => {
    try {
      const verification = await verifyFacebookPageConnection();
      if (verification.connected && verification.pageId && verification.pageName) {
        const current = await getSettings();
        await updateSettings({
          businessName: current.businessName,
          businessDescription: current.businessDescription,
          currency: current.currency,
          deliveryCharge: current.deliveryCharge,
          deliveryChargeNote: current.deliveryChargeNote,
          returnPolicy: current.returnPolicy,
          salesInstructions: current.salesInstructions,
          aiTone: current.aiTone,
          aiLanguageMode: current.aiLanguageMode,
          aiGlobalEnabled: current.aiGlobalEnabled,
          humanHandoverKeywords: current.humanHandoverKeywords,
          humanHandoverRules: current.humanHandoverRules,
          facebookPageId: verification.pageId,
          facebookPageName: verification.pageName,
        });
      }
      res.json(verification);
    } catch (err) {
      res.status(500).json({
        connected: false,
        error: err instanceof Error ? err.message : 'Verification failed.',
      });
    }
  });

  // --- AI Training Studio ---
  router.get('/training/sessions', async (req: AuthenticatedRequest, res) => {
    try {
      const actor = toAdminActor(req);
      const sessions = await listTrainingSessions(actor.email);
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load training sessions.' });
    }
  });

  router.post('/training/sessions', async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ title: z.string().trim().max(120).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid training session payload.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const session = await createTrainingSession({
        title: parsed.data.title,
        adminId: actor.sub,
        adminEmail: actor.email,
      });
      res.status(201).json({ session });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create training session.' });
    }
  });

  router.get('/training/sessions/:id', async (req: AuthenticatedRequest, res) => {
    try {
      const actor = toAdminActor(req);
      const detail = await getTrainingSessionDetail(String(req.params.id));
      if (!detail || detail.session.ownerEmail !== actor.email) {
        res.status(404).json({ error: 'Training session not found.' });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load training session.' });
    }
  });

  router.post('/training/sessions/:id/messages', trainingLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Training message text is required.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const existing = await getTrainingSessionDetail(String(req.params.id));
      if (!existing || existing.session.ownerEmail !== actor.email) {
        res.status(404).json({ error: 'Training session not found.' });
        return;
      }
      const result = await processTrainingChatTurn({
        sessionId: existing.session._id,
        adminId: actor.sub,
        adminEmail: actor.email,
        text: parsed.data.text,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to process training message.' });
    }
  });

  router.post('/training/sessions/:id/messages/stream', trainingLimiter, async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Training message text is required.' });
      return;
    }

    try {
      const actor = toAdminActor(req);
      const existing = await getTrainingSessionDetail(String(req.params.id));
      if (!existing || existing.session.ownerEmail !== actor.email) {
        res.status(404).json({ error: 'Training session not found.' });
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const writeEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const result = await processTrainingChatTurn({
        sessionId: existing.session._id,
        adminId: actor.sub,
        adminEmail: actor.email,
        text: parsed.data.text,
        onToken: (delta) => writeEvent('delta', { delta }),
      });

      writeEvent('done', result);
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Streaming training error.';
      if (!res.headersSent) {
        res.status(500).json({ error: msg });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        res.end();
      }
    }
  });

  router.post('/training/sessions/:id/gaps', trainingLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      const actor = toAdminActor(req);
      const existing = await getTrainingSessionDetail(String(req.params.id));
      if (!existing || existing.session.ownerEmail !== actor.email) {
        res.status(404).json({ error: 'Training session not found.' });
        return;
      }
      const message = await runProactiveGapCheck({ sessionId: existing.session._id });
      res.json({ message });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Gap analysis failed.' });
    }
  });

  router.post(
    '/training/upload',
    trainingLimiter,
    (req, res, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : 'File upload error.' });
          return;
        }
        next();
      });
    },
    async (req: AuthenticatedRequest, res) => {
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required.' });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No file attached.' });
        return;
      }
      try {
        const actor = toAdminActor(req);
        const existing = await getTrainingSessionDetail(sessionId);
        if (!existing || existing.session.ownerEmail !== actor.email) {
          res.status(404).json({ error: 'Training session not found.' });
          return;
        }
        const source = await enqueueTrainingFileUpload({
          sessionId,
          filename: file.originalname,
          mimeType: file.mimetype,
          buffer: file.buffer,
          adminId: actor.sub,
          adminEmail: actor.email,
        });
        res.status(202).json({ source });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to process uploaded file.' });
      }
    },
  );

  router.get('/training/sources/:id', async (req: AuthenticatedRequest, res) => {
    try {
      toAdminActor(req);
      const source = await getKnowledgeSourceStatus(String(req.params.id));
      if (!source) {
        res.status(404).json({ error: 'Source document not found.' });
        return;
      }
      res.json({ source });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load upload status.' });
    }
  });

  // --- Knowledge Memory (Layer A: Approved Master Memory) ---
  router.get('/knowledge', async (req, res) => {
    try {
      const categoryParam =
        typeof req.query.category === 'string' && KNOWLEDGE_CATEGORIES.includes(req.query.category as KnowledgeCategory)
          ? (req.query.category as KnowledgeCategory)
          : 'all';
      const statusParam =
        req.query.status === 'archived' || req.query.status === 'all' ? req.query.status : 'approved';
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const entries = await listApprovedKnowledgeEntries({
        category: categoryParam,
        status: statusParam,
        search,
      });
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load knowledge entries.' });
    }
  });

  router.get('/knowledge/categories', async (_req, res) => {
    try {
      const entries = await listApprovedKnowledgeEntries({ status: 'approved' });
      const counts: Record<string, number> = {};
      for (const cat of KNOWLEDGE_CATEGORIES) counts[cat] = 0;
      for (const e of entries) {
        counts[e.category] = (counts[e.category] ?? 0) + 1;
      }
      res.json({
        categories: KNOWLEDGE_CATEGORIES.map((name) => ({
          name,
          count: counts[name] ?? 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load categories.' });
    }
  });

  router.get('/knowledge/:id', async (req, res) => {
    try {
      const detail = await getKnowledgeEntryDetail(String(req.params.id));
      if (!detail) {
        res.status(404).json({ error: 'Knowledge entry not found.' });
        return;
      }
      res.json(detail);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load knowledge entry.' });
    }
  });

  router.get('/knowledge/:id/versions', async (req, res) => {
    try {
      const detail = await getKnowledgeEntryDetail(String(req.params.id));
      if (!detail) {
        res.status(404).json({ error: 'Knowledge entry not found.' });
        return;
      }
      res.json({ versions: detail.versions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load version history.' });
    }
  });

  router.patch('/knowledge/:id', async (req: AuthenticatedRequest, res) => {
    if (req.body?.actorType === 'ai') {
      res.status(403).json({ error: 'AI agents cannot directly modify Master Memory.' });
      return;
    }
    const parsed = editKnowledgeEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid knowledge update payload.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const entry = await editApprovedKnowledgeEntry(String(req.params.id), parsed.data, actor);
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update knowledge entry.' });
    }
  });

  router.delete('/knowledge/:id', async (req: AuthenticatedRequest, res) => {
    if (req.body?.actorType === 'ai') {
      res.status(403).json({ error: 'AI agents cannot directly delete Master Memory.' });
      return;
    }
    const parsed = z
      .object({
        confirmDelete: z.literal(true),
        entryIdConfirm: z.string().trim().min(1),
        reason: z.string().trim().max(400).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Explicit deletion confirmation (confirmDelete=true and matching entryIdConfirm) is required.',
      });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const archived = await archiveKnowledgeEntry({
        entryId: String(req.params.id),
        actor,
        confirmDelete: parsed.data.confirmDelete,
        entryIdConfirm: parsed.data.entryIdConfirm,
        reason: parsed.data.reason,
      });
      res.json({ entry: archived });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to archive knowledge entry.' });
    }
  });

  router.post('/knowledge/:id/restore', async (req: AuthenticatedRequest, res) => {
    try {
      const actor = toAdminActor(req);
      const restored = await restoreArchivedKnowledgeEntry(String(req.params.id), actor);
      res.json({ entry: restored });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to restore knowledge entry.' });
    }
  });

  // --- Proposals & Approval Workflow ---
  router.get('/proposals', async (req, res) => {
    try {
      const statusParam =
        req.query.status === 'pending_approval' ||
        req.query.status === 'approved' ||
        req.query.status === 'rejected' ||
        req.query.status === 'clarification_requested'
          ? req.query.status
          : 'all';
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const proposals = await listProposals({ status: statusParam, sessionId });
      res.json({ proposals });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load proposals.' });
    }
  });

  router.post('/proposals', async (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      proposalType: z.enum(['knowledge', 'product']),
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
      rules: z.array(z.string().trim().min(1).max(400)).min(1).max(20),
      reason: z.string().trim().max(400).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid proposal payload.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const result = await createProposalsFromExtractedItems({
        candidates: [
          {
            itemType: parsed.data.proposalType,
            category: parsed.data.category,
            title: parsed.data.title,
            description: parsed.data.description,
            rules: parsed.data.rules,
            reason: parsed.data.reason,
          },
        ],
        newSourceLabel: `Admin Proposal (${actor.email})`,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create proposal.' });
    }
  });

  router.patch('/proposals/:id', async (req: AuthenticatedRequest, res) => {
    if (req.body?.actorType === 'ai') {
      res.status(403).json({ error: 'Forbidden: AI cannot edit proposal state directly.' });
      return;
    }
    const parsed = editProposalSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid proposal edit.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const proposal = await editProposal(String(req.params.id), parsed.data, actor);
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to edit proposal.' });
    }
  });

  router.post('/proposals/:id/approve', async (req: AuthenticatedRequest, res) => {
    if (req.body?.actorType === 'ai') {
      res.status(403).json({ error: 'Forbidden: AI cannot self-approve proposals.' });
      return;
    }
    const parsed = z
      .object({
        confirmDelete: z.boolean().optional(),
        targetEntryId: z.string().trim().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid approval options.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const result = await approveProposal(String(req.params.id), actor, parsed.data);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to approve proposal.' });
    }
  });

  router.post('/proposals/:id/reject', async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ reason: z.string().trim().max(400).optional() }).safeParse(req.body ?? {});
    try {
      const actor = toAdminActor(req);
      const proposal = await rejectProposal(
        String(req.params.id),
        parsed.success ? parsed.data.reason : undefined,
        actor,
      );
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to reject proposal.' });
    }
  });

  router.post('/proposals/:id/clarify', async (req: AuthenticatedRequest, res) => {
    const parsed = z.object({ note: z.string().trim().min(2).max(500) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Clarification note is required.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const proposal = await requestProposalClarification(String(req.params.id), parsed.data.note, actor);
      res.json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to request clarification.' });
    }
  });

  // --- Layer B: Short Memory Script ---
  router.get('/memory/script', async (_req, res) => {
    try {
      const [activeScript, versions] = await Promise.all([
        getActiveMemoryScript(),
        listMemoryScriptVersions(20),
      ]);
      res.json({ activeScript, versions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load Short Memory Script.' });
    }
  });

  router.post('/memory/script/regenerate', async (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({ tokenBudget: z.number().int().min(200).max(2000).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid token budget (allowed: 200-2000).' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const script = await compileShortMemoryScript({
        tokenBudget: parsed.data.tokenBudget,
        actorType: 'admin',
        actorId: actor.sub,
        actorEmail: actor.email,
      });
      res.json({ activeScript: script });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to regenerate script.' });
    }
  });

  router.put('/memory/script', async (req: AuthenticatedRequest, res) => {
    const parsed = z
      .object({
        scriptText: z.string().trim().min(10).max(10000),
        tokenBudget: z.number().int().min(200).max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid Short Memory Script.' });
      return;
    }
    try {
      const actor = toAdminActor(req);
      const script = await saveManualMemoryScriptEdit({
        scriptText: parsed.data.scriptText,
        tokenBudget: parsed.data.tokenBudget,
        adminEmail: actor.email,
        adminId: actor.sub,
      });
      res.json({ activeScript: script });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save Short Memory Script.' });
    }
  });

  // --- Audit History ---
  router.get('/audit-logs', async (req, res) => {
    try {
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 80;
      const logs = await listAuditLogs({ limit: Number.isFinite(limit) ? limit : 80 });
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load audit logs.' });
    }
  });

  return router;
}
