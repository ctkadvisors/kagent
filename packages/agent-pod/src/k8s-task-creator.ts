/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-pod K8s client for the WS-K spawn_child_task tool. The agent pod
 * already has a ServiceAccount token mounted at the standard SA path
 * (/var/run/secrets/kubernetes.io/serviceaccount/token); this module
 * uses `KubeConfig.loadFromCluster()` to pick it up.
 *
 * Two narrow operations:
 *   - createChildTask: POST a child AgentTask CR with parent UID labels
 *     + ownerRef wired so WS-I's parent-reconcile picks it up.
 *   - listLiveChildren: list children of THIS task that are in
 *     non-terminal phases — used by the spawn tool's
 *     concurrent-children-cap guardrail and by WS-L's
 *     wait_for_children_all polling loop.
 *
 * Kept as a separate module from `builtin-tools-spawn.ts` so:
 *   - the K8s client construction can be test-injected without
 *     mocking @kubernetes/client-node directly,
 *   - the spawn tool stays a pure validator-then-delegate function,
 *     trivially unit-testable against a fake K8sTaskCreator.
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

/**
 * Local mirror of `@kagent/dto`'s `AgentTaskPhase`. Kept inline so
 * agent-pod stays a leaf in the workspace dep graph (no @kagent
 * cross-package imports) — same pattern as `AgentSpecEnv` /
 * `TaskSpecEnv` in `env.ts`. Promote to a shared types pkg the moment
 * a third copy appears.
 */
export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTTASK_PLURAL = 'agenttasks';
const AGENT_PLURAL = 'agents';

/** Label key the operator's WS-I reconcile uses to find children. */
export const PARENT_TASK_UID_LABEL = 'kagent.knuteson.io/parent-task-uid';

/**
 * Label the operator's WS-M template-instantiator stamps on every
 * Agent it materializes (`template-instantiator.ts:216`). The spawn
 * tool's v0.1.3 `allowedChildTemplates` check matches against this
 * label to admit content-addressed Agent names without enumerating
 * them in `allowedChildAgents`.
 */
export const FROM_TEMPLATE_LABEL = 'kagent.knuteson.io/from-template';

/**
 * v0.1.9 — task-depth label. Local mirror of the operator's canonical
 * `TASK_DEPTH_LABEL` constant in `packages/operator/src/job-spec.ts`.
 * Kept inline so agent-pod stays a leaf in the workspace dep graph
 * (no `@kagent/operator` cross-package import). Single source of truth
 * is the string literal — both packages reference exactly
 * `'kagent.knuteson.io/task-depth'`.
 */
export const TASK_DEPTH_LABEL = 'kagent.knuteson.io/task-depth';

/**
 * v0.4.1-blackboard — Wave 3 / Blackboard sub-team. Local mirror of
 * the operator's canonical `ROOT_TASK_UID_LABEL` constant in
 * `packages/operator/src/job-spec.ts`. Stamped on every spawned
 * child so the operator's job-spec render path can derive the
 * `KAGENT_BLACKBOARD_BUCKET` env without walking the parent chain.
 * For the parent's own (root-uid lookup): if the parent itself
 * carries this label, the value is the root UID; otherwise the
 * parent IS the root and its UID is the root UID.
 */
export const ROOT_TASK_UID_LABEL = 'kagent.knuteson.io/root-task-uid';

/** Parent identity threaded into child manifests. */
export interface ParentIdentity {
  readonly uid: string;
  readonly name: string;
  readonly namespace: string;
  /**
   * v0.1.9 — parent's depth in the spawn tree (root = 0). Sourced from
   * `PodConfig.taskDepth` in main.ts. Used by `createChildTask` to
   * stamp `kagent.knuteson.io/task-depth=<parent.depth + 1>` on the
   * child's metadata.labels — that label is what the operator reads
   * when building the child's spawned Job env (KAGENT_TASK_DEPTH) and
   * what the admission path uses to enforce the cluster cap. Optional
   * (defaults to 0 = treat parent as root) so test fixtures + early
   * callers don't have to thread depth through every path.
   */
  readonly depth?: number;
  /**
   * v0.4.1-blackboard — Wave 3 Blackboard sub-team. The parent's
   * resolved root-task UID. When the parent IS the root, this equals
   * the parent UID; for grandchildren+ the parent inherits its own
   * parent's value. The agent-pod's main.ts derives this from
   * `PodConfig.rootTaskUid` (env-stamped by the operator's job-spec
   * render path). Optional in the type so test fixtures can omit;
   * production wiring always supplies it.
   */
  readonly rootUid?: string;
}

export interface ChildTaskInput {
  readonly name: string;
  readonly targetAgent: string;
  readonly originalUserMessage: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
    /**
     * v0.1.11 — W3C Trace Context propagation. When set, the operator's
     * job-spec builder threads this verbatim into the spawned Job's
     * `OTEL_TRACEPARENT` env so the child agent-pod's main.ts can seed
     * its OtelTraceSink root span context with the parent's span — the
     * child's trace tree becomes a child of the parent's, not a sibling.
     *
     * Format: literal W3C v00 traceparent header value
     * (`00-<32hex traceId>-<16hex spanId>-<2hex flags>`). The CRD
     * admission schema enforces the shape upstream of this code, so the
     * stamping side can pass the value through verbatim.
     */
    readonly traceparent?: string;
  };
  readonly payload?: unknown;
}

export interface ChildTaskCreated {
  readonly name: string;
  readonly namespace: string;
  readonly uid: string;
}

/** A live (non-terminal) child the parent currently owns. */
export interface LiveChildSummary {
  readonly name: string;
  readonly namespace: string;
  readonly uid: string;
  readonly phase: AgentTaskPhase | undefined;
}

/** A terminal child snapshot — used by WS-L's wait_for_children_all. */
export interface ChildSnapshot {
  readonly name: string;
  readonly namespace: string;
  readonly uid: string;
  readonly phase: AgentTaskPhase | undefined;
  readonly result?: { readonly content?: string };
  readonly error?: string;
}

/** Minimal Agent CR projection — labels only, all v0.1.3 needs. */
export interface AgentSummary {
  readonly labels: Readonly<Record<string, string>>;
}

export interface K8sTaskCreator {
  createChildTask(parent: ParentIdentity, input: ChildTaskInput): Promise<ChildTaskCreated>;
  listLiveChildren(parent: ParentIdentity): Promise<readonly LiveChildSummary[]>;
  /** Used by WS-L wait_for_children_all to enumerate ALL children incl. terminal. */
  listAllChildren(parent: ParentIdentity): Promise<readonly ChildSnapshot[]>;
  /** Used by WS-L wait_for_child_task to fetch one specific child by uid. */
  getTaskByUid(namespace: string, uid: string): Promise<ChildSnapshot | undefined>;
  /**
   * v0.1.3 — fetch an Agent CR by namespace/name, returning just the
   * label projection used by `spawn_child_task`'s
   * `allowedChildTemplates` check. Returns `undefined` when the Agent
   * is absent (404). Other errors (RBAC, network) propagate.
   */
  getAgentByName(namespace: string, name: string): Promise<AgentSummary | undefined>;
}

/**
 * Build a K8sTaskCreator from the in-pod ServiceAccount kubeconfig.
 * The agent pod's RBAC (template/agent-pod-rbac.yaml) grants
 * `agenttasks: [get, list, create]` and `agents: [get, list]` in the
 * release namespace.
 */
export function createInClusterK8sTaskCreator(): K8sTaskCreator {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const customApi = kc.makeApiClient(CustomObjectsApi);
  return buildK8sTaskCreator(customApi);
}

/** Test-injectable factory: build the creator over an explicit CustomObjectsApi. */
export function buildK8sTaskCreator(customApi: CustomObjectsApi): K8sTaskCreator {
  return {
    async createChildTask(
      parent: ParentIdentity,
      input: ChildTaskInput,
    ): Promise<ChildTaskCreated> {
      // v0.1.9 — task-depth threading. Stamp child depth = parent + 1
      // on the AgentTask label. The operator reads this same label
      // (TASK_DEPTH_LABEL) when building the spawned Job env to set
      // KAGENT_TASK_DEPTH on the child agent-pod, and the admission
      // path uses it to enforce the cluster cap. Default the parent
      // depth to 0 (root) when callers haven't threaded it through —
      // the spawn tool always sets it; only legacy / test fixtures
      // would omit.
      const parentDepth =
        typeof parent.depth === 'number' && Number.isInteger(parent.depth) && parent.depth >= 0
          ? parent.depth
          : 0;
      const childDepth = parentDepth + 1;

      // v0.4.1-blackboard — Wave 3 / Blackboard sub-team. Resolve the
      // root-task UID. When the parent IS the root (parent.rootUid
      // unset), the parent's own UID becomes the root for the child.
      // Otherwise the child inherits the parent's already-resolved
      // root UID. Either way: every descendant carries the SAME label
      // value, so they all share a single per-tree blackboard bucket.
      const childRootUid =
        typeof parent.rootUid === 'string' && parent.rootUid.length > 0
          ? parent.rootUid
          : parent.uid;

      const manifest: Record<string, unknown> = {
        apiVersion: `${KAGENT_GROUP}/${KAGENT_VERSION}`,
        kind: 'AgentTask',
        metadata: {
          name: input.name,
          namespace: parent.namespace,
          labels: {
            'kagent.knuteson.io/managed-by': 'kagent-operator',
            'app.kubernetes.io/created-by': 'kagent-agent-pod',
            [PARENT_TASK_UID_LABEL]: parent.uid,
            [TASK_DEPTH_LABEL]: String(childDepth),
            [ROOT_TASK_UID_LABEL]: childRootUid,
          },
          ownerReferences: [
            {
              apiVersion: `${KAGENT_GROUP}/${KAGENT_VERSION}`,
              kind: 'AgentTask',
              name: parent.name,
              uid: parent.uid,
              // Per TASK-GRAPH.md §5: NOT controller (Job is controller of
              // the spawned Pod). v0.1.9 — `blockOwnerDeletion=true` so
              // the apiserver's GC waits for the child to acknowledge
              // before finalizing the parent, mirroring the operator's
              // own `buildChildTaskManifest` (task-graph.ts §5
              // "Split owner-ref semantics"). Cascade-delete itself is
              // unaffected; this just sequences it cleanly.
              controller: false,
              blockOwnerDeletion: true,
            },
          ],
        },
        spec: {
          targetAgent: input.targetAgent,
          originalUserMessage: input.originalUserMessage,
          parentTask: parent.uid,
          payload: input.payload ?? {},
          ...(input.runConfig !== undefined && { runConfig: input.runConfig }),
        },
      };

      const created: unknown = await customApi.createNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace: parent.namespace,
        plural: AGENTTASK_PLURAL,
        body: manifest,
      });
      const meta = readMeta(created);
      return {
        namespace: meta.namespace ?? parent.namespace,
        name: meta.name ?? input.name,
        uid: meta.uid ?? '',
      };
    },

    async listLiveChildren(parent: ParentIdentity): Promise<readonly LiveChildSummary[]> {
      const items = await listChildrenRaw(customApi, parent);
      const out: LiveChildSummary[] = [];
      for (const item of items) {
        const meta = readMeta(item);
        const phase = readPhase(item);
        if (phase === 'Completed' || phase === 'Failed') continue;
        out.push({
          name: meta.name ?? '',
          namespace: meta.namespace ?? parent.namespace,
          uid: meta.uid ?? '',
          phase,
        });
      }
      return out;
    },

    async listAllChildren(parent: ParentIdentity): Promise<readonly ChildSnapshot[]> {
      const items = await listChildrenRaw(customApi, parent);
      return items.map((it) => buildSnapshot(it, parent.namespace));
    },

    async getTaskByUid(namespace: string, uid: string): Promise<ChildSnapshot | undefined> {
      // CustomObjectsApi has no get-by-UID; the standard idiom is
      // list-with-no-selector and find. For per-task polling this is
      // wasteful, so we filter by the parent-task-uid label on the
      // CALL SITE — but here we need the absolute fallback (no parent
      // hint), so list-and-find is correct.
      const list: unknown = await customApi.listNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace,
        plural: AGENTTASK_PLURAL,
      });
      const items = readItems(list);
      for (const it of items) {
        const meta = readMeta(it);
        if (meta.uid === uid) return buildSnapshot(it, namespace);
      }
      return undefined;
    },

    async getAgentByName(namespace: string, name: string): Promise<AgentSummary | undefined> {
      let obj: unknown;
      try {
        obj = await customApi.getNamespacedCustomObject({
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: AGENT_PLURAL,
          name,
        });
      } catch (err: unknown) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
      if (obj === null || typeof obj !== 'object') return undefined;
      return { labels: readLabels(obj) };
    },
  };
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 404 || e.statusCode === 404;
}

function readLabels(obj: unknown): Readonly<Record<string, string>> {
  if (obj === null || typeof obj !== 'object') return {};
  const meta = (obj as Record<string, unknown>).metadata;
  if (meta === null || typeof meta !== 'object') return {};
  const labels = (meta as Record<string, unknown>).labels;
  if (labels === null || typeof labels !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function listChildrenRaw(
  customApi: CustomObjectsApi,
  parent: ParentIdentity,
): Promise<readonly unknown[]> {
  const list: unknown = await customApi.listNamespacedCustomObject({
    group: KAGENT_GROUP,
    version: KAGENT_VERSION,
    namespace: parent.namespace,
    plural: AGENTTASK_PLURAL,
    labelSelector: `${PARENT_TASK_UID_LABEL}=${parent.uid}`,
  });
  return readItems(list);
}

function buildSnapshot(item: unknown, fallbackNamespace: string): ChildSnapshot {
  const meta = readMeta(item);
  const phase = readPhase(item);
  if (item === null || typeof item !== 'object') {
    return {
      name: meta.name ?? '',
      namespace: meta.namespace ?? fallbackNamespace,
      uid: meta.uid ?? '',
      phase,
    };
  }
  const status = (item as Record<string, unknown>).status;
  let result: { readonly content?: string } | undefined;
  let error: string | undefined;
  if (status !== null && typeof status === 'object') {
    const s = status as Record<string, unknown>;
    if (s.result !== null && typeof s.result === 'object') {
      const r = s.result as Record<string, unknown>;
      if (typeof r.content === 'string') result = { content: r.content };
      else result = {};
    }
    if (typeof s.error === 'string') error = s.error;
  }
  return {
    name: meta.name ?? '',
    namespace: meta.namespace ?? fallbackNamespace,
    uid: meta.uid ?? '',
    phase,
    ...(result !== undefined && { result }),
    ...(error !== undefined && { error }),
  };
}

interface ParsedMeta {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
}

function readMeta(obj: unknown): ParsedMeta {
  if (obj === null || typeof obj !== 'object') return {};
  const m = (obj as Record<string, unknown>).metadata;
  if (m === null || typeof m !== 'object') return {};
  const meta = m as Record<string, unknown>;
  return {
    ...(typeof meta.name === 'string' && { name: meta.name }),
    ...(typeof meta.namespace === 'string' && { namespace: meta.namespace }),
    ...(typeof meta.uid === 'string' && { uid: meta.uid }),
  };
}

function readPhase(obj: unknown): AgentTaskPhase | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const status = (obj as Record<string, unknown>).status;
  if (status === null || typeof status !== 'object') return undefined;
  const phase = (status as Record<string, unknown>).phase;
  if (
    phase === 'Pending' ||
    phase === 'Dispatched' ||
    phase === 'Completed' ||
    phase === 'Failed'
  ) {
    return phase;
  }
  return undefined;
}

function readItems(list: unknown): readonly unknown[] {
  if (list === null || typeof list !== 'object') return [];
  const items = (list as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items;
}
