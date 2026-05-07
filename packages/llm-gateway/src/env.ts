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
 * Database connection (audit B7 — split-credential support):
 *   ONE of:
 *     DATABASE_URL     — libpq DSN. Back-compat path. The chart's BYO
 *                        mode uses this; deployers point dsnSecretRef
 *                        at a Secret holding the DSN string.
 *     PGHOST + PGUSER + PGPASSWORD + PGDATABASE — split-env path.
 *                        The chart's bundled-Postgres mode uses this so
 *                        the password is never embedded in a DSN string
 *                        in `stringData.dsn` (where any cluster
 *                        operator with `secrets:get` can read the
 *                        plaintext password right next to all the other
 *                        connection params).
 *   When BOTH are set, split-env wins (so the bundled chart's split
 *   keys take precedence even if a deployer also exports DATABASE_URL
 *   for some reason).
 *   PGPORT             — default 5432
 *   PGSSLMODE          — default verify-full when split-env, OR taken
 *                        from the DATABASE_URL when in DSN mode.
 *   PGSSLROOTCERT      — optional path to a CA bundle for verify-*
 *                        modes. The bundled-Postgres path mounts
 *                        Bitnami's auto-generated CA here at runtime.
 *
 * Required:
 *   ADMIN_API_TOKEN    — bearer token gating /admin/* endpoints.
 *
 * Optional:
 *   ADMIN_API_TOKEN_READONLY — M23: read-only bearer accepted on
 *                              /admin/capacity + /admin/usage in
 *                              addition to ADMIN_API_TOKEN. Key-
 *                              management endpoints (POST/GET/DELETE
 *                              /admin/keys) continue to require
 *                              ADMIN_API_TOKEN. Workbench-api can be
 *                              wired with this token so a workbench
 *                              memory-disclosure CVE cannot mint/
 *                              revoke arbitrary keys.
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

/**
 * Split-credential connection params (audit B7).
 *
 * The bundled-Postgres Helm path projects user/password/host/port/
 * database into individual env vars so the password never sits in a
 * `stringData.dsn` string next to the connection metadata. The
 * Postgres adapter (`db/pool.ts`) reads this struct and constructs the
 * `pg.Pool` config — we never re-stringify the password into a URL.
 *
 * `sslMode` mirrors libpq's verb (`disable`/`allow`/`prefer`/`require`/
 * `verify-ca`/`verify-full`). For verify-* modes the Helm chart mounts
 * a CA bundle at the path named by `sslRootCert`.
 */
export interface DatabaseConnConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly sslMode: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
  readonly sslRootCertPath?: string;
}

export interface GatewayConfig {
  /**
   * Legacy full-DSN path (audit-B7 back-compat). Present when
   * `DATABASE_URL` is set AND the split-env path isn't. The pool
   * factory consumes either this OR `database` — never both.
   */
  readonly databaseUrl: string | null;
  /**
   * Audit-B7 split-credential path. Populated when PG* env vars are
   * present (the bundled-Postgres chart wires it that way). Wins
   * over `databaseUrl` when both are configured so the chart's
   * split path is the authority.
   */
  readonly database: DatabaseConnConfig | null;
  readonly adminApiToken: string;
  /**
   * M23 — optional read-only admin token. When non-null,
   * `/admin/capacity` + `/admin/usage` accept either this token OR
   * the canonical `adminApiToken`. Null means the legacy single-token
   * behavior (back-compat).
   */
  readonly adminApiTokenReadonly: string | null;
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

/**
 * Parse the audit-B7 split-credential PG* env vars. Returns null when
 * the split path isn't in use (caller should fall back to
 * DATABASE_URL). Returns a populated config when ALL of PGHOST,
 * PGUSER, PGPASSWORD, PGDATABASE are set; throws when only some are
 * set (partial split-env config is always a misconfigured chart).
 */
export function parseDatabaseConn(env: NodeJS.ProcessEnv): DatabaseConnConfig | null {
  const host = trimOrUndef(env.PGHOST);
  const user = trimOrUndef(env.PGUSER);
  const password = env.PGPASSWORD; // password may legitimately have spaces; do NOT trim
  const database = trimOrUndef(env.PGDATABASE);
  const present = [host, user, password, database].filter((v) => v !== undefined && v.length > 0);
  if (present.length === 0) return null;
  if (present.length < 4) {
    const missing: string[] = [];
    if (host === undefined || host.length === 0) missing.push('PGHOST');
    if (user === undefined || user.length === 0) missing.push('PGUSER');
    if (password === undefined || password.length === 0) missing.push('PGPASSWORD');
    if (database === undefined || database.length === 0) missing.push('PGDATABASE');
    throw new Error(
      `partial split-credential PG* env: missing ${missing.join(',')} — set all four (PGHOST/PGUSER/PGPASSWORD/PGDATABASE) or set DATABASE_URL`,
    );
  }
  // All four are now defined and non-empty.
  const port = parsePositiveInt(env.PGPORT, 5432, 'PGPORT');
  const sslMode = parseSslMode(env.PGSSLMODE);
  const sslRootCertPath = trimOrUndef(env.PGSSLROOTCERT);
  return Object.freeze({
    host: host as string,
    port,
    user: user as string,
    password: password as string,
    database: database as string,
    sslMode,
    ...(sslRootCertPath !== undefined && sslRootCertPath.length > 0 ? { sslRootCertPath } : {}),
  });
}

export function parseEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const splitConn = parseDatabaseConn(env);
  // Either split-env (audit B7 preferred) or DATABASE_URL — at least one
  // MUST be present. Split-env wins when both are set.
  const dsnRaw = env.DATABASE_URL;
  if (splitConn === null && (dsnRaw === undefined || dsnRaw.length === 0)) {
    throw new Error(
      'required env DATABASE_URL is missing (and no split-credential PGHOST/PGUSER/PGPASSWORD/PGDATABASE provided either)',
    );
  }
  const databaseUrl = splitConn === null ? (dsnRaw as string) : null;
  const adminApiToken = required(env, 'ADMIN_API_TOKEN');
  // M23 — optional readonly admin token. Trim whitespace; treat empty
  // as not-configured.
  const adminReadonlyRaw = env.ADMIN_API_TOKEN_READONLY;
  const adminApiTokenReadonly =
    typeof adminReadonlyRaw === 'string' && adminReadonlyRaw.trim().length > 0
      ? adminReadonlyRaw.trim()
      : null;
  // Defensive: reject equality between the full and read tokens. If
  // an operator accidentally sets both env vars to the same string,
  // the split is no-op'd and a CVE leaking the read token also leaks
  // the full token. Refusing at boot is louder than logging a warning.
  if (adminApiTokenReadonly !== null && adminApiTokenReadonly === adminApiToken) {
    throw new Error(
      'invalid env ADMIN_API_TOKEN_READONLY: must NOT equal ADMIN_API_TOKEN (M23 — split posture defeated when tokens match)',
    );
  }
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
    database: splitConn,
    adminApiToken,
    adminApiTokenReadonly,
    port,
    backendTimeoutMs,
    modelEndpointNamespace:
      modelEndpointNamespace.length > 0 ? modelEndpointNamespace : DEFAULT_NAMESPACE,
    backendApiKeys,
  });
}

function trimOrUndef(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSslMode(raw: string | undefined): DatabaseConnConfig['sslMode'] {
  // Default `verify-full` — audit B7 calls for the cleanest secure
  // default. The chart README documents how to override to `verify-ca`
  // when bundled-Postgres uses a self-signed cert (the bitnami
  // sub-chart's auto-generated CA bundle is mounted at
  // PGSSLROOTCERT in that path).
  if (raw === undefined || raw.length === 0) return 'verify-full';
  const v = raw.trim();
  if (
    v === 'disable' ||
    v === 'allow' ||
    v === 'prefer' ||
    v === 'require' ||
    v === 'verify-ca' ||
    v === 'verify-full'
  ) {
    return v;
  }
  throw new Error(
    `invalid env PGSSLMODE: ${raw} (must be disable|allow|prefer|require|verify-ca|verify-full)`,
  );
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
