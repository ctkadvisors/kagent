/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Informer wiring — opens cluster-wide watches on the four kinds the
 * Workbench cares about (`Agent`, `AgentTask`, `Channel`,
 * `ChannelBinding`, `ChannelSession`, owned `Job`, owned `Pod`)
 * and feeds every event into the supplied `SnapshotCache`.
 *
 * The pattern mirrors `packages/operator/src/{watch,job-watch}.ts`:
 *
 *   - Cluster-wide watches (no namespace scoping in v0.1).
 *   - Job/Pod watches use the `kagent.knuteson.io/managed-by=kagent-operator`
 *     label selector so we don't inhale every unrelated workload.
 *   - On error: log + automatic 5-second restart. The Workbench is a
 *     read-only follower; if the watch goes away we just need to come
 *     back later.
 *
 * Production note: the operator's informers and the Workbench's
 * informers run independently — they don't share state. That's
 * intentional. The Workbench can be deployed without the operator
 * (read-only debug mode), and the operator stays small.
 */

import {
  type CoreV1Api,
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type KubernetesObject,
  type V1Job,
  type V1Pod,
  makeInformer,
} from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  isChannel,
  isChannelBinding,
  isChannelSession,
  type Agent,
  type AgentTask,
  type Channel,
  type ChannelBinding,
  type ChannelSession,
} from '@kagent/dto';

import type { SnapshotCache } from './cache.js';

const TASK_PLURAL = 'agenttasks' as const;
const AGENT_PLURAL = 'agents' as const;
const CHANNEL_PLURAL = 'channels' as const;
const CHANNEL_BINDING_PLURAL = 'channelbindings' as const;
const CHANNEL_SESSION_PLURAL = 'channelsessions' as const;

const TASK_WATCH_PATH = `/apis/${API_GROUP}/${API_VERSION}/${TASK_PLURAL}` as const;
const AGENT_WATCH_PATH = `/apis/${API_GROUP}/${API_VERSION}/${AGENT_PLURAL}` as const;
const CHANNEL_WATCH_PATH = `/apis/${API_GROUP}/${API_VERSION}/${CHANNEL_PLURAL}` as const;
const CHANNEL_BINDING_WATCH_PATH =
  `/apis/${API_GROUP}/${API_VERSION}/${CHANNEL_BINDING_PLURAL}` as const;
const CHANNEL_SESSION_WATCH_PATH =
  `/apis/${API_GROUP}/${API_VERSION}/${CHANNEL_SESSION_PLURAL}` as const;

const MANAGED_BY = 'kagent.knuteson.io/managed-by=kagent-operator';
const JOB_WATCH_PATH = `/apis/batch/v1/jobs?labelSelector=${encodeURIComponent(MANAGED_BY)}`;
const POD_WATCH_PATH = `/api/v1/pods?labelSelector=${encodeURIComponent(MANAGED_BY)}`;

/**
 * Bag of informer dependencies. Tests can inject mocks; main.ts reads
 * from the live KubeConfig.
 */
export interface InformerDeps {
  readonly kc: KubeConfig;
  readonly customApi: CustomObjectsApi;
  readonly coreApi: CoreV1Api;
  readonly listJobs: () => Promise<KubernetesListObject<V1Job>>;
}

/**
 * Composite handle — `start()` spins up all four informers; `stop()`
 * cleanly shuts them down. The Workbench uses one set per process.
 */
export interface InformerSet {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Type-narrow a watch event payload into a typed `AgentTask` /
 * `Agent` — the K8s client returns `unknown` for CRs because they
 * aren't part of the OpenAPI schema. We trust the apiVersion field
 * (which the apiserver guarantees on every payload from a CR endpoint).
 */
function isAgentTaskShape(obj: unknown): obj is AgentTask {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  return o.kind === 'AgentTask' && typeof o.spec === 'object' && o.spec !== null;
}

export function isAgentShape(obj: unknown): obj is Agent {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.kind !== 'Agent') return false;
  const spec = o.spec as { model?: unknown; modelClass?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  // Mirror the operator's CRD admission rule: at-least-one of `model`
  // or `modelClass` MUST be a non-empty string. Pre-v0.1.8-modelclass
  // this checked only `model`; that silently filtered every migrated
  // Agent (modelClass-only) out of the workbench cache, leaving the
  // /api/agents endpoint serving stale pre-migration snapshots forever.
  const hasModel = typeof spec.model === 'string' && spec.model.length > 0;
  const hasModelClass = typeof spec.modelClass === 'string' && spec.modelClass.length > 0;
  return hasModel || hasModelClass;
}

export function createInformerSet(deps: InformerDeps, cache: SnapshotCache): InformerSet {
  const { kc, customApi, coreApi, listJobs } = deps;

  const taskListFn = async (): Promise<KubernetesListObject<AgentTask>> => {
    // CustomObjectsApi.listClusterCustomObject returns Promise<any> by
    // design — CRDs aren't in the OpenAPI schema. Cast at the call
    // site is the documented pattern from @kubernetes/client-node.
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: TASK_PLURAL,
    });
    return res as KubernetesListObject<AgentTask>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const agentListFn = async (): Promise<KubernetesListObject<Agent>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: AGENT_PLURAL,
    });
    return res as KubernetesListObject<Agent>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const channelListFn = async (): Promise<KubernetesListObject<Channel>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: CHANNEL_PLURAL,
    });
    return res as KubernetesListObject<Channel>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const channelBindingListFn = async (): Promise<KubernetesListObject<ChannelBinding>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: CHANNEL_BINDING_PLURAL,
    });
    return res as KubernetesListObject<ChannelBinding>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const channelSessionListFn = async (): Promise<KubernetesListObject<ChannelSession>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res = await customApi.listClusterCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      plural: CHANNEL_SESSION_PLURAL,
    });
    return res as KubernetesListObject<ChannelSession>;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
  };

  const podListFn = async (): Promise<KubernetesListObject<V1Pod>> => {
    return await coreApi.listPodForAllNamespaces({ labelSelector: MANAGED_BY });
  };

  const taskInformer = makeInformer<AgentTask>(kc, TASK_WATCH_PATH, taskListFn);
  const agentInformer = makeInformer<Agent>(kc, AGENT_WATCH_PATH, agentListFn);
  const channelInformer = makeInformer<Channel>(kc, CHANNEL_WATCH_PATH, channelListFn);
  const channelBindingInformer = makeInformer<ChannelBinding>(
    kc,
    CHANNEL_BINDING_WATCH_PATH,
    channelBindingListFn,
  );
  const channelSessionInformer = makeInformer<ChannelSession>(
    kc,
    CHANNEL_SESSION_WATCH_PATH,
    channelSessionListFn,
  );
  const jobInformer = makeInformer<V1Job>(kc, JOB_WATCH_PATH, listJobs);
  const podInformer = makeInformer<V1Pod>(kc, POD_WATCH_PATH, podListFn);

  function wireRestart<T extends KubernetesObject>(informer: Informer<T>, label: string): void {
    informer.on('error', (err) => {
      console.error(`[workbench-api] ${label} informer error; restarting in 5s:`, err);
      setTimeout(() => {
        void informer.start();
      }, 5000);
    });
  }

  taskInformer.on('add', (obj) => {
    if (isAgentTaskShape(obj)) cache.upsertTask(obj);
  });
  taskInformer.on('update', (obj) => {
    if (isAgentTaskShape(obj)) cache.upsertTask(obj);
  });
  taskInformer.on('delete', (obj) => {
    if (isAgentTaskShape(obj)) cache.deleteTask(obj);
  });
  wireRestart(taskInformer, 'AgentTask');

  agentInformer.on('add', (obj) => {
    if (isAgentShape(obj)) cache.upsertAgent(obj);
  });
  agentInformer.on('update', (obj) => {
    if (isAgentShape(obj)) cache.upsertAgent(obj);
  });
  agentInformer.on('delete', (obj) => {
    if (isAgentShape(obj)) cache.deleteAgent(obj);
  });
  wireRestart(agentInformer, 'Agent');

  channelInformer.on('add', (obj) => {
    if (isChannel(obj)) cache.upsertChannel(obj);
  });
  channelInformer.on('update', (obj) => {
    if (isChannel(obj)) cache.upsertChannel(obj);
  });
  channelInformer.on('delete', (obj) => {
    if (isChannel(obj)) cache.deleteChannel(obj);
  });
  wireRestart(channelInformer, 'Channel');

  channelBindingInformer.on('add', (obj) => {
    if (isChannelBinding(obj)) cache.upsertChannelBinding(obj);
  });
  channelBindingInformer.on('update', (obj) => {
    if (isChannelBinding(obj)) cache.upsertChannelBinding(obj);
  });
  channelBindingInformer.on('delete', (obj) => {
    if (isChannelBinding(obj)) cache.deleteChannelBinding(obj);
  });
  wireRestart(channelBindingInformer, 'ChannelBinding');

  channelSessionInformer.on('add', (obj) => {
    if (isChannelSession(obj)) cache.upsertChannelSession(obj);
  });
  channelSessionInformer.on('update', (obj) => {
    if (isChannelSession(obj)) cache.upsertChannelSession(obj);
  });
  channelSessionInformer.on('delete', (obj) => {
    if (isChannelSession(obj)) cache.deleteChannelSession(obj);
  });
  wireRestart(channelSessionInformer, 'ChannelSession');

  jobInformer.on('add', (j) => {
    cache.upsertJob(j);
  });
  jobInformer.on('update', (j) => {
    cache.upsertJob(j);
  });
  jobInformer.on('delete', (j) => {
    cache.deleteJob(j);
  });
  wireRestart(jobInformer, 'Job');

  podInformer.on('add', (p) => {
    cache.upsertPod(p);
  });
  podInformer.on('update', (p) => {
    cache.upsertPod(p);
  });
  podInformer.on('delete', (p) => {
    cache.deletePod(p);
  });
  wireRestart(podInformer, 'Pod');

  return {
    async start(): Promise<void> {
      await taskInformer.start();
      await agentInformer.start();
      await channelInformer.start();
      await channelBindingInformer.start();
      await channelSessionInformer.start();
      await jobInformer.start();
      await podInformer.start();
    },
    async stop(): Promise<void> {
      await taskInformer.stop();
      await agentInformer.stop();
      await channelInformer.stop();
      await channelBindingInformer.stop();
      await channelSessionInformer.stop();
      await jobInformer.stop();
      await podInformer.stop();
    },
  };
}
