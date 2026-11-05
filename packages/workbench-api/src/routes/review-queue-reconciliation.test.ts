/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { parseAgentTemplateSpec, type AgentTask } from '@kagent/dto';
import type { SnapshotCache } from '../cache.js';
import { reviewQueueRoute, type ReviewQueueRouteDeps } from './review-queue.js';
import originals from '../__fixtures__/accepted-fenceaudit-tasks.json' with { type: 'json' };

const DECISION = 'kagent.knuteson.io/review-decision';
const FROM = 'kagent.knuteson.io/promoted-from-task';
const NAME = 'capability-fenceaudit';
const task = (suffix: string) =>
  structuredClone(
    originals.find((value) => value.metadata.name.endsWith(suffix))!,
  ) as unknown as AgentTask;
const old = () => task('1793464500');
const accepted = () => task('1793714700');
const rejected = () => task('1793656200');
const final = (value: AgentTask) =>
  value.status!.artifacts!.at(-1)! as unknown as {
    name: string;
    checksum: string;
    payloadBase64: string;
    producedAt: string;
  };
const spec = (value: AgentTask) => {
  const result = parseAgentTemplateSpec(
    Buffer.from(final(value).payloadBase64, 'base64').toString('utf8'),
  );
  if (!result.ok) throw new Error(result.error);
  return result.spec;
};
function setup(tasks: AgentTask[] = [old(), accepted(), rejected()], current = old()) {
  const template = {
    metadata: {
      name: NAME,
      namespace: 'kagent-system',
      uid: 'template-uid',
      resourceVersion: '42',
      annotations: { [FROM]: 'kagent-system/' + current.metadata.name },
    },
    spec: spec(current),
  };
  const customApi = {
    createNamespacedCustomObject: vi.fn().mockRejectedValue({ code: 409, body: 'already exists' }),
    getNamespacedCustomObject: vi
      .fn()
      .mockImplementation((args: { plural: string; name: string }) => {
        if (args.plural === 'agenttemplates') return Promise.resolve(template);
        const found = tasks.find((value) => value.metadata.name === args.name);
        return found
          ? Promise.resolve(found)
          : Promise.reject(Object.assign(new Error('missing source'), { code: 404 }));
      }),
    replaceNamespacedCustomObject: vi
      .fn()
      .mockImplementation((args: { body: unknown }) => Promise.resolve(args.body)),
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  };
  const auditPublisher = { publish: vi.fn().mockResolvedValue(undefined) };
  const cache = {
    listTasks: () => tasks,
    getTask: (namespace: string, name: string) =>
      tasks.find((value) => value.metadata.namespace === namespace && value.metadata.name === name),
  } as unknown as SnapshotCache;
  const app = new Hono();
  app.route(
    '/',
    reviewQueueRoute({
      cache,
      customApi: customApi as unknown as ReviewQueueRouteDeps['customApi'],
      auditPublisher,
    }),
  );
  const post = (value: AgentTask, fields: Record<string, unknown> = {}) =>
    app.request('/kagent-system/' + value.metadata.name + '/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedArtifactName: NAME,
        expectedArtifactChecksum: final(value).checksum,
        ...fields,
      }),
    });
  return { app, post, customApi, auditPublisher, template, tasks };
}

describe('accepted template chronology and reconciliation', () => {
  it('reproduces and refuses the original Oct31 task displacing the newer Nov3 template', async () => {
    const stale = old();
    delete stale.metadata.annotations![DECISION];
    const s = setup([stale, accepted()], accepted());
    const response = await s.post(stale);
    expect(response.status).toBe(409);
    expect(s.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.auditPublisher.publish).not.toHaveBeenCalled();
  });

  it('restores the exact already-accepted newer final without creating a new task decision', async () => {
    const s = setup();
    const preserved = JSON.stringify(s.tasks);
    const response = await s.post(accepted(), { reconcileAccepted: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reconciled: true,
      unchanged: false,
      agentTemplateRef: { name: NAME },
    });
    expect(s.customApi.createNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce();
    expect(s.customApi.replaceNamespacedCustomObject.mock.calls[0]?.[0]).toMatchObject({
      body: {
        metadata: {
          resourceVersion: '42',
          annotations: { [FROM]: 'kagent-system/' + accepted().metadata.name },
        },
        spec: spec(accepted()),
      },
    });
    expect(s.customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.auditPublisher.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(s.tasks)).toBe(preserved);
    expect(rejected().metadata.annotations![DECISION]).toBe('rejected');
  });

  it('is idempotent only when the selected target binding is already current', async () => {
    const s = setup(undefined, accepted());
    const response = await s.post(accepted(), { reconcileAccepted: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reconciled: true, unchanged: true });
    expect(s.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.auditPublisher.publish).not.toHaveBeenCalled();
  });

  it('keeps normal already-decided POSTs and rejected reconciliation refused', async () => {
    const s = setup();
    expect((await s.post(accepted())).status).toBe(409);
    expect((await s.post(rejected(), { reconcileAccepted: true })).status).toBe(409);
    expect(s.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it.each([
    { expectedArtifactName: undefined },
    { expectedArtifactChecksum: undefined },
    { expectedArtifactChecksum: 'sha256:' + '0'.repeat(64) },
  ])('requires the exact final artifact selectors: %j', async (selector) => {
    const s = setup();
    const response = await s.post(accepted(), { reconcileAccepted: true, ...selector });
    expect([400, 409]).toContain(response.status);
    expect(s.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('refuses an earlier same-name probe even when its bytes match the requested checksum', async () => {
    const candidate = accepted();
    const s = setup();
    const artifact = candidate.status!.artifacts![0]! as unknown as { checksum: string };
    expect(
      (
        await s.post(candidate, {
          reconcileAccepted: true,
          expectedArtifactChecksum: artifact.checksum,
        })
      ).status,
    ).toBe(409);
    expect(s.customApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it.each([
    'missing-completion',
    'equal-completion',
    'missing-source',
    'cas-race',
    'manual-template',
    'missing-resource-version',
    'post-decision-artifact',
  ])('fails closed on unsafe reconciliation: %s', async (scenario) => {
    const candidate = accepted();
    const current = old();
    if (scenario === 'missing-completion') delete candidate.status!.completedAt;
    if (scenario === 'equal-completion')
      current.status!.completedAt = candidate.status!.completedAt;
    if (scenario === 'post-decision-artifact') final(candidate).producedAt = '2026-11-03T17:30:00Z';
    const s = setup([candidate, current], current);
    if (scenario === 'missing-source')
      s.template.metadata.annotations[FROM] = 'kagent-system/absent';
    if (scenario === 'cas-race')
      s.customApi.replaceNamespacedCustomObject.mockRejectedValue({ code: 409 });
    if (scenario === 'manual-template')
      delete (s.template.metadata.annotations as Record<string, string>)[FROM];
    if (scenario === 'missing-resource-version')
      delete (s.template.metadata as { resourceVersion?: string }).resourceVersion;
    const response = await s.post(candidate, { reconcileAccepted: true });
    expect(response.status).toBe(409);
    expect(s.customApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(s.auditPublisher.publish).not.toHaveBeenCalled();
  });

  it('still allows a genuinely newer ordinary candidate and uses the live template resourceVersion', async () => {
    const candidate = accepted();
    delete candidate.metadata.annotations![DECISION];
    const s = setup([old(), candidate]);
    expect((await s.post(candidate)).status).toBe(200);
    expect(s.customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce();
    expect(s.customApi.patchNamespacedCustomObject).toHaveBeenCalledOnce();
  });
});

describe('bounded accepted candidate discovery', () => {
  it('returns only admitted candidates, exact finals, newest completedAt first', async () => {
    const s = setup();
    const response = await s.app.request('/?candidates=true&acceptedForTemplate=' + NAME);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<{
        taskRef: { name: string };
        candidateTemplate: { artifactRef: { checksum: string } };
      }>;
    };
    expect(body.items.map((row) => row.taskRef.name)).toEqual([
      accepted().metadata.name,
      old().metadata.name,
    ]);
    expect(body.items[0]?.candidateTemplate.artifactRef.checksum).toBe(final(accepted()).checksum);
  });

  it.each(['', '../outside', 'CAPABILITY', 'a'.repeat(64)])(
    'rejects an invalid template query: %s',
    async (name) => {
      const s = setup();
      expect(
        (await s.app.request('/?candidates=true&acceptedForTemplate=' + encodeURIComponent(name)))
          .status,
      ).toBe(400);
    },
  );

  it.each(['tie', 'invalid-final', 'missing-completion'])(
    'never falls back from an ambiguous/unavailable latest source: %s',
    async (scenario) => {
      const latest = accepted();
      if (scenario === 'missing-completion') delete latest.status!.completedAt;
      if (scenario === 'invalid-final')
        final(latest).payloadBase64 = Buffer.from('not a template').toString('base64');
      const tasks = [old(), latest];
      if (scenario === 'tie') {
        const other = accepted();
        other.metadata.name += '-tie';
        tasks.push(other);
      }
      const s = setup(tasks);
      expect((await s.app.request('/?candidates=true&acceptedForTemplate=' + NAME)).status).toBe(
        409,
      );
    },
  );
});

it('refuses an earlier probe sharing the final URI, and contradictory current admission metadata', async () => {
  const candidate = accepted();
  const artifacts = candidate.status!.artifacts! as unknown as Array<{
    uri: string;
    checksum: string;
  }>;
  artifacts[0]!.uri = artifacts.at(-1)!.uri;
  const s = setup([old(), candidate]);
  expect(
    (
      await s.post(candidate, {
        reconcileAccepted: true,
        expectedArtifactChecksum: artifacts[0]!.checksum,
      })
    ).status,
  ).toBe(409);
  const current = setup(undefined, accepted());
  (current.template.metadata.annotations as Record<string, string>)[
    'kagent.knuteson.io/promoted-artifact-name'
  ] = NAME;
  (current.template.metadata.annotations as Record<string, string>)[
    'kagent.knuteson.io/promoted-artifact-checksum'
  ] = 'sha256:' + '0'.repeat(64);
  expect((await current.post(accepted(), { reconcileAccepted: true })).status).toBe(409);
});

it('bounds discovery to 100 latest sources and rejects conflicting query identities', async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => {
    const value = accepted();
    value.metadata.name += '-' + index;
    value.status!.completedAt = new Date(
      Date.parse(value.status!.completedAt!) + index * 1000,
    ).toISOString();
    value.metadata.annotations!['kagent.knuteson.io/review-decided-at'] = new Date(
      Date.parse(value.status!.completedAt) + 1000,
    ).toISOString();
    return value;
  });
  const s = setup(tasks);
  const result = (await (
    await s.app.request('/?candidates=true&acceptedForTemplate=' + NAME)
  ).json()) as { items: Array<{ taskRef: { name: string } }>; hasMore: boolean };
  expect(result.items).toHaveLength(100);
  expect(result.items[0]?.taskRef.name).toBe(tasks.at(-1)!.metadata.name);
  expect(result.hasMore).toBe(true);
  expect((await s.app.request('/?acceptedForTemplate=' + NAME)).status).toBe(400);
  expect(
    (
      await s.app.request(
        '/?candidates=true&acceptedForTemplate=' + NAME + '&acceptedForTemplate=other',
      )
    ).status,
  ).toBe(400);
});

it('revises a template whose recorded admission the API server normalized on write', async () => {
  // Live 2026-11-05: capability-shapecapture-probe's fixed version was refused (409) because the
  // stored spec carried the CRD default revisionHistoryLimit that the admitted YAML omits.
  const normalize = (value: unknown) => ({ revisionHistoryLimit: 20, ...(value as object) });
  const s = setup(undefined, old());
  const annotations = s.template.metadata.annotations as Record<string, string>;
  annotations['kagent.knuteson.io/promoted-artifact-name'] = NAME;
  annotations['kagent.knuteson.io/promoted-artifact-checksum'] = final(old()).checksum;
  const stored = s.template as { spec: unknown };
  stored.spec = normalize(spec(old()));
  s.customApi.createNamespacedCustomObject.mockImplementation(
    (args: { dryRun?: string; body: { spec: unknown } }) =>
      args.dryRun === 'All'
        ? Promise.resolve({ ...args.body, spec: normalize(args.body.spec) })
        : Promise.reject(Object.assign(new Error('already exists'), { code: 409 })),
  );
  expect((await s.post(accepted(), { reconcileAccepted: true })).status).toBe(200);
  expect(s.customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce();
  // A stored spec changed after admission still refuses.
  stored.spec = { ...normalize(spec(old())), revisionHistoryLimit: 7 };
  expect((await s.post(accepted(), { reconcileAccepted: true })).status).toBe(409);
  expect(s.customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce();
});

it('reads a current source missing from cache through Kubernetes and preserves CAS', async () => {
  const candidate = accepted();
  const s = setup([candidate]);
  s.customApi.getNamespacedCustomObject.mockImplementation((args: { plural: string }) =>
    Promise.resolve(args.plural === 'agenttemplates' ? s.template : old()),
  );
  expect((await s.post(candidate, { reconcileAccepted: true })).status).toBe(200);
  expect(s.customApi.getNamespacedCustomObject).toHaveBeenCalledWith(
    expect.objectContaining({ plural: 'agenttasks', name: old().metadata.name }),
  );
  expect(s.customApi.replaceNamespacedCustomObject.mock.calls[0]?.[0]).toMatchObject({
    body: { metadata: { resourceVersion: '42' } },
  });
});
