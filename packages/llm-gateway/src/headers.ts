/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Parse the kagent-attribution headers off an inbound request. The
 * agent-pod stamps these on every LLM call (Wave 2 work, not in this
 * package) so that usage rows can be joined back to the originating
 * AgentTask + Agent.
 *
 * Both headers are OPTIONAL — non-kagent consumers (anyone with a valid
 * API key calling /v1/chat/completions directly) won't send them, and
 * those rows simply land with `task_uid` / `agent_name` = NULL.
 *
 *   X-Kagent-Task-UID  → usage_records.task_uid
 *   X-Kagent-Agent     → usage_records.agent_name
 *
 * Header lookup is case-insensitive (Node lowercases all incoming header
 * names on `IncomingMessage.headers`); we accept either casing here for
 * defensive symmetry with future test fixtures.
 */

import type { IncomingMessage } from 'node:http';

export interface KagentHeaders {
  readonly taskUid: string | null;
  readonly agentName: string | null;
}

export const KAGENT_TASK_UID_HEADER = 'x-kagent-task-uid';
export const KAGENT_AGENT_HEADER = 'x-kagent-agent';

export function parseKagentHeaders(req: IncomingMessage): KagentHeaders {
  return {
    taskUid: pickHeader(req, KAGENT_TASK_UID_HEADER),
    agentName: pickHeader(req, KAGENT_AGENT_HEADER),
  };
}

function pickHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t.length > 0 ? t : null;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0];
    if (typeof first === 'string') {
      const t = first.trim();
      return t.length > 0 ? t : null;
    }
  }
  return null;
}
