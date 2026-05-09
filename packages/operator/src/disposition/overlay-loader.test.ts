/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import type { V1ConfigMap, V1ConfigMapList } from '@kubernetes/client-node';

import {
  loadDispositionOverlayForAgent,
  loadDispositionOverlays,
  type DispositionCoreApi,
} from './overlay-loader.js';

const VALID_DISPOSITION_YAML = `
idleBehavior:
  readChannels: []
  attentionBudget:
    tokensPerDay: 50000
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst:
      - templates
      - verifiers
    maxProposalsPerDay: 3
`;

function makeValidCm(name: string, agentRef: string): V1ConfigMap {
  return {
    metadata: {
      name,
      namespace: 'kagent-system',
      labels: { 'kagent.knuteson.io/agent-disposition': 'true' },
      annotations: { 'kagent.knuteson.io/agent-ref': agentRef },
    },
    data: { 'disposition.yaml': VALID_DISPOSITION_YAML },
  };
}

function makeInvalidCm(name: string): V1ConfigMap {
  // Missing tokensPerDay: parser should reject.
  const yaml = `
idleBehavior:
  readChannels: []
  attentionBudget:
    pollIntervalSeconds: 300
  proposalScope:
    mayProposeAgainst:
      - templates
    maxProposalsPerDay: 3
`;
  return {
    metadata: {
      name,
      namespace: 'kagent-system',
      labels: { 'kagent.knuteson.io/agent-disposition': 'true' },
      annotations: { 'kagent.knuteson.io/agent-ref': 'kagent-system/broken-agent' },
    },
    data: { 'disposition.yaml': yaml },
  };
}

function fakeApi(items: V1ConfigMap[]): {
  api: DispositionCoreApi;
  listFn: ReturnType<typeof vi.fn>;
} {
  const list: V1ConfigMapList = { items };
  const listFn = vi.fn().mockResolvedValue(list);
  return {
    api: { listNamespacedConfigMap: listFn as DispositionCoreApi['listNamespacedConfigMap'] },
    listFn,
  };
}

describe('loadDispositionOverlays', () => {
  it('lists ConfigMaps with the disposition label and returns parsed overlays', async () => {
    const { api, listFn } = fakeApi([
      makeValidCm('researcher-01-disposition', 'kagent-system/researcher-01'),
      makeValidCm('writer-02-disposition', 'kagent-system/writer-02'),
    ]);
    const result = await loadDispositionOverlays(api, 'kagent-system');
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(listFn.mock.calls[0]?.[0]).toEqual({
      namespace: 'kagent-system',
      labelSelector: 'kagent.knuteson.io/agent-disposition=true',
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.agentName).toBe('researcher-01');
    expect(result[1]?.agentName).toBe('writer-02');
  });

  it('filters out invalid ConfigMaps and logs each error via logger.warn', async () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m) };
    const { api } = fakeApi([
      makeValidCm('researcher-01-disposition', 'kagent-system/researcher-01'),
      makeInvalidCm('broken-agent-disposition'),
    ]);
    const result = await loadDispositionOverlays(api, 'kagent-system', logger);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentName).toBe('researcher-01');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/broken-agent-disposition/);
    expect(warnings[0]).toMatch(/tokensPerDay/);
  });

  it('returns an empty array when there are no ConfigMaps', async () => {
    const { api } = fakeApi([]);
    const result = await loadDispositionOverlays(api, 'kagent-system');
    expect(result).toEqual([]);
  });
});

describe('loadDispositionOverlayForAgent', () => {
  it('returns the overlay matching agentRef', async () => {
    const { api } = fakeApi([
      makeValidCm('researcher-01-disposition', 'kagent-system/researcher-01'),
      makeValidCm('writer-02-disposition', 'kagent-system/writer-02'),
    ]);
    const overlay = await loadDispositionOverlayForAgent(api, 'kagent-system', 'writer-02');
    expect(overlay).not.toBeNull();
    expect(overlay?.agentName).toBe('writer-02');
    expect(overlay?.configMapName).toBe('writer-02-disposition');
  });

  it('returns null when no overlay matches the Agent', async () => {
    const { api } = fakeApi([
      makeValidCm('researcher-01-disposition', 'kagent-system/researcher-01'),
    ]);
    const overlay = await loadDispositionOverlayForAgent(api, 'kagent-system', 'unknown-agent');
    expect(overlay).toBeNull();
  });
});
