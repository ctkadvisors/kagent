/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Channel controller core.
 *
 * Adapters normalize provider-specific events into ChannelInboundEnvelope.
 * This module owns the durable control-plane decision: policy check,
 * binding route, session guard, idempotent AgentTask materialization.
 */

import { createHash } from 'node:crypto';

import type { CustomObjectsApi } from '@kubernetes/client-node';

import {
  API_GROUP,
  API_GROUP_VERSION,
  API_VERSION,
  CHANNEL_ACCOUNT_ANNOTATION,
  CHANNEL_ACCOUNT_LABEL,
  CHANNEL_BINDING_ANNOTATION,
  CHANNEL_CREATED_BY,
  CHANNEL_LABEL,
  CHANNEL_PEER_HASH_LABEL,
  CHANNEL_PEER_ID_ANNOTATION,
  CHANNEL_PEER_KIND_ANNOTATION,
  CHANNEL_PEER_KIND_LABEL,
  CHANNEL_PROVIDER_ANNOTATION,
  CHANNEL_SESSION_KEY_ANNOTATION,
  CHANNEL_SESSION_LABEL,
  CHANNEL_THREAD_ANNOTATION,
  buildChannelTurnAgentTask,
  evaluateChannelInboundPolicy,
  isChannel,
  isChannelBinding,
  isChannelSession,
  routeChannelInbound,
  type AgentTask,
  type Channel,
  type ChannelBinding,
  type ChannelInboundEnvelope,
  type ChannelPolicyDenyReason,
  type ChannelRoute,
  type ChannelSession,
  type ChannelSessionStatus,
} from './crds/index.js';
import { mergePatchOptions } from './k8s.js';

const CHANNEL_PLURAL = 'channels' as const;
const CHANNEL_BINDING_PLURAL = 'channelbindings' as const;
const CHANNEL_SESSION_PLURAL = 'channelsessions' as const;
const AGENT_TASK_PLURAL = 'agenttasks' as const;

export type ChannelControllerDenyReason =
  | ChannelPolicyDenyReason
  | 'channel_not_found'
  | 'channel_mismatch'
  | 'no_route'
  | 'session_paused'
  | 'session_backoff';

export type ChannelControllerResult =
  | {
      readonly action: 'created';
      readonly route: ChannelRoute;
      readonly session: ChannelSession;
      readonly task: AgentTask;
    }
  | {
      readonly action: 'duplicate';
      readonly route: ChannelRoute;
      readonly session: ChannelSession;
      readonly task: AgentTask;
    }
  | {
      readonly action: 'approval_required';
      readonly bindingName: string;
      readonly mode: 'operator' | 'per-turn' | 'tool';
    }
  | {
      readonly action: 'denied';
      readonly reason: ChannelControllerDenyReason;
      readonly sessionName?: string;
      readonly backoffUntil?: string;
    };

export interface ChannelControllerStore {
  getChannel(namespace: string, name: string): Promise<Channel | undefined>;
  listChannelBindings(namespace: string, channelName: string): Promise<readonly ChannelBinding[]>;
  getChannelSession(namespace: string, name: string): Promise<ChannelSession | undefined>;
  createChannelSession(
    session: ChannelSession,
  ): Promise<{ readonly session: ChannelSession; readonly created: boolean }>;
  patchChannelSessionStatus(
    namespace: string,
    name: string | undefined,
    status: ChannelSessionStatus,
  ): Promise<void>;
  createAgentTask(
    task: AgentTask,
  ): Promise<{ readonly task: AgentTask; readonly created: boolean }>;
}

export interface ReconcileChannelInboundInput {
  readonly namespace: string;
  readonly inbound: ChannelInboundEnvelope;
  readonly store: ChannelControllerStore;
  readonly clock?: () => Date;
}

export async function reconcileChannelInbound(
  input: ReconcileChannelInboundInput,
): Promise<ChannelControllerResult> {
  const { namespace, inbound, store } = input;
  const now = (input.clock ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const channel = await store.getChannel(namespace, inbound.channelName);
  if (channel === undefined) {
    return { action: 'denied', reason: 'channel_not_found' };
  }
  if (channel.spec.provider !== inbound.provider || channel.spec.accountId !== inbound.accountId) {
    return { action: 'denied', reason: 'channel_mismatch' };
  }

  const policy = evaluateChannelInboundPolicy(channel, inbound);
  if (!policy.allowed) {
    return { action: 'denied', reason: policy.reason };
  }

  const bindings = await store.listChannelBindings(namespace, inbound.channelName);
  const route = routeChannelInbound(bindings, inbound);
  if (route === undefined) {
    return { action: 'denied', reason: 'no_route' };
  }

  const approval = route.binding.spec.approval;
  if (approval?.required === true) {
    return {
      action: 'approval_required',
      bindingName: route.binding.metadata.name ?? '',
      mode: approval.mode ?? 'operator',
    };
  }

  const task = buildChannelTurnAgentTask({
    namespace,
    name: channelTurnName(inbound),
    route,
    inbound,
  });
  const desiredSession = buildChannelSessionFromTask(channel, route, inbound, task);
  const sessionName = desiredSession.metadata.name ?? '';
  const existingSession = await store.getChannelSession(namespace, sessionName);
  const guarded = guardExistingSession(existingSession, sessionName, now);
  if (guarded !== undefined) return guarded;

  const sessionResult =
    existingSession === undefined
      ? await store.createChannelSession(desiredSession)
      : { session: existingSession, created: false };

  const taskResult = await store.createAgentTask(task);
  if (!taskResult.created) {
    return {
      action: 'duplicate',
      route,
      session: sessionResult.session,
      task: taskResult.task,
    };
  }

  await store.patchChannelSessionStatus(namespace, sessionResult.session.metadata.name, {
    phase: 'Active',
    observedGeneration: sessionResult.session.metadata.generation ?? 1,
    lastInboundAt: nowIso,
    lastTaskRef: {
      namespace,
      name: taskResult.task.metadata.name ?? task.metadata.name ?? '',
      ...(taskResult.task.metadata.uid !== undefined && { uid: taskResult.task.metadata.uid }),
    },
  });

  return {
    action: 'created',
    route,
    session: sessionResult.session,
    task: taskResult.task,
  };
}

export function buildKubernetesChannelControllerStore(
  customApi: CustomObjectsApi,
): ChannelControllerStore {
  return {
    async getChannel(namespace, name): Promise<Channel | undefined> {
      try {
        const obj: unknown = await customApi.getNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: CHANNEL_PLURAL,
          name,
        });
        return isChannel(obj) ? obj : undefined;
      } catch (err) {
        if (isK8sStatus(err, 404)) return undefined;
        throw err;
      }
    },

    async listChannelBindings(namespace, channelName): Promise<readonly ChannelBinding[]> {
      const res = (await customApi.listNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: CHANNEL_BINDING_PLURAL,
      })) as { items?: unknown };
      const items = Array.isArray(res.items) ? res.items : [];
      return items
        .filter(isChannelBinding)
        .filter((binding) => binding.spec.channelRef.name === channelName);
    },

    async getChannelSession(namespace, name): Promise<ChannelSession | undefined> {
      try {
        const obj: unknown = await customApi.getNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: CHANNEL_SESSION_PLURAL,
          name,
        });
        return isChannelSession(obj) ? obj : undefined;
      } catch (err) {
        if (isK8sStatus(err, 404)) return undefined;
        throw err;
      }
    },

    async createChannelSession(session): Promise<{
      readonly session: ChannelSession;
      readonly created: boolean;
    }> {
      try {
        const created = (await customApi.createNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: session.metadata.namespace ?? 'default',
          plural: CHANNEL_SESSION_PLURAL,
          body: session,
        })) as unknown;
        return { session: isChannelSession(created) ? created : session, created: true };
      } catch (err) {
        if (!isK8sStatus(err, 409)) throw err;
        const existing = await this.getChannelSession(
          session.metadata.namespace ?? 'default',
          requiredName(session.metadata.name, 'ChannelSession'),
        );
        if (existing === undefined) throw err;
        return { session: existing, created: false };
      }
    },

    async patchChannelSessionStatus(namespace, name, status): Promise<void> {
      await customApi.patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: CHANNEL_SESSION_PLURAL,
          name: requiredName(name, 'ChannelSession'),
          body: { status } as object,
        },
        mergePatchOptions,
      );
    },

    async createAgentTask(task): Promise<{ readonly task: AgentTask; readonly created: boolean }> {
      try {
        const created = (await customApi.createNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: task.metadata.namespace ?? 'default',
          plural: AGENT_TASK_PLURAL,
          body: task,
        })) as unknown;
        return {
          task: isAgentTaskLike(created) ? created : task,
          created: true,
        };
      } catch (err) {
        if (!isK8sStatus(err, 409)) throw err;
        const existing = (await customApi.getNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: task.metadata.namespace ?? 'default',
          plural: AGENT_TASK_PLURAL,
          name: requiredName(task.metadata.name, 'AgentTask'),
        })) as unknown;
        return {
          task: isAgentTaskLike(existing) ? existing : task,
          created: false,
        };
      }
    },
  };
}

function buildChannelSessionFromTask(
  channel: Channel,
  route: Pick<ChannelRoute, 'binding' | 'target'>,
  inbound: ChannelInboundEnvelope,
  task: AgentTask,
): ChannelSession {
  const labels = task.metadata.labels ?? {};
  const annotations = task.metadata.annotations ?? {};
  const sessionName = labels[CHANNEL_SESSION_LABEL] ?? channelTurnName(inbound);
  const sessionKey = annotations[CHANNEL_SESSION_KEY_ANNOTATION] ?? sessionName;
  const bindingName = route.binding.metadata.name ?? annotations[CHANNEL_BINDING_ANNOTATION] ?? '';
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelSession',
    metadata: {
      name: sessionName,
      ...(task.metadata.namespace !== undefined && { namespace: task.metadata.namespace }),
      labels: {
        'app.kubernetes.io/created-by': CHANNEL_CREATED_BY,
        'kagent.knuteson.io/managed-by': 'kagent-operator',
        [CHANNEL_LABEL]: labels[CHANNEL_LABEL] ?? safeLabelValue(inbound.channelName),
        [CHANNEL_ACCOUNT_LABEL]: labels[CHANNEL_ACCOUNT_LABEL] ?? safeLabelValue(inbound.accountId),
        [CHANNEL_PEER_KIND_LABEL]: labels[CHANNEL_PEER_KIND_LABEL] ?? inbound.peer.kind,
        [CHANNEL_PEER_HASH_LABEL]:
          labels[CHANNEL_PEER_HASH_LABEL] ?? shortHash(`${inbound.peer.kind}:${inbound.peer.id}`),
      },
      annotations: {
        [CHANNEL_PROVIDER_ANNOTATION]: annotations[CHANNEL_PROVIDER_ANNOTATION] ?? inbound.provider,
        [CHANNEL_ACCOUNT_ANNOTATION]: annotations[CHANNEL_ACCOUNT_ANNOTATION] ?? inbound.accountId,
        [CHANNEL_PEER_KIND_ANNOTATION]:
          annotations[CHANNEL_PEER_KIND_ANNOTATION] ?? inbound.peer.kind,
        [CHANNEL_PEER_ID_ANNOTATION]: annotations[CHANNEL_PEER_ID_ANNOTATION] ?? inbound.peer.id,
        [CHANNEL_SESSION_KEY_ANNOTATION]: sessionKey,
        [CHANNEL_BINDING_ANNOTATION]: bindingName,
        ...(inbound.threadId !== undefined && {
          [CHANNEL_THREAD_ANNOTATION]: annotations[CHANNEL_THREAD_ANNOTATION] ?? inbound.threadId,
        }),
      },
      ownerReferences: [
        {
          apiVersion: channel.apiVersion,
          kind: channel.kind,
          name: channel.metadata.name ?? inbound.channelName,
          uid: channel.metadata.uid ?? '',
          controller: false,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: {
      channelRef: { name: inbound.channelName },
      provider: inbound.provider,
      accountId: inbound.accountId,
      peer: inbound.peer,
      ...(inbound.threadId !== undefined && { threadId: inbound.threadId }),
      sessionKey,
      ...(bindingName.length > 0 && { bindingRef: { name: bindingName } }),
      target: route.target,
    },
  };
}

function guardExistingSession(
  session: ChannelSession | undefined,
  sessionName: string,
  now: Date,
): ChannelControllerResult | undefined {
  if (session === undefined) return undefined;
  if (session.spec.paused === true || session.status?.phase === 'Paused') {
    return { action: 'denied', reason: 'session_paused', sessionName };
  }
  if (session.status?.phase === 'Backoff') {
    const backoffUntil = session.status.backoffUntil;
    if (backoffUntil === undefined)
      return { action: 'denied', reason: 'session_backoff', sessionName };
    if (Date.parse(backoffUntil) > now.getTime()) {
      return { action: 'denied', reason: 'session_backoff', sessionName, backoffUntil };
    }
  }
  return undefined;
}

function requiredName(name: string | undefined, kind: string): string {
  if (typeof name === 'string' && name.length > 0) return name;
  throw new Error(`${kind} name is required`);
}

function isK8sStatus(err: unknown, status: number): boolean {
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
  } | null;
  return e?.code === status || e?.statusCode === status || e?.response?.statusCode === status;
}

function isAgentTaskLike(value: unknown): value is AgentTask {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as { apiVersion?: unknown; kind?: unknown; metadata?: unknown; spec?: unknown };
  return obj.apiVersion === API_GROUP_VERSION && obj.kind === 'AgentTask';
}

function channelTurnName(inbound: ChannelInboundEnvelope): string {
  const base = slug(inbound.channelName) || 'channel';
  const hash = shortHash(
    [
      inbound.channelName,
      inbound.provider,
      inbound.accountId,
      inbound.peer.kind,
      inbound.peer.id,
      inbound.threadId ?? '',
      inbound.messageId,
    ].join('\u001f'),
  );
  return `kct-${base.slice(0, 46)}-${hash}`.slice(0, 63);
}

function safeLabelValue(value: string): string {
  if (value.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value)) {
    return value;
  }
  const base = slug(value);
  const hash = shortHash(value);
  if (base.length === 0) return hash;
  return `${base.slice(0, 50)}-${hash}`.slice(0, 63);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
