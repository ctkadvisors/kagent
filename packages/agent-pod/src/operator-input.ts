/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Operator input for this running task. The workbench appends
 * `{id, text, at}` rows to the task's `kagent.knuteson.io/operator-input`
 * annotation (`POST /api/tasks/:ns/:name/input`); the agent loop calls the
 * returned poller once per model turn (`RunInput.pollOperatorInput`).
 * The pod's ServiceAccount can only patch `agenttasks/status`, so the
 * annotation is never agent-written. Rows are append-only: a cursor over
 * the array delivers each row exactly once.
 */

export const OPERATOR_INPUT_ANNOTATION = 'kagent.knuteson.io/operator-input';

export function buildOperatorInputPoller(
  readTask: () => Promise<unknown>,
): () => Promise<string[]> {
  let delivered = 0;
  return async () => {
    const task = (await readTask()) as
      | { metadata?: { annotations?: Record<string, string> } }
      | undefined;
    const raw = task?.metadata?.annotations?.[OPERATOR_INPUT_ANNOTATION];
    if (raw === undefined) return [];
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length <= delivered) return [];
    const fresh = rows.slice(delivered);
    delivered = rows.length;
    return fresh
      .map((row: unknown) => (row as { text?: unknown } | null)?.text)
      .filter((text): text is string => typeof text === 'string' && text.length > 0);
  };
}
