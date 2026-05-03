/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Bearer-token authentication for /v1/chat/completions and /v1/models.
 *
 * Key shape: `sk-<random>`. SHA-256 hash is what's stored in the
 * `api_keys.key_hash` Postgres column; the raw key never touches the
 * DB. This mirrors the archived `lambda/router/server.ts` flow but
 * drops AWS Secrets Manager + DynamoDB lookups in favor of a simple
 * `ApiKeyLookup` callback the caller wires to `db/api-keys.ts`.
 *
 * The /admin/* endpoints use a SEPARATE bearer token
 * (`ADMIN_API_TOKEN` env, see `env.ts`) — admin auth is handled inline
 * in `admin-routes.ts` because the contract is just a single static
 * token check, not a hashed-DB lookup.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface ApiKeyInfo {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly status: 'active' | 'revoked' | 'expired';
  /** ISO 8601 timestamp; null = never expires. */
  readonly expiresAt: string | null;
}

/** Async lookup the auth function defers to — wired to Postgres in main. */
export type ApiKeyLookup = (keyHash: string) => Promise<ApiKeyInfo | null>;

export type AuthResult =
  | { readonly ok: true; readonly keyHash: string; readonly keyPrefix: string }
  | { readonly ok: false; readonly statusCode: 401 | 403; readonly message: string };

const KEY_PREFIX_LEN = 8;

/** SHA-256 hex digest. Stable across processes; safe to compare. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export async function authenticate(
  req: IncomingMessage,
  lookup: ApiKeyLookup,
): Promise<AuthResult> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    return { ok: false, statusCode: 401, message: 'missing authorization header' };
  }
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  if (apiKey.length === 0 || !apiKey.startsWith('sk-')) {
    return { ok: false, statusCode: 401, message: 'invalid api key format (expected sk-<...>)' };
  }

  const keyHash = hashApiKey(apiKey);
  const info = await lookup(keyHash);
  if (info === null) {
    return { ok: false, statusCode: 401, message: 'api key not found' };
  }
  if (info.status !== 'active') {
    return { ok: false, statusCode: 403, message: `api key is ${info.status}` };
  }
  if (info.expiresAt !== null && new Date(info.expiresAt).getTime() < Date.now()) {
    return { ok: false, statusCode: 403, message: 'api key has expired' };
  }

  return {
    ok: true,
    keyHash,
    keyPrefix: apiKey.slice(0, KEY_PREFIX_LEN),
  };
}
