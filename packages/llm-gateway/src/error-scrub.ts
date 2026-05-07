/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Secret-scrubber used on every upstream error body before it lands in
 * the gateway's `usage_records.error_message` column or is echoed back
 * in the OpenAI error envelope (H15).
 *
 * Provider error bodies routinely contain the literal API key the
 * upstream rejected — both as a courtesy ("your key sk-XXXX is
 * invalid") and as accidental log echo. Letting that key flow into our
 * own DB / response stream would re-expose it to anyone with read
 * access to the gateway.
 *
 * What we scrub
 * -------------
 *
 * The patterns below cover the common shapes vendors emit. They are
 * intentionally permissive — scrubbing too much is acceptable; missing
 * a real key is not. Order matters: longer prefixes first, otherwise a
 * shorter prefix can swallow part of a key and leave the tail visible.
 *
 *   - OpenAI / generic: `sk-<base64url>`             (also `sk-proj-<...>`)
 *   - OpenAI org token: `sk-org-<base64url>`
 *   - Anthropic:        `sk-ant-<base64url>`         (matched by `sk-` rule)
 *   - Google AI:        `AIza<...>` (39 chars)
 *   - Google service:   `ya29.<token>`
 *   - AWS access key:   `AKIA<...>` (20 chars total)
 *   - Slack-style:      `xoxb-...`, `xoxa-...`, `xoxp-...`
 *   - Stripe-style:     `sk_live_...`, `pk_live_...`, `sk_test_...`
 *   - Fallback:         `Bearer <token>` Authorization header echoes
 *
 * Anything not matched passes through unchanged. The truncation step
 * (in BackendError) caps the final length, which is a second
 * defence-in-depth layer.
 */

/**
 * Maximum sanitised error-message length. Matches the audit's H15
 * "256 chars" recommendation. Anything longer is truncated with a
 * trailing `…` ellipsis.
 */
export const MAX_ERROR_MESSAGE_CHARS = 256;

const SCRUBBED = '[REDACTED]';

/**
 * Order matters — longest / most-specific shapes first. Each pattern
 * is intentionally bounded with explicit terminators so a long
 * not-a-key string (e.g. base64-encoded JSON in a stack trace) doesn't
 * collapse to `[REDACTED]` cosmetically while leaving the real
 * structure visible.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI project keys (sk-proj-<base64url>) — must come before plain sk-
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  // Anthropic (sk-ant-<base64url>) — must come before plain sk-
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  // OpenAI org keys (sk-org-<base64url>) — must come before plain sk-
  /sk-org-[A-Za-z0-9_-]{16,}/g,
  // Generic sk-<base64url> — at least 16 chars after the prefix to
  // reduce false positives on short marker strings like "sk-" alone.
  /sk-[A-Za-z0-9_-]{16,}/g,
  // Google AI / Maps / Cloud — `AIza` prefix + 35 base64url chars (39 total).
  /AIza[0-9A-Za-z_-]{35}/g,
  // Google OAuth bearer tokens — `ya29.<token>` (variable length).
  /ya29\.[0-9A-Za-z_-]{20,}/g,
  // AWS access key — `AKIA` + 16 uppercase / digit chars (20 total).
  /AKIA[0-9A-Z]{16}/g,
  // Slack-style tokens (xoxb / xoxa / xoxp / xoxs / xoxr).
  /xox[abprs]-[0-9A-Za-z-]{10,}/g,
  // Stripe-style keys (sk_live_ / pk_live_ / sk_test_ / pk_test_) —
  // common when an LLM tool surface accidentally wraps a Stripe error.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // Bearer header echoes — defensive, in case a provider proxies the
  // raw Authorization line back. We strip the token and keep the word.
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/**
 * Apply the secret patterns to a raw string. Public for tests; the
 * canonical path is `sanitizeUpstreamErrorBody` which also truncates.
 */
export function scrubSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, SCRUBBED);
  }
  return out;
}

/**
 * Truncate a message to `MAX_ERROR_MESSAGE_CHARS`. Public so the router
 * can apply the same cap when it stringifies a non-BackendError
 * exception (`String(err)` or `err.message`).
 */
export function truncateErrorMessage(message: string): string {
  if (message.length <= MAX_ERROR_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_ERROR_MESSAGE_CHARS - 1)}…`;
}

/**
 * Sanitize a raw upstream error body for safe logging / response use.
 *
 * Two-step pipeline:
 *  1. Scrub any matching secret shapes.
 *  2. Truncate to `MAX_ERROR_MESSAGE_CHARS` (256) so we never leak a
 *     megabyte of HTML stack trace from a misconfigured upstream.
 *
 * Truncation runs *after* scrubbing so a scrub that slightly enlarges
 * the string (replacing a 30-char key with `[REDACTED]`) still ends up
 * within the cap.
 */
export function sanitizeUpstreamErrorBody(rawBody: string): string {
  const scrubbed = scrubSecrets(rawBody);
  return truncateErrorMessage(scrubbed);
}
