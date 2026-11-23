import { getCollections } from '../db/mongo.ts';
import type { AuditLogDoc } from '../types.ts';

export async function recordAuditLog(params: {
  actorType: AuditLogDoc['actorType'];
  actorId: string;
  actorEmail?: string;
  action: string;
  targetType: AuditLogDoc['targetType'];
  targetId: string;
  summary: string;
  details?: Record<string, unknown>;
}): Promise<AuditLogDoc> {
  const { audit_logs } = getCollections();
  return audit_logs.insertOne({
    actorType: params.actorType,
    actorId: params.actorId,
    actorEmail: params.actorEmail,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    summary: params.summary,
    details: params.details,
    createdAt: new Date(),
  });
}

export async function listAuditLogs(opts?: {
  targetType?: AuditLogDoc['targetType'];
  limit?: number;
}): Promise<AuditLogDoc[]> {
  const { audit_logs } = getCollections();
  const filter: Record<string, unknown> = {};
  if (opts?.targetType) {
    filter.targetType = opts.targetType;
  }
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 80));
  return audit_logs.find(filter, { sort: { createdAt: -1 }, limit });
}
