/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { CustomObjectsApi, setHeaderOptions } from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  API_GROUP_VERSION,
  type AgentTask,
  type ChannelCondition,
  type ChannelOutboxStore,
  type ChannelSession,
  type ChannelSessionStatusPatch,
  type ChannelStatusPatch,
  type ChannelStatusPatcher,
} from './types.js';

const CHANNEL_PLURAL = 'channels';
const CHANNEL_SESSION_PLURAL = 'channelsessions';
const AGENT_TASK_PLURAL = 'agenttasks';
const mergePatchOptions = setHeaderOptions('Content-Type', 'application/merge-patch+json');

export function buildKubernetesChannelStatusPatcher(input: {
  readonly customApi: CustomObjectsApi;
  readonly namespace: string;
  readonly channelName: string;
}): ChannelStatusPatcher {
  return {
    async patch(status: ChannelStatusPatch): Promise<void> {
      await input.customApi.patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace: input.namespace,
          plural: CHANNEL_PLURAL,
          name: input.channelName,
          body: { status } as object,
        },
        mergePatchOptions,
      );
    },
  };
}

export function adapterCondition(input: {
  readonly type: string;
  readonly status: ChannelCondition['status'];
  readonly reason: string;
  readonly message: string;
  readonly now: Date;
}): ChannelCondition {
  return {
    type: input.type,
    status: input.status,
    reason: input.reason,
    message: input.message,
    lastTransitionTime: input.now.toISOString(),
  };
}

export function buildKubernetesChannelOutboxStore(input: {
  readonly customApi: CustomObjectsApi;
}): ChannelOutboxStore {
  return {
    async listChannelSessions(query): Promise<readonly ChannelSession[]> {
      const res = (await input.customApi.listNamespacedCustomObject({
        group: API_GROUP,
        version: API_VERSION,
        namespace: query.namespace,
        plural: CHANNEL_SESSION_PLURAL,
      })) as { readonly items?: readonly unknown[] };
      const items = Array.isArray(res.items) ? res.items : [];
      return items.filter(isChannelSession).filter((session) => {
        return (
          session.spec.channelRef.name === query.channelName &&
          session.spec.provider === 'telegram' &&
          session.spec.accountId === query.accountId
        );
      });
    },

    async getAgentTask(ref): Promise<AgentTask | undefined> {
      try {
        const obj = (await input.customApi.getNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace: ref.namespace,
          plural: AGENT_TASK_PLURAL,
          name: ref.name,
        })) as unknown;
        return isAgentTask(obj) ? obj : undefined;
      } catch (err) {
        if (isK8sStatus(err, 404)) return undefined;
        throw err;
      }
    },

    async patchSessionStatus(
      namespace: string,
      name: string,
      status: ChannelSessionStatusPatch,
    ): Promise<void> {
      await input.customApi.patchNamespacedCustomObjectStatus(
        {
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: CHANNEL_SESSION_PLURAL,
          name,
          body: { status } as object,
        },
        mergePatchOptions,
      );
    },
  };
}

function isChannelSession(value: unknown): value is ChannelSession {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as {
    readonly apiVersion?: unknown;
    readonly kind?: unknown;
    readonly metadata?: unknown;
    readonly spec?: {
      readonly channelRef?: { readonly name?: unknown };
      readonly provider?: unknown;
      readonly accountId?: unknown;
      readonly peer?: { readonly kind?: unknown; readonly id?: unknown };
      readonly sessionKey?: unknown;
      readonly target?: unknown;
    };
  };
  if (obj.apiVersion !== API_GROUP_VERSION || obj.kind !== 'ChannelSession') return false;
  if (typeof obj.metadata !== 'object' || obj.metadata === null) return false;
  const spec = obj.spec;
  return (
    typeof spec === 'object' &&
    spec !== null &&
    isNonEmptyString(spec.channelRef?.name) &&
    isNonEmptyString(spec.provider) &&
    isNonEmptyString(spec.accountId) &&
    isNonEmptyString(spec.peer?.kind) &&
    isNonEmptyString(spec.peer?.id) &&
    isNonEmptyString(spec.sessionKey) &&
    typeof spec.target === 'object' &&
    spec.target !== null
  );
}

function isAgentTask(value: unknown): value is AgentTask {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as {
    readonly apiVersion?: unknown;
    readonly kind?: unknown;
    readonly metadata?: unknown;
    readonly spec?: unknown;
  };
  return (
    obj.apiVersion === API_GROUP_VERSION &&
    obj.kind === 'AgentTask' &&
    typeof obj.metadata === 'object' &&
    obj.metadata !== null &&
    typeof obj.spec === 'object' &&
    obj.spec !== null
  );
}

function isK8sStatus(err: unknown, status: number): boolean {
  const e = err as {
    readonly code?: unknown;
    readonly statusCode?: unknown;
    readonly response?: { readonly statusCode?: unknown };
  } | null;
  return e?.code === status || e?.statusCode === status || e?.response?.statusCode === status;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
