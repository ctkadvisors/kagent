/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Runtime validators for `CapabilityClaims` and `CapabilityBundle`.
 *
 * The JWT payload arrives as `unknown` (whether from a JSON parse, a
 * decoded JWT, or a CRD field); these validators sniff the shape so
 * downstream code can treat the value as the strict typed surface.
 *
 * Errors are descriptive — every validator returns either the typed
 * value or an `Error` with a single line summary suitable for an audit
 * record (`reason: 'InvalidCapability'` etc.). No throws — caller
 * decides whether to fail the request or merely log.
 */

import {
  ALL_CAPABILITY_CLAIM_CATEGORIES,
  KAGENT_SUBSTRATE_AUDIENCE,
  type CapabilityBundle,
  type CapabilityClaimCategory,
  type CapabilityClaims,
} from './types.js';

/**
 * Result discriminator. Every validator returns `{ ok: true, value }`
 * on success or `{ ok: false, error }` on failure. Callers
 * consistency-check via `if (!result.ok) ...`.
 */
export type Validation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Convenience wrapper — narrow the success branch into the typed value
 * or `undefined` on failure. Useful inside test helpers where the
 * error string is uninteresting.
 */
export function validValue<T>(r: Validation<T>): T | undefined {
  return r.ok ? r.value : undefined;
}

/**
 * Validate that an `unknown` value conforms to `CapabilityClaims`.
 * Every claim category, when present, must be:
 *   - `tools | models | spawn | read | write | egress | publish | subscribe`:
 *     readonly array of non-empty strings.
 *   - `tenant`: a single non-empty string.
 *
 * Unknown keys are REJECTED — claim shapes are tightly governed
 * because the substrate's authority surface MUST stay enumerable for
 * audit. New categories require a SemVer-minor in this package.
 */
export function validateCapabilityClaims(raw: unknown): Validation<CapabilityClaims> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'capabilityClaims must be an object' };
  }
  if (Array.isArray(raw)) {
    return { ok: false, error: 'capabilityClaims must be an object, not an array' };
  }

  const r = raw as Record<string, unknown>;
  const knownKeys = new Set<string>(ALL_CAPABILITY_CLAIM_CATEGORIES);
  for (const key of Object.keys(r)) {
    if (!knownKeys.has(key)) {
      return {
        ok: false,
        error: `capabilityClaims has unknown key "${key}"; allowed: ${[...knownKeys].sort().join(', ')}`,
      };
    }
  }

  const out: { -readonly [K in keyof CapabilityClaims]: CapabilityClaims[K] } = {};
  for (const cat of ALL_CAPABILITY_CLAIM_CATEGORIES) {
    if (!(cat in r)) continue;
    const v = r[cat];
    if (cat === 'tenant') {
      if (typeof v !== 'string' || v.length === 0) {
        return { ok: false, error: `capabilityClaims.tenant must be a non-empty string` };
      }
      out.tenant = v;
      continue;
    }
    // Array categories.
    if (!Array.isArray(v)) {
      return {
        ok: false,
        error: `capabilityClaims.${cat} must be an array of strings`,
      };
    }
    const list: string[] = [];
    for (let i = 0; i < v.length; i++) {
      const item = (v as unknown[])[i];
      if (typeof item !== 'string' || item.length === 0) {
        return {
          ok: false,
          error: `capabilityClaims.${cat}[${String(i)}] must be a non-empty string`,
        };
      }
      list.push(item);
    }
    // Type narrowing: every category except 'tenant' is an array
    // category by construction; the early `if (cat === 'tenant')` above
    // returns before reaching this point.
    assignArrayCategory(out, cat, list);
  }
  return { ok: true, value: out };
}

/**
 * Validate that an `unknown` value conforms to `CapabilityBundle`. The
 * registered claims (`iss`, `sub`, `aud`, `exp`, `iat`, `nbf`, `jti`)
 * are checked first; the substrate `claims` subobject is delegated to
 * `validateCapabilityClaims`.
 *
 * `aud` must be an array containing `'kagent-substrate'`. Verifying
 * code MAY narrow further (e.g. require a tenant audience element when
 * Wave 4 lands) but the substrate baseline is checked here.
 */
export function validateCapabilityBundle(raw: unknown): Validation<CapabilityBundle> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'capability bundle must be an object' };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.iss !== 'string' || r.iss.length === 0) {
    return { ok: false, error: 'capability bundle: `iss` is required (string)' };
  }
  if (typeof r.sub !== 'string' || r.sub.length === 0) {
    return { ok: false, error: 'capability bundle: `sub` is required (string)' };
  }
  if (typeof r.jti !== 'string' || r.jti.length === 0) {
    return { ok: false, error: 'capability bundle: `jti` is required (string)' };
  }
  if (typeof r.exp !== 'number' || !Number.isFinite(r.exp)) {
    return { ok: false, error: 'capability bundle: `exp` is required (unix epoch seconds)' };
  }

  if (!Array.isArray(r.aud) || r.aud.length === 0) {
    return { ok: false, error: 'capability bundle: `aud` is required (non-empty array)' };
  }
  for (let i = 0; i < r.aud.length; i++) {
    const a = (r.aud as unknown[])[i];
    if (typeof a !== 'string' || a.length === 0) {
      return {
        ok: false,
        error: `capability bundle: aud[${String(i)}] must be a non-empty string`,
      };
    }
  }
  const audList = r.aud as string[];
  if (!audList.includes(KAGENT_SUBSTRATE_AUDIENCE)) {
    return {
      ok: false,
      error: `capability bundle: aud must include "${KAGENT_SUBSTRATE_AUDIENCE}"`,
    };
  }

  if (r.iat !== undefined && (typeof r.iat !== 'number' || !Number.isFinite(r.iat))) {
    return { ok: false, error: 'capability bundle: `iat`, when present, must be a number' };
  }
  if (r.nbf !== undefined && (typeof r.nbf !== 'number' || !Number.isFinite(r.nbf))) {
    return { ok: false, error: 'capability bundle: `nbf`, when present, must be a number' };
  }

  const claimsResult = validateCapabilityClaims(r.claims);
  if (!claimsResult.ok) {
    return { ok: false, error: `capability bundle: ${claimsResult.error}` };
  }

  const bundle: CapabilityBundle = {
    iss: r.iss,
    sub: r.sub,
    jti: r.jti,
    aud: audList,
    exp: r.exp,
    ...(typeof r.iat === 'number' && { iat: r.iat }),
    ...(typeof r.nbf === 'number' && { nbf: r.nbf }),
    claims: claimsResult.value,
  };
  return { ok: true, value: bundle };
}

/**
 * Test whether a bundle is currently expired (or not-before in the
 * future). `now` is unix epoch SECONDS, defaulting to `Date.now()/1000`
 * for production callers; tests inject a fixed clock for determinism.
 *
 * Returns `null` when the bundle is currently valid by time bounds, or
 * an error string explaining the failure otherwise. Caller decides
 * whether the failure is fatal (admission gate) or advisory.
 */
export function bundleTimeError(bundle: CapabilityBundle, now?: number): string | null {
  const nowSec = typeof now === 'number' ? now : Math.floor(Date.now() / 1000);
  if (bundle.exp <= nowSec) {
    return `capability bundle expired (exp=${String(bundle.exp)} ≤ now=${String(nowSec)})`;
  }
  if (typeof bundle.nbf === 'number' && bundle.nbf > nowSec) {
    return `capability bundle not yet valid (nbf=${String(bundle.nbf)} > now=${String(nowSec)})`;
  }
  return null;
}

/**
 * Type-tag the writable shape on `CapabilityClaims` so the validator
 * can assign categories without `as` casts everywhere. Internal
 * helper, not exported.
 */
function assignArrayCategory(
  out: { -readonly [K in keyof CapabilityClaims]: CapabilityClaims[K] },
  cat: CapabilityClaimCategory,
  list: readonly string[],
): void {
  switch (cat) {
    case 'tools':
      out.tools = list;
      return;
    case 'models':
      out.models = list;
      return;
    case 'spawn':
      out.spawn = list;
      return;
    case 'read':
      out.read = list;
      return;
    case 'write':
      out.write = list;
      return;
    case 'egress':
      out.egress = list;
      return;
    case 'publish':
      out.publish = list;
      return;
    case 'subscribe':
      out.subscribe = list;
      return;
    case 'tenant':
      // Unreachable — tenant is handled before assignArrayCategory in
      // validateCapabilityClaims. Listed here for exhaustiveness.
      return;
  }
}
