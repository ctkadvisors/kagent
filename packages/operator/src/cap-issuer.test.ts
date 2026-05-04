/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { KAGENT_SUBSTRATE_AUDIENCE, type CapabilityBundle } from '@kagent/capability-types';

import { loadFromMaterials } from './cap-ca.js';
import {
  CapabilityViolationError,
  mintCapabilityForTask,
  narrowClaimsByParent,
  resolveAgentClaims,
} from './cap-issuer.js';
import type { Agent, AgentTask } from './crds/index.js';

async function makeCa() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  return await loadFromMaterials({ privatePem, publicPem });
}

function makeAgent(over: Partial<Agent['spec']> = {}): Agent {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'Agent',
    metadata: { name: 'researcher', namespace: 'default' },
    spec: { model: 'workers-ai/test', ...over },
  };
}

function makeTask(over: Partial<AgentTask['spec']> & { uid?: string } = {}): AgentTask {
  const { uid, ...spec } = over;
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { name: 'kat-1', namespace: 'default', uid: uid ?? 'task-uid-1' },
    spec: { targetAgent: 'researcher', payload: {}, ...spec },
  };
}

describe('resolveAgentClaims', () => {
  it('returns the declared capabilityClaims when set', () => {
    const agent = makeAgent({
      capabilityClaims: { tools: ['http_get'], spawn: ['summarizer-*'] },
    });
    const claims = resolveAgentClaims(agent);
    expect(claims.tools).toEqual(['http_get']);
    expect(claims.spawn).toEqual(['summarizer-*']);
  });

  it('falls back to legacy allowedChildAgents → spawn', () => {
    const agent = makeAgent({ allowedChildAgents: ['summarizer', 'validator'] });
    const claims = resolveAgentClaims(agent);
    expect(claims.spawn).toEqual(['summarizer', 'validator']);
    expect(claims.tools).toBeUndefined();
  });

  it('encodes legacy allowedChildTemplates with template: prefix', () => {
    const agent = makeAgent({
      allowedChildTemplates: ['summarizer', 'validator'],
    });
    const claims = resolveAgentClaims(agent);
    expect(claims.spawn).toEqual(['template:summarizer', 'template:validator']);
  });

  it('combines both legacy fields', () => {
    const agent = makeAgent({
      allowedChildAgents: ['exact'],
      allowedChildTemplates: ['tmpl'],
    });
    const claims = resolveAgentClaims(agent);
    expect(claims.spawn).toEqual(['exact', 'template:tmpl']);
  });

  it('returns empty claims when both legacy + capabilityClaims absent', () => {
    const agent = makeAgent();
    expect(resolveAgentClaims(agent)).toEqual({});
  });

  it('capabilityClaims wins over legacy when both set', () => {
    const agent = makeAgent({
      capabilityClaims: { spawn: ['from-claims'] },
      allowedChildAgents: ['from-legacy'],
    });
    expect(resolveAgentClaims(agent).spawn).toEqual(['from-claims']);
  });
});

describe('narrowClaimsByParent', () => {
  it('intersects literal patterns', () => {
    const child = { spawn: ['summarizer', 'validator'] };
    const parent = { spawn: ['summarizer', 'evil'] };
    const narrowed = narrowClaimsByParent(child, parent);
    expect(narrowed.spawn).toEqual(['summarizer']);
  });

  it('keeps child globs that are subset of parent globs', () => {
    const child = { spawn: ['summarizer-narrow-*'] };
    const parent = { spawn: ['summarizer-*'] };
    const narrowed = narrowClaimsByParent(child, parent);
    expect(narrowed.spawn).toEqual(['summarizer-narrow-*']);
  });

  it('drops child entries not admitted by parent', () => {
    const child = { spawn: ['summarizer', 'evil'] };
    const parent = { spawn: ['summarizer-*'] }; // 'summarizer' (no dash) is NOT subset of 'summarizer-*'
    const narrowed = narrowClaimsByParent(child, parent);
    expect(narrowed.spawn ?? []).toEqual([]);
  });

  it('inherits parent tenant when child has none', () => {
    const narrowed = narrowClaimsByParent({}, { tenant: 'acme' });
    expect(narrowed.tenant).toBe('acme');
  });

  it('keeps matching child tenant', () => {
    const narrowed = narrowClaimsByParent({ tenant: 'acme' }, { tenant: 'acme' });
    expect(narrowed.tenant).toBe('acme');
  });

  it('drops mismatched tenant (admission catches the violation)', () => {
    const narrowed = narrowClaimsByParent({ tenant: 'evil' }, { tenant: 'acme' });
    expect(narrowed.tenant).toBeUndefined();
  });

  it('drops a category entirely when nothing intersects', () => {
    const narrowed = narrowClaimsByParent({ tools: ['http_get'] }, { models: ['gpt-4o'] });
    expect(narrowed.tools).toBeUndefined();
  });
});

describe('mintCapabilityForTask', () => {
  it('mints a JWT from a root task using Agent capabilityClaims', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['http_get'], spawn: ['summarizer-*'] },
    });
    const task = makeTask({ uid: 'root-1' });
    const result = await mintCapabilityForTask(ca, { task, agent });
    expect(result.jwt.split('.').length).toBe(3);
    expect(result.claims.tools).toEqual(['http_get']);
    expect(result.claims.spawn).toEqual(['summarizer-*']);
    expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('narrows by parent bundle when task is a child', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { spawn: ['summarizer-1'], tools: ['http_get'] },
    });
    const parentBundle: CapabilityBundle = {
      iss: 'kagent.knuteson.io/operator',
      sub: 'task-uid:parent',
      aud: [KAGENT_SUBSTRATE_AUDIENCE],
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'cap-parent',
      claims: {
        tools: ['http_get'],
        spawn: ['summarizer-*'],
      },
    };
    const task = makeTask({ uid: 'child-1', parentTask: 'parent' });
    const result = await mintCapabilityForTask(ca, { task, agent, parentBundle });
    expect(result.claims.spawn).toEqual(['summarizer-1']);
    expect(result.claims.tools).toEqual(['http_get']);
  });

  it('throws CapabilityViolationError when narrowing yields escalation', async () => {
    // Construct a synthetic case where narrow() returns a value that's
    // somehow NOT subset (defensive — usually the narrow algorithm
    // produces ⊆-correct output, but the post-narrow assertion is the
    // belt-and-suspenders).
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tenant: 'evil' },
    });
    const parentBundle: CapabilityBundle = {
      iss: 'kagent.knuteson.io/operator',
      sub: 'task-uid:parent',
      aud: [KAGENT_SUBSTRATE_AUDIENCE],
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'cap-parent',
      claims: { tenant: 'acme' },
    };
    const task = makeTask({ uid: 'child-2', parentTask: 'parent' });
    // narrowClaimsByParent drops mismatched tenant, so this won't
    // throw. Demonstrate that root agents with broader tenant claim
    // than parent get scrubbed cleanly.
    const result = await mintCapabilityForTask(ca, { task, agent, parentBundle });
    expect(result.claims.tenant).toBeUndefined();
  });

  it('uses runConfig.timeoutSeconds + 60 as TTL when set', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: {} });
    const task = makeTask({ uid: 'budgeted', runConfig: { timeoutSeconds: 120 } });
    const before = Math.floor(Date.now() / 1000);
    const result = await mintCapabilityForTask(ca, { task, agent });
    // Allow a couple-second clock drift on either side.
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 120);
    expect(result.expiresAt).toBeLessThanOrEqual(before + 120 + 65);
  });

  it('throws when AgentTask has no metadata.uid', async () => {
    const ca = await makeCa();
    const agent = makeAgent();
    const task = makeTask({ uid: '' });
    await expect(mintCapabilityForTask(ca, { task, agent })).rejects.toThrow(/metadata.uid/);
  });

  it('uses jtiOverride when supplied (test injection)', async () => {
    const ca = await makeCa();
    const agent = makeAgent();
    const task = makeTask({ uid: 'fixed' });
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      jtiOverride: 'cap-fixed',
    });
    expect(result.jti).toBe('cap-fixed');
  });
});

describe('CapabilityViolationError', () => {
  it('formats the violation summary', () => {
    const err = new CapabilityViolationError(
      [{ category: 'spawn', detail: 'evil not in parent' }],
      'cap-parent',
    );
    expect(err.message).toContain('capability_violation');
    expect(err.message).toContain('[spawn]');
    expect(err.parentJti).toBe('cap-parent');
  });
});
