/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Identity (v0.4.3-identity) — SPIFFE/SPIRE-aware identity
 * primitives, operator-side. See `docs/SUBSTRATE-V1.md` §3.10 (Identity)
 * + `docs/WAVES.md` §5.4 + `docs/GATEWAY-CONTRACT.md` §4.3.
 *
 * Design surface, top-down:
 *
 * 1. SPIFFE ID convention. Every kagent agent-pod (and workflow
 *    runtime pod) advertises a SPIFFE ID of the shape:
 *
 *      `spiffe://kagent.knuteson.io/ns/<ns>/sa/<sa>/agent/<agent-name>`
 *
 *    The trust domain `kagent.knuteson.io` is the operator's; SPIRE
 *    Server is configured against it via the chart. The path embeds
 *    namespace + service-account + Agent name so a SPIRE registration
 *    selector ladder can attest a pod off the K8s SA + the AgentTask
 *    name label and bind it to the matching SPIFFE ID.
 *
 * 2. Identity off, default. `identity.enabled=false` (chart) is the
 *    Wave 3 v0.4.3 default. Bearer-token auth (Wave 0 secrets-hygiene)
 *    is still the production-default credential. Flipping the flag
 *    deploys the SPIRE Server StatefulSet + Agent DaemonSet sub-chart,
 *    mounts the workload-API socket on every spawned agent-pod via the
 *    operator's `buildIdentityVolumes` helper, and switches the
 *    agent-pod's LLM client into mTLS mode (graceful fall-back to
 *    bearer when the gateway lacks mTLS — see `probeGatewayMtls`).
 *
 * 3. Trust-domain narrowing. Capability JWTs (Wave 2 / Caps) and
 *    SVIDs are ISSUED by the SAME logical authority — the operator's
 *    cert-manager-rooted CA. Wave 3 v0.4.3 keeps the two key paths
 *    separate (SPIRE has its own internal CA; cap-ca.ts has its own);
 *    but the chart provisions a single shared cert-manager `Issuer`
 *    for both. This module exposes `loadSpireCaBundleFromEnv` for
 *    callers that want to verify a SPIRE-issued cert chain.
 *
 * 4. What this module ships in v0.4.3. Pure functional surface:
 *      - `buildSpiffeId({ namespace, serviceAccount, agentName, trustDomain })`
 *      - `parseSpiffeId(uri)` — discriminated round-trip
 *      - `IdentityVolumes` — k8s volume + volumeMount struct for the
 *        SPIRE Workload-API socket; the chart provides the host path
 *        and the agent-pod consumes it via `KAGENT_SPIRE_SOCKET_PATH`
 *      - `buildIdentityVolumes` — additive helper used by
 *        `job-spec.ts` when `identity.enabled=true`
 *      - `IdentityWatcher` interface — operator-side rotation hook;
 *        the production wiring fires `identity.svid_issued` +
 *        `identity.rotation` audit events when a SPIRE Workload-API
 *        attestation streams a fresh SVID. Wave 3 ships the interface
 *        + a `MockIdentityWatcher` that's used by tests AND by dev
 *        clusters with `identity.enabled=true` AND
 *        `identity.mock.enabled=true` (see chart values).
 *
 * 5. What's deferred. End-to-end SPIRE Server admission webhook
 *    integration (the operator-side reconciler that creates SPIRE
 *    `RegistrationEntry` per AgentTask) is left as a follow-up wave.
 *    The substrate primitives + audit hooks land in v0.4.3; the
 *    automated registration controller can light up additively in
 *    v0.4.x without breaking the CRD shape.
 */

import {
  IDENTITY_ROTATION,
  IDENTITY_SVID_ISSUED,
  makeEvent,
  type AuditEvent,
  type IdentityRotationData,
  type IdentitySvidIssuedData,
} from '@kagent/audit-events';

/**
 * Default trust domain for kagent SPIFFE IDs. Must match the SPIRE
 * Server `trust_domain` config the chart provisions; the Helm value
 * `identity.trustDomain` overrides both ends in lockstep.
 */
export const DEFAULT_TRUST_DOMAIN = 'kagent.knuteson.io';

/**
 * Default mount path for the SPIRE Workload-API socket inside spawned
 * agent-pods. SPIRE convention is `/run/spire/sockets/agent.sock`; we
 * pin a kagent-prefixed path so multiple SPIRE installs on the same
 * node don't collide with the workload-API socket the agent-pod's
 * `svid-client.ts` opens.
 */
export const DEFAULT_SPIRE_SOCKET_PATH = '/run/kagent-spire/sockets/agent.sock';

/**
 * Default host path the SPIRE Agent DaemonSet exposes the
 * Workload-API UDS at. The chart's SPIRE Agent runs as a DaemonSet
 * with hostPath access; the agent-pod side mounts it as a hostPath
 * volume under the same key. Distinct from the in-pod mount path so
 * the host filesystem layout stays readable.
 */
export const DEFAULT_SPIRE_HOST_SOCKET_DIR = '/run/kagent-spire/sockets';

/** Inputs to `buildSpiffeId`. */
export interface BuildSpiffeIdInput {
  readonly namespace: string;
  readonly serviceAccount: string;
  readonly agentName: string;
  readonly trustDomain?: string;
}

/**
 * Construct the canonical SPIFFE ID for an agent-pod.
 *
 *   `spiffe://<trustDomain>/ns/<ns>/sa/<sa>/agent/<agent>`
 *
 * The path components are URI-segment-encoded; `agentName` and
 * `serviceAccount` MUST already be valid K8s names so encoding is a
 * pass-through but we apply `encodeURIComponent` defensively to
 * surface invalid input early. Throws Error with a descriptive
 * message on missing / empty parts (substrate fails closed; a missing
 * piece would otherwise produce a syntactically-valid-but-wrong
 * SPIFFE ID, which is worse than a hard error).
 */
export function buildSpiffeId(input: BuildSpiffeIdInput): string {
  const td = (input.trustDomain ?? DEFAULT_TRUST_DOMAIN).trim();
  const ns = input.namespace.trim();
  const sa = input.serviceAccount.trim();
  const agent = input.agentName.trim();
  if (td.length === 0) throw new Error('buildSpiffeId: trustDomain is empty');
  if (ns.length === 0) throw new Error('buildSpiffeId: namespace is empty');
  if (sa.length === 0) throw new Error('buildSpiffeId: serviceAccount is empty');
  if (agent.length === 0) throw new Error('buildSpiffeId: agentName is empty');
  return `spiffe://${td}/ns/${encodeURIComponent(ns)}/sa/${encodeURIComponent(
    sa,
  )}/agent/${encodeURIComponent(agent)}`;
}

/**
 * Parsed SPIFFE ID. Returned by `parseSpiffeId` on a well-formed kagent
 * SPIFFE ID; null on anything else. Out-of-spec SPIFFE URIs (e.g.
 * SPIRE's own `spiffe://example.org/spire/agent/...` paths) parse to
 * null — kagent only narrows the shape it ISSUES.
 */
export interface ParsedSpiffeId {
  readonly trustDomain: string;
  readonly namespace: string;
  readonly serviceAccount: string;
  readonly agentName: string;
}

/**
 * Parse a kagent-shaped SPIFFE ID. Strictly pattern-match — anything
 * that isn't `spiffe://<td>/ns/<ns>/sa/<sa>/agent/<name>` returns null.
 * URI-decoded so a callsite that received `agent/researcher%2Dv2`
 * sees `researcher-v2`.
 */
export function parseSpiffeId(uri: string): ParsedSpiffeId | null {
  if (typeof uri !== 'string' || uri.length === 0) return null;
  const re = /^spiffe:\/\/([^/]+)\/ns\/([^/]+)\/sa\/([^/]+)\/agent\/(.+)$/;
  const m = re.exec(uri);
  if (m === null) return null;
  const td = m[1];
  const ns = m[2];
  const sa = m[3];
  const agent = m[4];
  if (
    typeof td !== 'string' ||
    typeof ns !== 'string' ||
    typeof sa !== 'string' ||
    typeof agent !== 'string'
  ) {
    return null;
  }
  try {
    return {
      trustDomain: td,
      namespace: decodeURIComponent(ns),
      serviceAccount: decodeURIComponent(sa),
      agentName: decodeURIComponent(agent),
    };
  } catch {
    return null;
  }
}

/**
 * `IdentityVolumes` — k8s volume + volumeMount struct for the SPIRE
 * Workload-API socket plumbing. Returned by `buildIdentityVolumes`
 * and consumed by `job-spec.ts`'s additive `identity.enabled=true`
 * branch (additive: the existing job-spec is unchanged when identity
 * is off).
 *
 * Shape:
 *   - `volume` is a HostPath volume so the agent-pod talks to the
 *     SPIRE Agent's UDS directly. SPIRE recommends HostPath for the
 *     Workload-API socket per spiffe.io's deploying-svids guide.
 *   - `volumeMount` mounts the directory (NOT the file) into the
 *     agent-pod at `KAGENT_SPIRE_SOCKET_PATH`'s parent so the in-pod
 *     `svid-client.ts` can connect against the UDS.
 *   - `env` carries the in-pod path the client opens — we want a
 *     single source of truth between operator and agent-pod.
 */
export interface IdentityVolumes {
  readonly volume: {
    readonly name: string;
    readonly hostPath: { readonly path: string; readonly type: 'DirectoryOrCreate' };
  };
  readonly volumeMount: {
    readonly name: string;
    readonly mountPath: string;
    readonly readOnly: true;
  };
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** Inputs to `buildIdentityVolumes`. */
export interface BuildIdentityVolumesInput {
  /** Default false — when false the helper returns null. */
  readonly enabled: boolean;
  /** Override DEFAULT_SPIRE_HOST_SOCKET_DIR. */
  readonly hostSocketDir?: string;
  /** Override DEFAULT_SPIRE_SOCKET_PATH. */
  readonly podSocketPath?: string;
}

/**
 * Build the identity volume plumbing — null when disabled, full
 * struct when enabled.
 *
 * The chart writes `identity.enabled=true` AND mounts the SPIRE Agent
 * DaemonSet on every node; this helper produces the agent-pod-side
 * volume + volumeMount + env so `job-spec.ts` can splice them into
 * the spawned Job spec without conditional branches deeper in the
 * builder.
 */
export function buildIdentityVolumes(input: BuildIdentityVolumesInput): IdentityVolumes | null {
  if (!input.enabled) return null;
  const hostDir = input.hostSocketDir ?? DEFAULT_SPIRE_HOST_SOCKET_DIR;
  const podSocketPath = input.podSocketPath ?? DEFAULT_SPIRE_SOCKET_PATH;
  const lastSlash = podSocketPath.lastIndexOf('/');
  const podMountDir = lastSlash > 0 ? podSocketPath.substring(0, lastSlash) : podSocketPath;
  return {
    volume: {
      name: 'kagent-spire-socket',
      hostPath: {
        path: hostDir,
        type: 'DirectoryOrCreate',
      },
    },
    volumeMount: {
      name: 'kagent-spire-socket',
      mountPath: podMountDir,
      readOnly: true,
    },
    env: [
      { name: 'KAGENT_SPIRE_SOCKET_PATH', value: podSocketPath },
      { name: 'KAGENT_LITELLM_USE_SVID', value: 'true' },
    ],
  };
}

/**
 * `IdentityWatcher` — operator-side hook the chart wires up when
 * `identity.enabled=true`. Ships an interface + a `MockIdentityWatcher`
 * that fires synthetic events for dev clusters; the real
 * SPIRE-Workload-API-streaming implementation can land additively
 * once an integration cluster exists.
 *
 * Substrate guarantee: an issuance/rotation event is fire-and-forget
 * — `record*()` MUST NOT throw into the reconcile critical path.
 */
export interface IdentityWatcher {
  /**
   * Record an SVID issuance. Idempotent on the same `(spiffeId,
   * notBefore, notAfter)` triple; the audit publisher carries its
   * own dedupe via CloudEvents `id`.
   */
  recordIssuance(input: RecordIssuanceInput): Promise<void>;
  /**
   * Record a rotation event. Caller is responsible for tracking the
   * previous notAfter; the watcher just stamps the audit envelope.
   */
  recordRotation(input: RecordRotationInput): Promise<void>;
}

export interface RecordIssuanceInput {
  readonly taskUid: string;
  readonly taskName: string;
  readonly taskNamespace: string;
  readonly agentName: string;
  readonly spiffeId: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly source: 'spire-agent' | 'mock';
}

export interface RecordRotationInput {
  readonly spiffeId: string;
  readonly newNotBefore: Date;
  readonly newNotAfter: Date;
  readonly previousNotAfter?: Date;
  readonly source: 'spire-agent' | 'mock';
}

/**
 * Test-injection seam. Production wiring constructs a
 * `MockIdentityWatcher` against the real audit publisher in
 * `main.ts`. Tests pass a fake publisher that captures the
 * AuditEvents in a Stream-buffer.
 */
export interface IdentityWatcherDeps {
  /** Best-effort fire — must never throw. */
  readonly publish: (event: AuditEvent) => Promise<void> | void;
  /** Test-injectable clock; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Production-grade `IdentityWatcher` implementation that publishes
 * directly through the audit pipeline. Despite the "Mock" name, this
 * IS the production class for v0.4.3 — the difference between
 * "real SPIRE" and "mock" is the SOURCE of the SVID record (a real
 * SPIRE Workload-API stream vs. a synthetic boot-time fixture); both
 * paths funnel through this watcher.
 */
export class MockIdentityWatcher implements IdentityWatcher {
  private readonly publish: (event: AuditEvent) => Promise<void> | void;
  private readonly now: () => Date;

  constructor(deps: IdentityWatcherDeps) {
    this.publish = deps.publish;
    this.now = deps.now ?? ((): Date => new Date());
  }

  async recordIssuance(input: RecordIssuanceInput): Promise<void> {
    const data: IdentitySvidIssuedData = {
      taskUid: input.taskUid,
      taskNamespace: input.taskNamespace,
      taskName: input.taskName,
      agentName: input.agentName,
      spiffeId: input.spiffeId,
      notBefore: input.notBefore.toISOString(),
      notAfter: input.notAfter.toISOString(),
      source: input.source,
    };
    const event = makeEvent(
      {
        type: IDENTITY_SVID_ISSUED,
        source: 'kagent.knuteson.io/operator',
        subject: `AgentTask/${input.taskNamespace}/${input.taskName}`,
        data,
      },
      { now: this.now },
    );
    try {
      await this.publish(event);
    } catch (err) {
      console.warn('[kagent-operator/identity] recordIssuance: publish failed (best-effort):', err);
    }
  }

  async recordRotation(input: RecordRotationInput): Promise<void> {
    const previousNotAfter = input.previousNotAfter?.toISOString();
    const gapSeconds =
      input.previousNotAfter !== undefined
        ? Math.floor((input.newNotBefore.getTime() - input.previousNotAfter.getTime()) / 1000)
        : undefined;
    const data: IdentityRotationData = {
      spiffeId: input.spiffeId,
      newNotBefore: input.newNotBefore.toISOString(),
      newNotAfter: input.newNotAfter.toISOString(),
      previousNotAfter,
      gapSeconds,
      source: input.source,
    };
    const event = makeEvent(
      {
        type: IDENTITY_ROTATION,
        source: 'kagent.knuteson.io/operator',
        subject: `SVID/${input.spiffeId}`,
        data,
      },
      { now: this.now },
    );
    try {
      await this.publish(event);
    } catch (err) {
      console.warn('[kagent-operator/identity] recordRotation: publish failed (best-effort):', err);
    }
  }
}

/**
 * Read SPIRE-CA-bundle PEM bytes from the operator's mounted Secret.
 * The chart mounts `/var/kagent/spire-ca/bundle.pem` when
 * `identity.enabled=true`; absent + identity disabled, returns null.
 *
 * Used by `cap-ca.ts`'s optional secondary-trust-bundle integration
 * (the operator's cap signing CA is independent, but a
 * substrate-level audit wants to log "the SPIRE bundle the operator
 * trusts" alongside the cap CA's bundle).
 */
export function loadSpireCaBundleFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): string | null {
  if (env.KAGENT_IDENTITY_ENABLED !== 'true') return null;
  const path = env.KAGENT_SPIRE_CA_BUNDLE_FILE ?? '/var/kagent/spire-ca/bundle.pem';
  const body = readFile(path);
  if (typeof body !== 'string' || body.length === 0) return null;
  return body;
}
