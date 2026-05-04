/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/capability-types` — JWT capability bundle schema + helpers.
 *
 * This is the FOUNDATIONAL Wave 2 package — Supervision (§4.2) and
 * Workflows (§4.3) sub-teams import it for cap-typed integration.
 * Published before any other Wave 2 deliverable.
 *
 * Surface:
 *   - Types: `CapabilityBundle`, `CapabilityClaims`, `CapabilityRef`,
 *     `CapabilityClaimCategory`.
 *   - Validators: `validateCapabilityClaims`, `validateCapabilityBundle`.
 *   - Glob match: `globMatch`, `globMatchAny`, `patternListIsSubset`,
 *     `globPatternIsSubset`.
 *   - Subset checks: `claimsAreSubsetOf`, `claimsSubsetViolations`.
 *   - JWT helpers: `buildCapabilityJwt`, `verifyCapabilityJwt`,
 *     `decodeCapabilityJwtUnsafe`, plus jose re-exports
 *     (`importPKCS8`, `importSPKI`, `createLocalJWKSet`, `JWK`).
 *
 * See docs/SUBSTRATE-V1.md §3.6 for the spec.
 */

export type {
  CapabilityBundle,
  CapabilityClaims,
  CapabilityClaimCategory,
  CapabilityRef,
} from './types.js';
export { ALL_CAPABILITY_CLAIM_CATEGORIES, KAGENT_SUBSTRATE_AUDIENCE } from './types.js';

export type { Validation } from './validate.js';
export {
  bundleTimeError,
  validateCapabilityBundle,
  validateCapabilityClaims,
  validValue,
} from './validate.js';

export { globMatch, globMatchAny, globPatternIsSubset, patternListIsSubset } from './glob-match.js';

export type { SubsetViolation } from './subset.js';
export { claimsAreSubsetOf, claimsSubsetViolations, formatViolations } from './subset.js';

export type {
  BuildCapabilityJwtInput,
  CapJwtAlg,
  VerifierKey,
  VerifyCapInput,
  VerifyCapResult,
} from './jwt.js';
export {
  ACCEPTED_CAP_ALGS,
  buildCapabilityJwt,
  createLocalJWKSet,
  DEFAULT_CAP_JWT_TTL_SECONDS,
  decodeCapabilityJwtUnsafe,
  exportJWK,
  importJWK,
  importPKCS8,
  importSPKI,
  verifyCapabilityJwt,
} from './jwt.js';
export type { JWK } from './jwt.js';
