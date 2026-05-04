/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tenant controller — Wave 4 / Tenancy sub-team (v0.5.0-tenancy).
 *
 * Reconciles `kagent.knuteson.io/v1alpha1` `Tenant` CRs:
 *
 *   1. Validate `spec.name == metadata.name` (defensive — admission's
 *      first job).
 *   2. Detect namespace overlap with another Tenant CR (substrate
 *      forbids two tenants claiming the same namespace).
 *   3. Walk the cluster's Agent + AgentTask informer caches (label-
 *      filtered to this tenant) and refresh:
 *        - `status.namespaceCount` (number of allowlisted namespaces
 *          that actually exist)
 *        - `status.agentCount` (Agents labeled with this tenant)
 *        - `status.activeTaskCount` (non-terminal AgentTasks labeled
 *          with this tenant)
 *   4. Set `status.phase`:
 *        - `Failed`  if namespace-overlap or name-mismatch
 *        - `Ready`   if at least one allowlisted namespace exists
 *        - `Pending` otherwise
 *   5. Emit conditions for each transition.
 *   6. Emit `tenant.created` / `tenant.updated` / `tenant.deleted`
 *      audit events.
 *
 * Per docs/SUBSTRATE-V1.md §3.6 + docs/WAVES.md §6.1 deliverable 7.
 *
 * The reconciler is dependency-injected so tests can drive it without
 * a KubeConfig. The main.ts wiring under
 * `// === Wave 4 — Tenancy ===` constructs the informer triplet
 * (Tenant + label-selected Agent + label-selected AgentTask).
 */

import {
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type ObjectCache,
  type V1Namespace,
  makeInformer,
} from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  TENANT_LABEL,
  isTenant,
  type Agent,
  type AgentTask,
  type Tenant,
  type TenantCondition,
  type TenantPhase,
  type TenantStatus,
} from './crds/index.js';
import { mergePatchOptions } from './k8s.js';

const PLURAL = 'tenants' as const;

/* =====================================================================
 * Reconciler dependencies — injected so tests don't need KubeConfig.
 * ===================================================================== */

/**
 * Iterate all known Tenants. Used for overlap detection (cluster-
 * scoped scan). Production: informer cache snapshot.
 */
export type ListTenantsFn = () => readonly Tenant[];

/**
 * Iterate Agents labeled with the given tenant name. Production:
 * informer cache snapshot filtered by `metadata.labels[TENANT_LABEL]`.
 */
export type ListAgentsForTenantFn = (tenantName: string) => readonly Agent[];

/**
 * Iterate non-terminal AgentTasks labeled with the given tenant name.
 * "Non-terminal" = phase ∉ {Completed, Failed}. Production: informer
 * cache snapshot.
 */
export type ListActiveTasksForTenantFn = (tenantName: string) => readonly AgentTask[];

/**
 * Lookup whether a namespace exists in the cluster. Production: K8s
 * Namespace informer or coreApi GET. Tests pass a Set-backed lookup.
 */
export type NamespaceExistsFn = (namespace: string) => boolean;

/** Audit-emission hook — best-effort; failures are logged + swallowed. */
export interface TenantAuditHooks {
  readonly onCreated?: (data: TenantLifecycleEmissionData) => Promise<void>;
  readonly onUpdated?: (data: TenantLifecycleEmissionData) => Promise<void>;
  readonly onDeleted?: (data: TenantLifecycleEmissionData) => Promise<void>;
}

/**
 * Lifecycle event payload — same shape as
 * `@kagent/audit-events`'s `TenantLifecycleData`. Kept structurally-
 * compatible (the controller doesn't import the audit-events package
 * directly to keep the test surface light; main.ts adapter bridges).
 */
export interface TenantLifecycleEmissionData {
  readonly tenant: string;
  readonly namespaceAllowlist: readonly string[];
  readonly namespaceCount: number;
  readonly agentCount: number;
  readonly activeTaskCount: number;
  readonly tenantUid: string | undefined;
  readonly phase: TenantPhase;
}

export interface TenantReconcilerDeps {
  readonly customApi: CustomObjectsApi;
  readonly listTenants: ListTenantsFn;
  readonly listAgentsForTenant: ListAgentsForTenantFn;
  readonly listActiveTasksForTenant: ListActiveTasksForTenantFn;
  readonly namespaceExists: NamespaceExistsFn;
  readonly audit?: TenantAuditHooks;
  /** `() => new Date()` injection seam. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/* =====================================================================
 * Pure helpers — testable in isolation.
 * ===================================================================== */

/**
 * Detect namespace overlap with other Tenants. Returns the list of
 * (otherTenantName, overlappingNamespace) pairs. Empty array = no
 * overlap.
 *
 * Self-overlap is ignored (`other.spec.name === ours.spec.name`
 * skips). Pure: takes the candidate Tenant + the full list of known
 * Tenants.
 */
export interface NamespaceOverlap {
  readonly otherTenant: string;
  readonly namespace: string;
}

export function detectNamespaceOverlap(
  ours: Tenant,
  all: readonly Tenant[],
): readonly NamespaceOverlap[] {
  const out: NamespaceOverlap[] = [];
  const ourNs = new Set(ours.spec.namespaceAllowlist);
  for (const other of all) {
    if (other.spec.name === ours.spec.name) continue;
    for (const ns of other.spec.namespaceAllowlist) {
      if (ourNs.has(ns)) out.push({ otherTenant: other.spec.name, namespace: ns });
    }
  }
  return out;
}

/**
 * Compute the tenant's desired phase from observable state. Pure.
 *
 *   - `spec.name !== metadata.name`        → Failed (`NameMismatch`)
 *   - namespace overlap detected           → Failed (`NamespaceOverlap`)
 *   - at least one allowlisted ns exists    → Ready
 *   - otherwise                             → Pending
 */
export interface ComputePhaseInput {
  readonly tenant: Tenant;
  readonly namespaceCount: number;
  readonly overlaps: readonly NamespaceOverlap[];
}

export function computeTenantPhase(input: ComputePhaseInput): TenantPhase {
  const { tenant, namespaceCount, overlaps } = input;
  if (typeof tenant.metadata.name === 'string' && tenant.metadata.name !== tenant.spec.name) {
    return 'Failed';
  }
  if (overlaps.length > 0) return 'Failed';
  if (namespaceCount >= 1) return 'Ready';
  return 'Pending';
}

/** Append-or-replace a condition by `type` (mirrors workspace-controller). */
export function mergeTenantCondition(
  existing: readonly TenantCondition[] | undefined,
  next: TenantCondition,
): readonly TenantCondition[] {
  const list = existing ?? [];
  const out: TenantCondition[] = [];
  let replaced = false;
  for (const c of list) {
    if (c.type === next.type) {
      replaced = true;
      if (c.status === next.status && c.reason === next.reason && c.message === next.message) {
        out.push(c);
      } else {
        out.push(next);
      }
    } else {
      out.push(c);
    }
  }
  if (!replaced) out.push(next);
  return out;
}

/**
 * Compute the conditions list for a tenant's status from observable
 * state. Pure: doesn't mutate or read external state.
 */
export function computeTenantConditions(
  input: ComputePhaseInput,
  now: () => Date,
): readonly TenantCondition[] {
  const ts = now().toISOString();
  const out: TenantCondition[] = [];
  const { tenant, namespaceCount, overlaps } = input;
  out.push({
    type: 'NamespaceAllowlistResolved',
    status: namespaceCount >= 1 ? 'True' : 'False',
    lastTransitionTime: ts,
    ...(namespaceCount === 0 && {
      reason: 'NoExistingNamespace',
      message: `None of the allowlisted namespaces exist in the cluster (${tenant.spec.namespaceAllowlist.join(', ')})`,
    }),
  });
  if (overlaps.length > 0) {
    const summary = overlaps
      .map((o) => `${o.namespace} (also claimed by ${o.otherTenant})`)
      .join('; ');
    out.push({
      type: 'NamespaceOverlap',
      status: 'True',
      reason: 'OverlappingAllowlist',
      message: `substrate forbids two tenants claiming the same namespace: ${summary}`,
      lastTransitionTime: ts,
    });
  }
  if (typeof tenant.metadata.name === 'string' && tenant.metadata.name !== tenant.spec.name) {
    out.push({
      type: 'NameMismatch',
      status: 'True',
      reason: 'SpecMetadataMismatch',
      message: `spec.name="${tenant.spec.name}" does not equal metadata.name="${tenant.metadata.name}"`,
      lastTransitionTime: ts,
    });
  }
  return out;
}

/* =====================================================================
 * Reconciler — composes pure helpers with the K8s status patch + audit
 * emission. Idempotent on every call.
 * ===================================================================== */

export type ReconcileTenantAction =
  | { readonly kind: 'noop'; readonly reason: string }
  | { readonly kind: 'status-patched'; readonly phase: TenantPhase }
  | { readonly kind: 'deletion-observed'; readonly tenantName: string };

export async function reconcileTenant(
  tenant: Tenant,
  deps: TenantReconcilerDeps,
): Promise<ReconcileTenantAction> {
  const now = deps.now ?? (() => new Date());
  const tenantName = tenant.spec.name;

  // Deletion path — no finalizer in v0.5.0 (Tenant CRs don't own
  // child resources directly; downstream consumers re-resolve on
  // their own reconcile loops). Just emit the deletion event.
  if (
    tenant.metadata.deletionTimestamp !== undefined &&
    tenant.metadata.deletionTimestamp !== null
  ) {
    if (deps.audit?.onDeleted !== undefined) {
      await safeEmitAudit(
        () =>
          deps.audit!.onDeleted!({
            tenant: tenantName,
            namespaceAllowlist: tenant.spec.namespaceAllowlist,
            namespaceCount: tenant.status?.namespaceCount ?? 0,
            agentCount: tenant.status?.agentCount ?? 0,
            activeTaskCount: tenant.status?.activeTaskCount ?? 0,
            tenantUid: tenant.metadata.uid,
            phase: tenant.status?.phase ?? 'Pending',
          }),
        'onDeleted',
      );
    }
    return { kind: 'deletion-observed', tenantName };
  }

  // Compute observable state.
  const allTenants = deps.listTenants();
  const overlaps = detectNamespaceOverlap(tenant, allTenants);
  let namespaceCount = 0;
  for (const ns of tenant.spec.namespaceAllowlist) {
    if (deps.namespaceExists(ns)) namespaceCount++;
  }
  const agents = deps.listAgentsForTenant(tenantName);
  const activeTasks = deps.listActiveTasksForTenant(tenantName);
  const agentCount = agents.length;
  const activeTaskCount = activeTasks.length;

  const phase = computeTenantPhase({ tenant, namespaceCount, overlaps });
  const conditions = computeTenantConditions({ tenant, namespaceCount, overlaps }, now);

  // Build the status patch. Use the existing observed state to detect
  // a transition for audit-event emission.
  const previousPhase = tenant.status?.phase;
  const desiredStatus: TenantStatus = {
    phase,
    namespaceCount,
    agentCount,
    activeTaskCount,
    conditions,
    ...(typeof tenant.metadata.generation === 'number' && {
      observedGeneration: tenant.metadata.generation,
    }),
  };

  await patchTenantStatus(tenant, desiredStatus, deps);

  // Audit emission — onCreated for first reconcile (no previousPhase
  // means first-sight); onUpdated for any subsequent reconcile.
  if (deps.audit !== undefined) {
    const data: TenantLifecycleEmissionData = {
      tenant: tenantName,
      namespaceAllowlist: tenant.spec.namespaceAllowlist,
      namespaceCount,
      agentCount,
      activeTaskCount,
      tenantUid: tenant.metadata.uid,
      phase,
    };
    if (previousPhase === undefined) {
      if (deps.audit.onCreated !== undefined) {
        await safeEmitAudit(() => deps.audit!.onCreated!(data), 'onCreated');
      }
    } else if (deps.audit.onUpdated !== undefined) {
      await safeEmitAudit(() => deps.audit!.onUpdated!(data), 'onUpdated');
    }
  }

  return { kind: 'status-patched', phase };
}

async function patchTenantStatus(
  tenant: Tenant,
  status: TenantStatus,
  deps: TenantReconcilerDeps,
): Promise<void> {
  const name = tenant.metadata.name ?? tenant.spec.name;
  try {
    // Tenants are cluster-scoped — use the cluster-level patcher.
    await deps.customApi.patchClusterCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        plural: PLURAL,
        name,
        body: { status } as object,
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.warn(`[kagent-tenant] status patch failed for ${name}:`, err);
  }
}

async function safeEmitAudit(fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[kagent-tenant] audit hook ${label} raised (dropping):`, err);
  }
}

/* =====================================================================
 * Wiring — informer + reconciler binding for the operator's main.ts.
 * Tests can ignore this and drive `reconcileTenant` directly.
 * ===================================================================== */

export interface BuildTenantControllerInput {
  readonly kc: KubeConfig;
  readonly customApi: CustomObjectsApi;
  /** Lookup callback for namespace existence. */
  readonly namespaceExists: NamespaceExistsFn;
  /** Cluster-wide Agent informer cache snapshot reader. */
  readonly listAllAgents: () => readonly Agent[];
  /** Cluster-wide AgentTask informer cache snapshot reader. */
  readonly listAllAgentTasks: () => readonly AgentTask[];
  readonly audit?: TenantAuditHooks;
}

export interface TenantControllerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Lookup callback the cap-issuer + admission validator consume. */
  readonly lookupTenant: (name: string) => Tenant | undefined;
  /** List-all callback for the cluster snapshot. */
  readonly listAllTenants: () => readonly Tenant[];
}

export function buildTenantController(input: BuildTenantControllerInput): TenantControllerHandle {
  const { kc, customApi, namespaceExists, listAllAgents, listAllAgentTasks, audit } = input;

  // Cluster-scoped Tenant informer.
  const tenantListFn = async (): Promise<KubernetesListObject<Tenant>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: PLURAL,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<Tenant>;
  };
  const tenantWatchPath = `/apis/${API_GROUP}/${API_VERSION}/${PLURAL}`;
  const tenantInformer: Informer<Tenant> & ObjectCache<Tenant> = makeInformer<Tenant>(
    kc,
    tenantWatchPath,
    tenantListFn,
  );

  const lookupTenant = (name: string): Tenant | undefined => {
    // Cluster-scoped: no namespace param. Walk cache list since
    // cache.get may need (name, namespace).
    for (const t of tenantInformer.list()) {
      if (t.spec.name === name) return t;
      if (t.metadata.name === name) return t;
    }
    return undefined;
  };

  const listAllTenants = (): readonly Tenant[] => tenantInformer.list();

  const listAgentsForTenant = (tenantName: string): readonly Agent[] => {
    const out: Agent[] = [];
    for (const a of listAllAgents()) {
      if (a.metadata.labels?.[TENANT_LABEL] === tenantName) out.push(a);
    }
    return out;
  };

  const listActiveTasksForTenant = (tenantName: string): readonly AgentTask[] => {
    const out: AgentTask[] = [];
    for (const t of listAllAgentTasks()) {
      if (t.metadata.labels?.[TENANT_LABEL] !== tenantName) continue;
      const phase = t.status?.phase;
      if (phase === 'Completed' || phase === 'Failed') continue;
      out.push(t);
    }
    return out;
  };

  const deps: TenantReconcilerDeps = {
    customApi,
    listTenants: listAllTenants,
    listAgentsForTenant,
    listActiveTasksForTenant,
    namespaceExists,
    ...(audit !== undefined && { audit }),
  };

  const fire = (obj: unknown): void => {
    if (!isTenant(obj)) return;
    void reconcileTenant(obj, deps).catch((err: unknown) => {
      console.error(`[kagent-tenant] reconcile failed for ${obj.spec.name}:`, err);
    });
  };

  tenantInformer.on('add', fire);
  tenantInformer.on('update', fire);
  tenantInformer.on('delete', fire);
  tenantInformer.on('error', (err) => {
    console.error('[kagent-tenant] Tenant watch error:', err);
    setTimeout(() => {
      void tenantInformer.start();
    }, 5000);
  });

  return {
    async start(): Promise<void> {
      await tenantInformer.start();
    },
    async stop(): Promise<void> {
      try {
        await tenantInformer.stop();
      } catch (err) {
        console.error('[kagent-tenant] Tenant informer stop failed:', err);
      }
    },
    lookupTenant,
    listAllTenants,
  };
}

/**
 * Build a sync namespace-existence predicate from the K8s Namespace
 * informer cache. Production wiring; tests pass a Set-backed inline
 * function. Exported so main.ts can compose it without re-implementing.
 */
export function buildNamespaceExistsFromInformer(
  informer: ObjectCache<V1Namespace>,
): NamespaceExistsFn {
  return (namespace: string) => {
    if (typeof namespace !== 'string' || namespace.length === 0) return false;
    // K8s Namespace API: cluster-scoped resource → cache.get(name, '').
    const ns = informer.get(namespace, '');
    return ns !== undefined;
  };
}
