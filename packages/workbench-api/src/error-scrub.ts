/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * M15 (workbench projection) — secret-scrubber applied to `errorMessage`
 * fields before they leave the workbench-api on the wire.
 *
 * Rationale: H15 scrubs upstream error bodies BEFORE they land in
 * `usage_records.error_message`. M15 adds a second pass on the
 * read side so:
 *   1. Legacy rows persisted before H15 landed are still scrubbed in
 *      flight to the UI.
 *   2. Any path that bypasses the gateway's recorder (third-party
 *      plugin pulling rows directly, or a future cross-cluster
 *      federation reader) still benefits from the same scrub.
 *
 * The patterns mirror the llm-gateway's `src/error-scrub.ts` exactly so
 * both layers agree on what counts as a secret. We don't import from
 * the gateway package because gateway-client.ts intentionally avoids
 * a build-time dependency on `@kagent/llm-gateway` (the comment block
 * in gateway-client.ts spells this out).
 *
 * Order matters: longer prefixes first, otherwise a shorter prefix can
 * swallow part of a key and leave the tail visible.
 */

const SCRUBBED = '[REDACTED]';

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-org-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[0-9A-Za-z_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[0-9A-Za-z-]{10,}/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/**
 * Apply the secret patterns to a raw string. Defensive: passes through
 * the empty string and short messages unchanged.
 */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, SCRUBBED);
  }
  return out;
}

/**
 * Scrub a nullable error message. `null` and `undefined` pass through
 * unchanged so the workbench-api preserves SQL-NULL / column-absent
 * semantics. Empty strings pass through too — H15 already captured
 * the truncation length cap on the gateway side; we don't re-truncate
 * on the read path because re-truncation could disagree with what's
 * already persisted.
 */
export function scrubErrorMessage<T extends string | null | undefined>(input: T): T {
  if (typeof input !== 'string') return input;
  return scrubSecrets(input) as T;
}
