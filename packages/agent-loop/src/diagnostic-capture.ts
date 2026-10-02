/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

const SECRET_FIELD =
  /^(?:.*(?:password|secret|credential|authorization|cookie|private.?key|signing.?key)|(?:api|public|access|session)[_-]?key|(?:access|refresh|id|auth)?[_-]?token|dsn)$/i;
/** Capture actual tool arguments/results within an explicit bound, redacting before persistence. */
export function captureDiagnostic(value: unknown, maxChars = 65_536): string {
  function redact(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(redact);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([key, content]) => [
          key,
          SECRET_FIELD.test(key) ? '[REDACTED]' : redact(content),
        ]),
      );
    if (typeof input !== 'string') return input;
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(redact(parsed));
    } catch {
      /* plain output */
    }
    return input
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '[REDACTED]')
      .replace(
        /(?:sk-(?:proj-|ant-|org-)?|(?:ghp|ghs|github_pat)_)[A-Za-z0-9_-]{16,}/g,
        '[REDACTED]',
      )
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(
        /(\b(?:api[_-]?key|password|secret|token|authorization|cookie)["']?\s*[=:]\s*)["']?[^\s,;"'}]+/gi,
        '$1[REDACTED]',
      );
  }
  let text: string;
  try {
    const safe = redact(value);
    text = typeof safe === 'string' ? safe : (JSON.stringify(safe) ?? '');
  } catch {
    text = '[unserializable]';
  }
  if (text.length <= maxChars) return text;
  const marker = `\n...[truncated: original ${String(text.length)} chars]...\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  return text.slice(0, Math.ceil(remaining / 2)) + marker + text.slice(-Math.floor(remaining / 2));
}
