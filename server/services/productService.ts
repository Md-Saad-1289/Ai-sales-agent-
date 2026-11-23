import { z } from 'zod';
import { getCollections } from '../db/mongo.ts';
import type { ProductDoc } from '../types.ts';

function isSafeImageUrl(url: string): boolean {
  if (url.startsWith('/src/assets/')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  price: z.number().min(0).max(10000000),
  stock: z.number().int().min(0).max(1000000),
  description: z.string().trim().max(2500),
  features: z.array(z.string().trim().min(1).max(160)).max(25),
  images: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .refine(isSafeImageUrl, 'Image URL must use http(s)://'),
    )
    .max(10),
  isActive: z.boolean(),
});

export async function listProducts(opts?: { search?: string; activeOnly?: boolean }): Promise<ProductDoc[]> {
  const { products } = getCollections();
  const filter: Record<string, unknown> = {};

  if (opts?.activeOnly) {
    filter.isActive = true;
  }

  if (opts?.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: escaped, $options: 'i' } },
      { description: { $regex: escaped, $options: 'i' } },
    ];
  }

  return products.find(filter, { sort: { updatedAt: -1 } });
}

export async function getProductById(id: string): Promise<ProductDoc | null> {
  const { products } = getCollections();
  return products.findOne({ _id: id });
}

export async function getActiveCatalogForAI(): Promise<ProductDoc[]> {
  const { products } = getCollections();
  return products.find({ isActive: true }, { sort: { stock: -1, updatedAt: -1 }, limit: 50 });
}

export async function createProduct(input: z.infer<typeof productInputSchema>): Promise<ProductDoc> {
  const { products } = getCollections();
  const now = new Date();
  return products.insertOne({
    name: input.name,
    price: Number(input.price),
    stock: Number(input.stock),
    description: input.description,
    features: input.features,
    images: input.images,
    isActive: input.isActive,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateProduct(
  id: string,
  input: z.infer<typeof productInputSchema>,
): Promise<ProductDoc | null> {
  const { products } = getCollections();
  return products.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        name: input.name,
        price: Number(input.price),
        stock: Number(input.stock),
        description: input.description,
        features: input.features,
        images: input.images,
        isActive: input.isActive,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}

export async function deleteProduct(id: string): Promise<boolean> {
  const { products } = getCollections();
  const res = await products.deleteOne({ _id: id });
  return res.deletedCount > 0;
}

export async function decrementStock(productId: string, quantity: number): Promise<ProductDoc | null> {
  const { products } = getCollections();
  return products.findOneAndUpdate(
    { _id: productId, isActive: true, stock: { $gte: quantity } },
    { $inc: { stock: -quantity }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}

export async function restoreStock(productId: string, quantity: number): Promise<void> {
  const { products } = getCollections();
  await products.updateOne(
    { _id: productId },
    { $inc: { stock: quantity }, $set: { updatedAt: new Date() } },
  );
}
