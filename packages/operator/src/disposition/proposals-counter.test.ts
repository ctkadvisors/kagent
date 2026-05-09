/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Unit tests for the proposals-today annotation-writer helper. Covers
 * the pure rollover/baseline rules, the K8s patch call shape, and the
 * optimistic-concurrency CAS retry loop.
 */

import { describe, expect, it, vi } from 'vitest';

import type { V1ConfigMap } from '@kubernetes/client-node';

import {
  DISPOSITION_PROPOSALS_TODAY_ANNOTATION,
  DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION,
  type DispositionOverlay,
} from '@kagent/dto';

import {
  buildProposalsTodayPatchBody,
  computeNextProposalsTodayPatch,
  formatUtcDay,
  incrementProposalsToday,
  type ProposalsCounterCoreApi,
} from './proposals-counter.js';

const TODAY = new Date(Date.UTC(2026, 4, 9, 3, 0, 0)); // 2026-05-09 03:00 UTC
const TODAY_DAY = '2026-05-09';
const YESTERDAY_DAY = '2026-05-08';

function makeOverlay(): DispositionOverlay {
  return {
    agentRef: 'kagent-system/researcher-01',
    agentNamespace: 'kagent-system',
    agentName: 'researcher-01',
    configMapName: 'researcher-01-disposition',
    configMapNamespace: 'kagent-system',
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst: ['templates'], maxProposalsPerDay: 3 },
    },
  };
}

function makeConfigMapBody(
  annotations: Record<string, string>,
  resourceVersion = 'rv-1',
): V1ConfigMap {
  return {
    metadata: {
      name: 'researcher-01-disposition',
      namespace: 'kagent-system',
      annotations,
      resourceVersion,
    },
    data: {
      'disposition.yaml': '...',
    },
  };
}

describe('formatUtcDay', () => {
  it('formats UTC year/month/day with two-digit padding', () => {
    expect(formatUtcDay(new Date(Date.UTC(2026, 0, 9, 23, 30, 0)))).toBe('2026-01-09');
    expect(formatUtcDay(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2026-12-31');
  });
});

describe('computeNextProposalsTodayPatch', () => {
  it('Test 1 — same-day increment', () => {
    const result = computeNextProposalsTodayPatch({
      currentValue: '2',
      currentDay: TODAY_DAY,
      todayDay: TODAY_DAY,
    });
    expect(result).toEqual({ nextValue: '3', nextDay: TODAY_DAY });
  });

  it('Test 2 — rollover from yesterday resets to 1', () => {
    const result = computeNextProposalsTodayPatch({
      currentValue: '5',
      currentDay: YESTERDAY_DAY,
      todayDay: TODAY_DAY,
    });
    expect(result).toEqual({ nextValue: '1', nextDay: TODAY_DAY });
  });

  it('Test 3 — missing annotations starts at 1', () => {
    const result = computeNextProposalsTodayPatch({
      currentValue: undefined,
      currentDay: undefined,
      todayDay: TODAY_DAY,
    });
    expect(result).toEqual({ nextValue: '1', nextDay: TODAY_DAY });
  });

  it('Test 4 — malformed numeric annotation is treated as 0 (rollover semantics)', () => {
    const result = computeNextProposalsTodayPatch({
      currentValue: 'not-a-number',
      currentDay: TODAY_DAY,
      todayDay: TODAY_DAY,
    });
    expect(result).toEqual({ nextValue: '1', nextDay: TODAY_DAY });
  });

  it('negative value is treated as 0 baseline', () => {
    const result = computeNextProposalsTodayPatch({
      currentValue: '-3',
      currentDay: TODAY_DAY,
      todayDay: TODAY_DAY,
    });
    expect(result).toEqual({ nextValue: '1', nextDay: TODAY_DAY });
  });
});

describe('buildProposalsTodayPatchBody', () => {
  it('emits the JSON-Patch test+replace+replace shape with JSON-Pointer escapes', () => {
    const body = buildProposalsTodayPatchBody({
      resourceVersion: 'rv-42',
      nextValue: '3',
      nextDay: TODAY_DAY,
    });
    expect(body).toEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: 'rv-42' },
      {
        op: 'replace',
        path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
        value: '3',
      },
      {
        op: 'replace',
        path: '/metadata/annotations/kagent.knuteson.io~1proposals-today-day',
        value: TODAY_DAY,
      },
    ]);
  });
});

describe('incrementProposalsToday', () => {
  it('Test 5 — issues a JSON-Patch test+replace patch with the expected shape', async () => {
    const cm = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '2',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-7',
    );
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY });
    expect(coreApi.readNamespacedConfigMap).toHaveBeenCalledTimes(1);
    expect(coreApi.patchNamespacedConfigMap).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(coreApi.patchNamespacedConfigMap).mock.calls[0]![0];
    expect(callArg.name).toBe('researcher-01-disposition');
    expect(callArg.namespace).toBe('kagent-system');
    expect(callArg.body).toEqual([
      { op: 'test', path: '/metadata/resourceVersion', value: 'rv-7' },
      {
        op: 'replace',
        path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
        value: '3',
      },
      {
        op: 'replace',
        path: '/metadata/annotations/kagent.knuteson.io~1proposals-today-day',
        value: TODAY_DAY,
      },
    ]);
  });

  it('Test 1 — same-day increment writes "3" when annotation is "2"', async () => {
    const cm = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '2',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-1',
    );
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY });
    const ops = vi.mocked(coreApi.patchNamespacedConfigMap).mock.calls[0]![0].body as Array<
      Record<string, unknown>
    >;
    expect(ops[1]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: '3',
    });
    expect(ops[2]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today-day',
      value: TODAY_DAY,
    });
  });

  it('Test 2 — rollover from yesterday writes "1" + today day annotation', async () => {
    const cm = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '5',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: YESTERDAY_DAY,
      },
      'rv-99',
    );
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY });
    const ops = vi.mocked(coreApi.patchNamespacedConfigMap).mock.calls[0]![0].body as Array<
      Record<string, unknown>
    >;
    expect(ops[1]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: '1',
    });
    expect(ops[2]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today-day',
      value: TODAY_DAY,
    });
  });

  it('Test 3 — missing annotations writes "1" and today day', async () => {
    const cm = makeConfigMapBody({}, 'rv-empty');
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY });
    const ops = vi.mocked(coreApi.patchNamespacedConfigMap).mock.calls[0]![0].body as Array<
      Record<string, unknown>
    >;
    expect(ops[1]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: '1',
    });
  });

  it('Test 4 — malformed numeric annotation is treated as 0; written as "1"', async () => {
    const cm = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: 'not-a-number',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-mal',
    );
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY });
    const ops = vi.mocked(coreApi.patchNamespacedConfigMap).mock.calls[0]![0].body as Array<
      Record<string, unknown>
    >;
    expect(ops[1]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: '1',
    });
  });

  it('Test 7 — patch failure (non-409) does NOT throw; logs via injected logger and returns', async () => {
    const cm = makeConfigMapBody({}, 'rv-1');
    const err = Object.assign(new Error('forbidden'), { code: 403 });
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: vi.fn(() => Promise.resolve(cm)),
      patchNamespacedConfigMap: vi.fn(() => Promise.reject(err)),
    };
    const logger = { warn: vi.fn(), info: vi.fn() };
    await expect(
      incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY, logger }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('proposals-counter: increment failed'),
    );
  });

  it('Test 8 — concurrency CAS retry success: two 409 conflicts then a 200 success', async () => {
    const cm1 = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '0',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-1',
    );
    const cm2 = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '1',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-2',
    );
    const cm3 = makeConfigMapBody(
      {
        [DISPOSITION_PROPOSALS_TODAY_ANNOTATION]: '2',
        [DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION]: TODAY_DAY,
      },
      'rv-3',
    );
    const conflictErr = Object.assign(new Error('conflict'), { code: 409 });
    const reads = vi
      .fn<ProposalsCounterCoreApi['readNamespacedConfigMap']>()
      .mockResolvedValueOnce(cm1)
      .mockResolvedValueOnce(cm2)
      .mockResolvedValueOnce(cm3);
    const patches = vi
      .fn<ProposalsCounterCoreApi['patchNamespacedConfigMap']>()
      .mockRejectedValueOnce(conflictErr)
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce(cm3);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: reads,
      patchNamespacedConfigMap: patches,
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY, logger });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(patches).toHaveBeenCalledTimes(3);
    // The third (successful) patch must use rv-3 captured from the third read.
    const finalCall = patches.mock.calls[2]![0];
    const finalOps = finalCall.body as Array<Record<string, unknown>>;
    expect(finalOps[0]).toEqual({
      op: 'test',
      path: '/metadata/resourceVersion',
      value: 'rv-3',
    });
    // The third call increments from value=2 (from cm3) to "3".
    expect(finalOps[1]).toEqual({
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: '3',
    });
    // No warn-level give-up; only info-level retry breadcrumbs.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('Test 9 — concurrency CAS retry give-up: four consecutive 409 conflicts logs warn and stops', async () => {
    const cm = makeConfigMapBody({}, 'rv-x');
    const conflictErr = Object.assign(new Error('conflict'), { code: 409 });
    const reads = vi.fn<ProposalsCounterCoreApi['readNamespacedConfigMap']>().mockResolvedValue(cm);
    const patches = vi
      .fn<ProposalsCounterCoreApi['patchNamespacedConfigMap']>()
      .mockRejectedValue(conflictErr);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: reads,
      patchNamespacedConfigMap: patches,
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY, logger });
    // 1 initial + 3 retries = 4 attempts; on the fourth conflict the
    // helper must give up and NOT issue a fifth patch.
    expect(patches).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gave up after 3 conflicts'));
  });

  it('handles 409 surfaced via response.statusCode shape', async () => {
    const cm = makeConfigMapBody({}, 'rv-z');
    const conflictErr = { response: { statusCode: 409 } } as unknown;
    const reads = vi.fn<ProposalsCounterCoreApi['readNamespacedConfigMap']>().mockResolvedValue(cm);
    const patches = vi
      .fn<ProposalsCounterCoreApi['patchNamespacedConfigMap']>()
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce(cm);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: reads,
      patchNamespacedConfigMap: patches,
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY, logger });
    expect(patches).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns without patching when resourceVersion is missing on the read', async () => {
    const cm = {
      metadata: { name: 'researcher-01-disposition', namespace: 'kagent-system', annotations: {} },
    } as V1ConfigMap;
    const reads = vi.fn<ProposalsCounterCoreApi['readNamespacedConfigMap']>().mockResolvedValue(cm);
    const patches = vi.fn<ProposalsCounterCoreApi['patchNamespacedConfigMap']>();
    const logger = { warn: vi.fn(), info: vi.fn() };
    const coreApi: ProposalsCounterCoreApi = {
      readNamespacedConfigMap: reads,
      patchNamespacedConfigMap: patches,
    };
    await incrementProposalsToday({ coreApi, overlay: makeOverlay(), now: TODAY, logger });
    expect(patches).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing resourceVersion'));
  });
});
