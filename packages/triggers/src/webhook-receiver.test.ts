/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { computeSignature } from './hmac.js';
import type { RenderedAgentTask } from './render-task.js';
import {
  handleWebhookRequest,
  type WebhookReceiverDeps,
  type WebhookTrigger,
} from './webhook-receiver.js';

const baseTrigger: WebhookTrigger = {
  id: 'trigger-a',
  namespace: 'kagent-system',
  secret: 'shh-shared-secret',
  taskTemplate: {
    targetAgent: 'researcher',
    payload: { mode: 'default' },
  },
};

function mkDeps(trigger: WebhookTrigger | undefined): {
  deps: WebhookReceiverDeps;
  created: RenderedAgentTask[];
} {
  const created: RenderedAgentTask[] = [];
  const deps: WebhookReceiverDeps = {
    lookupTrigger: () => trigger,
    createAgentTask: (m) => {
      created.push(m);
    },
    clock: () => new Date(Date.UTC(2026, 4, 3, 6, 0, 0, 0)),
  };
  return { deps, created };
}

describe('handleWebhookRequest', () => {
  it('accepts a request with a valid HMAC signature and creates an AgentTask', async () => {
    const { deps, created } = mkDeps(baseTrigger);
    const body = Buffer.from(JSON.stringify({ mode: 'override' }));
    const sig = computeSignature(baseTrigger.secret, body);
    const out = await handleWebhookRequest(body, sig, baseTrigger.id, deps);
    expect(out.status).toBe(202);
    expect(created).toHaveLength(1);
    expect(created[0]?.spec.payload).toEqual({ mode: 'override' });
    expect(created[0]?.metadata.labels['kagent.knuteson.io/trigger-kind']).toBe('webhook');
    expect(created[0]?.metadata.labels['kagent.knuteson.io/trigger-name']).toBe('trigger-a');
  });

  it('rejects a request with a tampered HMAC signature with 401', async () => {
    const { deps, created } = mkDeps(baseTrigger);
    const body = Buffer.from(JSON.stringify({ mode: 'override' }));
    const sig = computeSignature(baseTrigger.secret, body);
    const tampered = (sig.startsWith('a') ? 'b' : 'a') + sig.slice(1);
    const out = await handleWebhookRequest(body, tampered, baseTrigger.id, deps);
    expect(out.status).toBe(401);
    expect(out.body.code).toBe('invalid_signature');
    expect(created).toHaveLength(0);
  });

  it('rejects a request with no signature header with 400', async () => {
    const { deps, created } = mkDeps(baseTrigger);
    const out = await handleWebhookRequest(Buffer.from('{}'), undefined, baseTrigger.id, deps);
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('missing_signature');
    expect(created).toHaveLength(0);
  });

  it('rejects an unknown trigger id with 404', async () => {
    const { deps, created } = mkDeps(undefined);
    const body = Buffer.from('{}');
    const sig = computeSignature('any', body);
    const out = await handleWebhookRequest(body, sig, 'no-such', deps);
    expect(out.status).toBe(404);
    expect(out.body.code).toBe('trigger_not_found');
    expect(created).toHaveLength(0);
  });

  it('rejects an empty trigger id with 404', async () => {
    const { deps } = mkDeps(baseTrigger);
    const out = await handleWebhookRequest(Buffer.from('{}'), 'sig', '', deps);
    expect(out.status).toBe(404);
  });

  it('rejects a body that is non-JSON with 400', async () => {
    const { deps, created } = mkDeps(baseTrigger);
    const body = Buffer.from('not json {{{');
    const sig = computeSignature(baseTrigger.secret, body);
    const out = await handleWebhookRequest(body, sig, baseTrigger.id, deps);
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('bad_json');
    expect(created).toHaveLength(0);
  });

  it('falls back to the template payload when the request body is empty', async () => {
    const { deps, created } = mkDeps(baseTrigger);
    const body = Buffer.alloc(0);
    const sig = computeSignature(baseTrigger.secret, body);
    const out = await handleWebhookRequest(body, sig, baseTrigger.id, deps);
    expect(out.status).toBe(202);
    expect(created[0]?.spec.payload).toEqual({ mode: 'default' });
  });

  it('returns 500 on a downstream K8s create failure', async () => {
    const { deps } = mkDeps(baseTrigger);
    const failingDeps: WebhookReceiverDeps = {
      ...deps,
      createAgentTask: () => {
        throw new Error('etcd lease lost');
      },
    };
    const body = Buffer.from(JSON.stringify({ mode: 'x' }));
    const sig = computeSignature(baseTrigger.secret, body);
    const out = await handleWebhookRequest(body, sig, baseTrigger.id, failingDeps);
    expect(out.status).toBe(500);
    expect(out.body.code).toBe('k8s_error');
  });
});
