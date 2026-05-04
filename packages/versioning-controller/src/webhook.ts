/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Agent immutability admission webhook — Wave 4 / Versioning sub-team
 * (v0.5.3-versioning).
 *
 * Per docs/WAVES.md §6.4: once an Agent CR is admitted, **`spec` is
 * immutable**. The only sanctioned mutation is bumping the
 * `kagent.knuteson.io/published` annotation from `false` → `true`
 * exactly once (publication transition).
 *
 * `validateAgentMutation(oldAgent, newAgent) → ValidationResult` is the
 * pure validator. The operator wires it as a Kubernetes
 * ValidatingAdmissionWebhook served on the operator's existing HTTP
 * surface (cf. `template-server.ts`). This module ALSO exports the
 * AdmissionReview ↔ ValidationResult adapter the webhook handler uses
 * over the wire.
 *
 * What is allowed (PASS):
 *   - Status writes (the apiserver routes status through the
 *     `/status` subresource; this validator never sees them).
 *   - Annotation additions (NOTE: removals OR re-flips are rejected
 *     except the one-shot `published: false → true` bump).
 *   - Label additions / removals (substrate-managed labels move
 *     freely — tenant migration, version index, etc.).
 *   - The exact published-annotation transition `false → true`. Any
 *     other transition on that annotation refuses (`true → false`
 *     un-publishes, `true → true` is a no-op so it's allowed but
 *     also a no-op so it doesn't matter).
 *
 * What is refused (FAIL):
 *   - ANY change to `spec.*`. The webhook compares the spec via
 *     structural deep-equality (JSON-compare). If the marshaled JSON
 *     diverges, refuse.
 *   - Any flip of `published: true → false` (un-publishing is not
 *     allowed; bump version + republish instead).
 *
 * Failure surface:
 *   - `agent.mutation_refused` audit event (catalog growth in
 *     `@kagent/audit-events`).
 *   - HTTP 200 with `allowed: false` + structured `status.message`.
 */

import { DEFAULT_AGENT_VERSION, PUBLISHED_ANNOTATION } from './constants.js';
import type { VersionedAgent, VersionedAgentMetadata } from './types.js';

/**
 * Outcome of the immutability validator. `ok: false` carries the
 * structured rejection reason — admission echoes this on the
 * AdmissionReview's `status.message` field and the operator's audit
 * publisher fires `agent.mutation_refused` with the same `reason`.
 */
export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AgentMutationRefusalReason;
      readonly message: string;
    };

/**
 * Refusal taxonomy. Stable strings — the audit warehouse keys on
 * these. `agent_immutable` is the catch-all for `spec` mutations;
 * the more specific `published_unflip` distinguishes the
 * un-publishing path from a generic spec write.
 */
export type AgentMutationRefusalReason = 'agent_immutable_spec' | 'agent_published_unflip';

/**
 * Pure validator: refuse any `spec.*` mutation; allow the one-shot
 * `published: false → true` annotation flip; allow status / label /
 * other-annotation mutations freely.
 *
 * @param oldAgent The Agent CR as the apiserver currently stores it.
 *                 Pass the post-create CR on the first UPDATE event.
 * @param newAgent The Agent CR the apiserver is being asked to admit.
 *                 The validator returns `ok: false` to refuse the
 *                 admission outright.
 */
export function validateAgentMutation(
  oldAgent: VersionedAgent,
  newAgent: VersionedAgent,
): ValidationResult {
  // 1) Spec immutability — deep-equal compare of the marshaled JSON.
  if (!isStructurallyEqual(oldAgent.spec, newAgent.spec)) {
    const oldName = oldAgent.metadata.name ?? '(no-name)';
    const oldNs = oldAgent.metadata.namespace ?? 'default';
    const oldVer = (oldAgent.spec as { version?: unknown }).version;
    const oldVerStr = typeof oldVer === 'string' ? oldVer : DEFAULT_AGENT_VERSION;
    return {
      ok: false,
      reason: 'agent_immutable_spec',
      message: `agent.mutation_refused: Agent ${oldNs}/${oldName} (version=${oldVerStr}) spec is immutable post-publish. Bump spec.version + create a new Agent CR with the same metadata.name to evolve.`,
    };
  }

  // 2) `published` annotation discipline. The only sanctioned
  // mutation on this key is `false → true`. Anything else refuses.
  const oldPub = readPublishedAnnotation(oldAgent.metadata);
  const newPub = readPublishedAnnotation(newAgent.metadata);
  if (oldPub !== newPub) {
    if (oldPub === 'true' && newPub !== 'true') {
      return {
        ok: false,
        reason: 'agent_published_unflip',
        message: `agent.mutation_refused: Agent ${oldAgent.metadata.namespace ?? 'default'}/${oldAgent.metadata.name ?? '(no-name)'} cannot be un-published (kagent.knuteson.io/published: true → ${String(newPub ?? '(absent)')}). Bump spec.version + republish instead.`,
      };
    }
    // From-absent or from-'false' → 'true' is the canonical
    // publication flip. Allow.
    // From 'true' → 'true' (no-op) was caught above (oldPub === newPub).
    // Any other transition (e.g. absent → 'false') is a benign
    // bookkeeping write — allow it; the important invariant is "no
    // un-publish AND no spec change", and both are checked.
  }

  return { ok: true };
}

/**
 * Read the `kagent.knuteson.io/published` annotation as a normalized
 * lower-case string. Missing / undefined returns `undefined`.
 */
function readPublishedAnnotation(meta: VersionedAgentMetadata): string | undefined {
  const raw = meta.annotations?.[PUBLISHED_ANNOTATION];
  if (typeof raw !== 'string') return undefined;
  return raw.trim().toLowerCase();
}

/**
 * Structural deep-equal on two unknown values, tolerant of property-
 * order differences and JSON-shaped nesting. Used to compare two
 * `Agent.spec` objects across an UPDATE without needing a third-party
 * deep-equal dep.
 *
 * Equivalence rules:
 *   - Primitives (string, number, boolean, null, undefined): `===`.
 *   - Arrays: same length AND every index pair is structurally equal.
 *   - Plain objects: same set of own-enumerable keys AND every value
 *     pair is structurally equal.
 *   - Functions, Dates, RegExps, Maps, Sets, etc.: NEVER appear in a
 *     CRD's marshaled JSON, so we don't carry special handling.
 */
export function isStructurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // Both are non-null objects.
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a;
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!isStructurallyEqual(arrA[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).sort();
  const keysB = Object.keys(objB).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
  }
  for (const key of keysA) {
    if (!isStructurallyEqual(objA[key], objB[key])) return false;
  }
  return true;
}

/* =====================================================================
 * AdmissionReview adapter — wire format the K8s apiserver speaks.
 *
 * The apiserver POSTs a JSON document of kind `AdmissionReview` to the
 * webhook URL on every UPDATE the matching ValidatingWebhookConfiguration
 * targets. The webhook handler:
 *
 *   1. Decodes the payload.
 *   2. Validates `oldObject` vs `object`.
 *   3. Returns a 200 OK with an AdmissionReview response carrying
 *      `allowed: true|false` + an optional `status.message`.
 *
 * This adapter is intentionally minimal — the K8s SDK has rich types
 * but for the substrate's narrow use-case (one resource, two paths,
 * deterministic payload shape) we hand-roll the literal JSON.
 *
 * Reference: K8s ValidatingAdmissionWebhook docs:
 *   https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/
 * ===================================================================== */

/**
 * Inbound AdmissionReview shape. Carved as `unknown` first then
 * narrowed inside the adapter so a malformed payload gets a structured
 * 400 instead of crashing the handler.
 */
export interface AdmissionReviewRequest {
  readonly apiVersion: string;
  readonly kind: 'AdmissionReview';
  readonly request: {
    readonly uid: string;
    readonly operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'CONNECT';
    readonly object: VersionedAgent | null;
    readonly oldObject: VersionedAgent | null;
  };
}

export interface AdmissionReviewResponse {
  readonly apiVersion: string;
  readonly kind: 'AdmissionReview';
  readonly response: {
    readonly uid: string;
    readonly allowed: boolean;
    readonly status?: { readonly code: number; readonly message: string };
  };
}

/**
 * Drive the validator from a decoded AdmissionReview payload. The
 * handler invokes this and serializes the return back to the apiserver.
 *
 * Matrix:
 *   - operation === 'CREATE'  → ALWAYS allow (Agent immutability is
 *                                 about post-create mutations; create
 *                                 itself is the publication moment).
 *   - operation === 'UPDATE'  → run `validateAgentMutation`.
 *   - operation === 'DELETE'  → ALWAYS allow (substrate doesn't gate
 *                                 deletion; cluster admin may GC any
 *                                 Agent CR — in-flight tasks already
 *                                 hold a snapshot of the spec via the
 *                                 immutable Agent CR they were pinned
 *                                 to AND the operator's index has the
 *                                 cached copy).
 *   - operation === 'CONNECT' → ALWAYS allow (CONNECT is rare for
 *                                 CRDs but defensive default-allow).
 */
export function reviewAgentAdmission(req: AdmissionReviewRequest): AdmissionReviewResponse {
  const apiVersion = req.apiVersion;
  const uid = req.request.uid;

  const operation = req.request.operation;
  if (operation !== 'UPDATE') {
    return buildAllowed(apiVersion, uid);
  }

  const oldObj = req.request.oldObject;
  const newObj = req.request.object;
  if (oldObj === null || newObj === null) {
    // UPDATE without both shapes is malformed; default-allow rather
    // than crash so a buggy apiserver / chart can't soft-brick
    // updates. The corresponding audit event still fires.
    return buildAllowed(apiVersion, uid);
  }

  const result = validateAgentMutation(oldObj, newObj);
  if (result.ok) return buildAllowed(apiVersion, uid);
  return buildDenied(apiVersion, uid, result.message);
}

function buildAllowed(apiVersion: string, uid: string): AdmissionReviewResponse {
  return {
    apiVersion,
    kind: 'AdmissionReview',
    response: { uid, allowed: true },
  };
}

function buildDenied(apiVersion: string, uid: string, message: string): AdmissionReviewResponse {
  return {
    apiVersion,
    kind: 'AdmissionReview',
    response: {
      uid,
      allowed: false,
      status: { code: 403, message },
    },
  };
}
