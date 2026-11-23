import { timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';
import {
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

  return router;
}
