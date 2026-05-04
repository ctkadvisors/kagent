/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * JOSE-format JWT helpers for capability bundles.
 *
 * Signing happens in the operator (`packages/operator/src/cap-ca.ts`);
 * verification happens in BOTH the operator (admission) and the
 * agent-pod (cap consumer). This module exposes the shared verify
 * surface so both consumers go through the same JOSE parser without
 * each pulling jose into their own factories.
 *
 * Algorithm choice: ES256 (ECDSA over P-256 + SHA-256) is the
 * substrate baseline. RS256 (RSA-2048) is supported as an alternative
 * for cert-manager Issuers that default to RSA. The verifier accepts
 * either; the admission gate rejects anything else (`alg: HS256` is
 * NEVER accepted — symmetric keys can't enforce the signing-CA
 * boundary).
 */

import {
  jwtVerify,
  SignJWT,
  importPKCS8,
  importSPKI,
  importJWK,
  exportJWK,
  createLocalJWKSet,
  type JWK,
  type JWTPayload,
  type JWTVerifyOptions,
  type JWTVerifyResult,
  type KeyObject,
  type CryptoKey,
} from 'jose';

import {
  KAGENT_SUBSTRATE_AUDIENCE,
  type CapabilityBundle,
  type CapabilityClaims,
} from './types.js';
import { validateCapabilityBundle, bundleTimeError } from './validate.js';

/**
 * Algorithms the substrate accepts. ES256 is the baseline (sm key, fast
 * verify, well-supported by cert-manager Issuers). RS256 is supported
 * for installs running cert-manager's default RSA-2048 keys.
 *
 * NEVER accept HS256 / `none` — symmetric and unsigned tokens cannot
 * carry the operator-CA boundary the substrate's authority model
 * depends on.
 */
export const ACCEPTED_CAP_ALGS = Object.freeze(['ES256', 'RS256'] as const);
export type CapJwtAlg = (typeof ACCEPTED_CAP_ALGS)[number];

/**
 * Recommended TTL for the substrate cap JWT. Ten minutes is short
 * enough to bound exposure on a leaked JWT but long enough to cover
 * a single AgentTask's typical execution window. The operator's
 * issuer overrides this when an AgentTask's `runConfig.timeoutSeconds`
 * is set (rounding up to the next minute + 60s slack).
 */
export const DEFAULT_CAP_JWT_TTL_SECONDS = 600;

/**
 * Sign-side helper: build a `SignJWT` with the substrate's standard
 * registered claims pre-populated, ready for the caller to attach the
 * private key + algorithm + sign. The operator's `cap-ca.ts` is the
 * sole production caller.
 *
 * `subjectTaskUid` is the AgentTask UID; the SUB claim is stamped as
 * `task-uid:<uid>` per the spec convention. Extend this helper with
 * `workflow-uid:` in Wave 2 Workflows.
 */
export interface BuildCapabilityJwtInput {
  readonly issuer: string;
  readonly subjectTaskUid: string;
  readonly jti: string;
  readonly claims: CapabilityClaims;
  /** TTL in seconds; defaults to `DEFAULT_CAP_JWT_TTL_SECONDS`. */
  readonly ttlSeconds?: number;
  /** Test-injectable clock; production omits. */
  readonly now?: () => number;
  /** Extra audience entries added to the substrate baseline. */
  readonly audiences?: readonly string[];
}

/**
 * Construct a configured (but not yet signed) `SignJWT`. The caller
 * is responsible for `.sign(privateKey)` with the desired alg.
 */
export function buildCapabilityJwt(input: BuildCapabilityJwtInput): SignJWT {
  const nowSec = Math.floor((typeof input.now === 'function' ? input.now() : Date.now()) / 1000);
  const ttl = input.ttlSeconds ?? DEFAULT_CAP_JWT_TTL_SECONDS;
  const aud = [KAGENT_SUBSTRATE_AUDIENCE, ...(input.audiences ?? [])];

  const payload = {
    iss: input.issuer,
    sub: `task-uid:${input.subjectTaskUid}`,
    aud,
    exp: nowSec + ttl,
    iat: nowSec,
    jti: input.jti,
    claims: input.claims,
  } satisfies JWTPayload & { claims: CapabilityClaims };

  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: input.jti });
}

/**
 * Result of `verifyCapabilityJwt`. Carries the decoded bundle on
 * success or a single error string on failure. Mirrors the validation
 * result discriminator so callers compose easily.
 */
export type VerifyCapResult =
  | { readonly ok: true; readonly bundle: CapabilityBundle; readonly raw: JWTVerifyResult }
  | { readonly ok: false; readonly error: string };

/**
 * JWKS-backed verifier. Inputs:
 *   - `jwt`: the compact-serialized JWS (base64url x 3 dot-separated).
 *   - `keyOrJwks`: a `KeyLike` (single-key path) OR a JWKS resolver
 *     (rotation path).
 *   - `expectedIssuer`: the operator's `iss` value; verifier rejects
 *     bundles signed by another principal.
 *   - `now`: optional clock injection for tests.
 *
 * The verifier:
 *   1. Parses the JWS, checks `alg ∈ ACCEPTED_CAP_ALGS`.
 *   2. Verifies the signature against the JWKS.
 *   3. Asserts `iss === expectedIssuer`.
 *   4. Asserts `aud` includes `KAGENT_SUBSTRATE_AUDIENCE`.
 *   5. Validates the substrate `claims` shape via
 *      `validateCapabilityBundle`.
 *   6. Checks `exp/nbf` against `now`.
 *
 * Returns `VerifyCapResult.ok=true` only when ALL of those pass.
 * Failure modes are reported as a single error string (never throws).
 */
export interface VerifyCapInput {
  readonly jwt: string;
  readonly keyOrJwks: VerifierKey;
  readonly expectedIssuer: string;
  readonly now?: () => number;
}

/**
 * Tagged union of accepted verifier-key shapes:
 *   - `{ kind: 'key', key }`: a single `KeyObject`/`CryptoKey` (e.g.
 *     a `KeyLike`). Used in the cert-manager-single-key path.
 *   - `{ kind: 'jwks', jwks }`: a JOSE `KeyLike` resolver from
 *     `createLocalJWKSet` — supports key rotation by id.
 */
export type VerifierKey =
  | { readonly kind: 'key'; readonly key: KeyObject | CryptoKey | Uint8Array }
  | {
      readonly kind: 'jwks';
      readonly jwks: ReturnType<typeof createLocalJWKSet>;
    };

export async function verifyCapabilityJwt(input: VerifyCapInput): Promise<VerifyCapResult> {
  const verifyOpts: JWTVerifyOptions = {
    algorithms: [...ACCEPTED_CAP_ALGS],
    audience: KAGENT_SUBSTRATE_AUDIENCE,
    issuer: input.expectedIssuer,
    ...(input.now !== undefined && { currentDate: new Date(input.now() * 1000) }),
  };

  let raw: JWTVerifyResult;
  try {
    raw =
      input.keyOrJwks.kind === 'key'
        ? await jwtVerify(input.jwt, input.keyOrJwks.key, verifyOpts)
        : await jwtVerify(input.jwt, input.keyOrJwks.jwks, verifyOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `capability JWT verify failed: ${message}` };
  }

  const validation = validateCapabilityBundle(raw.payload);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  // jose's currentDate handles exp/nbf when provided, but defensive: a
  // forced clock skew via the `now` injection should also be applied
  // by us so a buggy jose update can't silently widen the window.
  const timeError = bundleTimeError(
    validation.value,
    typeof input.now === 'function' ? input.now() : undefined,
  );
  if (timeError !== null) {
    return { ok: false, error: timeError };
  }

  return { ok: true, bundle: validation.value, raw };
}

/**
 * Re-export the slim subset of jose surface that operator-side code
 * needs; keeps callers from importing jose directly (and the
 * dependency story stays "@kagent/capability-types is the only entry
 * point").
 */
export { importPKCS8, importSPKI, importJWK, exportJWK, createLocalJWKSet };
export type { JWK };

/**
 * Decode (without verifying) the payload of a JWS. NEVER use this on
 * untrusted input — it's strictly for diagnostics in trusted contexts
 * (e.g. operator logs the about-to-mint bundle's claim summary). The
 * substrate's authority gates ALL go through `verifyCapabilityJwt`.
 */
export function decodeCapabilityJwtUnsafe(jwt: string): CapabilityBundle | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1] ?? '';
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(decoded);
    const validation = validateCapabilityBundle(parsed);
    return validation.ok ? validation.value : undefined;
  } catch {
    return undefined;
  }
}
