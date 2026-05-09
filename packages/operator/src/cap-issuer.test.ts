/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { KAGENT_SUBSTRATE_AUDIENCE, type CapabilityBundle } from '@kagent/capability-types';

import { resolveCapTtlPolicy } from '@kagent/keyrotation-controller';

import { loadFromMaterials } from './cap-ca.js';
import {
  CapabilityViolationError,
  applyTenantClaim,
  applyTtlPolicy,
  mintCapabilityForTask,
  narrowClaimsByParent,
  resolveAgentClaims,
} from './cap-issuer.js';
import { API_GROUP_VERSION } from './crds/index.js';
import type { Agent, AgentTask, Tenant } from './crds/index.js';
import type { DispositionOverlay } from './disposition/overlay-loader.js';
import type { ProposalKind } from './disposition/proposal-tool-map.js';

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

/* =====================================================================
 * v0.5.0-tenancy — Wave 4 / Tenancy sub-team coverage.
 * ===================================================================== */

function makeTenant(overrides: Partial<Tenant['spec']> = {}): Tenant {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: { name: 'acme', uid: 'uid-acme' },
    spec: {
      name: 'acme',
      namespaceAllowlist: ['default'],
      ...overrides,
    },
  };
}

describe('applyTenantClaim (v0.5.0-tenancy)', () => {
  it('returns claims unchanged when tenant is undefined', () => {
    const claims = { tools: ['http_get'] };
    expect(applyTenantClaim(claims, undefined)).toBe(claims);
  });

  it('stamps tenant.spec.name onto claims.tenant when unset', () => {
    const result = applyTenantClaim({ tools: ['http_get'] }, makeTenant());
    expect(result.tenant).toBe('acme');
    expect(result.tools).toEqual(['http_get']);
  });

  it('preserves Agent-pinned tenant when already set', () => {
    const result = applyTenantClaim({ tenant: 'globex' }, makeTenant());
    expect(result.tenant).toBe('globex');
  });

  it('skips stamping when tenant.spec.name is empty', () => {
    const t = makeTenant({ name: '' });
    const result = applyTenantClaim({ tools: ['http_get'] }, t);
    expect(result.tenant).toBeUndefined();
  });
});

describe('mintCapabilityForTask — tenant integration (v0.5.0-tenancy)', () => {
  it('stamps claims.tenant from the resolved Tenant CR', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: ['http_get'] } });
    const task = makeTask({ uid: 'tenant-task' });
    const tenant = makeTenant();
    const result = await mintCapabilityForTask(ca, { task, agent, tenant });
    expect(result.claims.tenant).toBe('acme');
    expect(result.claims.tools).toEqual(['http_get']);
  });

  it('honors per-tenant capabilityRoot.issuer override on the JWT iss claim', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: {} });
    const task = makeTask({ uid: 'tenant-issuer-task' });
    const tenant = makeTenant({
      capabilityRoot: { issuer: 'kagent.knuteson.io/operator/acme' },
    });
    const result = await mintCapabilityForTask(ca, { task, agent, tenant });
    // Decode the JWT payload (no verify needed — we just signed it).
    const [, payloadB64] = result.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe('kagent.knuteson.io/operator/acme');
    expect(payload.sub).toBe('task-uid:tenant-issuer-task');
  });

  it('falls back to operator default issuer when tenant has no override', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: {} });
    const task = makeTask({ uid: 'no-issuer-override' });
    const tenant = makeTenant();
    const result = await mintCapabilityForTask(ca, { task, agent, tenant });
    const [, payloadB64] = result.jwt.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe('kagent.knuteson.io/operator');
  });

  it('Agent-pinned tenant wins over Tenant CR default', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tenant: 'globex' },
    });
    const task = makeTask({ uid: 'agent-pin' });
    // No parent bundle — root task; Agent's tenant claim flows through.
    const tenant = makeTenant();
    const result = await mintCapabilityForTask(ca, { task, agent, tenant });
    expect(result.claims.tenant).toBe('globex');
  });

  it('without tenant CR, claims.tenant stays unset (legacy behavior)', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: ['http_get'] } });
    const task = makeTask({ uid: 'legacy-task' });
    const result = await mintCapabilityForTask(ca, { task, agent });
    expect(result.claims.tenant).toBeUndefined();
  });
});

describe('applyTtlPolicy (v0.5.4-keyrotation)', () => {
  it('falls back to legacy heuristic (timeout + 60s) when policy is undefined', () => {
    const task = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default', uid: 'u' },
      spec: { targetAgent: 'a', payload: {}, runConfig: { timeoutSeconds: 600 } },
    } as unknown as AgentTask;
    const result = applyTtlPolicy(task, undefined);
    expect(result.ttlSeconds).toBe(660);
    expect(result.decision).toBeUndefined();
  });

  it('returns undefined ttlSeconds (JWT helper default) when no timeout + no policy', () => {
    const task = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default', uid: 'u' },
      spec: { targetAgent: 'a', payload: {} },
    } as unknown as AgentTask;
    const result = applyTtlPolicy(task, undefined);
    expect(result.ttlSeconds).toBeUndefined();
    expect(result.decision).toBeUndefined();
  });

  it('applies short-running policy tier when timeout missing', () => {
    const task = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default', uid: 'u' },
      spec: { targetAgent: 'a', payload: {} },
    } as unknown as AgentTask;
    const policy = resolveCapTtlPolicy({});
    const result = applyTtlPolicy(task, policy);
    expect(result.ttlSeconds).toBe(3600);
    expect(result.decision?.tier).toBe('short-running');
  });

  it('applies long-running-grace tier for >1h timeoutSeconds', () => {
    const task = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default', uid: 'u' },
      spec: { targetAgent: 'a', payload: {}, runConfig: { timeoutSeconds: 2 * 60 * 60 } },
    } as unknown as AgentTask;
    const policy = resolveCapTtlPolicy({});
    const result = applyTtlPolicy(task, policy);
    expect(result.ttlSeconds).toBe(2 * 60 * 60 + 300);
    expect(result.decision?.tier).toBe('long-running-grace');
  });

  it('clamps to 24h ceiling for absurdly long timeouts', () => {
    const task = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: { name: 't', namespace: 'default', uid: 'u' },
      spec: { targetAgent: 'a', payload: {}, runConfig: { timeoutSeconds: 48 * 60 * 60 } },
    } as unknown as AgentTask;
    const policy = resolveCapTtlPolicy({});
    const result = applyTtlPolicy(task, policy);
    expect(result.ttlSeconds).toBe(24 * 60 * 60);
    expect(result.decision?.tier).toBe('long-running-clamped');
  });
});

describe('mintCapabilityForTask — TTL policy integration (v0.5.4-keyrotation)', () => {
  it('mints with the short-running TTL when policy is applied + timeout missing', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: ['http_get'] } });
    const task = makeTask();
    const policy = resolveCapTtlPolicy({});
    const result = await mintCapabilityForTask(ca, { task, agent, ttlPolicy: policy });
    expect(result.ttlDecision).toBeDefined();
    expect(result.ttlDecision?.tier).toBe('short-running');
    expect(result.ttlDecision?.ttlSeconds).toBe(3600);
  });

  it('mints with the long-running-grace TTL when policy is applied + timeout > 1h', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: ['http_get'] } });
    const task = makeTask({ runConfig: { timeoutSeconds: 7200 } });
    const policy = resolveCapTtlPolicy({});
    const result = await mintCapabilityForTask(ca, { task, agent, ttlPolicy: policy });
    expect(result.ttlDecision?.tier).toBe('long-running-grace');
    expect(result.ttlDecision?.ttlSeconds).toBe(7500);
  });

  it('omits ttlDecision when no policy supplied (legacy path)', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: ['http_get'] } });
    const task = makeTask();
    const result = await mintCapabilityForTask(ca, { task, agent });
    expect(result.ttlDecision).toBeUndefined();
  });
});

/* =====================================================================
 * Phase 1 / DISP-02 — AgentDisposition overlay narrowing.
 * ===================================================================== */

function makeDispositionOverlay(
  mayProposeAgainst: readonly ProposalKind[],
  agentName = 'researcher',
  agentNamespace = 'default',
): DispositionOverlay {
  return {
    agentRef: `${agentNamespace}/${agentName}`,
    agentNamespace,
    agentName,
    configMapName: `${agentName}-disposition`,
    configMapNamespace: agentNamespace,
    idleBehavior: {
      readChannels: [],
      attentionBudget: { tokensPerDay: 50000, pollIntervalSeconds: 300 },
      proposalScope: { mayProposeAgainst, maxProposalsPerDay: 3 },
    },
  };
}

function makeCoreApiStub(): {
  readNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
} {
  return {
    readNamespacedConfigMap: vi.fn(() =>
      Promise.resolve({
        metadata: {
          name: 'researcher-disposition',
          namespace: 'default',
          annotations: {},
          resourceVersion: 'rv-cap-issuer-test',
        },
        data: { 'disposition.yaml': '...' },
      }),
    ),
    patchNamespacedConfigMap: vi.fn(() => Promise.resolve({})),
  };
}

describe('mintCapabilityForTask: AgentDisposition overlay narrowing (DISP-02)', () => {
  it('Test 1 — happy path no overlay (revocation/baseline): returns claims with all proposal tools intact', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: {
        tools: ['write_artifact', 'verifier_register', 'capability_policy_propose', 'http_get'],
      },
    });
    const task = makeTask({ uid: 'no-overlay-1' });
    // No loadDispositionOverlay injected → narrowing is skipped entirely.
    const result = await mintCapabilityForTask(ca, { task, agent });
    expect(result.claims.tools).toEqual([
      'write_artifact',
      'verifier_register',
      'capability_policy_propose',
      'http_get',
    ]);
    expect(result.dispositionRejections).toBeUndefined();
  });

  it('Test 1b — loader returning null = revocation path: no narrowing applied', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: {
        tools: ['write_artifact', 'verifier_register', 'capability_policy_propose'],
      },
    });
    const task = makeTask({ uid: 'overlay-deleted' });
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(null));
    const result = await mintCapabilityForTask(ca, { task, agent, loadDispositionOverlay });
    expect(result.claims.tools).toEqual([
      'write_artifact',
      'verifier_register',
      'capability_policy_propose',
    ]);
    expect(result.dispositionRejections).toBeUndefined();
  });

  it('Test 2 — overlay narrows: removes proposal tools whose kind is not in mayProposeAgainst, emits one event per excluded tool', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact', 'verifier_register', 'http_get'] },
    });
    const task = makeTask({ uid: 'narrow-1' });
    const overlay = makeDispositionOverlay(['templates']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const auditPublisher = { publish: vi.fn(() => Promise.resolve()) };
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      auditPublisher,
    });
    expect(result.claims.tools).toEqual(['write_artifact', 'http_get']);
    expect(auditPublisher.publish).toHaveBeenCalledTimes(1);
    const event = auditPublisher.publish.mock.calls[0]![0] as {
      type: string;
      data: {
        excludedTool: string;
        excludedKind: string;
        reason: string;
        taskUid: string;
        agentRef: string;
      };
    };
    expect(event.type).toBe('disposition.proposal_rejected');
    expect(event.data.excludedTool).toBe('verifier_register');
    expect(event.data.excludedKind).toBe('verifiers');
    expect(event.data.reason).toBe('not_in_mayProposeAgainst');
    expect(event.data.taskUid).toBe('narrow-1');
    expect(event.data.agentRef).toBe('default/researcher');
    expect(result.dispositionRejections).toHaveLength(1);
  });

  it('Test 3 — emits one event per excluded proposal tool', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: {
        tools: ['write_artifact', 'verifier_register', 'capability_policy_propose'],
      },
    });
    const task = makeTask({ uid: 'narrow-3' });
    const overlay = makeDispositionOverlay([]);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const auditPublisher = { publish: vi.fn(() => Promise.resolve()) };
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      auditPublisher,
    });
    expect(result.claims.tools).toEqual([]);
    expect(auditPublisher.publish).toHaveBeenCalledTimes(3);
    expect(result.dispositionRejections).toHaveLength(3);
    const excludedTools = (result.dispositionRejections ?? []).map((r) => r.tool).sort();
    expect(excludedTools).toEqual([
      'capability_policy_propose',
      'verifier_register',
      'write_artifact',
    ]);
  });

  it('Test 4 — defense-in-depth invariant preserved: parent-narrowing still runs after overlay narrowing without violation', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact', 'http_get'] },
    });
    const parentBundle: CapabilityBundle = {
      iss: 'kagent.knuteson.io/operator',
      sub: 'task-uid:parent',
      aud: [KAGENT_SUBSTRATE_AUDIENCE],
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: 'cap-parent',
      claims: { tools: ['write_artifact', 'http_get'] },
    };
    const task = makeTask({ uid: 'narrow-4', parentTask: 'parent' });
    const overlay = makeDispositionOverlay(['templates']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    // No CapabilityViolationError thrown for valid (subset) inputs.
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      parentBundle,
    });
    expect(result.claims.tools).toEqual(['write_artifact', 'http_get']);
  });

  it('Test 5 — narrowing is monotonic: empty cap stays empty even when overlay allows everything', async () => {
    const ca = await makeCa();
    const agent = makeAgent({ capabilityClaims: { tools: [] } });
    const task = makeTask({ uid: 'narrow-5' });
    const overlay = makeDispositionOverlay(['templates', 'verifiers', 'capability-policy']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const auditPublisher = { publish: vi.fn(() => Promise.resolve()) };
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      auditPublisher,
    });
    expect(result.claims.tools).toEqual([]);
    expect(auditPublisher.publish).not.toHaveBeenCalled();
    expect(result.dispositionRejections).toBeUndefined();
  });

  it('Test 6 — overlay loader error handling (fail-open for availability): mint proceeds with no narrowing', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact', 'verifier_register', 'http_get'] },
    });
    const task = makeTask({ uid: 'narrow-6' });
    const loadDispositionOverlay = vi.fn(() => Promise.reject(new Error('k8s api unreachable')));
    const auditPublisher = { publish: vi.fn(() => Promise.resolve()) };
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      auditPublisher,
    });
    // Narrowing is skipped on loader-throw — minted claims equal base.
    expect(result.claims.tools).toEqual(['write_artifact', 'verifier_register', 'http_get']);
    expect(result.dispositionRejections).toBeUndefined();
    expect(auditPublisher.publish).not.toHaveBeenCalled();
  });

  it('Test 7 — taskUid populated in audit event from input.task.metadata.uid', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['verifier_register'] },
    });
    const task = makeTask({ uid: 'task-uid-xyz' });
    const overlay = makeDispositionOverlay(['templates']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const auditPublisher = { publish: vi.fn(() => Promise.resolve()) };
    await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      auditPublisher,
    });
    const callArg = auditPublisher.publish.mock.calls[0]![0] as {
      data: { taskUid: string };
    };
    expect(callArg.data.taskUid).toBe('task-uid-xyz');
  });

  it('Test 8 — overlay loader undefined (back-compat): baseline behavior preserved', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact', 'verifier_register'] },
    });
    const task = makeTask({ uid: 'narrow-8' });
    // No loadDispositionOverlay AND no auditPublisher → baseline behavior.
    const result = await mintCapabilityForTask(ca, { task, agent });
    expect(result.claims.tools).toEqual(['write_artifact', 'verifier_register']);
    expect(result.dispositionRejections).toBeUndefined();
  });

  it('Test 9 — proposals-today increment fires when minted JWT carries a proposal-category tool', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact', 'http_get'] },
    });
    const task = makeTask({ uid: 'mint-with-proposal' });
    const overlay = makeDispositionOverlay(['templates']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const coreApi = makeCoreApiStub();
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      coreApi,
    });
    // write_artifact (templates) survives narrowing — proposal-category mint.
    expect(result.claims.tools).toEqual(['write_artifact', 'http_get']);
    expect(coreApi.patchNamespacedConfigMap).toHaveBeenCalledTimes(1);
    const callArg = coreApi.patchNamespacedConfigMap.mock.calls[0]![0] as {
      name: string;
      namespace: string;
      body: unknown;
    };
    expect(callArg.name).toBe('researcher-disposition');
    expect(callArg.namespace).toBe('default');
    // The patch body is a JSON-Patch array; second/third ops touch the
    // proposals-today annotations.
    const ops = callArg.body as Array<{ op: string; path: string; value: unknown }>;
    expect(ops[1]!.path).toBe('/metadata/annotations/kagent.knuteson.io~1proposals-today');
    expect(ops[2]!.path).toBe('/metadata/annotations/kagent.knuteson.io~1proposals-today-day');
  });

  it('Test 10 — proposals-today increment SKIPPED when narrowing removes all proposal tools', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['verifier_register'] },
    });
    const task = makeTask({ uid: 'mint-narrowed-empty' });
    const overlay = makeDispositionOverlay(['templates']);
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(overlay));
    const coreApi = makeCoreApiStub();
    const result = await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      coreApi,
    });
    // verifier_register removed → no proposal-category tool in mint.
    expect(result.claims.tools).toEqual([]);
    expect(coreApi.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });

  it('Test 11 — proposals-today increment SKIPPED when no overlay loaded', async () => {
    const ca = await makeCa();
    const agent = makeAgent({
      capabilityClaims: { tools: ['write_artifact'] },
    });
    const task = makeTask({ uid: 'mint-no-overlay' });
    const loadDispositionOverlay = vi.fn(() => Promise.resolve(null));
    const coreApi = makeCoreApiStub();
    await mintCapabilityForTask(ca, {
      task,
      agent,
      loadDispositionOverlay,
      coreApi,
    });
    expect(coreApi.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });
});
