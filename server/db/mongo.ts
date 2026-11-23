import { randomUUID } from 'node:crypto';
import { MongoClient, type Db, type Collection, type Document } from 'mongodb';
import type {
  AdminUserDoc,
  ConversationDoc,
  CustomerDoc,
  MessageDoc,
  OrderDoc,
  ProductDoc,
  SettingsDoc,
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
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { returnDocument?: 'before' | 'after' },
  ): Promise<T | null>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
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
        if (op === '$gte') {
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
    const val = getNested(doc, key);
    if (!matchesCondition(val, cond)) return false;
  }
  return true;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  if (update.$set && typeof update.$set === 'object') {
    for (const [k, v] of Object.entries(update.$set as Record<string, unknown>)) {
      setNested(doc, k, v);
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
    const record = this.clone({
      ...doc,
      _id: doc._id ?? randomUUID(),
    } as T);

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

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const idx = this.rows.findIndex((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (idx === -1) {
      if (options.upsert) {
        const base: Record<string, unknown> = { _id: randomUUID() };
        for (const [k, v] of Object.entries(filter)) {
          if (!k.startsWith('$') && (typeof v !== 'object' || v instanceof Date)) {
            setNested(base, k, v);
          }
        }
        if (update.$setOnInsert && typeof update.$setOnInsert === 'object') {
          for (const [k, v] of Object.entries(update.$setOnInsert as Record<string, unknown>)) {
            setNested(base, k, v);
          }
        }
        applyUpdate(base, update);
        await this.insertOne(base as T);
        return { matchedCount: 0, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    const target = this.rows[idx] as unknown as Record<string, unknown>;
    applyUpdate(target, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: 'before' | 'after' } = {},
  ): Promise<T | null> {
    const idx = this.rows.findIndex((r) => matchesFilter(r as unknown as Record<string, unknown>, filter));
    if (idx === -1) return null;
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
    const record = {
      ...doc,
      _id: doc._id ?? randomUUID(),
    };
    await this.col.insertOne(record as unknown as Document);
    return record as unknown as T;
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { upsert?: boolean } = {},
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const res = await this.col.updateOne(filter, update, options);
    return { matchedCount: res.matchedCount, modifiedCount: res.modifiedCount };
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: { returnDocument?: 'before' | 'after' } = {},
  ): Promise<T | null> {
    const doc = await this.col.findOneAndUpdate(filter, update, {
      returnDocument: options.returnDocument ?? 'after',
    });
    return (doc as unknown as T) ?? null;
  }

  async deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }> {
    const res = await this.col.deleteOne(filter);
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
}

let client: MongoClient | null = null;
let db: Db | null = null;
let collections: DatabaseCollections | null = null;
let dbMode: 'mongodb' | 'memory' = 'memory';
let dbConnectionError: string | null = null;

async function ensureMongoIndexes(database: Db): Promise<void> {
  await Promise.all([
    database.collection('products').createIndexes([
      { key: { isActive: 1, updatedAt: -1 } },
      { key: { name: 'text', description: 'text' } },
    ]),
    database.collection('customers').createIndexes([
      { key: { messengerId: 1 }, unique: true },
      { key: { updatedAt: -1 } },
    ]),
    database.collection('conversations').createIndexes([
      { key: { messengerId: 1 }, unique: true },
      { key: { customerId: 1 } },
      { key: { lastMessageAt: -1 } },
      { key: { humanTakeover: 1, aiEnabled: 1 } },
    ]),
    database.collection('messages').createIndexes([
      { key: { conversationId: 1, createdAt: 1 } },
      { key: { externalMessageId: 1 }, unique: true, sparse: true },
    ]),
    database.collection('orders').createIndexes([
      { key: { orderNumber: 1 }, unique: true },
      { key: { idempotencyKey: 1 }, unique: true, sparse: true },
      { key: { customerId: 1, createdAt: -1 } },
      { key: { status: 1, createdAt: -1 } },
    ]),
    database.collection('settings').createIndex({ key: 1 }, { unique: true }),
    database.collection('webhook_events').createIndexes([
      { key: { eventId: 1 }, unique: true },
      { key: { status: 1, nextRetryAt: 1 } },
    ]),
    database.collection('admin_users').createIndex({ email: 1 }, { unique: true }),
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
      await ensureMongoIndexes(db);

      collections = {
        products: new MongoCollectionWrapper<ProductDoc>(db.collection('products')),
        customers: new MongoCollectionWrapper<CustomerDoc>(db.collection('customers')),
        conversations: new MongoCollectionWrapper<ConversationDoc>(db.collection('conversations')),
        messages: new MongoCollectionWrapper<MessageDoc>(db.collection('messages')),
        orders: new MongoCollectionWrapper<OrderDoc>(db.collection('orders')),
        settings: new MongoCollectionWrapper<SettingsDoc>(db.collection('settings')),
        webhook_events: new MongoCollectionWrapper<WebhookEventDoc>(db.collection('webhook_events')),
        admin_users: new MongoCollectionWrapper<AdminUserDoc>(db.collection('admin_users')),
      };
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
