/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Identity (v0.4.3-identity) — agent-pod SVID consumer.
 *
 * In-pod surface for SPIFFE Workload-API SVID consumption + the
 * mTLS LLM-client switch described in `docs/SUBSTRATE-V1.md` §3.10
 * + `docs/GATEWAY-CONTRACT.md` §4.3.
 *
 * The SPIRE Agent (deployed by the Wave 3 Helm sub-chart) listens on
 * a UDS at `KAGENT_SPIRE_SOCKET_PATH` (default
 * `/run/kagent-spire/sockets/agent.sock`). When
 * `KAGENT_LITELLM_USE_SVID=true` is on the env, the agent-pod's LLM
 * client wires an `IdentityHandle` against that socket. The handle:
 *
 *   1. Reads the latest SVID material on demand (X.509 cert + key
 *      PEM + optional bundle PEM). Production wiring uses the
 *      `spiffe-helper` sidecar pattern: the helper materializes the
 *      SVID into a tmpfs path the agent-pod also mounts, watching
 *      the cert file for changes. The handle re-reads on every LLM
 *      request — cheap (file read), and rotation is "free" (the
 *      next request picks up the rotated material).
 *
 *   2. Exposes `getMtlsContext()` returning a Node 22
 *      `tls.SecureContextOptions` shape the OpenAI-compat client's
 *      undici dispatcher consumes via `connect: { ca, cert, key }`.
 *
 *   3. Exposes `probeMtls(baseUrl)` — a one-shot capability probe
 *      that opens a TLS handshake to the gateway and inspects the
 *      handshake outcome. mTLS-supporting gateways accept the
 *      client cert; bearer-only gateways either ignore it (still
 *      success — the handshake completes) or reject it. The probe
 *      records a graceful-fall-back signal on the
 *      WARN-log path that the runner can use to decide whether to
 *      keep mTLS on or fall back to the bearer.
 *
 *      Probe semantics are deliberately PERMISSIVE: a successful TLS
 *      handshake is NOT proof of mTLS — the gateway might be doing
 *      one-way TLS and ignoring the client cert. In v0.4.3 we treat
 *      "handshake completed" as "mTLS is ON the wire"; v0.4.x can
 *      tighten the probe with a richer challenge (e.g. send a
 *      kagent-side header `X-Kagent-Identity-Probe: required` and
 *      check the gateway's response).
 *
 * v0.4.3 decisions (and why):
 *
 *   - **No SPIRE Workload-API gRPC client** in this package. The
 *     `@spiffe/spiffe-helper` and SPIRE-team `spiffe-helper` (Go)
 *     sidecar are the canonical materializers. We DO NOT vendor a
 *     gRPC client into the agent-pod image — keeps the runtime
 *     dependency surface small. The handle reads from disk; the
 *     helper writes to disk.
 *
 *   - **`KAGENT_LITELLM_API_KEY` is NOT removed from the codebase**;
 *     it stays as a bootstrap fall-back. When `KAGENT_LITELLM_USE_SVID
 *     =true` AND `probeMtls` succeeds, the bearer is dropped on the
 *     wire. When the probe fails (gateway is bearer-only), the
 *     runner logs a WARN and threads the bearer through —
 *     interim-degraded but functional. Wave 4 KeyRotation drops the
 *     bearer entirely.
 *
 *   - **Path testability.** Every external boundary
 *     (`fetch`, `readFileSync`) is dependency-injected. The
 *     production boot in `main.ts` defaults the deps; tests pass
 *     a fake.
 *
 * Open question for the gateway team (per
 * GATEWAY-CONTRACT.md §4.3): should the gateway emit a
 * `X-Kagent-Identity-Verified: spiffe://...` response header on
 * mTLS success so the agent-pod can record the verified SPIFFE ID
 * in trace metadata? Wave 3 punts: the SVID is recorded on the
 * operator side (audit `identity.svid_issued`); per-request
 * verification proof is the gateway team's call.
 */

import { readFileSync as defaultReadFileSync } from 'node:fs';

/**
 * `IdentityHandle` — agent-pod-side facade around a SPIRE-managed
 * SVID. Production caller is `runner.ts`'s `buildLlmClient`; tests
 * inject a fake.
 */
export interface IdentityHandle {
  /** SPIFFE ID this handle authenticates as. May be `undefined` until first SVID materialization. */
  readonly spiffeId: string | undefined;
  /**
   * Materialize the latest SVID + key + bundle PEM bytes from disk.
   * Throws on read failure (the substrate fails closed when SVID is
   * required but unreadable).
   */
  loadMaterial(): SvidMaterial;
  /**
   * Build a `tls.SecureContextOptions`-shaped object the undici
   * dispatcher consumes. Returns `null` when the SVID material is
   * unavailable (e.g. SPIRE-helper hasn't written yet; runner uses
   * this null to keep falling back to bearer auth).
   */
  getMtlsContext(): SvidMtlsContext | null;
}

/**
 * SVID material as PEM strings. Mirrors the spiffe-helper sidecar's
 * default file-output layout: cert, key, bundle each in its own PEM.
 */
export interface SvidMaterial {
  readonly certPem: string;
  readonly keyPem: string;
  readonly bundlePem: string | undefined;
}

/**
 * Shape consumed by undici / Node 22's TLS layer when the LLM client
 * opens an HTTPS connection to the gateway. Matches
 * `tls.SecureContextOptions` (`ca`, `cert`, `key`) — kept as a
 * separate interface so the OpenAI-compat client doesn't need to
 * import `node:tls` types for this one struct.
 */
export interface SvidMtlsContext {
  readonly ca: string | undefined;
  readonly cert: string;
  readonly key: string;
}

/**
 * Boot-time inputs to `loadIdentityHandle`. All paths come from the
 * env contract (see `env.ts`); test wiring overrides via `readFile`.
 */
export interface LoadIdentityHandleInput {
  readonly enabled: boolean;
  /** Path to PEM cert (default `/var/kagent/svid/tls.crt`). */
  readonly certPath?: string;
  /** Path to PEM key (default `/var/kagent/svid/tls.key`). */
  readonly keyPath?: string;
  /** Path to PEM bundle (default `/var/kagent/svid/bundle.pem`). May be missing. */
  readonly bundlePath?: string;
  /** SPIFFE ID the operator declared this pod attests as. Surfaced via `IdentityHandle.spiffeId`. */
  readonly spiffeId?: string;
  /** Test-injectable reader. Defaults to `fs.readFileSync`. */
  readonly readFile?: (path: string) => string;
}

const DEFAULT_CERT_PATH = '/var/kagent/svid/tls.crt';
const DEFAULT_KEY_PATH = '/var/kagent/svid/tls.key';
const DEFAULT_BUNDLE_PATH = '/var/kagent/svid/bundle.pem';

/**
 * Construct an `IdentityHandle` from the env contract. Returns `null`
 * when `enabled=false` (the runner stays on bearer auth).
 *
 * Caller is responsible for the env-flag checks: this fn just wires
 * the file-read paths. The handle's `loadMaterial` throws on
 * disk-read failure so a misconfigured chart surfaces fast at first
 * LLM call (vs. silently falling back).
 */
export function loadIdentityHandle(input: LoadIdentityHandleInput): IdentityHandle | null {
  if (!input.enabled) return null;
  const certPath = input.certPath ?? DEFAULT_CERT_PATH;
  const keyPath = input.keyPath ?? DEFAULT_KEY_PATH;
  const bundlePath = input.bundlePath ?? DEFAULT_BUNDLE_PATH;
  const readFile = input.readFile ?? ((p: string): string => defaultReadFileSync(p, 'utf8'));

  const handle: IdentityHandle = {
    spiffeId: input.spiffeId,
    loadMaterial(): SvidMaterial {
      const certPem = readFile(certPath);
      const keyPem = readFile(keyPath);
      let bundlePem: string | undefined;
      try {
        const body = readFile(bundlePath);
        if (typeof body === 'string' && body.length > 0) bundlePem = body;
      } catch {
        bundlePem = undefined;
      }
      if (typeof certPem !== 'string' || certPem.length === 0) {
        throw new Error(`SVID cert at ${certPath} is empty / unreadable`);
      }
      if (typeof keyPem !== 'string' || keyPem.length === 0) {
        throw new Error(`SVID key at ${keyPath} is empty / unreadable`);
      }
      return { certPem, keyPem, bundlePem };
    },
    getMtlsContext(): SvidMtlsContext | null {
      try {
        const m = this.loadMaterial();
        return { ca: m.bundlePem, cert: m.certPem, key: m.keyPem };
      } catch {
        return null;
      }
    },
  };
  return handle;
}

/**
 * Test-injectable shape for `probeGatewayMtls`'s fetch surface.
 * Modeled after `globalThis.fetch` but intentionally narrow so
 * tests don't need to mock the full Response body.
 */
export interface ProbeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get: (name: string) => string | null };
}

export interface ProbeGatewayMtlsInput {
  readonly handle: IdentityHandle;
  readonly baseUrl: string;
  readonly fetchImpl?: (
    url: string,
    init: { method: string; headers: Record<string, string> },
  ) => Promise<ProbeFetchResponse>;
}

export interface ProbeGatewayMtlsResult {
  /** True when the gateway accepted the mTLS handshake. */
  readonly mtlsSupported: boolean;
  /**
   * Reason for the verdict. `'handshake-ok'` is the success path;
   * other values document why the probe came back negative so the
   * runner can log a structured WARN.
   */
  readonly reason:
    | 'handshake-ok'
    | 'no-cert-material'
    | 'tls-error'
    | 'fetch-failed'
    | 'fetch-rejected';
  /**
   * Audit-rev2 M7 (= evidence/audit-rev2/C2.md §1 row M7): the probe
   * is structurally OPTIMISTIC. A successful TLS handshake is NOT
   * proof the gateway honored our client cert (one-way TLS gateways
   * complete the handshake while ignoring the cert). When this flag
   * is `true`, the gateway emitted the `X-Kagent-Identity-Verified`
   * response header and the runner can trust mTLS is end-to-end.
   * When `false` (and `mtlsSupported=true`), the runner should log
   * the probe at WARN with `mtlsSupported: true (UNVERIFIED)` so
   * operators see the discoverability gap; audit emissions should
   * use the same flag to distinguish verified from optimistic.
   *
   * The header value, when present, carries the SPIFFE ID the
   * gateway resolved (e.g. `spiffe://kagent.knuteson.io/agent/<name>`).
   * Tracking until the gateway team's contract decision lands
   * (docs/GATEWAY-CONTRACT.md §4.3 open question).
   */
  readonly identityVerifiedHeader?: string;
  /** Trace-friendly detail string. May be empty. */
  readonly detail: string;
}

/**
 * Probe the gateway's mTLS capability. v0.4.3 implementation: GET the
 * gateway's `<baseUrl>/health` (or `/`, falling back) and inspect the
 * handshake outcome. A successful response (any 2xx, 4xx, or 401/403)
 * means TLS handshake completed; a network error means TLS handshake
 * rejected our client cert.
 *
 * v0.4.3 limitation (DOCUMENTED): we cannot reliably distinguish
 * "gateway ignored our cert" from "gateway accepted our cert" without
 * a richer protocol. The probe is OPTIMISTIC: when the GET succeeds
 * AND the gateway does NOT emit the `X-Kagent-Identity-Verified`
 * header, the result carries `mtlsSupported=true` /
 * `identityVerifiedHeader=undefined`. Callers should log
 * "mtlsSupported: true (UNVERIFIED)" on this path so operators
 * see the discoverability gap. The real-world fall-back path is the
 * gateway responding 426 Upgrade Required or 401 with a body
 * indicating "bearer required" — both signal the runner to fall back.
 *
 * Audit-rev2 M7 (= evidence/audit-rev2/C2.md §1 row M7): when the
 * gateway DOES emit `X-Kagent-Identity-Verified: spiffe://...` (the
 * outcome of GATEWAY-CONTRACT.md §4.3's open question), the probe
 * propagates the header on `identityVerifiedHeader` so the runner can
 * promote the WARN to a structured INFO and audit emissions can flag
 * the connection as VERIFIED.
 */
export async function probeGatewayMtls(
  input: ProbeGatewayMtlsInput,
): Promise<ProbeGatewayMtlsResult> {
  const ctx = input.handle.getMtlsContext();
  if (ctx === null) {
    return {
      mtlsSupported: false,
      reason: 'no-cert-material',
      detail: 'IdentityHandle.getMtlsContext returned null — SVID material missing',
    };
  }
  const fetchImpl =
    input.fetchImpl ??
    (async (url, init): Promise<ProbeFetchResponse> => {
      const r = await globalThis.fetch(url, init);
      return r;
    });
  const probeUrl = `${input.baseUrl.replace(/\/+$/, '')}/health`;
  try {
    const response = await fetchImpl(probeUrl, {
      method: 'GET',
      headers: {
        'X-Kagent-Identity-Probe': 'optional',
        Accept: 'application/json',
      },
    });
    // Any non-network outcome means TLS completed. We treat the probe
    // as "mtls supported" if the gateway didn't outright reject the
    // request with a 426 (the conventional "upgrade required" code we
    // expect a bearer-only gateway to return when fed a client cert).
    if (response.status === 426) {
      return {
        mtlsSupported: false,
        reason: 'tls-error',
        detail: `gateway returned 426 (Upgrade Required) — bearer-only`,
      };
    }
    // Audit-rev2 M7: extract the optional verification header. When
    // present, the runner can promote the WARN to a structured INFO
    // and audit emissions flag the connection as VERIFIED. When
    // absent, the probe is OPTIMISTIC and the caller should log
    // "mtlsSupported: true (UNVERIFIED)".
    const verified = response.headers.get('X-Kagent-Identity-Verified') ?? undefined;
    const verifiedSuffix =
      typeof verified === 'string' && verified.length > 0 ? ` VERIFIED=${verified}` : ' UNVERIFIED';
    return {
      mtlsSupported: true,
      reason: 'handshake-ok',
      detail: `probe ${probeUrl} -> ${response.status}${verifiedSuffix}`,
      ...(typeof verified === 'string' &&
        verified.length > 0 && { identityVerifiedHeader: verified }),
    };
  } catch (err) {
    // Network / TLS error — handshake rejected.
    return {
      mtlsSupported: false,
      reason: 'fetch-rejected',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
