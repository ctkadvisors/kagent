/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Env parsing for the gateway entrypoint. Reads the operator/Helm-
 * injected variables once at boot and freezes them into a typed
 * `GatewayConfig`. Mirrors `packages/agent-pod/src/env.ts` in shape:
 * pure function, throws on first invalid key with a message naming
 * the var so the K8s pod log makes the cause obvious.
 *
 * Required:
 *   DATABASE_URL       — libpq DSN. Gateway never instantiates its own
 *                        DB; the Helm chart wires this from a Secret.
 *   ADMIN_API_TOKEN    — bearer token gating /admin/* endpoints.
 *
 * Optional with defaults:
 *   PORT                       (default 4000)
 *   BACKEND_TIMEOUT_MS         (default 60000)
 *   MODEL_ENDPOINT_NAMESPACE   (default 'kagent-system')
 *
 * Optional backend API keys (per-backend; empty/absent = backend
 * unauthenticated, which is correct for ollama/localai/exo/mock and
 * incorrect for cloudflare/openai/anthropic/bedrock/groq — those
 * fail at provider call time with 401 if the corresponding key is
 * missing). The chart wires these from a Secret; see
 * `charts/llm-gateway/values.yaml` `backendApiKeysSecret`.
 *
 *   BACKEND_API_KEY_CLOUDFLARE   — Cloudflare API token (workers-ai)
 *   BACKEND_API_KEY_OPENAI       — OpenAI API key
 *   BACKEND_API_KEY_ANTHROPIC    — Anthropic API key
 *   BACKEND_API_KEY_BEDROCK      — AWS Bedrock SigV4 token (when applicable)
 *   BACKEND_API_KEY_GROQ         — Groq API key
 *   BACKEND_API_KEY_LOCALAI      — LocalAI API key (when configured)
 *   BACKEND_API_KEY_OLLAMA       — Ollama auth (typically unset)
 *   BACKEND_API_KEY_EXO          — exo cluster API key
 *   BACKEND_API_KEY_MOCK         — mock provider (test fixtures only)
 */

import type { BackendKind } from './types.js';

/**
 * Per-backend API key bag. Keys absent from the map are treated as
 * "no key" (provider receives no Authorization header) — appropriate
 * for unauthenticated local backends like Ollama. Provider-side
 * `requiresApiKey` catches missing keys when the backend genuinely
 * needs one.
 */
export type BackendApiKeys = Readonly<Partial<Record<BackendKind, string>>>;

export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly adminApiToken: string;
  readonly port: number;
  readonly backendTimeoutMs: number;
  readonly modelEndpointNamespace: string;
  readonly backendApiKeys: BackendApiKeys;
}

const DEFAULT_PORT = 4000;
const DEFAULT_BACKEND_TIMEOUT_MS = 60_000;
const DEFAULT_NAMESPACE = 'kagent-system';

/**
 * Order matches `BackendKind` union — keep in sync. Each entry is
 * `[backendKind, envVarName]`. Unioned at compile time via the
 * BackendKind type so a new backend kind here triggers a compile
 * error if not added to the union.
 */
const BACKEND_API_KEY_ENV_VARS: ReadonlyArray<readonly [BackendKind, string]> = [
  ['ollama', 'BACKEND_API_KEY_OLLAMA'],
  ['localai', 'BACKEND_API_KEY_LOCALAI'],
  ['cloudflare', 'BACKEND_API_KEY_CLOUDFLARE'],
  ['openai', 'BACKEND_API_KEY_OPENAI'],
  ['anthropic', 'BACKEND_API_KEY_ANTHROPIC'],
  ['bedrock', 'BACKEND_API_KEY_BEDROCK'],
  ['groq', 'BACKEND_API_KEY_GROQ'],
  ['exo', 'BACKEND_API_KEY_EXO'],
  ['mock', 'BACKEND_API_KEY_MOCK'],
] as const;

export function parseEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const adminApiToken = required(env, 'ADMIN_API_TOKEN');
  const port = parsePort(env.PORT);
  const backendTimeoutMs = parsePositiveInt(
    env.BACKEND_TIMEOUT_MS,
    DEFAULT_BACKEND_TIMEOUT_MS,
    'BACKEND_TIMEOUT_MS',
  );
  const modelEndpointNamespace = (env.MODEL_ENDPOINT_NAMESPACE ?? DEFAULT_NAMESPACE).trim();
  const backendApiKeys = parseBackendApiKeys(env);

  return Object.freeze({
    databaseUrl,
    adminApiToken,
    port,
    backendTimeoutMs,
    modelEndpointNamespace:
      modelEndpointNamespace.length > 0 ? modelEndpointNamespace : DEFAULT_NAMESPACE,
    backendApiKeys,
  });
}

/**
 * Parse the `BACKEND_API_KEY_*` env vars into a per-backend map.
 * An env var that is unset, empty, or whitespace-only is treated as
 * "no key configured" and silently omitted (the router passes
 * `apiKey: undefined` to the provider; the provider's
 * `requiresApiKey` flag catches the genuine error case).
 *
 * Throws on a key that is set but contains only whitespace, since
 * that is almost always a misconfigured Secret reference.
 */
export function parseBackendApiKeys(env: NodeJS.ProcessEnv): BackendApiKeys {
  const out: Partial<Record<BackendKind, string>> = {};
  for (const [kind, envVar] of BACKEND_API_KEY_ENV_VARS) {
    const raw = env[envVar];
    if (raw === undefined) continue;
    if (raw.length === 0) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error(`invalid env ${envVar}: value is whitespace-only (likely empty Secret key)`);
    }
    out[kind] = trimmed;
  }
  return Object.freeze(out);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`required env ${key} is missing`);
  }
  return v;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`invalid env PORT: ${raw} (must be integer 1..65535)`);
  }
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid env ${key}: ${raw} (must be positive integer)`);
  }
  return n;
}
