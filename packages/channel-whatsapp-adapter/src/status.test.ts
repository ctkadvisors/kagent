/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { buildKubernetesChannelStatusPatcher } from './status.js';

describe('buildKubernetesChannelStatusPatcher', () => {
  it('merge-patches Channel.status in the adapter namespace', async () => {
    const customApi = {
      patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
    };
    const patcher = buildKubernetesChannelStatusPatcher({
      customApi: customApi as never,
      namespace: 'kagent-system',
      channelName: 'whatsapp-work',
    });

    await patcher.patch({
      phase: 'Pairing',
      pairing: { state: 'qr', qrCode: 'qr-data' },
    });

    expect(customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalledWith(
      {
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: 'kagent-system',
        plural: 'channels',
        name: 'whatsapp-work',
        body: { status: { phase: 'Pairing', pairing: { state: 'qr', qrCode: 'qr-data' } } },
      },
      expect.any(Object),
    );
  });
});
