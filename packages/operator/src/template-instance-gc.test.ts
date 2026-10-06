/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { AddressInfo } from 'node:net';

import type { CustomObjectsApi } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

import type { AgentTemplate } from './crds/types.js';
import { API_GROUP_VERSION } from './crds/types.js';
import { mergePatchOptions } from './k8s.js';
import { startTemplateServer } from './template-server.js';

// An instantiate retires its template's stale instances: other Agents from the same
// template that no unfinished AgentTask targets and that were not used in the last hour.
// Without it every re-promotion leaves an Agent behind (35 check Agents for 19 checks).
// The reuse refresh of last-used-at must be a merge patch (k8s.ts): the client's default
// JSON-patch is rejected for an object body, so the sweep would see a busy Agent as idle.
const T0 = new Date('2026-10-06T12:00:00Z');
const OLD = '2026-10-04T12:00:00.000Z';
const FROM = 'kagent.knuteson.io/from-template';
const USED = 'kagent.knuteson.io/last-used-at';

const template: AgentTemplate = {
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentTemplate',
  metadata: { name: 'summarizer', namespace: 'ns' },
  spec: {
    templateVersion: 1,
    parameters: [{ name: 'topic', type: 'string', pattern: '^[a-z]{1,20}$', required: true }],
    toolAllowlist: [],
    toolDefaults: [],
    agentSpec: { model: 'm', systemPrompt: 'sum ${param.topic}' },
  },
};

type Obj = {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: unknown;
  status?: unknown;
};
const agent = (name: string, from?: string, used = OLD): Obj => ({
  metadata: {
    name,
    labels: from === undefined ? {} : { [FROM]: from },
    annotations: { [USED]: used },
  },
});
const task = (target: string, phase?: string): Obj => ({
  metadata: { name: `t-${target}-${phase ?? 'new'}` },
  spec: { targetAgent: target },
  ...(phase !== undefined && { status: { phase } }),
});

function cluster(agents: Obj[], tasks: Obj[], failList = false) {
  const deleted: string[] = [];
  const patched: { name: string; body: unknown; options: unknown }[] = [];
  const fail = (code: number) => Promise.reject(Object.assign(new Error(String(code)), { code }));
  const api = {
    getNamespacedCustomObject: () => Promise.resolve(template),
    createNamespacedCustomObject(a: { body: Obj }) {
      if (agents.some((x) => x.metadata.name === a.body.metadata.name)) return fail(409);
      agents.push(a.body);
      return Promise.resolve(a.body);
    },
    listNamespacedCustomObject(a: { plural: string; labelSelector?: string }) {
      if (failList) return fail(500);
      const items = a.plural === 'agents' ? agents : a.plural === 'agenttasks' ? tasks : [];
      const want = (a.labelSelector ?? '')
        .split(',')
        .filter(Boolean)
        .map((kv) => kv.split('='));
      return Promise.resolve({
        items: items.filter((o) => want.every(([k = '', v]) => o.metadata.labels?.[k] === v)),
      });
    },
    deleteNamespacedCustomObject(a: { plural: string; name: string }) {
      if (a.plural === 'agents') deleted.push(a.name);
      return Promise.resolve({});
    },
    patchNamespacedCustomObject(a: { name: string; body: unknown }, options?: unknown) {
      patched.push({ name: a.name, body: a.body, options });
      return Promise.resolve({});
    },
  };
  return { api: api as unknown as CustomObjectsApi, deleted, patched };
}

async function instantiate(api: CustomObjectsApi, now: Date) {
  const handle = await startTemplateServer(0, {
    customApi: api,
    resolveNamespace: () => 'ns',
    clock: () => now,
  });
  if (handle === undefined) throw new Error('server did not bind');
  try {
    const { port } = handle.server.address() as AddressInfo;
    const res = await fetch(
      `http://127.0.0.1:${String(port)}/v1alpha1/templates/summarizer:instantiate`,
      {
        method: 'POST',
        body: JSON.stringify({ parameterValues: { topic: 'alpha' }, createdByTaskUid: 'uid-1' }),
      },
    );
    return { status: res.status, body: (await res.json()) as { agentName: string } };
  } finally {
    await handle.close();
  }
}

describe('instantiate retires stale instances of its template', () => {
  it('deletes idle older instances of the same template and nothing else', async () => {
    const agents = [
      agent('summarizer-old', 'summarizer'),
      agent('summarizer-done', 'summarizer'),
      agent('summarizer-running', 'summarizer'),
      agent('summarizer-queued', 'summarizer'),
      agent('summarizer-recent', 'summarizer', '2026-10-06T11:50:00.000Z'),
      agent('other-old', 'other'),
      agent('handmade'),
    ];
    const tasks = [
      task('summarizer-done', 'Completed'),
      task('summarizer-done', 'Failed'),
      task('summarizer-running', 'Dispatched'),
      task('summarizer-queued'),
    ];
    const c = cluster(agents, tasks);
    const r = await instantiate(c.api, T0);
    expect(r.status).toBe(201);
    expect([...c.deleted].sort()).toEqual(['summarizer-done', 'summarizer-old']);
  });

  it('sweeps on reuse too, merge-patching the reused Agent last-used-at', async () => {
    const agents: Obj[] = [];
    const c = cluster(agents, []);
    const first = await instantiate(c.api, T0);
    expect(first.status).toBe(201);
    agents.push(agent('summarizer-old', 'summarizer'));
    const later = new Date(T0.getTime() + 3600_000);
    const again = await instantiate(c.api, later);
    expect(again.status).toBe(200);
    expect(again.body.agentName).toBe(first.body.agentName);
    expect(c.deleted).toEqual(['summarizer-old']);
    expect(
      c.patched.some(
        (p) =>
          p.name === first.body.agentName && JSON.stringify(p.body).includes(later.toISOString()),
      ),
    ).toBe(true);
    expect(c.patched.every((p) => p.options === mergePatchOptions)).toBe(true);
  });

  it('never fails an instantiation because the sweep failed', async () => {
    const c = cluster([agent('summarizer-old', 'summarizer')], [], true);
    const r = await instantiate(c.api, T0);
    expect(r.status).toBe(201);
    expect(r.body.agentName).toMatch(/^summarizer-/);
  });
});
