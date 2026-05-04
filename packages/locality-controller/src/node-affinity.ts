/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wave 3 / Locality sub-team — `deriveNodeAffinity`.
 *
 * Pure helper that translates an Agent + AgentTask + workspace lookup
 * into a Kubernetes `V1Affinity` value (or `undefined` when no
 * affinity is warranted). The operator splices the result onto the
 * spawned-Job pod spec from the reconciler — never inside
 * `buildJobSpec` itself (additive, no refactor; coordination per
 * docs/WAVES.md §5.5).
 *
 * The whole point: when an Agent declares a `kind: 'workspace'` input
 * and the bound Workspace's PVC is backed by a node-pinned PV, schedule
 * the agent-pod onto the node that has the volume locally — turning a
 * cross-node ReadWriteMany / NFS hop into a local read-write filesystem
 * call (single-digit-millisecond p99 vs. 50-150ms over the network).
 *
 * Algorithm:
 *
 *   1. Walk the Agent's `inputs[]`, keep only `kind: 'workspace'`
 *      declarations whose name is bound by the AgentTask via
 *      `from.workspace`.
 *   2. For each binding, resolve via the injected `workspaceLookup`:
 *      - the Workspace CR (for `status.bytesUsed` tie-break)
 *      - the bound PV's `spec.nodeAffinity` (the source of node-pin truth)
 *   3. Pick the candidate with the largest `bytesUsed` (deterministic
 *      tie-break — the agent-pod's hot path benefits more from
 *      co-location with the largest workspace; smaller workspaces fit
 *      in page cache after the first read).
 *   4. Emit `requiredDuringSchedulingIgnoredDuringExecution` mirroring
 *      the PV's `nodeAffinity.required.nodeSelectorTerms[]`. The PV
 *      already encodes the node grammar (matchExpressions /
 *      matchFields); the helper forwards it verbatim so a CSI plugin
 *      that pins via `kubernetes.io/hostname` and one that pins via
 *      a per-driver topology key both work without per-driver code.
 *
 * Why `required` vs `preferred`: the brief mandates
 * `requiredDuringSchedulingIgnoredDuringExecution`. Rationale: if the
 * pod ends up on the wrong node, the RWX mount degrades to a
 * cross-node mount and the whole optimization evaporates — at which
 * point the user's task ALSO blows past its latency SLO. Hard-required
 * with a clear `Unschedulable` event surfaces the misconfiguration
 * loudly; soft-preferred quietly degrades performance. We pick loud.
 *
 * Failure modes — all return `undefined` (caller falls through to
 * default scheduling):
 *
 *   - No workspace input bindings on the Agent
 *   - Workspace not yet Ready (`status.pvcName` unset)
 *   - PV not bound or PV's `nodeAffinity` absent
 *   - PV's `nodeAffinity.required.nodeSelectorTerms[]` empty
 *
 * The helper has zero dependencies on the operator's reconciler — it's
 * a pure shape-transform. Tests use plain object literals against the
 * `WorkspaceLookup` injection seam.
 */

import type {
  V1Affinity,
  V1NodeSelectorTerm,
  V1PersistentVolume,
  V1PersistentVolumeClaim,
} from '@kubernetes/client-node';

import type { AffinityAgent, AffinityTask, Workspace } from './types.js';

/* =====================================================================
 * Public types
 * ===================================================================== */

/**
 * Resolver that the operator wires from informer caches. Receives the
 * Workspace name (and namespace) and returns the resolved trio:
 *
 *   - the Workspace CR (for `status.bytesUsed`)
 *   - the bound PVC (for `spec.volumeName`)
 *   - the bound PV (for `spec.nodeAffinity`)
 *
 * Returning `undefined` for any field SKIPS that workspace as a
 * candidate. The lookup is sync because the operator's informer caches
 * are sync; tests inject a plain `(name, ns) => { ... }`.
 */
export interface WorkspaceLookup {
  /** Look up the Workspace CR by name + namespace. */
  readonly workspace: (name: string, namespace: string) => Workspace | undefined;
  /** Look up the PVC by name + namespace. */
  readonly pvc: (name: string, namespace: string) => V1PersistentVolumeClaim | undefined;
  /** Look up the PV by name (cluster-scoped). */
  readonly pv: (name: string) => V1PersistentVolume | undefined;
}

/**
 * Internal — one resolved candidate row. Tracked so the tie-break
 * comparator has the bytesUsed + node selector terms in one struct.
 */
interface Candidate {
  readonly workspaceName: string;
  readonly bytesUsed: number;
  readonly nodeSelectorTerms: readonly V1NodeSelectorTerm[];
}

/* =====================================================================
 * deriveNodeAffinity
 * ===================================================================== */

/**
 * Derive the V1Affinity to splice onto a spawned Job's pod spec, or
 * return undefined when no co-location is warranted.
 *
 * @param agent  Resolved Agent CR for the AgentTask (post capability
 *               resolution).
 * @param task   AgentTask with `spec.inputs[]` bindings.
 * @param lookup Sync lookup pair (Workspace CR + PVC + PV) backed by
 *               the operator's informer caches.
 */
export function deriveNodeAffinity(
  agent: AffinityAgent,
  task: AffinityTask,
  lookup: WorkspaceLookup,
): V1Affinity | undefined {
  const namespace = task.metadata.namespace ?? 'default';
  const declaredInputs = agent.spec.inputs ?? [];
  const bindings = task.spec.inputs ?? [];
  if (declaredInputs.length === 0 || bindings.length === 0) return undefined;

  // Index AgentTask bindings by name → from-discriminant. We only care
  // about workspace-typed inputs whose binding names a workspace.
  const bindingByName = new Map<string, string>();
  for (const b of bindings) {
    if (typeof b.name !== 'string' || b.name.length === 0) continue;
    const from = b.from;
    if (typeof from !== 'object' || from === null) continue;
    const wsName = (from as { workspace?: unknown }).workspace;
    if (typeof wsName !== 'string' || wsName.length === 0) continue;
    bindingByName.set(b.name, wsName);
  }
  if (bindingByName.size === 0) return undefined;

  const candidates: Candidate[] = [];
  for (const decl of declaredInputs) {
    if (decl.kind !== 'workspace') continue;
    if (typeof decl.name !== 'string' || decl.name.length === 0) continue;
    const wsName = bindingByName.get(decl.name);
    if (wsName === undefined) continue;

    const ws = lookup.workspace(wsName, namespace);
    if (ws === undefined) continue;
    const pvcName = ws.status?.pvcName;
    if (typeof pvcName !== 'string' || pvcName.length === 0) continue;

    const pvc = lookup.pvc(pvcName, namespace);
    if (pvc === undefined) continue;
    const pvName = pvc.spec?.volumeName;
    if (typeof pvName !== 'string' || pvName.length === 0) continue;

    const pv = lookup.pv(pvName);
    if (pv === undefined) continue;
    const terms = pv.spec?.nodeAffinity?.required?.nodeSelectorTerms;
    if (!Array.isArray(terms) || terms.length === 0) continue;

    // Defensive: a node selector term with neither matchExpressions nor
    // matchFields is the K8s "match nothing" sentinel — skip so we
    // don't accidentally make the pod unschedulable. The pod's affinity
    // would otherwise stamp the empty term verbatim and K8s would
    // refuse to schedule it.
    const usable = terms.filter(
      (t) =>
        (Array.isArray(t.matchExpressions) && t.matchExpressions.length > 0) ||
        (Array.isArray(t.matchFields) && t.matchFields.length > 0),
    );
    if (usable.length === 0) continue;

    candidates.push({
      workspaceName: wsName,
      bytesUsed: typeof ws.status?.bytesUsed === 'number' ? ws.status.bytesUsed : 0,
      nodeSelectorTerms: usable,
    });
  }

  if (candidates.length === 0) return undefined;

  // Tie-break: largest workspace by bytesUsed wins. On exact tie
  // (e.g. both unset → both 0), the binding that came earlier in the
  // Agent's `inputs[]` order wins (stable sort) — gives operators a
  // deterministic knob via input order.
  const winner = candidates.reduce((best, c) => (c.bytesUsed > best.bytesUsed ? c : best));

  return {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        // Forward — the PV's terms already encode the node's
        // identity (hostname, region, zone, per-driver topology keys).
        // We deep-copy (spread + map + values-array clone) so callers
        // can't mutate the lookup cache through the returned value.
        nodeSelectorTerms: winner.nodeSelectorTerms.map((t) => ({
          ...(Array.isArray(t.matchExpressions) && {
            matchExpressions: t.matchExpressions.map((e) => ({
              ...e,
              ...(Array.isArray(e.values) && { values: [...e.values] }),
            })),
          }),
          ...(Array.isArray(t.matchFields) && {
            matchFields: t.matchFields.map((e) => ({
              ...e,
              ...(Array.isArray(e.values) && { values: [...e.values] }),
            })),
          }),
        })),
      },
    },
  };
}
