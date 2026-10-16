/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { SnapshotCache } from '../cache.js';
import { OPERATOR_INPUT_ANNOTATION, tasksRoute } from './tasks.js';

type Live = { metadata: Record<string, unknown>; status?: { phase?: string } };

function fakeApi(live: Live, conflicts = 0) {
  const patches: unknown[] = [];
  let remaining = conflicts;
  const api = {
    getNamespacedCustomObject: vi.fn(() => Promise.resolve(structuredClone(live))),
    patchNamespacedCustomObject: vi.fn((req: { body: { metadata: Live['metadata'] } }) => {
      if (remaining > 0) {
        remaining -= 1;
        live.metadata.resourceVersion = String(Number(live.metadata.resourceVersion) + 1);
        return Promise.reject(Object.assign(new Error('conflict'), { code: 409 }));
      }
      patches.push(req.body);
      live.metadata.annotations = req.body.metadata.annotations;
      return Promise.resolve({});
    }),
  };
  return { api, patches };
}

const running = (): Live => ({
  metadata: { name: 't', namespace: 'kagent-system', uid: 'uid-1', resourceVersion: '7' },
  status: { phase: 'Dispatched' },
});

function post(app: ReturnType<typeof tasksRoute>, body: unknown) {
  return app.request('/api/tasks/kagent-system/t/input', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tasks/:namespace/:name/input', () => {
  it('appends to the annotation under the read resourceVersion, once per id', async () => {
    const live = running();
    const { api, patches } = fakeApi(live);
    const app = tasksRoute({ cache: new SnapshotCache(), customApi: api as never });
    const res = await post(app, { message: '  stop and report  ', id: 'a1', uid: 'uid-1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, id: 'a1', index: 1 });
    const meta = (
      patches[0] as { metadata: { resourceVersion: string; annotations: Record<string, string> } }
    ).metadata;
    expect(meta.resourceVersion).toBe('7');
    expect(JSON.parse(meta.annotations[OPERATOR_INPUT_ANNOTATION]!)).toMatchObject([
      { id: 'a1', text: 'stop and report' },
    ]);
    expect((await post(app, { message: 'stop and report', id: 'a1' })).status).toBe(202);
    expect(patches).toHaveLength(1);
    await post(app, { message: 'second' });
    expect(
      JSON.parse((live.metadata.annotations as Record<string, string>)[OPERATOR_INPUT_ANNOTATION]!),
    ).toHaveLength(2);
  });

  it('re-reads and retries when a concurrent append wins', async () => {
    const { api, patches } = fakeApi(running(), 1);
    const app = tasksRoute({ cache: new SnapshotCache(), customApi: api as never });
    expect((await post(app, { message: 'go' })).status).toBe(202);
    expect(api.getNamespacedCustomObject).toHaveBeenCalledTimes(2);
    expect((patches[0] as { metadata: { resourceVersion: string } }).metadata.resourceVersion).toBe(
      '8',
    );
  });

  it('refuses finished tasks, changed identity and bad bodies without writing', async () => {
    const done = running();
    done.status = { phase: 'Completed' };
    const finished = fakeApi(done);
    const app = tasksRoute({ cache: new SnapshotCache(), customApi: finished.api as never });
    expect((await post(app, { message: 'go' })).status).toBe(409);
    const live = fakeApi(running());
    const app2 = tasksRoute({ cache: new SnapshotCache(), customApi: live.api as never });
    expect((await post(app2, { message: 'go', uid: 'other' })).status).toBe(409);
    expect((await post(app2, { message: '   ' })).status).toBe(400);
    expect((await post(app2, { message: 'x'.repeat(4001) })).status).toBe(400);
    expect(finished.patches.length + live.patches.length).toBe(0);
    expect((await post(tasksRoute({ cache: new SnapshotCache() }), { message: 'go' })).status).toBe(
      503,
    );
  });
});
