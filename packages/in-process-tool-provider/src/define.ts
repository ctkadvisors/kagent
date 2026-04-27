/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { InProcessToolDefinition } from './provider.js';

/**
 * Identity helper for type-inference ergonomics (D-21). Equivalent to
 * `as const` for tool definitions — no runtime behavior beyond returning
 * the input. The type signature lets TypeScript infer the handler's
 * `args` parameter shape from the tool definition's `inputSchema` when
 * the consumer provides a typed schema (e.g., via `json-schema-to-ts`).
 *
 * Optional sugar — the constructor accepts `InProcessToolDefinition[]`
 * directly without going through this helper.
 */
export function defineInProcessTool(def: InProcessToolDefinition): InProcessToolDefinition {
  return def;
}
