/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure-function path templating for `HttpToolProvider`. Substitutes
 * `{argName}` placeholders in a `path` string with `encodeURIComponent`-
 * wrapped values from an args object.
 *
 * Edge cases (RESEARCH §Path templating lines 264-271):
 *   - Special chars (slash, space, `?`, `&`) are URL-encoded — prevents
 *     accidental path-traversal injection from LLM-emitted args.
 *   - Numeric args (`0`) and boolean args (`false`) flatten via String() —
 *     never empty-string.
 *   - Missing key throws `HttpToolProviderConfigError` — this is a
 *     programmer error (the tool definition declared a placeholder but
 *     the LLM did not supply the matching arg). Distinguish from
 *     network errors (which throw `HttpToolProviderNetworkError`).
 *
 * Pure: no I/O, no side effects, no external state.
 */

import { HttpToolProviderConfigError } from '@kagent/agent-loop';

export function substitutePath(path: string, args: Record<string, unknown>): string {
  return path.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in args)) {
      throw new HttpToolProviderConfigError(`Path placeholder "{${key}}" has no matching argument`);
    }
    return encodeURIComponent(String(args[key]));
  });
}
