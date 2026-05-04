/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask, type OutputRef } from './crds/index.js';
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IdempotencyCache,
  deriveIdempotencyKey,
  hashTaskInputs,
  validateAgentTaskInputs,
  validateEventTopicsAgainstClaims,
  validateRequiredOutputsPresent,
} from './task-admission.js';

const baseAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default' },
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    inputs: [
      { name: 'corpus', kind: 'workspace', mountPath: '/var/in/corpus' },
      { name: 'brief', kind: 'artifact', mountPath: '/var/in/brief', optional: true },
    ],
    outputs: [
      { name: 'digest', kind: 'artifact', required: true },
      { name: 'extra', kind: 'artifact', required: false },
    ],
  },
};

const baseTask: AgentTask = {
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentTask',
  metadata: { name: 't1', namespace: 'default', uid: 'task-uid-1' },
  spec: {
    targetAgent: 'researcher',
    payload: { topic: 'k3s' },
    inputs: [{ name: 'corpus', from: { workspace: 'ws-1' } }],
  },
};

/* =====================================================================
 * validateAgentTaskInputs
 * ===================================================================== */

describe('validateAgentTaskInputs', () => {
  it('accepts a task that binds every required input on a typed-io Agent', () => {
    expect(validateAgentTaskInputs(baseAgent, baseTask).ok).toBe(true);
  });

  it('back-compat: a v0.1 Agent (no inputs[]) accepts a v0.1 AgentTask (no inputs[])', () => {
    const v01agent: Agent = {
      ...baseAgent,
      spec: { model: baseAgent.spec.model },
    };
    const v01task: AgentTask = {
      ...baseTask,
      spec: { targetAgent: 'researcher', payload: {} },
    };
    expect(validateAgentTaskInputs(v01agent, v01task).ok).toBe(true);
  });

  it('rejects a task missing a required Agent input', () => {
    const result = validateAgentTaskInputs(baseAgent, {
      ...baseTask,
      spec: { ...baseTask.spec, inputs: [] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('InvalidInputs');
    expect(result.missing).toEqual(['corpus']);
    expect(result.message).toContain('missing required inputs');
    expect(result.message).toContain('corpus');
  });

  it('rejects a task with a malformed `from` discriminant (multiple keys)', () => {
    // Build the malformed binding via a typed `unknown` round-trip — the
    // CRD-level oneOf forbids this shape, but a buggy webhook / hand-edited
    // CR could land here, and admission must reject it.
    const malformedFrom = { workspace: 'w', taskUid: 'u', output: 'o' } as unknown as {
      readonly workspace: string;
    };
    const result = validateAgentTaskInputs(baseAgent, {
      ...baseTask,
      spec: {
        ...baseTask.spec,
        inputs: [{ name: 'corpus', from: malformedFrom }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.malformed).toContain('corpus');
    expect(result.missing).toContain('corpus');
  });

  it('rejects a task with an unknown binding name (drift / typo)', () => {
    const result = validateAgentTaskInputs(baseAgent, {
      ...baseTask,
      spec: {
        ...baseTask.spec,
        inputs: [
          { name: 'corpus', from: { workspace: 'w' } },
          { name: 'mistyped', from: { scalar: 1 } },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownBindings).toEqual(['mistyped']);
  });

  it('rejects an Agent that declares a workspace input without mountPath', () => {
    const badAgent: Agent = {
      ...baseAgent,
      spec: {
        ...baseAgent.spec,
        inputs: [{ name: 'corpus', kind: 'workspace' }],
      },
    };
    const result = validateAgentTaskInputs(badAgent, {
      ...baseTask,
      spec: {
        ...baseTask.spec,
        inputs: [{ name: 'corpus', from: { workspace: 'w' } }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mountPathMissing).toEqual(['corpus']);
    expect(result.message).toContain('mountPath');
  });

  it('reports multiple failure dimensions in one structured error', () => {
    const result = validateAgentTaskInputs(baseAgent, {
      ...baseTask,
      spec: {
        ...baseTask.spec,
        inputs: [
          { name: 'mistyped', from: { scalar: 1 } },
          { name: 'extra', from: {} as unknown as { readonly workspace: string } },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['corpus']);
    expect(result.unknownBindings).toContain('mistyped');
    expect(result.malformed).toContain('extra');
  });
});

/* =====================================================================
 * validateRequiredOutputsPresent
 * ===================================================================== */

describe('validateRequiredOutputsPresent', () => {
  it('accepts when all required outputs are present', () => {
    const ok = validateRequiredOutputsPresent(baseAgent, [
      { name: 'digest', ref: 'pvc://kagent-artifacts/uid-1/digest.md' },
    ]);
    expect(ok.ok).toBe(true);
  });

  it('back-compat: v0.1 Agent without outputs[] always passes', () => {
    const v01agent: Agent = {
      ...baseAgent,
      spec: { model: baseAgent.spec.model },
    };
    expect(validateRequiredOutputsPresent(v01agent, undefined).ok).toBe(true);
    expect(validateRequiredOutputsPresent(v01agent, []).ok).toBe(true);
  });

  it('rejects when a required output is missing', () => {
    const result = validateRequiredOutputsPresent(baseAgent, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('MissingRequiredOutputs');
    expect(result.missing).toEqual(['digest']);
    expect(result.message).toContain('digest');
  });

  it('does NOT require outputs marked `required: false`', () => {
    // baseAgent has `extra` declared as required: false; only `digest` is required.
    const result = validateRequiredOutputsPresent(baseAgent, [
      { name: 'digest', ref: 'pvc://...' },
    ]);
    expect(result.ok).toBe(true);
  });

  it('treats undefined status.outputs the same as []', () => {
    const result = validateRequiredOutputsPresent(baseAgent, undefined);
    expect(result.ok).toBe(false);
  });
});

/* =====================================================================
 * IdempotencyCache
 * ===================================================================== */

describe('IdempotencyCache', () => {
  const sampleKey = {
    namespace: 'default',
    agentName: 'researcher',
    idempotencyKey: 'k-1',
  } as const;

  it('returns miss on a fresh key, then replay on the second submit with same hash', () => {
    const cache = new IdempotencyCache();
    const decision1 = cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    expect(decision1.kind).toBe('miss');

    const decision2 = cache.checkAndStore(sampleKey, 'h1', 'task-uid-2');
    expect(decision2.kind).toBe('replay');
    if (decision2.kind !== 'replay') return;
    expect(decision2.originalTaskUid).toBe('task-uid-1');
    expect(decision2.outputs).toEqual([]);
  });

  it('returns conflict when the second submit has a DIFFERENT input hash', () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    const decision = cache.checkAndStore(sampleKey, 'h2', 'task-uid-2');
    expect(decision.kind).toBe('conflict');
    if (decision.kind !== 'conflict') return;
    expect(decision.originalTaskUid).toBe('task-uid-1');
    expect(decision.storedHash).toBe('h1');
    expect(decision.incomingHash).toBe('h2');
  });

  it('scopes entries by namespace + agent name (different agent = different cache slot)', () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    const otherAgent = { ...sampleKey, agentName: 'summarizer' } as const;
    const decision = cache.checkAndStore(otherAgent, 'h1', 'task-uid-2');
    expect(decision.kind).toBe('miss');
  });

  it('scopes entries by namespace (different namespace = different cache slot)', () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    const otherNs = { ...sampleKey, namespace: 'other' } as const;
    const decision = cache.checkAndStore(otherNs, 'h1', 'task-uid-2');
    expect(decision.kind).toBe('miss');
  });

  it('records cached outputs that subsequent replay decisions surface', () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    const outputs: OutputRef[] = [
      { name: 'digest', ref: 'pvc://kagent-artifacts/uid-1/digest.md' },
    ];
    cache.recordOutputs(sampleKey, outputs);

    const decision = cache.checkAndStore(sampleKey, 'h1', 'task-uid-2');
    expect(decision.kind).toBe('replay');
    if (decision.kind !== 'replay') return;
    expect(decision.outputs).toEqual(outputs);
  });

  it('honors a 24h TTL by default', () => {
    expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('evicts entries past the TTL window', () => {
    let now = 1_000_000_000_000; // arbitrary epoch ms
    const cache = new IdempotencyCache({ ttlMs: 1000, now: () => now });
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    expect(cache.size()).toBe(1);

    // Advance past TTL.
    now += 2_000;
    expect(cache.size()).toBe(0);

    // Same key resubmitted → fresh miss.
    const decision = cache.checkAndStore(sampleKey, 'h1', 'task-uid-2');
    expect(decision.kind).toBe('miss');
  });

  it('reset() clears all entries (test convenience)', () => {
    const cache = new IdempotencyCache();
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    cache.reset();
    expect(cache.size()).toBe(0);
  });

  it('recordOutputs is a no-op when the entry has been evicted', () => {
    let now = 0;
    const cache = new IdempotencyCache({ ttlMs: 100, now: () => now });
    cache.checkAndStore(sampleKey, 'h1', 'task-uid-1');
    now = 1000; // past TTL
    // Should not throw, should not resurrect the entry.
    cache.recordOutputs(sampleKey, [{ name: 'x', ref: 'y' }]);
    expect(cache.size()).toBe(0);
  });
});

/* =====================================================================
 * deriveIdempotencyKey
 * ===================================================================== */

describe('deriveIdempotencyKey', () => {
  it('returns null when the task has no idempotencyKey', () => {
    expect(deriveIdempotencyKey(baseTask, 'researcher')).toBe(null);
  });

  it('returns a key when idempotencyKey is set', () => {
    const task: AgentTask = {
      ...baseTask,
      spec: { ...baseTask.spec, idempotencyKey: 'idem-1' },
    };
    const key = deriveIdempotencyKey(task, 'researcher');
    expect(key).toEqual({
      namespace: 'default',
      agentName: 'researcher',
      idempotencyKey: 'idem-1',
    });
  });

  it('defaults namespace to "default" when missing on the task metadata', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { name: 't', uid: 'u' }, // no namespace
      spec: { ...baseTask.spec, idempotencyKey: 'idem-2' },
    };
    const key = deriveIdempotencyKey(task, 'researcher');
    expect(key?.namespace).toBe('default');
  });

  it('returns null when the resolved agent name is empty', () => {
    const task: AgentTask = {
      ...baseTask,
      spec: { ...baseTask.spec, idempotencyKey: 'idem-3' },
    };
    expect(deriveIdempotencyKey(task, '')).toBe(null);
  });
});

/* =====================================================================
 * hashTaskInputs (re-export sanity)
 * ===================================================================== */

describe('hashTaskInputs (re-export)', () => {
  it('produces a stable hash that the cache can use as a discriminator', () => {
    const a = hashTaskInputs(baseTask);
    const b = hashTaskInputs(baseTask);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

/* =====================================================================
 * validateCapabilityBounds (v0.3.0-capabilities)
 * ===================================================================== */

import { validateCapabilityBounds } from './task-admission.js';
import { KAGENT_SUBSTRATE_AUDIENCE, type CapabilityBundle } from '@kagent/capability-types';

describe('validateCapabilityBounds (v0.3.0)', () => {
  const parentBundle: CapabilityBundle = {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task-uid:parent',
    aud: [KAGENT_SUBSTRATE_AUDIENCE],
    exp: 9_999_999_999,
    jti: 'cap-parent',
    claims: { spawn: ['summarizer-*'], tools: ['http_get'] },
  };

  it('passes when no parent bundle (root task)', () => {
    const r = validateCapabilityBounds(baseAgent, undefined);
    expect(r.ok).toBe(true);
  });

  it('passes when Agent claims are subset of parent', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: { ...baseAgent.spec, capabilityClaims: { spawn: ['summarizer-1'] } },
    };
    const r = validateCapabilityBounds(agent, parentBundle);
    expect(r.ok).toBe(true);
  });

  it('rejects when Agent claims escalate past parent', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: { ...baseAgent.spec, capabilityClaims: { spawn: ['evil-agent'] } },
    };
    const r = validateCapabilityBounds(agent, parentBundle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('CapabilityViolation');
      expect(r.message).toContain('policy_denied:capability_violation');
      expect(r.message).toContain('cap-parent');
    }
  });

  it('rejects when Agent declares a tools claim parent does not have', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: { ...baseAgent.spec, capabilityClaims: { tools: ['rogue_tool'] } },
    };
    const r = validateCapabilityBounds(agent, parentBundle);
    expect(r.ok).toBe(false);
  });

  it('uses legacy allowedChildAgents fallback when capabilityClaims absent', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: { ...baseAgent.spec, allowedChildAgents: ['summarizer-1'] },
    };
    // Resolved claims become spawn=['summarizer-1'] which IS subset of
    // parent.spawn=['summarizer-*'] — the legacy field passes.
    const r = validateCapabilityBounds(agent, parentBundle);
    expect(r.ok).toBe(true);
  });
});

/* =====================================================================
 * v0.4.0-events — Wave 3 / Events sub-team admission validator.
 * ===================================================================== */

describe('validateEventTopicsAgainstClaims (v0.4.0)', () => {
  it('passes for an Agent with neither publishes nor subscribes', () => {
    const r = validateEventTopicsAgainstClaims(baseAgent);
    expect(r.ok).toBe(true);
  });

  it('passes when every topic ⊆ its respective claim', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: {
        ...baseAgent.spec,
        publishes: [{ topic: 'research.findings' }],
        subscribes: [{ topic: 'research.priorities' }],
        capabilityClaims: { publish: ['research.*'], subscribe: ['research.*'] },
      },
    };
    const r = validateEventTopicsAgainstClaims(agent);
    expect(r.ok).toBe(true);
  });

  it('rejects when a publish topic is outside the publish claim list', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: {
        ...baseAgent.spec,
        publishes: [{ topic: 'audit.task.completed' }],
        capabilityClaims: { publish: ['research.*'] },
      },
    };
    const r = validateEventTopicsAgainstClaims(agent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('InvalidEventTopics');
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]?.category).toBe('publish');
      expect(r.violations[0]?.topic).toBe('audit.task.completed');
    }
  });

  it('rejects when a subscribe topic is malformed', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: {
        ...baseAgent.spec,
        subscribes: [{ topic: 'Research.findings' }],
        capabilityClaims: { subscribe: ['*'] },
      },
    };
    const r = validateEventTopicsAgainstClaims(agent);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0]?.reason).toBe('invalid_topic');
    }
  });

  it('rejects when capabilityClaims has no publish/subscribe (fail-closed)', () => {
    const agent: Agent = {
      ...baseAgent,
      spec: {
        ...baseAgent.spec,
        publishes: [{ topic: 'research.findings' }],
        capabilityClaims: {},
      },
    };
    const r = validateEventTopicsAgainstClaims(agent);
    expect(r.ok).toBe(false);
  });
});

/* =====================================================================
 * v0.5.0-tenancy — Wave 4 / Tenancy admission validator + resolver.
 * ===================================================================== */

import {
  TENANT_NAMESPACE_REFUSAL_REASON,
  resolveTenantForTask,
  tenantLabelPatch,
  validateTenantNamespace,
  type TenantLookupFn,
} from './task-admission.js';
import { TENANT_LABEL, type Tenant } from './crds/index.js';

function makeTenant(name: string, namespaces: string[]): Tenant {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Tenant',
    metadata: { name, uid: `uid-${name}` },
    spec: { name, namespaceAllowlist: namespaces },
  };
}

function makeLookup(...tenants: Tenant[]): TenantLookupFn {
  const m = new Map<string, Tenant>();
  for (const t of tenants) m.set(t.spec.name, t);
  return (name) => m.get(name);
}

describe('resolveTenantForTask (v0.5.0-tenancy)', () => {
  const acme = makeTenant('acme', ['acme-prod', 'acme-staging']);
  const globex = makeTenant('globex', ['globex-prod']);
  const fallback = makeTenant('default-tenant', ['default']);

  it('resolves tenant from AgentTask label first', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, labels: { [TENANT_LABEL]: 'acme' } },
    };
    const agent: Agent = { ...baseAgent };
    const t = resolveTenantForTask(task, agent, undefined, makeLookup(acme, globex));
    expect(t?.spec.name).toBe('acme');
  });

  it('falls back to Agent label when AgentTask has none', () => {
    const task: AgentTask = { ...baseTask };
    const agent: Agent = {
      ...baseAgent,
      metadata: { ...baseAgent.metadata, labels: { [TENANT_LABEL]: 'globex' } },
    };
    const t = resolveTenantForTask(task, agent, undefined, makeLookup(acme, globex));
    expect(t?.spec.name).toBe('globex');
  });

  it('falls back to cluster default when neither task nor agent labeled', () => {
    const t = resolveTenantForTask(
      baseTask,
      baseAgent,
      'default-tenant',
      makeLookup(acme, fallback),
    );
    expect(t?.spec.name).toBe('default-tenant');
  });

  it('returns undefined when nothing resolves', () => {
    const t = resolveTenantForTask(baseTask, baseAgent, undefined, makeLookup(acme));
    expect(t).toBeUndefined();
  });

  it('AgentTask label wins over Agent label (precedence)', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, labels: { [TENANT_LABEL]: 'acme' } },
    };
    const agent: Agent = {
      ...baseAgent,
      metadata: { ...baseAgent.metadata, labels: { [TENANT_LABEL]: 'globex' } },
    };
    const t = resolveTenantForTask(
      task,
      agent,
      'default-tenant',
      makeLookup(acme, globex, fallback),
    );
    expect(t?.spec.name).toBe('acme');
  });

  it('skips an unknown tenant label and falls through', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, labels: { [TENANT_LABEL]: 'mystery' } },
    };
    const agent: Agent = {
      ...baseAgent,
      metadata: { ...baseAgent.metadata, labels: { [TENANT_LABEL]: 'globex' } },
    };
    const t = resolveTenantForTask(task, agent, undefined, makeLookup(globex));
    // mystery doesn't exist; falls through to globex on Agent label.
    expect(t?.spec.name).toBe('globex');
  });
});

describe('validateTenantNamespace (v0.5.0-tenancy)', () => {
  const acme = makeTenant('acme', ['acme-prod', 'acme-staging']);

  it('admits when tenant allowlist contains the task namespace', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, namespace: 'acme-prod' },
    };
    const r = validateTenantNamespace(task, acme);
    expect(r.ok).toBe(true);
  });

  it('refuses with TenantNamespaceMismatch when not allowlisted', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, namespace: 'globex-prod' },
    };
    const r = validateTenantNamespace(task, acme);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('TenantNamespaceMismatch');
      expect(r.message).toContain(TENANT_NAMESPACE_REFUSAL_REASON);
      expect(r.message).toContain('acme-prod, acme-staging');
      expect(r.tenantName).toBe('acme');
      expect(r.namespace).toBe('globex-prod');
    }
  });

  it('admits when tenant resolved is undefined AND tenancyEnforced=false (fail-open default)', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, namespace: 'arbitrary-ns' },
    };
    const r = validateTenantNamespace(task, undefined);
    expect(r.ok).toBe(true);
  });

  it('refuses when tenant resolved is undefined AND tenancyEnforced=true', () => {
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, namespace: 'arbitrary-ns' },
    };
    const r = validateTenantNamespace(task, undefined, true);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('TenantNamespaceMismatch');
      expect(r.message).toContain('no tenant resolved');
    }
  });

  it('uses default namespace when task has none', () => {
    const tenant = makeTenant('acme', ['default']);
    const task: AgentTask = {
      ...baseTask,
      metadata: { ...baseTask.metadata, namespace: undefined },
    };
    const r = validateTenantNamespace(task, tenant);
    expect(r.ok).toBe(true);
  });
});

describe('tenantLabelPatch', () => {
  it('builds a labels patch with the tenant label key', () => {
    expect(tenantLabelPatch('acme')).toEqual({
      labels: { [TENANT_LABEL]: 'acme' },
    });
  });
});
