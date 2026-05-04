/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Capability-CA — operator-side signing-key abstraction (v0.3.0-capabilities).
 *
 * Two key sources are supported, swapped via env config:
 *
 *   1. **File-mount path (default).** The operator's Helm chart mounts
 *      a Secret holding a PEM-encoded private key at
 *      `KAGENT_CAP_SIGNING_KEY_FILE` (default
 *      `/var/kagent/cap-ca/tls.key`). The same Secret carries the
 *      corresponding PEM public key at `KAGENT_CAP_SIGNING_PUB_FILE`
 *      (default `/var/kagent/cap-ca/tls.crt`). The chart is the source
 *      of truth; the operator just reads.
 *
 *      This path works WITHOUT cert-manager — important for the
 *      "kagent boots on a vanilla K3s without bootstrapping
 *      cert-manager first" flow per the brief.
 *
 *   2. **cert-manager Issuer path (advanced).** The chart can layer in
 *      an `Issuer` + `Certificate` and mount the resulting Secret;
 *      from the operator's view the data path is identical (both
 *      surfaces drop a `tls.key`/`tls.crt` pair into the mounted
 *      directory). This module doesn't talk to cert-manager directly —
 *      the chart wires the rotation; the operator just re-reads the
 *      mounted files when the watcher fires.
 *
 * The signed JWT alg is ES256 by default (P-256 ECDSA + SHA-256). The
 * private key file MUST therefore be a PEM PKCS#8 EC P-256 key. RS256
 * (RSA-2048+) is the fallback when the chart provisioned an RSA key
 * (some cert-manager Issuers default RSA). Detection: read the PEM
 * header — `BEGIN EC PRIVATE KEY` / `BEGIN PRIVATE KEY` (PKCS#8) +
 * inspect the parsed key for curve / RSA type.
 *
 * The companion `template-server.ts` exposes the public key at
 * `/.well-known/jwks.json`. Verifiers (agent-pod cap consumer,
 * downstream substrate gates) fetch JWKS to verify a JWT without a
 * shared secret.
 *
 * Test surface: `loadFromMaterials({ privatePem, publicPem })` builds
 * a CapCa from in-memory PEMs (used by unit tests so they don't need
 * fixture files).
 */

import { readFileSync } from 'node:fs';

import {
  buildCapabilityJwt,
  exportJWK,
  importPKCS8,
  importSPKI,
  type CapabilityClaims,
  type CapJwtAlg,
  type JWK,
} from '@kagent/capability-types';

/**
 * Signing-key handle held by the operator. The PRIVATE key never
 * leaves this module; the PUBLIC key (as JWK) is exposed by the JWKS
 * endpoint. `kid` is stamped on every JWT this CA mints AND on the
 * JWK so verifiers can resolve via the JWKS without trying every key.
 */
export interface CapCa {
  /** Algorithm to sign with — `'ES256'` (default) or `'RS256'`. */
  readonly alg: CapJwtAlg;
  /** Public-key JSON Web Key (with kid + alg + use stamped). */
  readonly jwk: JWK;
  /** Stable key id — convention: `kagent-cap-<hex8>`. */
  readonly kid: string;
  /** Issuer URI baked into every minted JWT. */
  readonly issuer: string;
  /**
   * Mint a new JWT capability bundle. Pure compose-around the
   * `buildCapabilityJwt` from `@kagent/capability-types`; the
   * operator's `cap-issuer.ts` is the production caller.
   */
  mint(input: MintCapInput): Promise<MintCapResult>;
  /**
   * JOSE-format JWKS document (one `keys` entry per active CA key).
   * Wave 2 v0.3.0 ships single-key + a placeholder for the rotation
   * second-key path — the chart can drop a `kagent-cap-ca-extra`
   * secret next to the primary that this fn reads + adds a second
   * JWK to the document.
   */
  jwks(): { readonly keys: readonly JWK[] };
}

/**
 * Inputs to `CapCa.mint()`. Mirrors `BuildCapabilityJwtInput` minus
 * the `issuer` (the CA owns it) and minus the `now` injection
 * (production callers don't override the clock; tests inject via
 * `loadFromMaterials({ now })`).
 */
export interface MintCapInput {
  readonly subjectTaskUid: string;
  readonly jti: string;
  readonly claims: CapabilityClaims;
  /** TTL in seconds; defaults from the JWT helper. */
  readonly ttlSeconds?: number;
  /** Extra audiences appended after `'kagent-substrate'`. */
  readonly audiences?: readonly string[];
}

export interface MintCapResult {
  readonly jwt: string;
  readonly jti: string;
  readonly expiresAt: number;
}

/**
 * Inputs for `loadFromMaterials` — in-memory PEM strings. Production
 * boots prefer `loadFromEnv` which reads from disk.
 */
export interface CapCaMaterials {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly alg?: CapJwtAlg;
  readonly kid?: string;
  readonly issuer?: string;
  /** Test-injectable clock; mints use it via `buildCapabilityJwt`. */
  readonly now?: () => number;
  /**
   * Optional second public key — exposed via JWKS for the rotation
   * path. The CA does NOT sign with this key (rotation flips the
   * primary materials when the chart updates the Secret); it's
   * present so verifiers cached against the previous primary still
   * succeed during the cutover window.
   */
  readonly secondaryPublicPem?: string;
  readonly secondaryAlg?: CapJwtAlg;
  readonly secondaryKid?: string;
}

const DEFAULT_ISSUER = 'kagent.knuteson.io/operator';

/**
 * Build a CapCa from in-memory PEMs. Used by unit tests + by
 * `loadFromEnv` after disk reads.
 */
export async function loadFromMaterials(input: CapCaMaterials): Promise<CapCa> {
  const alg = input.alg ?? detectAlgFromPem(input.privatePem);
  const issuer = input.issuer ?? DEFAULT_ISSUER;
  const kid = input.kid ?? defaultKid();

  const privateKey = await importPKCS8(input.privatePem, alg);
  const publicKey = await importSPKI(input.publicPem, alg);
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = alg;
  jwk.use = 'sig';

  let secondaryJwk: JWK | undefined;
  if (input.secondaryPublicPem !== undefined && input.secondaryPublicPem.length > 0) {
    const secAlg = input.secondaryAlg ?? alg;
    const secKey = await importSPKI(input.secondaryPublicPem, secAlg);
    secondaryJwk = await exportJWK(secKey);
    secondaryJwk.kid = input.secondaryKid ?? `${kid}-prev`;
    secondaryJwk.alg = secAlg;
    secondaryJwk.use = 'sig';
  }

  const ca: CapCa = {
    alg,
    jwk,
    kid,
    issuer,
    async mint(req: MintCapInput): Promise<MintCapResult> {
      const builder = buildCapabilityJwt({
        issuer,
        subjectTaskUid: req.subjectTaskUid,
        jti: req.jti,
        claims: req.claims,
        ...(req.ttlSeconds !== undefined && { ttlSeconds: req.ttlSeconds }),
        ...(req.audiences !== undefined && { audiences: req.audiences }),
        ...(input.now !== undefined && { now: input.now }),
      });
      builder.setProtectedHeader({ alg, kid });
      const jwt = await builder.sign(privateKey);

      // Recover exp from the freshly-signed JWT — `buildCapabilityJwt`
      // sets it via `now + ttl`. Decode-and-trust here because we just
      // produced the bundle ourselves; the verifier path is the one
      // that re-checks signatures.
      const payload = decodePayload(jwt);
      const exp = typeof payload?.exp === 'number' ? payload.exp : 0;
      return { jwt, jti: req.jti, expiresAt: exp };
    },
    jwks(): { readonly keys: readonly JWK[] } {
      const keys: JWK[] = [jwk];
      if (secondaryJwk !== undefined) keys.push(secondaryJwk);
      return { keys };
    },
  };
  return ca;
}

/**
 * Production boot — read PEMs from the filesystem at the configured
 * paths. Throws descriptively on missing / unreadable files so the
 * operator fails fast at boot rather than silently signing with a
 * broken key.
 *
 * Env contract (mirrors the chart's value names):
 *   - `KAGENT_CAP_SIGNING_KEY_FILE`   — PEM PKCS#8 private key
 *                                       (default: `/var/kagent/cap-ca/tls.key`)
 *   - `KAGENT_CAP_SIGNING_PUB_FILE`   — PEM SPKI public key
 *                                       (default: `/var/kagent/cap-ca/tls.crt`)
 *   - `KAGENT_CAP_SIGNING_ALG`        — `ES256` (default) or `RS256`
 *   - `KAGENT_CAP_SIGNING_KID`        — kid string (default: derived
 *                                       from a hash of the public key)
 *   - `KAGENT_CAP_ISSUER`             — iss claim (default:
 *                                       `kagent.knuteson.io/operator`)
 *   - `KAGENT_CAP_SIGNING_PREV_PUB_FILE` — optional previous public
 *                                       key PEM (rotation cutover)
 *
 * v0.4.3-identity (Wave 3 / Identity sub-team): when
 * `KAGENT_IDENTITY_ENABLED=true` AND the operator's chart-mounted
 * cap-ca Secret is empty/missing, fall back to the SPIRE-managed key
 * pair at `KAGENT_SPIRE_CAP_SIGNING_KEY_FILE` /
 * `KAGENT_SPIRE_CAP_SIGNING_PUB_FILE` (defaults
 * `/var/kagent/spire-cap-ca/tls.{key,crt}`). When the SPIRE-managed
 * pair IS present + healthy, the cap CA uses it; otherwise the
 * canonical chart Secret path stays canonical. This lets a cluster
 * operator run BOTH SPIFFE/SPIRE for workload identity AND the
 * chart-managed Secret for cap signing without forcing a re-mint at
 * SPIRE-cert rotation time.
 *
 * `readFile` is dependency-injected so tests can drive both paths
 * without real filesystem access.
 */
export async function loadFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string = defaultReadFile,
): Promise<CapCa> {
  // v0.4.3-identity — additive SPIRE-cert source. Tried FIRST when
  // identity is enabled AND the SPIRE files are present + non-empty;
  // a missing/empty SPIRE pair falls through to the canonical
  // chart-Secret path. Wave 2 tests don't set KAGENT_IDENTITY_ENABLED
  // so they take the same path they always did.
  if (env.KAGENT_IDENTITY_ENABLED === 'true') {
    const spireKeyPath =
      env.KAGENT_SPIRE_CAP_SIGNING_KEY_FILE ?? '/var/kagent/spire-cap-ca/tls.key';
    const spirePubPath =
      env.KAGENT_SPIRE_CAP_SIGNING_PUB_FILE ?? '/var/kagent/spire-cap-ca/tls.crt';
    let spireKeyPem: string | undefined;
    let spirePubPem: string | undefined;
    try {
      spireKeyPem = readFile(spireKeyPath);
      spirePubPem = readFile(spirePubPath);
    } catch {
      spireKeyPem = undefined;
      spirePubPem = undefined;
    }
    if (
      typeof spireKeyPem === 'string' &&
      spireKeyPem.length > 0 &&
      typeof spirePubPem === 'string' &&
      spirePubPem.length > 0
    ) {
      console.log(`[kagent-operator] cap-ca: using SPIRE-managed signing key at ${spireKeyPath}`);
      const alg = parseAlg(env.KAGENT_CAP_SIGNING_ALG) ?? detectAlgFromPem(spireKeyPem);
      return await loadFromMaterials({
        privatePem: spireKeyPem,
        publicPem: spirePubPem,
        alg,
        ...(env.KAGENT_CAP_SIGNING_KID !== undefined && { kid: env.KAGENT_CAP_SIGNING_KID }),
        ...(env.KAGENT_CAP_ISSUER !== undefined && { issuer: env.KAGENT_CAP_ISSUER }),
      });
    }
    console.log(
      '[kagent-operator] cap-ca: KAGENT_IDENTITY_ENABLED=true but SPIRE-cap-ca files are absent/empty; falling back to chart Secret',
    );
  }

  const privatePath = env.KAGENT_CAP_SIGNING_KEY_FILE ?? '/var/kagent/cap-ca/tls.key';
  const publicPath = env.KAGENT_CAP_SIGNING_PUB_FILE ?? '/var/kagent/cap-ca/tls.crt';
  const privatePem = readFile(privatePath);
  const publicPem = readFile(publicPath);
  if (typeof privatePem !== 'string' || privatePem.length === 0) {
    throw new Error(`KAGENT_CAP_SIGNING_KEY_FILE (${privatePath}) is empty / unreadable`);
  }
  if (typeof publicPem !== 'string' || publicPem.length === 0) {
    throw new Error(`KAGENT_CAP_SIGNING_PUB_FILE (${publicPath}) is empty / unreadable`);
  }
  const alg = parseAlg(env.KAGENT_CAP_SIGNING_ALG) ?? detectAlgFromPem(privatePem);

  let secondaryPublicPem: string | undefined;
  const prevPath = env.KAGENT_CAP_SIGNING_PREV_PUB_FILE;
  if (typeof prevPath === 'string' && prevPath.length > 0) {
    try {
      const body = readFile(prevPath);
      if (typeof body === 'string' && body.length > 0) secondaryPublicPem = body;
    } catch (err) {
      console.warn(
        `[kagent-operator] cap-ca: previous-pub file at ${prevPath} unreadable, skipping rotation cutover:`,
        err,
      );
    }
  }

  return await loadFromMaterials({
    privatePem,
    publicPem,
    alg,
    ...(env.KAGENT_CAP_SIGNING_KID !== undefined && { kid: env.KAGENT_CAP_SIGNING_KID }),
    ...(env.KAGENT_CAP_ISSUER !== undefined && { issuer: env.KAGENT_CAP_ISSUER }),
    ...(secondaryPublicPem !== undefined && { secondaryPublicPem }),
  });
}

/* =====================================================================
 * Internal helpers
 * ===================================================================== */

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function parseAlg(raw: string | undefined): CapJwtAlg | undefined {
  if (raw === 'ES256' || raw === 'RS256') return raw;
  return undefined;
}

/**
 * Detect alg from PEM body. The substrate accepts:
 *   - PKCS#8 EC P-256 → ES256
 *   - PKCS#8 RSA-*    → RS256
 * Anything else throws — we don't pick alg silently.
 */
function detectAlgFromPem(pem: string): CapJwtAlg {
  // Heuristic on the body — RSA private keys carry a long modulus
  // (>1KB). EC P-256 keys are <300 bytes. We can't parse ASN.1 here
  // without a heavy dep, so use the encoded length as a tiebreaker.
  const trimmed = pem.replace(/-----BEGIN [A-Z ]+-----|-----END [A-Z ]+-----|\s/g, '');
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length > 600) return 'RS256';
  return 'ES256';
}

/**
 * Default `kid`: 8 hex chars seeded by the current time + random
 * bytes. Cap CA's kid is opaque to verifiers (they look up by
 * `header.kid` in JWKS) so any non-colliding string is fine.
 */
function defaultKid(): string {
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return `kagent-cap-${hex}`;
}

/**
 * Decode the PAYLOAD of a JWT WITHOUT verification. Used immediately
 * after `mint()` to recover the `exp` claim the helper stamped — the
 * data was just produced by us so we trust the round-trip.
 */
function decodePayload(jwt: string): { exp?: number } | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const padded = (parts[1] ?? '') + '='.repeat((4 - ((parts[1]?.length ?? 0) % 4)) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return JSON.parse(decoded) as { exp?: number };
  } catch {
    return undefined;
  }
}
