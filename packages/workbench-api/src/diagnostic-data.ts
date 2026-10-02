/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { scrubSecrets } from './error-scrub.js';

const SECRET_FIELD =
  /^(?:.*(?:password|secret|credential|authorization|cookie|private.?key|signing.?key)|(?:api|public|access|session)[_-]?key|(?:access|refresh|id|auth)?[_-]?token|dsn)$/i;
/** Redact legacy persisted records as well as fresh traces. Never echo auth headers. */
export function scrubDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return scrubDiagnostic(parsed);
    } catch {
      /* ordinary tool output */
    }
    return scrubSecrets(value)
      .replace(/\bBasic\s+[A-Za-z0-9+/=]{4,}/gi, '[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(
        /(\b(?:api[_-]?key|password|secret|token|authorization|cookie)["']?\s*[=:]\s*)["']?[^\s,;"'}]+/gi,
        '$1[REDACTED]',
      );
  }
  if (Array.isArray(value)) return value.map(scrubDiagnostic);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, content]) => [
        key,
        SECRET_FIELD.test(key) ? '[REDACTED]' : scrubDiagnostic(content),
      ]),
    );
  }
  return value;
}
