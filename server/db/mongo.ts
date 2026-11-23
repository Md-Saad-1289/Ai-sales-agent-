import { randomUUID } from 'node:crypto';
import { MongoClient, type Db, type Collection, type Document } from 'mongodb';
import type {
  AdminUserDoc,
  AuditLogDoc,
  ConversationDoc,
  CustomerDoc,
  KnowledgeChunkDoc,
  KnowledgeEntryDoc,
  KnowledgeProposalDoc,
  KnowledgeSourceDoc,
  KnowledgeVersionDoc,
  MemoryScriptDoc,
  MessageDoc,
  OrderDoc,
  ProductDoc,
  SessionDoc,
  SettingsDoc,
  SystemSecretDoc,
  TrainingMessageDoc,
  TrainingSessionDoc,
  WebhookEventDoc,
} from '../types.ts';

export interface QueryOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export interface CollectionAdapter<T extends { _id: string }> {
  find(filter?: Record<string, unknown>, options?: QueryOptions): Promise<T[]>;
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  insertOne(doc: Omit<T, '_id'> & { _id?: string }): Promise<T>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: 'before' | 'after'; upsert?: boolean },
  ): Promise<T | null>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined) {
      clean[key] = val;
    }
  }
  return clean as T;
}

function sanitizeUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [op, val] of Object.entries(update)) {
    if ((op === '$set' || op === '$setOnInsert') && val && typeof val === 'object') {
      const cleaned = stripUndefined(val as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) {
        out[op] = cleaned;
      }
    } else {
      out[op] = val;
    }
  }
  return out;
}

function getNested(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (value === undefined) return;
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function matchesCondition(value: unknown, cond: unknown): boolean {
  if (cond instanceof Date) {
    return value instanceof Date
      ? value.getTime() === cond.getTime()
      : String(value) === cond.toISOString();
  }
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const opObj = cond as Record<string, unknown>;
    const ops = Object.keys(opObj);
    if (ops.some((k) => k.startsWith('$'))) {
      for (const op of ops) {
        const target = opObj[op];
        if (op === '$gt') {
          const v = value instanceof Date ? value.getTime() : Number(value);
          const t = target instanceof Date ? target.getTime() : Number(target);
          if (!(v > t)) return false;
        } else if (op === '$gte') {
          const v = value instanceof Date ? value.getTime() : Number(value);
          const t = target instanceof Date ? target.getTime() : Number(target);
          if (!(v >= t)) return false;
        } else if (op === '$lte') {
          const v = value instanceof Date ? value.getTime() : Number(value);
          const t = target instanceof Date ? target.getTime() : Number(target);
          if (!(v <= t)) return false;
        } else if (op === '$lt') {
          const v = value instanceof Date ? value.getTime() : Number(value);
          const t = target instanceof Date ? target.getTime() : Number(target);
          if (!(v < t)) return false;
        } else if (op === '$ne') {
          if (value === target) return false;
        } else if (op === '$in' && Array.isArray(target)) {
          if (!target.includes(value)) return false;
        } else if (op === '$exists') {
          const exists = value !== undefined;
          if (Boolean(target) !== exists) return false;
        } else if (op === '$type') {
          if (target === 'string' && typeof value !== 'string') return false;
        } else if (op === '$regex') {
          const regex =
            target instanceof RegExp
              ? target
              : new RegExp(String(target), typeof opObj.$options === 'string' ? opObj.$options : 'i');
          if (!regex.test(String(value ?? ''))) return false;
        }
      }
      return true;
    }
  }
  return value === cond;
}

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(cond)) {
      const anyMatch = cond.some((sub) =>
        matchesFilter(doc, sub as Record<string, unknown>),
      );
      if (!anyMatch) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(cond)) {
      const allMatch = cond.every((sub) =>
        matchesFilter(doc, sub as Record<string, unknown>),
      );
      if (!allMatch) return false;
      continue;
    }
    const val = getNested(doc, key);
    if (!matchesCondition(val, cond)) return false;
  }
  return true;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  if (update.$set && typeof update.$set === 'object') {
    for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
      if (v !== undefined) {
        setNested(doc, k, v);
      }
    }
  }
  if (update.$unset && typeof update.$unset === 'object') {
    for (const k of Object.keys(update.$unset as Record<string, unknown>)) {
      delete doc[k];
    }
  }
  if (update.$inc && typeof update.$inc === 'object') {
    for (const [k, v] of Object.entries(update.$inc as Record<string, number>)) {
      const prev = Number(getNested(doc, k) ?? 0);
      setNested(doc, k, prev + v);
    }
  }
  if (update.$addToSet && typeof update.$addToSet === 'object') {
    for (const [k, v] of Object.entries(update.$addToSet as Record<string, unknown>)) {
      const arr = Array.isArray(getNested(doc, k)) ? [...(getNested(doc, k) as unknown[])] : [];
      if (v && typeof v === 'object' && '$each' in (v as Record<string, unknown>)) {
        const items = (v as { $each: unknown[] }).$each;
        for (const item of items) {
          if (!arr.includes(item)) arr.push(item);
        }
      } else if (!arr.includes(v)) {
        arr.push(v);
      }
      setNested(doc, k, arr);
    }
  }
}

class MemoryCollection<T extends { _id: string }> implements CollectionAdapter<T> {
  private rows: T[] = [];
  private uniqueFields: string[];

  constructor(uniqueFields: string[] = []) {
    this.uniqueFields = uniqueFields;
  }

  private clone(doc: T): T {
    return structuredClone(doc);
  }

  async find(filter: Record<string, unknown> = {}, options: QueryOptions = {}): Promise<T[]> {
    let result = this.rows.filter((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (options.sort) {
      const sortEntries = Object.entries(options.sort);
      result = [...result].sort((a, b) => {
        for (const [field, dir] of sortEntries) {
          const av = getNested(a, field);
          const bv = getNested(b, field);
          const an = av instanceof Date ? av.getTime() : typeof av === 'number' ? av : String(av ?? '');
          const bn = bv instanceof Date ? bv.getTime() : typeof bv === 'number' ? bv : String(bv ?? '');
          if (an < bn) return -1 * dir;
          if (an > bn) return 1 * dir;
        }
        return 0;
      });
    }
    if (options.skip) result = result.slice(options.skip);
    if (options.limit) result = result.slice(0, options.limit);
    return result.map((r) => this.clone(r));
  }

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    const found = this.rows.find((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    return found ? this.clone(found) : null;
  }

  async insertOne(doc: Omit<T, '_id'> & { _id?: string }): Promise<T> {
    const cleanDoc = stripUndefined({
      ...doc,
      _id: doc._id ?? randomUUID(),
    });
    const record = this.clone(cleanDoc as T);

    for (const field of this.uniqueFields) {
      const val = getNested(record, field);
      if (val !== undefined && val !== null) {
        const dup = this.rows.find((r) => getNested(r, field) === val);
        if (dup) {
          const err = new Error(`E11000 duplicate key error on ${field}`) as Error & { code?: number };
          err.code = 11000;
          throw err;
        }
      }
    }

    this.rows.push(record);
    return this.clone(record);
  }

  private buildUpsertBase(filter: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = { _id: randomUUID() };
    for (const [k, v] of Object.entries(filter)) {
      if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof Date)) {
        setNested(base, k, v);
      }
    }
    if (update.$setOnInsert && typeof update.$setOnInsert === 'object') {
      for (const [k, v] of Object.entries(update.$setOnInsert as Record<string, unknown>)) {
        if (v !== undefined) {
          setNested(base, k, v);
        }
      }
    }
    applyUpdate(base, update);
    return base;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const idx = this.rows.findIndex((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (idx === -1) {
      if (options.upsert) {
        const base = this.buildUpsertBase(filter, update);
        await this.insertOne(base as T);
        return { matchedCount: 0, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const target = this.rows[idx] as unknown as Record<string, unknown>;
    applyUpdate(target, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    let count = 0;
    for (const row of this.rows) {
      if (matchesFilter(row as unknown as Record<string, unknown>, filter)) {
        applyUpdate(row as unknown as Record<string, unknown>, update);
        count++;
      }
    }
    return { matchedCount: count, modifiedCount: count };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: 'before' | 'after'; upsert?: boolean } = {},
  ): Promise<T | null> {
    const idx = this.rows.findIndex((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (idx === -1) {
      if (options.upsert) {
        const base = this.buildUpsertBase(filter, update);
        const inserted = await this.insertOne(base as T);
        return options.returnDocument === 'before' ? null : inserted;
      }
      return null;
    }
    const before = this.clone(this.rows[idx]);
    applyUpdate(this.rows[idx] as unknown as Record<string, unknown>, update);
    return options.returnDocument === 'before' ? before : this.clone(this.rows[idx]);
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const idx = this.rows.findIndex((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (idx === -1) return { deletedCount: 0 };
    this.rows.splice(idx, 1);
    return { deletedCount: 1 };
  }

  async deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const prevLen = this.rows.length;
    this.rows = this.rows.filter((r) => !matchesFilter(r as unknown as Record<string, unknown>, filter));
    return { deletedCount: prevLen - this.rows.length };
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    return this.rows.filter((r) => matchesFilter(r as unknown as Record<string, unknown>, filter)).length;
  }
}

class MongoCollectionWrapper<T extends { _id: string }> implements CollectionAdapter<T> {
  private col: Collection<Document>;

  constructor(col: Collection<Document>) {
    this.col = col;
  }

  async find(filter: Record<string, unknown> = {}, options: QueryOptions = {}): Promise<T[]> {
    let cursor = this.col.find(filter);
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs as unknown as T[];
  }

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    const doc = await this.col.findOne(filter);
    return (doc as unknown as T) ?? null;
  }

  async insertOne(doc: Omit<T, '_id'> & { _id?: string }): Promise<T> {
    const record = stripUndefined({
      ...doc,
      _id: doc._id ?? randomUUID(),
    });
    await this.col.insertOne(record as unknown as Document);
    return record as unknown as T;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const res = await this.col.updateOne(filter, sanitizeUpdate(update), options);
    return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const res = await this.col.updateMany(filter, sanitizeUpdate(update));
    return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: 'before' | 'after'; upsert?: boolean } = {},
  ): Promise<T | null> {
    const doc = await this.col.findOneAndUpdate(filter, sanitizeUpdate(update), {
      returnDocument: options.returnDocument ?? 'after',
      upsert: Boolean(options.upsert),
    });
    return (doc as unknown as T) ?? null;
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const res = await this.col.deleteOne(filter);
    return { deletedCount: res.deletedCount };
  }

  async deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const res = await this.col.deleteMany(filter);
    return { deletedCount: res.deletedCount };
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    return this.col.countDocuments(filter);
  }
}

export interface DatabaseCollections {
  products: CollectionAdapter<ProductDoc>;
  customers: CollectionAdapter<CustomerDoc>;
  conversations: CollectionAdapter<ConversationDoc>;
  messages: CollectionAdapter<MessageDoc>;
  orders: CollectionAdapter<OrderDoc>;
  settings: CollectionAdapter<SettingsDoc>;
  webhook_events: CollectionAdapter<WebhookEventDoc>;
  admin_users: CollectionAdapter<AdminUserDoc>;
  sessions: CollectionAdapter<SessionDoc>;
  system_secrets: CollectionAdapter<SystemSecretDoc>;
  training_sessions: CollectionAdapter<TrainingSessionDoc>;
  training_messages: CollectionAdapter<TrainingMessageDoc>;
  knowledge_entries: CollectionAdapter<KnowledgeEntryDoc>;
  knowledge_versions: CollectionAdapter<KnowledgeVersionDoc>;
  knowledge_proposals: CollectionAdapter<KnowledgeProposalDoc>;
  knowledge_sources: CollectionAdapter<KnowledgeSourceDoc>;
  knowledge_chunks: CollectionAdapter<KnowledgeChunkDoc>;
  memory_scripts: CollectionAdapter<MemoryScriptDoc>;
  audit_logs: CollectionAdapter<AuditLogDoc>;
}

let client: MongoClient | null = null;
let db: Db | null = null;
let collections: DatabaseCollections | null = null;
let dbMode: 'mongodb' | 'memory' = 'memory';
let dbConnectionError: string | null = null;

async function safeCreateIndex(
  database: Db,
  collectionName: string,
  spec: { key: Record<string, 1 | -1 | 'text'>; unique?: boolean; sparse?: boolean; partialFilterExpression?: Record<string, unknown>; expireAfterSeconds?: number },
): Promise<void> {
  try {
    await database.collection(collectionName).createIndex(spec.key, {
      unique: spec.unique,
      sparse: spec.sparse,
      partialFilterExpression: spec.partialFilterExpression,
      expireAfterSeconds: spec.expireAfterSeconds,
    });
  } catch (err) {
    console.warn(
      `[db] Index check warning on ${collectionName}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function migrateMessagesIndexesAndNulls(database: Db): Promise<void> {
  const messagesCol = database.collection('messages');
  try {
    await messagesCol.updateMany(
      { externalMessageId: null },
      { $unset: { externalMessageId: '' } },
    );
  } catch (err) {
    console.warn('[db] Message null externalMessageId cleanup warning:', err instanceof Error ? err.message : String(err));
  }

  try {
    const indexes = await messagesCol.indexes();
    const legacyExtIdx = indexes.find(
      (idx) => idx.name === 'externalMessageId_1' && !idx.partialFilterExpression,
    );
    if (legacyExtIdx) {
      await messagesCol.dropIndex('externalMessageId_1');
    }
  } catch (err) {
    console.warn('[db] Legacy externalMessageId index migration warning:', err instanceof Error ? err.message : String(err));
  }
}

async function deduplicateConversationsAndCustomers(cols: DatabaseCollections): Promise<void> {
  try {
    const allCustomers = await cols.customers.find({}, { sort: { updatedAt: -1 } });
    const customersByMessenger = new Map<string, CustomerDoc[]>();
    for (const cust of allCustomers) {
      const list = customersByMessenger.get(cust.messengerId) ?? [];
      list.push(cust);
      customersByMessenger.set(cust.messengerId, list);
    }

    for (const [messengerId, custList] of customersByMessenger.entries()) {
      if (custList.length <= 1) continue;
      const rankedCusts = [...custList].sort((a, b) => {
        const aScore = (a.phone ? 2 : 0) + (a.name && !a.name.startsWith('Customer ') ? 1 : 0);
        const bScore = (b.phone ? 2 : 0) + (b.name && !b.name.startsWith('Customer ') ? 1 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      const primaryCust = rankedCusts[0];
      for (const secondaryCust of rankedCusts.slice(1)) {
        await cols.conversations.updateMany(
          { customerId: secondaryCust._id },
          { $set: { customerId: primaryCust._id, updatedAt: new Date() } },
        );
        await cols.messages.updateMany(
          { customerId: secondaryCust._id },
          { $set: { customerId: primaryCust._id, customer_id: primaryCust._id } },
        );
        await cols.orders.updateMany(
          { customerId: secondaryCust._id },
          { $set: { customerId: primaryCust._id } },
        );
        await cols.customers.deleteOne({ _id: secondaryCust._id });
      }
      console.log(`[db] Deduplicated ${custList.length - 1} duplicate customer(s) for PSID ${messengerId}`);
    }

    const allConvs = await cols.conversations.find({}, { sort: { lastMessageAt: -1 } });
    const byMessenger = new Map<string, ConversationDoc[]>();
    for (const conv of allConvs) {
      const list = byMessenger.get(conv.messengerId) ?? [];
      list.push(conv);
      byMessenger.set(conv.messengerId, list);
    }

    for (const [messengerId, list] of byMessenger.entries()) {
      if (list.length <= 1) continue;

      // Prefer conversation that has messages / non-empty lastMessageText, then most recent
      const ranked = [...list].sort((a, b) => {
        const aHasMsg = (a.lastMessageText || '').trim().length > 0 ? 1 : 0;
        const bHasMsg = (b.lastMessageText || '').trim().length > 0 ? 1 : 0;
        if (aHasMsg !== bHasMsg) return bHasMsg - aHasMsg;
        return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
      });

      const primary = ranked[0];
      for (const secondary of ranked.slice(1)) {
        await cols.messages.updateMany(
          { conversationId: secondary._id },
          {
            $set: {
              conversationId: primary._id,
              conversation_id: primary._id,
              customerId: primary.customerId,
              customer_id: primary.customerId,
            },
          },
        );
        await cols.orders.updateMany(
          { conversationId: secondary._id },
          {
            $set: {
              conversationId: primary._id,
              customerId: primary.customerId,
            },
          },
        );
        await cols.conversations.deleteOne({ _id: secondary._id });
      }

      // Recompute latest message summary on primary after merge
      const latestMsgs = await cols.messages.find(
        { conversationId: primary._id },
        { sort: { createdAt: -1 }, limit: 1 },
      );
      if (latestMsgs[0]) {
        const m = latestMsgs[0];
        await cols.conversations.updateOne(
          { _id: primary._id },
          {
            $set: {
              lastMessageText: (m.text || m.message_text || '').slice(0, 240),
              lastMessageSender: m.sender || m.sender_type,
              lastMessageAt: m.createdAt || m.timestamp,
              updatedAt: new Date(),
            },
          },
        );
      }
      console.log(`[db] Deduplicated ${list.length - 1} duplicate conversation(s) for PSID ${messengerId}`);
    }
  } catch (err) {
    console.warn('[db] Duplicate conversation cleanup warning:', err instanceof Error ? err.message : String(err));
  }
}

async function ensureMongoIndexes(database: Db): Promise<void> {
  await migrateMessagesIndexesAndNulls(database);

  await Promise.all([
    safeCreateIndex(database, 'products', { key: { isActive: 1, updatedAt: -1 } }),
    safeCreateIndex(database, 'products', { key: { name: 'text', description: 'text' } }),
    safeCreateIndex(database, 'customers', { key: { messengerId: 1 }, unique: true }),
    safeCreateIndex(database, 'customers', { key: { updatedAt: -1 } }),
    safeCreateIndex(database, 'conversations', { key: { messengerId: 1 }, unique: true }),
    safeCreateIndex(database, 'conversations', { key: { customerId: 1 } }),
    safeCreateIndex(database, 'conversations', { key: { lastMessageAt: -1 } }),
    safeCreateIndex(database, 'conversations', { key: { humanTakeover: 1, aiEnabled: 1 } }),
    safeCreateIndex(database, 'messages', { key: { conversationId: 1, createdAt: 1 } }),
    safeCreateIndex(database, 'messages', { key: { conversationId: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'messages', {
      key: { externalMessageId: 1 },
      unique: true,
      partialFilterExpression: { externalMessageId: { $type: 'string' } },
    }),
    safeCreateIndex(database, 'orders', { key: { orderNumber: 1 }, unique: true }),
    safeCreateIndex(database, 'orders', { key: { idempotencyKey: 1 }, unique: true, sparse: true }),
    safeCreateIndex(database, 'orders', { key: { customerId: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'orders', { key: { status: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'settings', { key: { key: 1 }, unique: true }),
    safeCreateIndex(database, 'webhook_events', { key: { eventId: 1 }, unique: true }),
    safeCreateIndex(database, 'webhook_events', { key: { status: 1, nextRetryAt: 1 } }),
    safeCreateIndex(database, 'admin_users', { key: { email: 1 }, unique: true }),
    safeCreateIndex(database, 'sessions', { key: { tokenHash: 1 }, unique: true }),
    safeCreateIndex(database, 'sessions', { key: { userId: 1 } }),
    safeCreateIndex(database, 'sessions', { key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
    safeCreateIndex(database, 'system_secrets', { key: { key: 1 }, unique: true }),
    safeCreateIndex(database, 'training_sessions', { key: { ownerEmail: 1, updatedAt: -1 } }),
    safeCreateIndex(database, 'training_messages', { key: { sessionId: 1, createdAt: 1 } }),
    safeCreateIndex(database, 'knowledge_entries', { key: { status: 1, category: 1, priority: -1, updatedAt: -1 } }),
    safeCreateIndex(database, 'knowledge_entries', { key: { stableKey: 1 } }),
    safeCreateIndex(database, 'knowledge_entries', { key: { title: 'text', description: 'text', rules: 'text' } }),
    safeCreateIndex(database, 'knowledge_versions', { key: { entryId: 1, version: -1 } }),
    safeCreateIndex(database, 'knowledge_proposals', { key: { status: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'knowledge_proposals', { key: { sessionId: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'knowledge_proposals', { key: { sourceId: 1 } }),
    safeCreateIndex(database, 'knowledge_sources', { key: { sessionId: 1, createdAt: -1 } }),
    safeCreateIndex(database, 'knowledge_sources', { key: { sha256: 1 } }),
    safeCreateIndex(database, 'knowledge_chunks', { key: { sourceId: 1, chunkIndex: 1 } }),
    safeCreateIndex(database, 'memory_scripts', { key: { isActive: 1, version: -1 } }),
    safeCreateIndex(database, 'audit_logs', { key: { createdAt: -1 } }),
    safeCreateIndex(database, 'audit_logs', { key: { targetType: 1, targetId: 1, createdAt: -1 } }),
  ]);
}

export async function initDatabase(): Promise<DatabaseCollections> {
  if (collections) return collections;

  const mongoUri = process.env.MONGODB_URI?.trim();
  const dbName = process.env.MONGODB_DB_NAME?.trim() || 'pageflow_ai';

  if (mongoUri) {
    try {
      client = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 5000,
      });
      await client.connect();
      db = client.db(dbName);
      await db.command({ ping: 1 });

      const mongoCols: DatabaseCollections = {
        products: new MongoCollectionWrapper<ProductDoc>(db.collection('products')),
        customers: new MongoCollectionWrapper<CustomerDoc>(db.collection('customers')),
        conversations: new MongoCollectionWrapper<ConversationDoc>(db.collection('conversations')),
        messages: new MongoCollectionWrapper<MessageDoc>(db.collection('messages')),
        orders: new MongoCollectionWrapper<OrderDoc>(db.collection('orders')),
        settings: new MongoCollectionWrapper<SettingsDoc>(db.collection('settings')),
        webhook_events: new MongoCollectionWrapper<WebhookEventDoc>(db.collection('webhook_events')),
        admin_users: new MongoCollectionWrapper<AdminUserDoc>(db.collection('admin_users')),
        sessions: new MongoCollectionWrapper<SessionDoc>(db.collection('sessions')),
        system_secrets: new MongoCollectionWrapper<SystemSecretDoc>(db.collection('system_secrets')),
        training_sessions: new MongoCollectionWrapper<TrainingSessionDoc>(db.collection('training_sessions')),
        training_messages: new MongoCollectionWrapper<TrainingMessageDoc>(db.collection('training_messages')),
        knowledge_entries: new MongoCollectionWrapper<KnowledgeEntryDoc>(db.collection('knowledge_entries')),
        knowledge_versions: new MongoCollectionWrapper<KnowledgeVersionDoc>(db.collection('knowledge_versions')),
        knowledge_proposals: new MongoCollectionWrapper<KnowledgeProposalDoc>(db.collection('knowledge_proposals')),
        knowledge_sources: new MongoCollectionWrapper<KnowledgeSourceDoc>(db.collection('knowledge_sources')),
        knowledge_chunks: new MongoCollectionWrapper<KnowledgeChunkDoc>(db.collection('knowledge_chunks')),
        memory_scripts: new MongoCollectionWrapper<MemoryScriptDoc>(db.collection('memory_scripts')),
        audit_logs: new MongoCollectionWrapper<AuditLogDoc>(db.collection('audit_logs')),
      };

      await deduplicateConversationsAndCustomers(mongoCols);
      await ensureMongoIndexes(db);

      collections = mongoCols;
      dbMode = 'mongodb';
      dbConnectionError = null;
      console.log(`[db] Connected to MongoDB database "${dbName}" with verified indexes.`);
      return collections;
    } catch (error) {
      dbConnectionError = error instanceof Error ? error.message : 'Failed to connect to MongoDB';
      console.error(`[db] MongoDB connection failed (${dbConnectionError}). Falling back to preview in-memory store.`);
      if (client) {
        await client.close().catch(() => undefined);
        client = null;
      }
      db = null;
    }
  }

  collections = {
    products: new MemoryCollection<ProductDoc>(),
    customers: new MemoryCollection<CustomerDoc>(['messengerId']),
    conversations: new MemoryCollection<ConversationDoc>(['messengerId']),
    messages: new MemoryCollection<MessageDoc>(['externalMessageId']),
    orders: new MemoryCollection<OrderDoc>(['orderNumber', 'idempotencyKey']),
    settings: new MemoryCollection<SettingsDoc>(['key']),
    webhook_events: new MemoryCollection<WebhookEventDoc>(['eventId']),
    admin_users: new MemoryCollection<AdminUserDoc>(['email']),
    sessions: new MemoryCollection<SessionDoc>(['tokenHash']),
    system_secrets: new MemoryCollection<SystemSecretDoc>(['key']),
    training_sessions: new MemoryCollection<TrainingSessionDoc>(),
    training_messages: new MemoryCollection<TrainingMessageDoc>(),
    knowledge_entries: new MemoryCollection<KnowledgeEntryDoc>(),
    knowledge_versions: new MemoryCollection<KnowledgeVersionDoc>(),
    knowledge_proposals: new MemoryCollection<KnowledgeProposalDoc>(),
    knowledge_sources: new MemoryCollection<KnowledgeSourceDoc>(),
    knowledge_chunks: new MemoryCollection<KnowledgeChunkDoc>(),
    memory_scripts: new MemoryCollection<MemoryScriptDoc>(),
    audit_logs: new MemoryCollection<AuditLogDoc>(),
  };
  dbMode = 'memory';
  console.log('[db] Running with preview in-memory MongoDB-compatible store (set MONGODB_URI for persistent MongoDB).');
  return collections;
}

export function getCollections(): DatabaseCollections {
  if (!collections) {
    throw new Error('Database has not been initialized yet.');
  }
  return collections;
}

export function getDatabaseStatus(): { mode: 'mongodb' | 'memory'; error: string | null } {
  return { mode: dbMode, error: dbConnectionError };
}

export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
