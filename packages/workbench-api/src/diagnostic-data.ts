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

// Kept inside the protected API package: reading legacy schemas must never load
// the fleet-owned runtime capture module into this credentialed process.
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
/** Preserve schema definitions while redacting data literals for credential fields. */
export function scrubSchemaDiagnostic(input: unknown, sensitive = false): unknown {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object')
        return scrubSchemaDiagnostic(parsed, sensitive);
    } catch {
      /* already a schema string field */
    }
    return scrubDiagnostic(input);
  }
  if (Array.isArray(input)) return input.map((value) => scrubSchemaDiagnostic(value, sensitive));
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
              scrubSchemaDiagnostic(definition, sensitive || SECRET_FIELD.test(name)),
            ]),
          ),
        ];
      }
      if (SCHEMA_LITERALS.has(key))
        return [key, sensitive ? redactSchemaLiteral(content) : scrubDiagnostic(content)];
      return [
        key,
        SECRET_FIELD.test(key) ? '[REDACTED]' : scrubSchemaDiagnostic(content, sensitive),
      ];
    }),
  );
}
