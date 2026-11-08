import type { FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { db, Database } from '../db.js';

export type Changes = Record<string, { avant: unknown; apres: unknown }>;

export function diff(before: Record<string, unknown>, after: Record<string, unknown>, labels: Record<string, string>): Changes {
  const out: Changes = {};
  for (const key of Object.keys(labels)) {
    const a = norm(before[key]);
    const b = norm(after[key]);
    if (a !== b) out[labels[key]] = { avant: a, apres: b };
  }
  return out;
}
function norm(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export async function audit(
  req: FastifyRequest | null,
  entity: string,
  entityId: number | null,
  action: string,
  summary: string,
  changes?: unknown,
  trx?: Kysely<Database> | Transaction<Database>,
) {
  const runner = trx ?? db;
  await runner
    .insertInto('audit_log')
    .values({
      user_id: req?.user?.id ?? null,
      entity,
      entity_id: entityId,
      action,
      summary: summary.slice(0, 255),
      changes: changes && (typeof changes !== 'object' || Object.keys(changes as object).length) ? JSON.stringify(changes) : null,
      ip: req?.ip ?? null,
    })
    .execute();
}
