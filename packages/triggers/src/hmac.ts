/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * HMAC-SHA256 helpers for the webhook receiver. The wire contract is:
 *
 *   POST /webhook/<trigger-id>
 *   X-Kagent-Signature: <hex(hmac_sha256(secret, raw-body))>
 *
 * Constant-time equality is used so a malicious caller cannot infer
 * the secret byte-by-byte from response timing.
 *
 * The placeholder shared cap (Wave 0) is shipped as the
 * `kagent-trigger-secrets` Secret in the operator's release namespace
 * with one key per trigger. Per-trigger caps land in Wave 2.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-kagent-signature';

/**
 * Compute the lowercase-hex HMAC-SHA256 of `body` using `secret`.
 * Exposed for symmetric tests + for the operator's trigger-tooling
 * paths (`kagent dev sign-webhook` etc.).
 */
export function computeSignature(secret: string, body: string | Buffer): string {
  const mac = createHmac('sha256', secret);
  mac.update(body);
  return mac.digest('hex');
}

/**
 * Verify a hex-encoded HMAC-SHA256 signature against `body` under
 * `secret`. Returns `true` on match, `false` otherwise. Constant-time
 * comparison — never short-circuits on the first byte mismatch.
 *
 * Returns `false` on any of:
 *   - signature length doesn't match expected (64 hex chars = 32 bytes)
 *   - signature contains non-hex characters
 *   - bytes do not compare equal
 */
export function verifySignature(secret: string, body: string | Buffer, presented: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  if (!/^[0-9a-fA-F]+$/.test(presented)) return false;
  const expectedHex = computeSignature(secret, body);
  if (expectedHex.length !== presented.length) return false;
  // Buffer.from('....', 'hex') silently ignores trailing odd bytes; we
  // already length-checked + regex-checked, so the buffers are
  // guaranteed equal length and same hex domain.
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
