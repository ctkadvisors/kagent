/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

const SECRET_FIELD =
  /^(?:.*(?:password|secret|credential|authorization|cookie|private.?key|signing.?key)|(?:api|public|access|session)[_-]?key|(?:access|refresh|id|auth)?[_-]?token|dsn)$/i;
function redactDiagnostic(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactDiagnostic);
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input).map(([key, content]) => [
        key,
        SECRET_FIELD.test(key) ? '[REDACTED]' : redactDiagnostic(content),
      ]),
    );
  if (typeof input !== 'string') return input;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed !== null && typeof parsed === 'object')
      return JSON.stringify(redactDiagnostic(parsed));
  } catch {
    /* plain output */
  }
  return input
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '[REDACTED]')
    .replace(/(?:sk-(?:proj-|ant-|org-)?|(?:ghp|ghs|github_pat)_)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /(\b(?:api[_-]?key|password|secret|token|authorization|cookie)["']?\s*[=:]\s*)["']?[^\s,;"'}]+/gi,
      '$1[REDACTED]',
    );
}

function capture(value: unknown, maxChars: number, redactor: (value: unknown) => unknown): string {
  let text: string;
  try {
    const safe = redactor(value);
    text = typeof safe === 'string' ? safe : (JSON.stringify(safe) ?? '');
  } catch {
    text = '[unserializable]';
  }
  if (text.length <= maxChars) return text;
  const marker = `\n...[truncated: original ${String(text.length)} chars]...\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  return text.slice(0, Math.ceil(remaining / 2)) + marker + text.slice(-Math.floor(remaining / 2));
}

/** Capture actual tool arguments/results within an explicit bound, redacting before persistence. */
export function captureDiagnostic(value: unknown, maxChars = 65_536): string {
  return capture(value, maxChars, redactDiagnostic);
}

function redactSchemaLiteral(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSchemaLiteral);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, content]) => [key, redactSchemaLiteral(content)]),
    );
  return '[REDACTED]';
}
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependentRequired',
  'dependencies',
]);
const SCHEMA_LITERALS = new Set(['default', 'example', 'examples', 'const', 'enum']);
function redactSchema(input: unknown, sensitive = false): unknown {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object') return redactSchema(parsed, sensitive);
    } catch {
      /* already a schema string field */
    }
    return redactDiagnostic(input);
  }
  if (Array.isArray(input)) return input.map((value) => redactSchema(value, sensitive));
  if (input === null || typeof input !== 'object') return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, content]) => {
      if (
        SCHEMA_MAPS.has(key) &&
        content !== null &&
        typeof content === 'object' &&
        !Array.isArray(content)
      ) {
        return [
          key,
          Object.fromEntries(
            Object.entries(content as Record<string, unknown>).map(([name, definition]) => [
              name,
              redactSchema(definition, sensitive || SECRET_FIELD.test(name)),
            ]),
          ),
        ];
      }
      if (SCHEMA_LITERALS.has(key))
        return [key, sensitive ? redactSchemaLiteral(content) : redactDiagnostic(content)];
      return [key, SECRET_FIELD.test(key) ? '[REDACTED]' : redactSchema(content, sensitive)];
    }),
  );
}
/** Preserve schema field definitions; credential defaults/examples are data, not definitions. */
export function captureSchemaDiagnostic(value: unknown, maxChars = 65_536): string {
  return capture(value, maxChars, redactSchema);
}
