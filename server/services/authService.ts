import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';

const scryptAsync = promisify(scrypt);

const ACCESS_COOKIE_NAME = 'pf_access';
const REFRESH_COOKIE_NAME = 'pf_refresh';
const ACCESS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let cachedSigningSecret: string | null = null;

export async function ensureAuthSecret(): Promise<string> {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret) {
    cachedSigningSecret = envSecret;
    return envSecret;
  }
  if (cachedSigningSecret) return cachedSigningSecret;

  const { system_secrets } = getCollections();
  const existing = await system_secrets.findOne({ key: 'auth_signing_secret' });
  if (existing?.value) {
    cachedSigningSecret = existing.value;
    return existing.value;
  }

  const generated = randomBytes(32).toString('hex');
  const now = new Date();
  try {
    await system_secrets.insertOne({
      key: 'auth_signing_secret',
      value: generated,
      createdAt: now,
      updatedAt: now,
    });
    cachedSigningSecret = generated;
    return generated;
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 11000) {
      const raced = await system_secrets.findOne({ key: 'auth_signing_secret' });
      if (raced?.value) {
        cachedSigningSecret = raced.value;
        return raced.value;
      }
    }
    cachedSigningSecret = generated;
    return generated;
  }
}

function getSigningSecretSync(): string {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret) return envSecret;
  if (!cachedSigningSecret) {
    cachedSigningSecret = randomBytes(32).toString('hex');
  }
  return cachedSigningSecret;
}

export function getServerEncryptionSecret(): string {
  return getSigningSecretSync();
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: 'admin';
  sid?: string;
  exp: number;
}

export interface AdminIdentity {
  email: string;
  name: string;
  role: 'admin';
}

export interface AuthenticatedRequest extends Request {
  admin?: AuthTokenPayload;
}

export const claimAdminSchema = z.object({
  email: z.string().trim().email().max(120),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(120).optional(),
  password: z.string().min(1).max(128),
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    const rawVal = part.slice(eqIdx + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(rawVal);
    } catch {
      result[name] = rawVal;
    }
  }
  return result;
}

function isHttpsRequest(req: Request): boolean {
  const xfProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return req.secure || xfProto === 'https';
}

function serializeCookie(
  name: string,
  value: string,
  opts: { path: string; maxAgeSeconds: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    'HttpOnly',
  ];
  if (opts.secure) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

export function setSessionCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  const secure = isHttpsRequest(req);
  res.append(
    'Set-Cookie',
    serializeCookie(ACCESS_COOKIE_NAME, accessToken, {
      path: '/api',
      maxAgeSeconds: Math.floor(ACCESS_TTL_MS / 1000),
      secure,
    }),
  );
  res.append(
    'Set-Cookie',
    serializeCookie(REFRESH_COOKIE_NAME, refreshToken, {
      path: '/api/auth',
      maxAgeSeconds: Math.floor(REFRESH_TTL_MS / 1000),
      secure,
    }),
  );
}

export function clearSessionCookies(req: Request, res: Response): void {
  const secure = isHttpsRequest(req);
  res.append(
    'Set-Cookie',
    serializeCookie(ACCESS_COOKIE_NAME, '', {
      path: '/api',
      maxAgeSeconds: 0,
      secure,
    }),
  );
  res.append(
    'Set-Cookie',
    serializeCookie(REFRESH_COOKIE_NAME, '', {
      path: '/api/auth',
      maxAgeSeconds: 0,
      secure,
    }),
  );
}

export function signAuthToken(payload: Omit<AuthTokenPayload, 'exp'>, ttlMs = ACCESS_TTL_MS): string {
  const fullPayload: AuthTokenPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = createHmac('sha256', getSigningSecretSync()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = createHmac('sha256', getSigningSecretSync()).update(encoded).digest('base64url');
  if (!timingSafeStringEqual(sig, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AuthTokenPayload;
    if (!payload.sub || !payload.email || payload.role !== 'admin' || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function createSessionForUser(user: {
  sub: string;
  email: string;
  name: string;
}): Promise<{ accessToken: string; refreshToken: string; admin: AdminIdentity }> {
  await ensureAuthSecret();
  const { sessions } = getCollections();
  const rawRefresh = randomBytes(48).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  const session = await sessions.insertOne({
    tokenHash: hashToken(rawRefresh),
    userId: user.sub,
    email: user.email,
    name: user.name,
    role: 'admin',
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  const accessToken = signAuthToken({
    sub: user.sub,
    email: user.email,
    name: user.name,
    role: 'admin',
    sid: session._id,
  });

  return {
    accessToken,
    refreshToken: rawRefresh,
    admin: { email: user.email, name: user.name, role: 'admin' },
  };
}

export async function rotateRefreshSession(rawRefreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  admin: AdminIdentity;
} | null> {
  await ensureAuthSecret();
  const clean = rawRefreshToken.trim();
  if (!clean) return null;

  const { sessions } = getCollections();
  const currentHash = hashToken(clean);
  const existing = await sessions.findOne({ tokenHash: currentHash });
  if (!existing || existing.revokedAt) {
    return null;
  }
  if (new Date(existing.expiresAt).getTime() <= Date.now()) {
    await sessions.deleteOne({ _id: existing._id });
    return null;
  }

  const nextRawRefresh = randomBytes(48).toString('base64url');
  const nextHash = hashToken(nextRawRefresh);
  const now = new Date();
  const nextExpires = new Date(Date.now() + REFRESH_TTL_MS);

  const rotated = await sessions.findOneAndUpdate(
    { _id: existing._id, tokenHash: currentHash },
    {
      $set: {
        tokenHash: nextHash,
        expiresAt: nextExpires,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );

  if (!rotated || rotated.revokedAt) {
    return null;
  }

  const accessToken = signAuthToken({
    sub: rotated.userId,
    email: rotated.email,
    name: rotated.name,
    role: 'admin',
    sid: rotated._id,
  });

  return {
    accessToken,
    refreshToken: nextRawRefresh,
    admin: { email: rotated.email, name: rotated.name, role: 'admin' },
  };
}

export async function revokeSessionFromRequest(req: Request): Promise<void> {
  const cookies = parseCookies(req);
  const { sessions } = getCollections();

  const rawRefresh = cookies[REFRESH_COOKIE_NAME];
  if (rawRefresh) {
    await sessions.deleteOne({ tokenHash: hashToken(rawRefresh) });
  }

  const rawAccess = cookies[ACCESS_COOKIE_NAME];
  if (rawAccess) {
    const payload = verifyAuthToken(rawAccess);
    if (payload?.sid) {
      await sessions.deleteOne({ _id: payload.sid });
    }
  }
}

export async function getAuthBootstrapStatus(): Promise<{
  needsSetup: boolean;
  envPasscodeConfigured: boolean;
  envEmailHint?: string;
}> {
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();
  if (envPasscode) {
    return {
      needsSetup: false,
      envPasscodeConfigured: true,
      envEmailHint: process.env.ADMIN_EMAIL?.trim() || 'admin@pageflow.local',
    };
  }
  const { admin_users } = getCollections();
  const count = await admin_users.countDocuments({});
  return {
    needsSetup: count === 0,
    envPasscodeConfigured: false,
  };
}

let setupLock = false;

export async function claimFirstAdmin(input: z.infer<typeof claimAdminSchema>): Promise<{
  accessToken: string;
  refreshToken: string;
  admin: AdminIdentity;
}> {
  if (process.env.ADMIN_PASSCODE?.trim()) {
    throw new Error('Admin login is managed by server environment credentials.');
  }
  if (setupLock) {
    throw new Error('Admin setup is already in progress.');
  }
  setupLock = true;
  try {
    const { admin_users } = getCollections();
    const existingCount = await admin_users.countDocuments({});
    if (existingCount > 0) {
      throw new Error('Admin account has already been claimed.');
    }
    const now = new Date();
    const email = input.email.toLowerCase();
    const passwordHash = await hashPassword(input.password);
    const created = await admin_users.insertOne({
      email,
      name: input.name,
      passwordHash,
      role: 'admin',
      createdAt: now,
      updatedAt: now,
    });
    return createSessionForUser({
      sub: created._id,
      email: created.email,
      name: created.name,
    });
  } finally {
    setupLock = false;
  }
}

export async function loginAdmin(input: z.infer<typeof loginSchema>): Promise<{
  accessToken: string;
  refreshToken: string;
  admin: AdminIdentity;
}> {
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();
  const envEmail = (process.env.ADMIN_EMAIL?.trim() || 'admin@pageflow.local').toLowerCase();

  if (envPasscode) {
    const emailOk = !input.email || timingSafeStringEqual(input.email.toLowerCase(), envEmail);
    const passOk = timingSafeStringEqual(input.password, envPasscode);
    if (!emailOk || !passOk) {
      throw new Error('Invalid email or password.');
    }
    return createSessionForUser({
      sub: 'env-admin',
      email: envEmail,
      name: 'Administrator',
    });
  }

  if (!input.email) {
    throw new Error('Email is required.');
  }

  const { admin_users } = getCollections();
  const user = await admin_users.findOne({ email: input.email.toLowerCase() });
  if (!user) {
    throw new Error('Invalid email or password.');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    throw new Error('Invalid email or password.');
  }

  return createSessionForUser({
    sub: user._id,
    email: user.email,
    name: user.name,
  });
}

function isSameOriginMutation(req: Request): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return true;
  }
  const hasCustomHeader = Boolean(req.header('x-requested-with'));
  const origin = req.header('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      const expectedHost = String(req.header('x-forwarded-host') || req.header('host') || '')
        .split(',')[0]
        .trim();
      if (expectedHost && originHost === expectedHost) {
        return true;
      }
      const appUrl = process.env.APP_URL?.trim();
      if (appUrl && originHost === new URL(appUrl).host) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  return hasCustomHeader || Boolean(req.headers.authorization?.startsWith('Bearer '));
}

export async function resolveAuthenticatedAdmin(req: Request): Promise<AuthTokenPayload | null> {
  await ensureAuthSecret();
  const header = req.headers.authorization;
  let token: string | undefined;

  if (header && header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length).trim();
  } else {
    const cookies = parseCookies(req);
    token = cookies[ACCESS_COOKIE_NAME];
  }

  if (!token) return null;
  const payload = verifyAuthToken(token);
  if (!payload) return null;

  if (payload.sid) {
    const { sessions } = getCollections();
    const session = await sessions.findOne({ _id: payload.sid });
    if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      return null;
    }
  }

  return payload;
}

export async function resolveOrRefreshAdmin(req: Request, res: Response): Promise<AuthTokenPayload | null> {
  const existing = await resolveAuthenticatedAdmin(req);
  if (existing) return existing;

  const cookies = parseCookies(req);
  const rawRefresh = cookies[REFRESH_COOKIE_NAME];
  if (!rawRefresh) return null;

  const rotated = await rotateRefreshSession(rawRefresh);
  if (!rotated) {
    clearSessionCookies(req, res);
    return null;
  }

  setSessionCookies(req, res, rotated.accessToken, rotated.refreshToken);
  return verifyAuthToken(rotated.accessToken);
}

export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isSameOriginMutation(req)) {
    res.status(403).json({ error: 'Cross-origin state-changing request rejected.' });
    return;
  }

  try {
    const payload = await resolveAuthenticatedAdmin(req);
    if (!payload) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    req.admin = payload;
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Auth check failed.' });
  }
}

export function getRefreshCookieName(): string {
  return REFRESH_COOKIE_NAME;
}

