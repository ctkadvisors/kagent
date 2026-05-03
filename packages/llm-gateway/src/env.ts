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
 */

export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly adminApiToken: string;
  readonly port: number;
  readonly backendTimeoutMs: number;
  readonly modelEndpointNamespace: string;
}

const DEFAULT_PORT = 4000;
const DEFAULT_BACKEND_TIMEOUT_MS = 60_000;
const DEFAULT_NAMESPACE = 'kagent-system';

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

  return Object.freeze({
    databaseUrl,
    adminApiToken,
    port,
    backendTimeoutMs,
    modelEndpointNamespace:
      modelEndpointNamespace.length > 0 ? modelEndpointNamespace : DEFAULT_NAMESPACE,
  });
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
