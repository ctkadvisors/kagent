/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Cluster visibility surface. Backs the workbench-ui's `#/cluster`
 * page so end-users (and Chris) can see the live K3s substrate
 * without `kubectl`.
 *
 *   GET /api/cluster/nodes     — K3s node list + conditions + capacity
 *   GET /api/cluster/snapshot  — one-shot: nodes + active tasks +
 *                                 recent-terminal tasks + pod-by-node map.
 *
 * Why a single `/snapshot` endpoint vs. four separate calls: the UI
 * paints all four panels in one tick. Combining them server-side
 * means the cluster state is observed *in the same kubectl breath*
 * — important when a Pod is spawning + a Task is dispatching + a
 * Job is being created in the same 1s window. Three independent
 * client-side fetches would race and stutter the UI.
 *
 * Pod snapshot is filtered to operator-managed Pods (selector matches
 * the operator's `kagent.knuteson.io/managed-by=kagent-operator`
 * label) — same RBAC posture documented in
 * `new_localai/docs/kagent-workbench-rbac.md` §2.2.
 */

import type { CoreV1Api, V1Pod } from '@kubernetes/client-node';
import { Hono } from 'hono';

import type { AgentTask } from '@kagent/dto';
import type { SnapshotCache } from '../cache.js';

/**
 * One row per cluster Node. Trims the `V1Node` shape to fields the
 * dashboard renders so the wire payload stays small + UI-leaf-deps-only.
 */
export interface NodeRow {
  readonly name: string;
  /** `control-plane`, `master`, `worker`, or `<unknown>` if no role label. */
  readonly role: string;
  /** kubelet version reported by node status (e.g. `v1.32.5+k3s1`). */
  readonly kubeletVersion: string;
  /** OS image (e.g. `K3s` / `Debian GNU/Linux`). Helps spot mixed clusters. */
  readonly osImage: string;
  /** Container runtime version. */
  readonly containerRuntime: string;
  /** Total `Ready` condition status — `'True' | 'False' | 'Unknown'`. */
  readonly ready: 'True' | 'False' | 'Unknown';
  /** Filtered conditions — Ready, MemoryPressure, DiskPressure, PIDPressure. */
  readonly conditions: ReadonlyArray<{ type: string; status: string; reason?: string }>;
  /** Capacity (CPUs, memory, ephemeral-storage). All as strings (K8s convention). */
  readonly capacity: Readonly<Record<string, string>>;
  /** Number of operator-managed pods scheduled on this node (computed). */
  readonly managedPodCount: number;
  /** ISO of last heartbeat from kubelet (lastHeartbeatTime on Ready condition). */
  readonly lastHeartbeatAt?: string;
}

interface PodOnNode {
  readonly namespace: string;
  readonly name: string;
  readonly node: string | null;
  readonly phase: string;
  readonly taskUid?: string;
  readonly taskName?: string;
  readonly agentName?: string;
}

interface ActiveTaskRow {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly phase: string;
  readonly targetAgent?: string;
  readonly model?: string;
  readonly podName?: string;
  readonly nodeName?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly parentTaskUid?: string;
  readonly childCount: number;
  readonly errorMessage?: string;
  readonly lastResultPreview?: string;
}

interface ClusterSnapshot {
  readonly fetchedAt: string;
  readonly nodes: readonly NodeRow[];
  readonly pods: readonly PodOnNode[];
  /** Tasks not yet in a terminal phase. */
  readonly activeTasks: readonly ActiveTaskRow[];
  /** Most recent N terminal tasks (Completed/Failed) — newest first. */
  readonly recentTasks: readonly ActiveTaskRow[];
  /**
   * Inventory counts so the UI can show "12 nodes / 47 managed pods /
   * 3 active tasks" headline numbers without re-counting the arrays.
   */
  readonly counts: {
    readonly nodes: number;
    readonly managedPods: number;
    readonly active: number;
    readonly recent: number;
    readonly agents: number;
  };
}

const RECENT_TASKS_LIMIT = 30;
const MANAGED_BY_SELECTOR = 'kagent.knuteson.io/managed-by=kagent-operator';

/**
 * `app.kubernetes.io/component`-or-similar label selector that
 * identifies the agent-pod Job's pod. Workbench-api filters cluster
 * pods by `managedBy` (operator label) so we don't leak unrelated
 * cluster pods into the visibility surface.
 */
const PARENT_TASK_LABEL = 'kagent.knuteson.io/parent-task';
const TASK_NAME_LABEL = 'kagent.knuteson.io/task';

export interface ClusterRouteDeps {
  readonly cache: SnapshotCache;
  /**
   * When omitted (skipInformer mode in tests), node + pod listing
   * 503s. Reads-only; no write surface here.
   */
  readonly coreApi?: CoreV1Api;
  /**
   * M14 — TTL for the cached `listNode()` response (ms). Default 5000.
   * Test-injectable so we can flip cache hit/miss without sleeping.
   * Set `0` to disable the cache entirely (tests).
   */
  readonly nodeListTtlMs?: number;
  /** Test-only clock override (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * M14 — wrap an async loader with a TTL cache. Coalesces concurrent
 * misses so a stampede of `/api/cluster/{snapshot,nodes}` requests
 * issues at most one upstream `listNode()`. Errors blow the cache;
 * the next caller re-tries (we do NOT cache failures — a 502 from the
 * apiserver shouldn't pin the workbench in a 5-second outage window).
 *
 * NEW-L1 reuses the same shape for `buildModelEndpointIndex`.
 */
function ttlCachedLoader<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number,
): () => Promise<T> {
  let cachedAt = 0;
  let cached: T | undefined;
  let inFlight: Promise<T> | null = null;
  return async function load_(): Promise<T> {
    const t = now();
    if (cached !== undefined && t - cachedAt < ttlMs) return cached;
    if (inFlight !== null) return inFlight;
    inFlight = load()
      .then((v) => {
        cached = v;
        cachedAt = now();
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

interface KubeNodeShape {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
  };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      lastHeartbeatTime?: string | Date;
    }>;
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
      containerRuntimeVersion?: string;
    };
    capacity?: Record<string, string>;
  };
}

export function summarizeNode(node: KubeNodeShape, podsOnNode: number): NodeRow {
  const name = node.metadata?.name ?? '<unknown>';
  const labels = node.metadata?.labels ?? {};
  // K8s convention: nodes carry `node-role.kubernetes.io/<role>=` labels.
  // K3s also stamps `node-role.kubernetes.io/master` on the control-plane.
  let role = '<unknown>';
  for (const labelKey of Object.keys(labels)) {
    if (labelKey.startsWith('node-role.kubernetes.io/')) {
      role = labelKey.slice('node-role.kubernetes.io/'.length);
      break;
    }
  }
  const conditions = (node.status?.conditions ?? []).filter(
    (c) =>
      typeof c.type === 'string' &&
      ['Ready', 'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(
        c.type,
      ),
  );
  const ready = conditions.find((c) => c.type === 'Ready');
  const readyStatus: 'True' | 'False' | 'Unknown' =
    ready?.status === 'True' ? 'True' : ready?.status === 'False' ? 'False' : 'Unknown';
  const heartbeat = ready?.lastHeartbeatTime;
  const heartbeatIso =
    heartbeat instanceof Date
      ? heartbeat.toISOString()
      : typeof heartbeat === 'string'
        ? heartbeat
        : undefined;
  return {
    name,
    role,
    kubeletVersion: node.status?.nodeInfo?.kubeletVersion ?? '<unknown>',
    osImage: node.status?.nodeInfo?.osImage ?? '<unknown>',
    containerRuntime: node.status?.nodeInfo?.containerRuntimeVersion ?? '<unknown>',
    ready: readyStatus,
    conditions: conditions.map((c) => ({
      type: c.type ?? '',
      status: c.status ?? 'Unknown',
      ...(c.reason !== undefined && { reason: c.reason }),
    })),
    capacity: node.status?.capacity ?? {},
    managedPodCount: podsOnNode,
    ...(heartbeatIso !== undefined && { lastHeartbeatAt: heartbeatIso }),
  };
}

function podPhase(pod: V1Pod): string {
  return pod.status?.phase ?? 'Unknown';
}

function podToRow(pod: V1Pod): PodOnNode {
  const labels = pod.metadata?.labels ?? {};
  return {
    namespace: pod.metadata?.namespace ?? 'default',
    name: pod.metadata?.name ?? '',
    node: pod.spec?.nodeName ?? null,
    phase: podPhase(pod),
    ...(labels['kagent.knuteson.io/task-uid'] !== undefined && {
      taskUid: labels['kagent.knuteson.io/task-uid'],
    }),
    ...(labels[TASK_NAME_LABEL] !== undefined && {
      taskName: labels[TASK_NAME_LABEL],
    }),
    ...(labels['kagent.knuteson.io/agent'] !== undefined && {
      agentName: labels['kagent.knuteson.io/agent'],
    }),
  };
}

function taskIsActive(task: AgentTask): boolean {
  const phase = task.status?.phase;
  return phase !== 'Completed' && phase !== 'Failed';
}

function taskRow(
  task: AgentTask,
  allTasks: readonly AgentTask[],
  allPods: readonly V1Pod[],
): ActiveTaskRow {
  const myUid = task.metadata.uid;
  // Children are tasks whose parentTaskUid label matches mine.
  const childCount = myUid
    ? allTasks.filter((t) => {
        const pl = (t.metadata.labels ?? {})[PARENT_TASK_LABEL];
        return typeof pl === 'string' && pl === myUid;
      }).length
    : 0;
  // Find the pod for this task — operator labels Pods with task-uid.
  const matchingPod =
    myUid !== undefined
      ? allPods.find((p) => (p.metadata?.labels ?? {})['kagent.knuteson.io/task-uid'] === myUid)
      : undefined;
  const status = task.status as Record<string, unknown> | undefined;
  const result = status?.result as { content?: string } | undefined;
  const lastResult = result?.content;
  const errorMessage = typeof status?.error === 'string' ? status.error : undefined;
  const parentLabel = (task.metadata.labels ?? {})[PARENT_TASK_LABEL];
  return {
    namespace: task.metadata.namespace ?? 'default',
    name: task.metadata.name ?? '<unnamed>',
    uid: task.metadata.uid ?? '',
    phase: typeof status?.phase === 'string' ? status.phase : 'Pending',
    ...(task.spec?.targetAgent !== undefined && { targetAgent: task.spec.targetAgent }),
    ...(typeof parentLabel === 'string' && { parentTaskUid: parentLabel }),
    ...(matchingPod?.metadata?.name !== undefined && { podName: matchingPod.metadata.name }),
    ...(matchingPod?.spec?.nodeName !== undefined && { nodeName: matchingPod.spec.nodeName }),
    ...(typeof status?.startedAt === 'string' && { startedAt: status.startedAt }),
    ...(typeof status?.completedAt === 'string' && { completedAt: status.completedAt }),
    ...(task.metadata.creationTimestamp !== undefined && {
      createdAt:
        task.metadata.creationTimestamp instanceof Date
          ? task.metadata.creationTimestamp.toISOString()
          : String(task.metadata.creationTimestamp),
    }),
    childCount,
    ...(errorMessage !== undefined && { errorMessage }),
    ...(typeof lastResult === 'string' &&
      lastResult.length > 0 && {
        lastResultPreview: lastResult.slice(0, 200),
      }),
  };
}

export function clusterRoute(deps: ClusterRouteDeps): Hono {
  const app = new Hono();
  // M14 — wrap `listNode()` in a 5s TTL cache shared by both
  // `/api/cluster/nodes` and `/api/cluster/snapshot`. Without this an
  // authenticated user (or a chatty UI poll loop) could issue
  // unbounded `listNode` calls against the apiserver — the audit
  // surfaced this as a low-cost amplification vector. The TTL is short
  // enough that a node going NotReady still surfaces in the UI within
  // 5s and long enough that a user mashing F5 collapses to a single
  // upstream call.
  const TTL_MS = deps.nodeListTtlMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const loadNodeList = async (): Promise<{ items?: KubeNodeShape[] }> => {
    if (deps.coreApi === undefined) return { items: [] };
    return deps.coreApi.listNode();
  };
  const cachedListNode = TTL_MS > 0 ? ttlCachedLoader(loadNodeList, TTL_MS, now) : loadNodeList;

  app.get('/api/cluster/nodes', async (c) => {
    if (deps.coreApi === undefined) {
      return c.json({ error: 'cluster-api-disabled' }, 503);
    }
    try {
      const list = await cachedListNode();
      const allPods = deps.cache.listPods();
      const podCountByNode = new Map<string, number>();
      for (const p of allPods) {
        const n = p.spec?.nodeName ?? null;
        if (n !== null) podCountByNode.set(n, (podCountByNode.get(n) ?? 0) + 1);
      }
      const items = (list.items ?? []).map((n) =>
        summarizeNode(n, podCountByNode.get(n.metadata?.name ?? '') ?? 0),
      );
      return c.json({ items, fetchedAt: new Date().toISOString() });
    } catch (err) {
      console.warn('[workbench-api] /api/cluster/nodes failed:', err);
      return c.json(
        { error: 'list-nodes-failed', message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  });

  app.get('/api/cluster/snapshot', async (c) => {
    if (deps.coreApi === undefined) {
      return c.json({ error: 'cluster-api-disabled' }, 503);
    }
    let nodes: NodeRow[] = [];
    // NEW-M2 — snapshot the pod-cache list ONCE and reuse it for both
    // the per-node count and the response payload. Previously the
    // handler called `listPods()` twice (once before the await for the
    // count, once after for the rows), so a pod lifecycle event between
    // those points would surface inconsistent counts. The pod cache is
    // a synchronous read; the only async hop is the node list, which
    // we now hoist BEFORE both pod reads.
    let allPodsForCount: ReadonlyArray<V1Pod> = [];
    try {
      const nodeList = await cachedListNode();
      allPodsForCount = deps.cache.listPods();
      const podCountByNode = new Map<string, number>();
      for (const p of allPodsForCount) {
        const n = p.spec?.nodeName ?? null;
        if (n !== null) podCountByNode.set(n, (podCountByNode.get(n) ?? 0) + 1);
      }
      nodes = (nodeList.items ?? []).map((n) =>
        summarizeNode(n, podCountByNode.get(n.metadata?.name ?? '') ?? 0),
      );
    } catch (err) {
      console.warn('[workbench-api] cluster snapshot — nodes failed:', err);
      // Continue — pods + tasks still useful even when node list errors.
      allPodsForCount = deps.cache.listPods();
    }

    const allTasks = deps.cache.listTasks();
    const allPods = allPodsForCount;
    const allAgents = deps.cache.listAgents();

    const activeTasks = allTasks
      .filter(taskIsActive)
      .map((t) => taskRow(t, allTasks, allPods))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

    const recentTasks = allTasks
      .filter((t) => !taskIsActive(t))
      .sort((a, b) => {
        const ac = (a.status as { completedAt?: string } | undefined)?.completedAt ?? '';
        const bc = (b.status as { completedAt?: string } | undefined)?.completedAt ?? '';
        return bc.localeCompare(ac);
      })
      .slice(0, RECENT_TASKS_LIMIT)
      .map((t) => taskRow(t, allTasks, allPods));

    const pods = allPods.map(podToRow);

    const snapshot: ClusterSnapshot = {
      fetchedAt: new Date().toISOString(),
      nodes,
      pods,
      activeTasks,
      recentTasks,
      counts: {
        nodes: nodes.length,
        managedPods: allPods.length,
        active: activeTasks.length,
        recent: recentTasks.length,
        agents: allAgents.length,
      },
    };
    return c.json(snapshot);
  });

  return app;
}

/**
 * Re-export so the SnapshotCache changes don't surface in router.ts.
 * Reflects the operator's pod label convention; consumers needing to
 * filter pods by other selectors should switch to listing via the
 * core API directly.
 */
export const CLUSTER_MANAGED_BY_SELECTOR = MANAGED_BY_SELECTOR;
