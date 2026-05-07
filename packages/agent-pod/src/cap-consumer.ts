/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Agent-pod capability consumer (v0.3.0-capabilities, Wave 2 Caps).
 *
 * Reads the operator-minted JWT from the file mounted at
 * `KAGENT_CAP_JWT_FILE` (default `/var/kagent/cap/cap.jwt` — same path
 * the operator's job-spec builder writes via Secret-volume), verifies
 * it against the operator's JWKS (cached), and exposes the decoded
 * `CapabilityBundle` to the runner.
 *
 * Wave 0 Hygiene lessons applied: the JWT is NEVER read from env —
 * Secret-volume file mount only. Env stamps the *path* to the file,
 * not the JWT itself.
 *
 * The runner threads the bundle into:
 *   - `defineGetMyContext` (extends `capability` field on the
 *     introspection result)
 *   - `defineSpawnChildTask` (bundle is the parent claim set the
 *     spawn tool narrows against)
 *
 * Verification is lazy + cached: the consumer holds the JWKS in
 * memory after the first fetch; rotation is handled by the operator's
 * JWKS exposing both keys during the cutover window.
 */

import { readFileSync } from 'node:fs';

import {
  KAGENT_SUBSTRATE_AUDIENCE,
  createLocalJWKSet,
  globMatchAny,
  type CapabilityBundle,
  type CapabilityClaims,
  type JWK,
  verifyCapabilityJwt,
} from '@kagent/capability-types';

/**
 * Default file path the operator mounts the JWT at. Mirror of the
 * operator's `JOB_CAP_JWT_FILE` constant.
 */
export const DEFAULT_CAP_JWT_FILE = '/var/kagent/cap/cap.jwt';

/**
 * Default JWKS URL — the operator's template-server exposes the JWKS
 * at `/.well-known/jwks.json`. The chart's `kagent-template`
 * ClusterIP Service fronts the operator pod's port; the agent-pod
 * reaches it by service name.
 */
export const DEFAULT_JWKS_URL =
  'http://kagent-template.kagent-system.svc.cluster.local:8081/.well-known/jwks.json';

/**
 * Default expected issuer — must match `Cap.issuer` from the
 * operator's `cap-ca.ts`.
 */
export const DEFAULT_CAP_ISSUER = 'kagent.knuteson.io/operator';

/**
 * Inputs to `loadCapabilityFromEnv`. Production callers leave
 * `readFile`/`fetchJwks` undefined; tests inject stubs.
 */
export interface LoadCapabilityInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** File reader; defaults to `fs.readFileSync` UTF-8. */
  readonly readFile?: (path: string) => string;
  /** JWKS resolver; defaults to a `fetch()` against the JWKS URL. */
  readonly fetchJwks?: (url: string) => Promise<{ readonly keys: readonly JWK[] }>;
  /** Test clock injection; production omits. */
  readonly now?: () => number;
}

/**
 * Result of loading + verifying the cap JWT. The runner stitches this
 * into `RunnerDeps`.
 */
export interface LoadCapabilityResult {
  readonly bundle: CapabilityBundle;
  readonly jwt: string;
}

/**
 * Load + verify the cap JWT mounted into this pod. Throws
 * descriptively when:
 *   - The file mount is missing (KAGENT_CAP_JWT_FILE points to
 *     nothing).
 *   - The JWKS URL is unreachable.
 *   - The JWT signature fails / is expired / wrong issuer / wrong
 *     audience.
 *
 * Caller (runner) decides whether to fail-closed (refuse to start
 * the agent loop) or fail-open (warn + treat the bundle as empty
 * for back-compat with pre-v0.3.0 deploys). v0.3.0 ships fail-open
 * — the chart adds the JWT mount when capabilityClaims is set on
 * the Agent; legacy pods without the mount continue to work.
 */
export async function loadCapabilityFromEnv(
  input: LoadCapabilityInput,
): Promise<LoadCapabilityResult> {
  const path = input.env.KAGENT_CAP_JWT_FILE ?? DEFAULT_CAP_JWT_FILE;
  const reader = input.readFile ?? defaultReadFile;
  const jwt = (() => {
    try {
      return reader(path).trim();
    } catch (err) {
      throw new Error(
        `cap-consumer: cannot read JWT file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  if (jwt.length === 0) {
    throw new Error(`cap-consumer: JWT file at ${path} is empty`);
  }

  const jwksUrl = input.env.KAGENT_CAP_JWKS_URL ?? DEFAULT_JWKS_URL;
  const expectedIssuer = input.env.KAGENT_CAP_ISSUER ?? DEFAULT_CAP_ISSUER;
  const fetcher = input.fetchJwks ?? defaultFetchJwks;
  const jwks = await fetcher(jwksUrl);
  const localJwks = createLocalJWKSet({ keys: jwks.keys as JWK[] });

  const result = await verifyCapabilityJwt({
    jwt,
    keyOrJwks: { kind: 'jwks', jwks: localJwks },
    expectedIssuer,
    ...(input.now !== undefined && { now: input.now }),
  });
  if (!result.ok) {
    throw new Error(`cap-consumer: ${result.error}`);
  }
  return { bundle: result.bundle, jwt };
}

/**
 * Capability loader with three explicit modes (audit C2.1 BLOCKER #1
 * remediation, docs/AUDIT-2026-05-06.md):
 *
 *   1. `KAGENT_CAP_JWT_FILE` env UNSET — legacy / pre-v0.3.0 deploy.
 *      The chart's per-task cap-Secret hasn't shipped yet; return
 *      `undefined` without touching the filesystem so the runner falls
 *      through to the legacy `Agent.spec.allowedChildAgents` path.
 *      Caller logs a one-liner so observability can spot un-migrated
 *      pods.
 *
 *   2. `KAGENT_CAP_JWT_FILE` env SET, file MISSING (ENOENT):
 *        - Default: throw a descriptive error. The pod boot is
 *          aborted by main.ts, the AgentTask is patched Failed, and
 *          the upgrade error is impossible to miss. This is the
 *          fail-LOUD default that closes the audit's silent-fail-open
 *          attack surface (a missing Secret silently disabled every
 *          cap-gated guardrail in the substrate).
 *        - When `KAGENT_CAPABILITY_ALLOW_MISSING=true` is set on the
 *          pod env, return `undefined` AND log a loud WARN that names
 *          the flag and states that capability enforcement is DISABLED
 *          for this pod. Trace metadata then carries the opt-out.
 *
 *   3. `KAGENT_CAP_JWT_FILE` env SET, file PRESENT — verify normally
 *      via `loadCapabilityFromEnv`; throws on signature/issuer/expiry
 *      failure (a tampered or expired JWT MUST refuse the loop start).
 *
 * An empty file with the env set is treated as "no claims": return
 * `undefined`. This matches the historical legacy-pod path for pods
 * mounted with a zero-byte Secret key during a misconfigured upgrade.
 */
export async function loadCapabilityOptional(
  input: LoadCapabilityInput,
): Promise<LoadCapabilityResult | undefined> {
  const envPath = input.env.KAGENT_CAP_JWT_FILE;
  if (envPath === undefined || envPath.length === 0) {
    // Mode 1 — env unset → legacy pre-v0.3.0 deploy. Don't even attempt
    // to read; the chart hasn't been upgraded to mount the cap Secret.
    return undefined;
  }
  const reader = input.readFile ?? defaultReadFile;
  let body: string;
  try {
    body = reader(envPath);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      // Mode 2 — env set, file missing.
      const allowMissing = input.env.KAGENT_CAPABILITY_ALLOW_MISSING === 'true';
      if (!allowMissing) {
        throw new Error(
          `cap-consumer: capability JWT file missing at ${envPath}; ` +
            `set KAGENT_CAPABILITY_ALLOW_MISSING=true to opt out of capability enforcement`,
        );
      }
      console.warn(
        `[kagent-agent-pod] WARNING: KAGENT_CAPABILITY_ALLOW_MISSING=true — ` +
          `capability enforcement DISABLED. This pod accepts any agent's claims at face value.`,
      );
      return undefined;
    }
    throw err;
  }
  if (body.trim().length === 0) {
    return undefined;
  }
  // Mode 3 — file present; verify. (Pass through whatever path the
  // caller originally specified by deferring to `loadCapabilityFromEnv`,
  // which honors the same `KAGENT_CAP_JWT_FILE` env we just read.)
  return await loadCapabilityFromEnv(input);
}

/**
 * Predicate used by spawn narrowing + admission gates: does the
 * bundle's claim set admit the given target string against the given
 * category?
 */
export function bundleAdmits(
  bundle: CapabilityBundle | undefined,
  category: keyof CapabilityClaims,
  target: string,
): boolean {
  if (bundle === undefined) return false;
  if (category === 'tenant') return bundle.claims.tenant === target;
  const list = bundle.claims[category];
  if (!Array.isArray(list)) return false;
  // Reuse the substrate's globMatchAny — `list` is already typed as
  // `readonly string[]` via the validator's runtime check.
  return globMatchAny(list, target);
}

/* =====================================================================
 * Internals
 * ===================================================================== */

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

async function defaultFetchJwks(url: string): Promise<{ readonly keys: readonly JWK[] }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`JWKS fetch ${url} returned HTTP ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { keys?: unknown }).keys)
  ) {
    throw new Error(`JWKS fetch ${url} returned malformed body`);
  }
  return body as { keys: readonly JWK[] };
}

/**
 * Re-export the substrate audience for tests / wiring code that wants
 * to assert against the same constant.
 */
export { KAGENT_SUBSTRATE_AUDIENCE };
