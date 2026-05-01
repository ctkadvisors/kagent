/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Thin wrapper around `@kubernetes/client-node` for the CLI's two
 * AgentTask operations: `create` (kagent submit) and `getStatus` (the
 * --wait poll loop). Kept narrow so a future workbench-api proxy
 * client can implement the same interface.
 *
 * Auth: kubeconfig only. The CLI loads `KUBECONFIG` / `~/.kube/config`
 * via `KubeConfig.loadFromDefault()` — same convention as `kubectl`.
 */

import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTTASK_PLURAL = 'agenttasks';

export type AgentTaskPhase = 'Pending' | 'Dispatched' | 'Completed' | 'Failed';

export interface CreateAgentTaskInput {
  readonly namespace: string;
  readonly name: string;
  readonly targetAgent: string;
  readonly originalUserMessage: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
    readonly maxIterations?: number;
  };
  readonly labels?: Readonly<Record<string, string>>;
  readonly payload?: unknown;
}

export interface AgentTaskCreated {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly creationTimestamp?: string;
}

export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: { readonly content?: string };
  readonly error?: string;
  readonly podName?: string;
}

export interface KubeClient {
  readonly currentContextNamespace: string | undefined;
  readonly clusterServer: string | undefined;
  createTask(input: CreateAgentTaskInput): Promise<AgentTaskCreated>;
  getTaskStatus(namespace: string, name: string): Promise<AgentTaskStatus | undefined>;
}

/**
 * Build a KubeClient from the user's kubeconfig (the standard
 * KUBECONFIG / ~/.kube/config resolution). Throws if no usable
 * context is found.
 */
export function createKubeClient(): KubeClient {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const ctx = kc.getContextObject(kc.getCurrentContext());
  if (ctx === null || ctx === undefined) {
    throw new Error(
      'no current kubeconfig context (set KUBECONFIG or run `kubectl config use-context`)',
    );
  }
  const cluster = kc.getCurrentCluster();
  const customApi = kc.makeApiClient(CustomObjectsApi);

  return {
    currentContextNamespace: ctx.namespace,
    clusterServer: cluster?.server,

    async createTask(input: CreateAgentTaskInput): Promise<AgentTaskCreated> {
      const manifest: Record<string, unknown> = {
        apiVersion: `${KAGENT_GROUP}/${KAGENT_VERSION}`,
        kind: 'AgentTask',
        metadata: {
          name: input.name,
          namespace: input.namespace,
          labels: {
            'kagent.knuteson.io/managed-by': 'kagent-operator',
            'app.kubernetes.io/created-by': 'kagent-cli',
            ...(input.labels ?? {}),
          },
        },
        spec: {
          targetAgent: input.targetAgent,
          originalUserMessage: input.originalUserMessage,
          payload: input.payload ?? {},
          ...(input.runConfig !== undefined && { runConfig: input.runConfig }),
        },
      };

      const created: unknown = await customApi.createNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace: input.namespace,
        plural: AGENTTASK_PLURAL,
        body: manifest,
      });
      const meta = readObjectMeta(created);
      if (meta === undefined) {
        throw new Error('K8s API returned a CustomObject with no usable metadata');
      }
      return {
        namespace: meta.namespace ?? input.namespace,
        name: meta.name ?? input.name,
        uid: meta.uid ?? '',
        ...(meta.creationTimestamp !== undefined && {
          creationTimestamp: meta.creationTimestamp,
        }),
      };
    },

    async getTaskStatus(namespace: string, name: string): Promise<AgentTaskStatus | undefined> {
      try {
        const obj: unknown = await customApi.getNamespacedCustomObject({
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: AGENTTASK_PLURAL,
          name,
        });
        return readTaskStatus(obj);
      } catch (err: unknown) {
        // 404 = not found yet (informer race); return undefined so the
        // poll loop can try again.
        const status = extractStatus(err);
        if (status === 404) return undefined;
        throw err;
      }
    },
  };
}

interface ParsedMeta {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly creationTimestamp?: string;
}

function readObjectMeta(obj: unknown): ParsedMeta | undefined {
  if (obj === null || typeof obj !== 'object') return undefined;
  const candidate = (obj as Record<string, unknown>).metadata;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const m = candidate as Record<string, unknown>;
  return {
    ...(typeof m.name === 'string' && { name: m.name }),
    ...(typeof m.namespace === 'string' && { namespace: m.namespace }),
    ...(typeof m.uid === 'string' && { uid: m.uid }),
    ...(typeof m.creationTimestamp === 'string' && { creationTimestamp: m.creationTimestamp }),
  };
}

function readTaskStatus(obj: unknown): AgentTaskStatus {
  if (obj === null || typeof obj !== 'object') return {};
  const status = (obj as Record<string, unknown>).status;
  if (status === null || typeof status !== 'object') return {};
  const s = status as Record<string, unknown>;
  const phase = typeof s.phase === 'string' ? (s.phase as AgentTaskPhase) : undefined;
  const podName = typeof s.podName === 'string' ? s.podName : undefined;
  const error = typeof s.error === 'string' ? s.error : undefined;
  let result: { readonly content?: string } | undefined;
  if (s.result !== null && typeof s.result === 'object') {
    const r = s.result as Record<string, unknown>;
    if (typeof r.content === 'string') result = { content: r.content };
    else result = {};
  }
  return {
    ...(phase !== undefined && { phase }),
    ...(podName !== undefined && { podName }),
    ...(error !== undefined && { error }),
    ...(result !== undefined && { result }),
  };
}

function extractStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}
