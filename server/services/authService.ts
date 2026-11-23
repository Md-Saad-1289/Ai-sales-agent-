import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';

const scryptAsync = promisify(scrypt);

const fallbackSessionKey = randomBytes(32).toString('hex');

function getSessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() || fallbackSessionKey;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: 'admin';
  exp: number;
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

export function signAuthToken(payload: Omit<AuthTokenPayload, 'exp'>): string {
  const fullPayload: AuthTokenPayload = {
    ...payload,
    exp: Date.now() + 1000 * 60 * 60 * 12,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
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
  token: string;
  admin: { email: string; name: string; role: 'admin' };
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
    const token = signAuthToken({
      sub: created._id,
      email: created.email,
      name: created.name,
      role: 'admin',
    });
    return {
      token,
      admin: { email: created.email, name: created.name, role: 'admin' },
    };
  } finally {
    setupLock = false;
  }
}

export async function loginAdmin(input: z.infer<typeof loginSchema>): Promise<{
  token: string;
  admin: { email: string; name: string; role: 'admin' };
}> {
  const envPasscode = process.env.ADMIN_PASSCODE?.trim();
  const envEmail = (process.env.ADMIN_EMAIL?.trim() || 'admin@pageflow.local').toLowerCase();

  if (envPasscode) {
    const emailOk = !input.email || timingSafeStringEqual(input.email.toLowerCase(), envEmail);
    const passOk = timingSafeStringEqual(input.password, envPasscode);
    if (!emailOk || !passOk) {
      throw new Error('Invalid email or password.');
    }
    const token = signAuthToken({
      sub: 'env-admin',
      email: envEmail,
      name: 'Administrator',
      role: 'admin',
    });
    return {
      token,
      admin: { email: envEmail, name: 'Administrator', role: 'admin' },
    };
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

  const token = signAuthToken({
    sub: user._id,
    email: user.email,
    name: user.name,
    role: 'admin',
  });

  return {
    token,
    admin: { email: user.email, name: user.name, role: 'admin' },
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired session.' });
    return;
  }
  req.admin = payload;
  next();
}
