/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Minimal Agent shape the versioning-controller cares about. Carved
 * here (rather than re-importing from `@kagent/operator`) so this
 * package stays a pure library that the operator depends on, not the
 * reverse. The operator's `Agent` type is structurally compatible —
 * pass it through wherever this module accepts a `VersionedAgent`.
 *
 * Order-of-fields mirrors the operator's `crds/types.ts` to keep
 * mental-mapping easy when reading both files side by side.
 */

/**
 * Subset of `metadata.annotations` the immutability + lifecycle path
 * inspects. Standard K8s annotations are arbitrary string→string maps;
 * this index narrows to the keys substrate-relevant.
 */
export interface VersionedAgentAnnotations {
  readonly [key: string]: string | undefined;
}

/**
 * Subset of K8s `ObjectMeta` the validator + index require. Trimmed
 * to insulate the package from `@kubernetes/client-node` types.
 */
export interface VersionedAgentMetadata {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly generation?: number;
  readonly resourceVersion?: string;
  readonly annotations?: VersionedAgentAnnotations;
  readonly labels?: { readonly [key: string]: string | undefined };
}

/**
 * Subset of `Agent.spec` fields the validator inspects. The webhook's
 * "no spec change" rule operates on the WHOLE spec object — comparing
 * the entire JSON representation — so this type is intentionally
 * `unknown` and the validator does a structural-equality compare
 * rather than enumerate every field. Using `unknown` (rather than
 * `Readonly<Record<string, unknown>>`) lets a strict `AgentSpec`
 * interface from the operator pass through without coercion.
 */
export type VersionedAgentSpec = unknown;

/**
 * Minimal Agent CR shape consumed by the immutability validator + the
 * version index. `spec` is `unknown` so the operator's strict
 * `AgentSpec` interface is structurally compatible without a cast.
 */
export interface VersionedAgent {
  readonly apiVersion?: string;
  readonly kind?: string;
  readonly metadata: VersionedAgentMetadata;
  readonly spec: VersionedAgentSpec;
}
