import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { getCollections } from '../db/mongo.ts';
import type { GeminiKeyStatus, SettingsDoc, StoredGeminiApiKey } from '../types.ts';
import { getServerEncryptionSecret } from './authService.ts';

export const GEMINI_MODEL = 'gemini-4-hydrogen';
export const ENV_GEMINI_KEY_ID = '__env__';

const RATE_LIMIT_COOLDOWN_MS = 65_000;
const DAILY_QUOTA_COOLDOWN_MS = 5 * 60_000;

export interface GeminiApiKeySummary {
  id: string;
  label: string;
  maskedKey: string;
  source: 'settings' | 'env';
  isActive: boolean;
  isCurrent: boolean;
  status: GeminiKeyStatus;
  cooldownUntil?: string;
  lastError?: string;
  lastUsedAt?: string;
  requestCount: number;
  createdAt: string;
}

interface CandidateKey {
  id: string;
  label: string;
  plainKey: string;
  source: 'settings' | 'env';
  isActive: boolean;
  status: GeminiKeyStatus;
  cooldownUntil?: Date;
}

// Runtime tracking for optional .env fallback key (not stored in DB)
const envKeyRuntime: {
  status: GeminiKeyStatus;
  cooldownUntil?: Date;
  lastError?: string;
  lastUsedAt?: Date;
  requestCount: number;
} = {
  status: 'active',
  requestCount: 0,
};

const clientCache = new Map<string, GoogleGenAI>();
let cachedSavedActiveCount = 0;
let cachedSavedTotalCount = 0;

function deriveVaultKey(): Buffer {
  return createHash('sha256')
    .update(`${getServerEncryptionSecret()}:gemini_key_vault_v1`, 'utf8')
    .digest();
}

export function encryptApiKey(plainKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveVaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptApiKey(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('Corrupted encrypted API key format.');
  }
  const [ivHex, tagHex, cipherHex] = parts;
  const decipher = createDecipheriv('aes-256-gcm', deriveVaultKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function hashApiKey(plainKey: string): string {
  return createHash('sha256').update(plainKey.trim(), 'utf8').digest('hex');
}

export function maskApiKey(plainKey: string): string {
  const clean = plainKey.trim();
  if (clean.length <= 10) {
    return `${clean.slice(0, 3)}••••${clean.slice(-2)}`;
  }
  return `${clean.slice(0, 6)}••••••${clean.slice(-4)}`;
}

function getClientForKey(plainKey: string): GoogleGenAI {
  const hash = hashApiKey(plainKey);
  const existing = clientCache.get(hash);
  if (existing) return existing;

  const client = new GoogleGenAI({
    apiKey: plainKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  clientCache.set(hash, client);
  return client;
}

export function syncGeminiPoolMetrics(settingsDoc?: SettingsDoc | null): void {
  const keys = settingsDoc?.geminiApiKeys ?? [];
  cachedSavedTotalCount = keys.length;
  cachedSavedActiveCount = keys.filter((k) => k.isActive && k.status !== 'invalid').length;
}

export function getGeminiPoolStatusSync(): {
  geminiConfigured: boolean;
  envConfigured: boolean;
  savedTotalCount: number;
  savedActiveCount: number;
} {
  const envConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  return {
    geminiConfigured: envConfigured || cachedSavedActiveCount > 0,
    envConfigured,
    savedTotalCount: cachedSavedTotalCount,
    savedActiveCount: cachedSavedActiveCount,
  };
}

function isRateLimitError(err: unknown): { matched: boolean; isDaily: boolean; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number; code?: number })?.status ??
    (err as { code?: number })?.code;
  const lower = message.toLowerCase();
  const matched =
    status === 429 ||
    /\b429\b/.test(message) ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('too many requests') ||
    lower.includes('quota');
  const isDaily = lower.includes('per day') || lower.includes('daily') || lower.includes('quota');
  return { matched, isDaily, message };
}

function isInvalidKeyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number; code?: number })?.status;
  const lower = message.toLowerCase();
  return (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('invalid api key') ||
    lower.includes('permission_denied')
  );
}

function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number })?.status;
  const lower = message.toLowerCase();
  return (
    status === 500 ||
    status === 503 ||
    /\b(500|502|503|504)\b/.test(message) ||
    lower.includes('timeout') ||
    lower.includes('unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed')
  );
}

async function getPrimarySettingsDoc(): Promise<SettingsDoc | null> {
  const { settings } = getCollections();
  const doc = await settings.findOne({ key: 'primary' });
  if (doc) syncGeminiPoolMetrics(doc);
  return doc;
}

function effectiveStatus(key: {
  isActive: boolean;
  status: GeminiKeyStatus;
  cooldownUntil?: Date;
}): GeminiKeyStatus {
  if (!key.isActive) return 'disabled';
  if (key.status === 'invalid') return 'invalid';
  if (key.status === 'rate_limited') {
    if (key.cooldownUntil && new Date(key.cooldownUntil).getTime() > Date.now()) {
      return 'rate_limited';
    }
    return 'active';
  }
  return 'active';
}

async function buildCandidatePool(): Promise<{
  candidates: CandidateKey[];
  activeKeyId?: string;
  settingsDoc: SettingsDoc | null;
}> {
  const settingsDoc = await getPrimarySettingsDoc();
  const storedKeys = settingsDoc?.geminiApiKeys ?? [];
  const candidates: CandidateKey[] = [];
  const seenHashes = new Set<string>();

  for (const k of storedKeys) {
    seenHashes.add(k.keyHash);
    if (!k.isActive) continue;
    try {
      const plainKey = decryptApiKey(k.encryptedKey);
      const eff = effectiveStatus(k);
      candidates.push({
        id: k.id,
        label: k.label,
        plainKey,
        source: 'settings',
        isActive: k.isActive,
        status: eff,
        cooldownUntil: k.cooldownUntil ? new Date(k.cooldownUntil) : undefined,
      });
    } catch {
      // Skip keys that cannot be decrypted
    }
  }

  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    const envHash = hashApiKey(envKey);
    if (!seenHashes.has(envHash)) {
      const eff = effectiveStatus({
        isActive: true,
        status: envKeyRuntime.status,
        cooldownUntil: envKeyRuntime.cooldownUntil,
      });
      candidates.push({
        id: ENV_GEMINI_KEY_ID,
        label: 'Server Environment (.env)',
        plainKey: envKey,
        source: 'env',
        isActive: true,
        status: eff,
        cooldownUntil: envKeyRuntime.cooldownUntil,
      });
    }
  }

  return {
    candidates,
    activeKeyId: settingsDoc?.activeGeminiKeyId,
    settingsDoc,
  };
}

function orderCandidatesStickily(candidates: CandidateKey[], activeKeyId?: string): CandidateKey[] {
  const now = Date.now();
  const nonInvalid = candidates.filter((c) => c.status !== 'invalid');
  if (nonInvalid.length === 0) return [];

  const currentIdx = activeKeyId ? nonInvalid.findIndex((c) => c.id === activeKeyId) : -1;
  const rotated =
    currentIdx >= 0
      ? [...nonInvalid.slice(currentIdx), ...nonInvalid.slice(0, currentIdx)]
      : [...nonInvalid];

  // Prioritize keys NOT in active cooldown while preserving sticky order
  const ready = rotated.filter(
    (c) => c.status !== 'rate_limited' || !c.cooldownUntil || c.cooldownUntil.getTime() <= now,
  );
  const cooling = rotated
    .filter((c) => c.status === 'rate_limited' && c.cooldownUntil && c.cooldownUntil.getTime() > now)
    .sort((a, b) => (a.cooldownUntil?.getTime() ?? 0) - (b.cooldownUntil?.getTime() ?? 0));

  return [...ready, ...cooling];
}

async function recordKeyOutcome(params: {
  keyId: string;
  source: 'settings' | 'env';
  status: GeminiKeyStatus;
  cooldownUntil?: Date;
  lastError?: string;
  incrementSuccess?: boolean;
  setAsCurrent?: boolean;
}): Promise<void> {
  const now = new Date();
  if (params.source === 'env') {
    envKeyRuntime.status = params.status;
    envKeyRuntime.cooldownUntil = params.cooldownUntil;
    envKeyRuntime.lastError = params.lastError;
    if (params.incrementSuccess) {
      envKeyRuntime.lastUsedAt = now;
      envKeyRuntime.requestCount += 1;
    }
    if (params.setAsCurrent) {
      const { settings } = getCollections();
      await settings.updateOne(
        { key: 'primary' },
        { $set: { activeGeminiKeyId: ENV_GEMINI_KEY_ID, updatedAt: now } },
      );
    }
    return;
  }

  const { settings } = getCollections();
  const doc = await settings.findOne({ key: 'primary' });
  if (!doc) return;

  const updatedKeys = (doc.geminiApiKeys ?? []).map((item) => {
    if (item.id !== params.keyId) return item;
    return {
      ...item,
      status: params.status,
      cooldownUntil: params.cooldownUntil,
      lastError: params.lastError,
      lastUsedAt: params.incrementSuccess ? now : item.lastUsedAt,
      requestCount: params.incrementSuccess ? (item.requestCount || 0) + 1 : item.requestCount || 0,
    };
  });

  const patch: Partial<SettingsDoc> = {
    geminiApiKeys: updatedKeys,
    updatedAt: now,
  };
  if (params.setAsCurrent) {
    patch.activeGeminiKeyId = params.keyId;
  }

  const saved = await settings.findOneAndUpdate(
    { key: 'primary' },
    { $set: patch },
    { returnDocument: 'after' },
  );
  if (saved) syncGeminiPoolMetrics(saved);
}

/**
 * Executes a Gemini operation using the current sticky key until a rate-limit
 * (or invalid key error) occurs, then automatically shifts to the next key.
 */
export async function executeWithGemini<T>(
  operation: (ai: GoogleGenAI, meta: { keyId: string; label: string }) => Promise<T>,
): Promise<T> {
  const { candidates, activeKeyId } = await buildCandidatePool();
  if (candidates.length === 0) {
    throw new Error(
      'No active Gemini API key configured. Add an API key in Settings -> Gemini API Keys.',
    );
  }

  const ordered = orderCandidatesStickily(candidates, activeKeyId);
  if (ordered.length === 0) {
    throw new Error(
      'All configured Gemini API keys are disabled or invalid. Check Settings -> Gemini API Keys.',
    );
  }

  let lastError: unknown;

  for (const candidate of ordered) {
    const client = getClientForKey(candidate.plainKey);

    for (let transientAttempt = 0; transientAttempt < 2; transientAttempt++) {
      try {
        const result = await operation(client, {
          keyId: candidate.id,
          label: candidate.label,
        });

        await recordKeyOutcome({
          keyId: candidate.id,
          source: candidate.source,
          status: 'active',
          cooldownUntil: undefined,
          lastError: undefined,
          incrementSuccess: true,
          setAsCurrent: candidate.id !== activeKeyId || candidate.status !== 'active',
        });

        return result;
      } catch (err) {
        lastError = err;

        const rateLimit = isRateLimitError(err);
        if (rateLimit.matched) {
          const cooldownMs = rateLimit.isDaily ? DAILY_QUOTA_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
          const cooldownUntil = new Date(Date.now() + cooldownMs);
          console.warn(
            `[gemini-pool] Key "${candidate.label}" hit rate limit; shifting to next key.`,
          );
          await recordKeyOutcome({
            keyId: candidate.id,
            source: candidate.source,
            status: 'rate_limited',
            cooldownUntil,
            lastError: rateLimit.message.slice(0, 240),
          });
          break; // Immediately shift to next key
        }

        if (isInvalidKeyError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[gemini-pool] Key "${candidate.label}" rejected as invalid; shifting.`);
          await recordKeyOutcome({
            keyId: candidate.id,
            source: candidate.source,
            status: 'invalid',
            lastError: msg.slice(0, 240),
          });
          break; // Shift to next key
        }

        if (isTransientNetworkError(err) && transientAttempt === 0) {
          await new Promise((r) => setTimeout(r, 350));
          continue;
        }

        // Non-key error (e.g., bad prompt/schema) or persistent transient error
        if (isTransientNetworkError(err)) {
          break; // Try next key on persistent 5xx
        }
        throw err;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All available Gemini API keys failed or exceeded rate limits.');
}

/**
 * Streaming variant that fails over cleanly before yielding the first chunk.
 */
export async function* executeWithGeminiStream(
  createStream: (
    ai: GoogleGenAI,
  ) => Promise<AsyncIterable<{ text?: string }>>,
): AsyncGenerator<{ text?: string }> {
  const { candidates, activeKeyId } = await buildCandidatePool();
  if (candidates.length === 0) {
    throw new Error(
      'No active Gemini API key configured. Add an API key in Settings -> Gemini API Keys.',
    );
  }

  const ordered = orderCandidatesStickily(candidates, activeKeyId);
  if (ordered.length === 0) {
    throw new Error(
      'All configured Gemini API keys are disabled or invalid. Check Settings -> Gemini API Keys.',
    );
  }

  let lastError: unknown;

  for (const candidate of ordered) {
    const client = getClientForKey(candidate.plainKey);
    try {
      const iterable = await createStream(client);
      const iterator = iterable[Symbol.asyncIterator]();
      const first = await iterator.next();

      await recordKeyOutcome({
        keyId: candidate.id,
        source: candidate.source,
        status: 'active',
        cooldownUntil: undefined,
        lastError: undefined,
        incrementSuccess: true,
        setAsCurrent: candidate.id !== activeKeyId || candidate.status !== 'active',
      });

      if (!first.done) {
        yield first.value;
      }
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        yield next.value;
      }
      return;
    } catch (err) {
      lastError = err;
      const rateLimit = isRateLimitError(err);
      if (rateLimit.matched) {
        const cooldownMs = rateLimit.isDaily ? DAILY_QUOTA_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
        await recordKeyOutcome({
          keyId: candidate.id,
          source: candidate.source,
          status: 'rate_limited',
          cooldownUntil: new Date(Date.now() + cooldownMs),
          lastError: rateLimit.message.slice(0, 240),
        });
        continue;
      }
      if (isInvalidKeyError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordKeyOutcome({
          keyId: candidate.id,
          source: candidate.source,
          status: 'invalid',
          lastError: msg.slice(0, 240),
        });
        continue;
      }
      if (isTransientNetworkError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('All available Gemini API keys failed or exceeded rate limits.');
}

// Legacy compatibility wrapper
export async function withGeminiRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * Math.pow(2, attempt)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Gemini request failed.');
}

export async function listGeminiKeySummaries(): Promise<{
  keys: GeminiApiKeySummary[];
  activeKeyId: string | null;
  envKeyPresent: boolean;
}> {
  const settingsDoc = await getPrimarySettingsDoc();
  const stored = settingsDoc?.geminiApiKeys ?? [];
  const envKey = process.env.GEMINI_API_KEY?.trim();
  const seenHashes = new Set<string>();

  const candidates = await buildCandidatePool();
  const ordered = orderCandidatesStickily(candidates.candidates, settingsDoc?.activeGeminiKeyId);
  const effectiveCurrentId = ordered[0]?.id ?? null;

  const summaries: GeminiApiKeySummary[] = stored.map((k) => {
    seenHashes.add(k.keyHash);
    const eff = effectiveStatus(k);
    return {
      id: k.id,
      label: k.label,
      maskedKey: k.maskedKey,
      source: 'settings',
      isActive: k.isActive,
      isCurrent: k.id === effectiveCurrentId,
      status: eff,
      cooldownUntil:
        eff === 'rate_limited' && k.cooldownUntil
          ? new Date(k.cooldownUntil).toISOString()
          : undefined,
      lastError: k.lastError,
      lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : undefined,
      requestCount: k.requestCount || 0,
      createdAt: new Date(k.createdAt).toISOString(),
    };
  });

  let envKeyPresent = false;
  if (envKey) {
    envKeyPresent = true;
    const envHash = hashApiKey(envKey);
    if (!seenHashes.has(envHash)) {
      const eff = effectiveStatus({
        isActive: true,
        status: envKeyRuntime.status,
        cooldownUntil: envKeyRuntime.cooldownUntil,
      });
      summaries.push({
        id: ENV_GEMINI_KEY_ID,
        label: 'Server Environment (.env)',
        maskedKey: maskApiKey(envKey),
        source: 'env',
        isActive: true,
        isCurrent: effectiveCurrentId === ENV_GEMINI_KEY_ID,
        status: eff,
        cooldownUntil:
          eff === 'rate_limited' && envKeyRuntime.cooldownUntil
            ? envKeyRuntime.cooldownUntil.toISOString()
            : undefined,
        lastError: envKeyRuntime.lastError,
        lastUsedAt: envKeyRuntime.lastUsedAt?.toISOString(),
        requestCount: envKeyRuntime.requestCount,
        createdAt: new Date(0).toISOString(),
      });
    }
  }

  return {
    keys: summaries,
    activeKeyId: effectiveCurrentId,
    envKeyPresent,
  };
}

export async function addGeminiApiKey(params: {
  apiKey: string;
  label?: string;
  makePrimary?: boolean;
}): Promise<GeminiApiKeySummary> {
  const cleanKey = params.apiKey.trim();
  if (cleanKey.length < 16) {
    throw new Error('Gemini API key looks too short.');
  }

  const { settings } = getCollections();
  const doc = await getPrimarySettingsDoc();
  if (!doc) throw new Error('Settings not initialized.');

  const existingKeys = doc.geminiApiKeys ?? [];
  const keyHash = hashApiKey(cleanKey);
  if (existingKeys.some((k) => k.keyHash === keyHash)) {
    throw new Error('This Gemini API key is already saved.');
  }

  const now = new Date();
  const newKey: StoredGeminiApiKey = {
    id: `gkey_${randomUUID().slice(0, 10)}`,
    label: params.label?.trim() || `Key ${existingKeys.length + 1}`,
    maskedKey: maskApiKey(cleanKey),
    encryptedKey: encryptApiKey(cleanKey),
    keyHash,
    isActive: true,
    status: 'active',
    requestCount: 0,
    createdAt: now,
  };

  const nextKeys = params.makePrimary ? [newKey, ...existingKeys] : [...existingKeys, newKey];
  const nextActiveId =
    params.makePrimary || !doc.activeGeminiKeyId || doc.activeGeminiKeyId === ENV_GEMINI_KEY_ID
      ? newKey.id
      : doc.activeGeminiKeyId;

  const saved = await settings.findOneAndUpdate(
    { key: 'primary' },
    {
      $set: {
        geminiApiKeys: nextKeys,
        activeGeminiKeyId: nextActiveId,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  if (saved) syncGeminiPoolMetrics(saved);

  return {
    id: newKey.id,
    label: newKey.label,
    maskedKey: newKey.maskedKey,
    source: 'settings',
    isActive: newKey.isActive,
    isCurrent: nextActiveId === newKey.id,
    status: 'active',
    requestCount: 0,
    createdAt: now.toISOString(),
  };
}

export async function updateGeminiApiKey(
  id: string,
  input: {
    label?: string;
    isActive?: boolean;
    makePrimary?: boolean;
    resetStatus?: boolean;
  },
): Promise<void> {
  if (id === ENV_GEMINI_KEY_ID) {
    if (input.resetStatus) {
      envKeyRuntime.status = 'active';
      envKeyRuntime.cooldownUntil = undefined;
      envKeyRuntime.lastError = undefined;
    }
    if (input.makePrimary) {
      const { settings } = getCollections();
      await settings.updateOne(
        { key: 'primary' },
        { $set: { activeGeminiKeyId: ENV_GEMINI_KEY_ID, updatedAt: new Date() } },
      );
    }
    return;
  }

  const { settings } = getCollections();
  const doc = await getPrimarySettingsDoc();
  if (!doc) throw new Error('Settings not initialized.');

  const keys = doc.geminiApiKeys ?? [];
  const target = keys.find((k) => k.id === id);
  if (!target) throw new Error('API key not found.');

  const updatedKeys = keys.map((k) => {
    if (k.id !== id) return k;
    const nextIsActive = input.isActive !== undefined ? input.isActive : k.isActive;
    let nextStatus: GeminiKeyStatus = k.status;
    let nextCooldown = k.cooldownUntil;
    let nextError = k.lastError;
    if (input.resetStatus || (input.isActive === true && k.status === 'disabled')) {
      nextStatus = 'active';
      nextCooldown = undefined;
      nextError = undefined;
    } else if (!nextIsActive) {
      nextStatus = 'disabled';
    }
    return {
      ...k,
      label: input.label !== undefined ? input.label.trim() || k.label : k.label,
      isActive: nextIsActive,
      status: nextStatus,
      cooldownUntil: nextCooldown,
      lastError: nextError,
    };
  });

  let nextActiveId = doc.activeGeminiKeyId;
  if (input.makePrimary) {
    nextActiveId = id;
  } else if (nextActiveId === id && input.isActive === false) {
    nextActiveId = updatedKeys.find((k) => k.isActive && k.status !== 'invalid')?.id;
  }

  const saved = await settings.findOneAndUpdate(
    { key: 'primary' },
    {
      $set: {
        geminiApiKeys: updatedKeys,
        activeGeminiKeyId: nextActiveId,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (saved) syncGeminiPoolMetrics(saved);
}

export async function deleteGeminiApiKey(id: string): Promise<void> {
  if (id === ENV_GEMINI_KEY_ID) {
    throw new Error('Server environment (.env) key cannot be deleted from the UI.');
  }

  const { settings } = getCollections();
  const doc = await getPrimarySettingsDoc();
  if (!doc) throw new Error('Settings not initialized.');

  const existing = doc.geminiApiKeys ?? [];
  const remaining = existing.filter((k) => k.id !== id);
  if (remaining.length === existing.length) {
    throw new Error('API key not found.');
  }

  const nextActiveId =
    doc.activeGeminiKeyId === id
      ? remaining.find((k) => k.isActive && k.status !== 'invalid')?.id
      : doc.activeGeminiKeyId;

  const saved = await settings.findOneAndUpdate(
    { key: 'primary' },
    {
      $set: {
        geminiApiKeys: remaining,
        activeGeminiKeyId: nextActiveId,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
  if (saved) syncGeminiPoolMetrics(saved);
}

export async function testGeminiApiKey(id: string): Promise<{
  ok: boolean;
  status: GeminiKeyStatus;
  message: string;
}> {
  let plainKey = '';
  let source: 'settings' | 'env' = 'settings';

  if (id === ENV_GEMINI_KEY_ID) {
    plainKey = process.env.GEMINI_API_KEY?.trim() || '';
    source = 'env';
  } else {
    const doc = await getPrimarySettingsDoc();
    const target = (doc?.geminiApiKeys ?? []).find((k) => k.id === id);
    if (!target) throw new Error('API key not found.');
    plainKey = decryptApiKey(target.encryptedKey);
  }

  if (!plainKey) {
    throw new Error('API key value is unavailable.');
  }

  try {
    const client = getClientForKey(plainKey);
    await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: 'Reply with OK.',
    });
    await recordKeyOutcome({
      keyId: id,
      source,
      status: 'active',
      cooldownUntil: undefined,
      lastError: undefined,
      incrementSuccess: true,
    });
    return { ok: true, status: 'active', message: 'API key is valid and ready.' };
  } catch (err) {
    const rateLimit = isRateLimitError(err);
    if (rateLimit.matched) {
      const cooldownMs = rateLimit.isDaily ? DAILY_QUOTA_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
      await recordKeyOutcome({
        keyId: id,
        source,
        status: 'rate_limited',
        cooldownUntil: new Date(Date.now() + cooldownMs),
        lastError: rateLimit.message.slice(0, 240),
      });
      return {
        ok: false,
        status: 'rate_limited',
        message: 'Key hit rate limit; pool will auto-shift to another key.',
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    const invalid = isInvalidKeyError(err);
    const nextStatus: GeminiKeyStatus = invalid ? 'invalid' : 'active';
    await recordKeyOutcome({
      keyId: id,
      source,
      status: nextStatus,
      lastError: msg.slice(0, 240),
    });
    return {
      ok: false,
      status: nextStatus,
      message: msg.slice(0, 200),
    };
  }
}
