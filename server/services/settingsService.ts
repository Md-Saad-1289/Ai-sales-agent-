import { z } from 'zod';
import { getCollections, getDatabaseStatus } from '../db/mongo.ts';
import type { SettingsDoc } from '../types.ts';

export const updateSettingsSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  businessDescription: z.string().trim().max(1000),
  currency: z.string().trim().min(1).max(10),
  deliveryCharge: z.number().min(0).max(100000),
  deliveryChargeNote: z.string().trim().max(300),
  returnPolicy: z.string().trim().max(1500),
  salesInstructions: z.string().trim().max(3000),
  aiTone: z.enum(['warm_professional', 'concise_direct', 'consultative']),
  aiLanguageMode: z.enum(['auto_multilingual', 'english', 'bangla']),
  aiGlobalEnabled: z.boolean(),
  humanHandoverKeywords: z.array(z.string().trim().min(1).max(60)).max(30),
  humanHandoverRules: z.string().trim().max(1000),
  facebookPageId: z.string().trim().max(60),
  facebookPageName: z.string().trim().max(120),
});

export async function getSettings(): Promise<SettingsDoc> {
  const { settings } = getCollections();
  const existing = await settings.findOne({ key: 'primary' });
  if (existing) return existing;

  const defaultDoc: Omit<SettingsDoc, '_id'> = {
    key: 'primary',
    businessName: 'Your Store',
    businessDescription: '',
    currency: 'BDT',
    deliveryCharge: 80,
    deliveryChargeNote: 'Standard nationwide delivery within 2-4 business days.',
    returnPolicy: '7-day replacement for manufacturing defects or damaged items.',
    salesInstructions:
      'সব সময় সংক্ষিপ্ত ও ভদ্র বাংলায় উত্তর দিন (১-২ বাক্যে)। কাস্টমারের বাজেট ও প্রয়োজন জেনে অ্যাক্টিভ প্রোডাক্ট সাজেস্ট করুন। কখনোই ভুল দাম, স্টক বা ডিসকাউন্ট বলবেন না।',
    aiTone: 'concise_direct',
    aiLanguageMode: 'bangla',
    aiGlobalEnabled: true,
    humanHandoverKeywords: ['human', 'agent', 'manager', 'complaint', 'refund', 'talk to someone'],
    humanHandoverRules:
      'Hand over to a human agent if the customer expresses anger, requests a custom bulk discount, reports a damaged delivery, or explicitly asks to speak with a human.',
    facebookPageId: '',
    facebookPageName: '',
    updatedAt: new Date(),
  };

  return settings.insertOne(defaultDoc);
}

export async function updateSettings(input: z.infer<typeof updateSettingsSchema>): Promise<SettingsDoc> {
  const { settings } = getCollections();
  await getSettings();

  const updated = await settings.findOneAndUpdate(
    { key: 'primary' },
    {
      $set: {
        businessName: input.businessName,
        businessDescription: input.businessDescription,
        currency: input.currency.toUpperCase(),
        deliveryCharge: input.deliveryCharge,
        deliveryChargeNote: input.deliveryChargeNote,
        returnPolicy: input.returnPolicy,
        salesInstructions: input.salesInstructions,
        aiTone: input.aiTone,
        aiLanguageMode: input.aiLanguageMode,
        aiGlobalEnabled: input.aiGlobalEnabled,
        humanHandoverKeywords: input.humanHandoverKeywords,
        humanHandoverRules: input.humanHandoverRules,
        facebookPageId: input.facebookPageId,
        facebookPageName: input.facebookPageName,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    throw new Error('Failed to update settings.');
  }
  return updated;
}

export function getEnvironmentStatus() {
  const dbStatus = getDatabaseStatus();
  return {
    databaseMode: dbStatus.mode,
    databaseError: dbStatus.error,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    metaPageTokenConfigured: Boolean(process.env.META_PAGE_ACCESS_TOKEN?.trim()),
    metaAppSecretConfigured: Boolean(process.env.META_APP_SECRET?.trim()),
    metaVerifyTokenConfigured: Boolean(process.env.META_VERIFY_TOKEN?.trim()),
    appUrl: process.env.APP_URL?.trim() || '',
  };
}
