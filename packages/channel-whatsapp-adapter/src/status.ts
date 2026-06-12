/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { CustomObjectsApi, setHeaderOptions } from '@kubernetes/client-node';

import {
  API_GROUP,
  API_VERSION,
  type ChannelCondition,
  type ChannelStatusPatch,
  type ChannelStatusPatcher,
} from './types.js';

const CHANNEL_PLURAL = 'channels';
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
