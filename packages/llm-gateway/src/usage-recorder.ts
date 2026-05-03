/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Thin wrapper around the usage repo that combines per-request
 * runtime state (latency, token counts, status) with the static
 * dispatch context (model, backend) and the kagent attribution
 * headers (taskUid, agentName) into the single insert shape the
 * `usage_records` table expects.
 *
 * Consumers fire-and-forget — `record(...).catch(console.error)` so
 * a transient DB hiccup doesn't fail the user-visible
 * /v1/chat/completions response.
 */

import type { BackendKind } from './types.js';
import type { UsageRepo } from './db/usage.js';

export interface UsageEvent {
  readonly apiKeyPrefix: string | null;
  readonly requestId: string;
  readonly model: string;
  readonly backend: BackendKind;
  readonly backendUrl: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly streaming: boolean;
  readonly taskUid: string | null;
  readonly agentName: string | null;
  /** Optional populated cost; gateway has no pricing table in v1. */
  readonly costUsd?: number;
  readonly errorMessage?: string;
}

export interface UsageRecorder {
  record(event: UsageEvent): Promise<void>;
}

export function createUsageRecorder(repo: UsageRepo): UsageRecorder {
  return {
    record: async (event) => {
      const total = event.inputTokens + event.outputTokens;
      await repo.record({
        apiKeyPrefix: event.apiKeyPrefix,
        requestId: event.requestId,
        model: event.model,
        backend: event.backend,
        backendUrl: event.backendUrl,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: total,
        latencyMs: event.latencyMs,
        statusCode: event.statusCode,
        costUsd: event.costUsd ?? 0,
        streaming: event.streaming,
        taskUid: event.taskUid,
        agentName: event.agentName,
        errorMessage: event.errorMessage ?? null,
      });
    },
  };
}
