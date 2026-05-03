/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * usage_records repository. Two operations:
 *   - `record(row)` — insert a single completed-request row.
 *   - `query(filter)` — paginated read for /admin/usage. Exposes
 *     enough filter knobs (taskUid, agentName, model, since/until)
 *     to satisfy spec §3.6 without building a full BI query layer.
 */

import type { Queryable } from './api-keys.js';

export interface UsageRow {
  readonly apiKeyPrefix: string | null;
  readonly requestId: string;
  readonly model: string;
  readonly backend: string;
  readonly backendUrl: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly costUsd: number;
  readonly streaming: boolean;
  readonly taskUid: string | null;
  readonly agentName: string | null;
  readonly errorMessage: string | null;
  /** Optional override; default NOW() server-side. */
  readonly occurredAt?: string;
}

export interface UsageQueryFilter {
  readonly taskUid?: string;
  readonly agentName?: string;
  readonly model?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}

export interface UsageQueryRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly apiKeyPrefix: string | null;
  readonly requestId: string;
  readonly model: string;
  readonly backend: string;
  readonly backendUrl: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly costUsd: number;
  readonly streaming: boolean;
  readonly taskUid: string | null;
  readonly agentName: string | null;
  readonly errorMessage: string | null;
}

export interface UsageRepo {
  record(row: UsageRow): Promise<void>;
  query(filter: UsageQueryFilter): Promise<readonly UsageQueryRow[]>;
}

interface DbUsageRow {
  readonly id: string;
  readonly occurred_at: Date | string;
  readonly api_key_prefix: string | null;
  readonly request_id: string;
  readonly model: string;
  readonly backend: string;
  readonly backend_url: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly latency_ms: number;
  readonly status_code: number;
  readonly cost_usd: string | number;
  readonly streaming: boolean;
  readonly task_uid: string | null;
  readonly agent_name: string | null;
  readonly error_message: string | null;
}

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

export function createUsageRepo(db: Queryable): UsageRepo {
  return {
    async record(row) {
      await db.query(
        `INSERT INTO usage_records (
            api_key_prefix, request_id, occurred_at, model, backend, backend_url,
            input_tokens, output_tokens, total_tokens,
            latency_ms, status_code, cost_usd, streaming,
            task_uid, agent_name, error_message
          ) VALUES (
            $1, $2, COALESCE($3::timestamptz, NOW()), $4, $5, $6,
            $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16
          )`,
        [
          row.apiKeyPrefix,
          row.requestId,
          row.occurredAt ?? null,
          row.model,
          row.backend,
          row.backendUrl,
          row.inputTokens,
          row.outputTokens,
          row.totalTokens,
          row.latencyMs,
          row.statusCode,
          row.costUsd,
          row.streaming,
          row.taskUid,
          row.agentName,
          row.errorMessage,
        ],
      );
    },
    async query(filter) {
      const wheres: string[] = [];
      const args: unknown[] = [];
      const push = (sql: string, value: unknown): void => {
        args.push(value);
        wheres.push(sql.replace('?', `$${String(args.length)}`));
      };
      if (filter.taskUid !== undefined) push('task_uid = ?', filter.taskUid);
      if (filter.agentName !== undefined) push('agent_name = ?', filter.agentName);
      if (filter.model !== undefined) push('model = ?', filter.model);
      if (filter.since !== undefined) push('occurred_at >= ?', filter.since);
      if (filter.until !== undefined) push('occurred_at < ?', filter.until);
      const whereClause = wheres.length === 0 ? '' : `WHERE ${wheres.join(' AND ')}`;
      const limit = clampLimit(filter.limit);
      args.push(limit);
      const r = await db.query<DbUsageRow>(
        `SELECT id, occurred_at, api_key_prefix, request_id, model, backend, backend_url,
                input_tokens, output_tokens, total_tokens, latency_ms, status_code,
                cost_usd, streaming, task_uid, agent_name, error_message
           FROM usage_records
           ${whereClause}
           ORDER BY occurred_at DESC
           LIMIT $${String(args.length)}`,
        args,
      );
      return r.rows.map((row) => ({
        id: row.id,
        occurredAt:
          row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
        apiKeyPrefix: row.api_key_prefix,
        requestId: row.request_id,
        model: row.model,
        backend: row.backend,
        backendUrl: row.backend_url,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        latencyMs: row.latency_ms,
        statusCode: row.status_code,
        costUsd: typeof row.cost_usd === 'number' ? row.cost_usd : Number(row.cost_usd),
        streaming: row.streaming,
        taskUid: row.task_uid,
        agentName: row.agent_name,
        errorMessage: row.error_message,
      }));
    },
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_QUERY_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_QUERY_LIMIT;
  return Math.min(MAX_QUERY_LIMIT, Math.floor(raw));
}
