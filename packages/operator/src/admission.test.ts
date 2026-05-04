/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Admission reconciler tests — covers the LLM-gateway bundle's
 * per-(model, backend) + per-Agent fairness gating. The reconciler
 * watches Job + ModelEndpoint events and un-suspends Pending Jobs
 * when capacity is available.
 *
 * See packages/operator/src/admission.ts for the implementation +
 * docs/superpowers/specs/2026-05-03-llm-gateway-bundle-design.md §3.2
 * for the data flow.
 */

import type { V1Job } from '@kubernetes/client-node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_LABEL,
  buildAdmissionReconciler,
  computeCapacity,
  countInFlightByAgent,
  countInFlightByModel,
  extractModelFromJob,
  extractTaskDepthFromJob,
  findDepthViolatingJobs,
  selectAdmittable,
  type AdmissionDeps,
  type AgentLookupFn,
  type JobLister,
  type ModelEndpointLister,
} from './admission.js';
import { API_GROUP_VERSION, type Agent, type AgentSpec, type ModelEndpoint } from './crds/index.js';

/* =====================================================================
 * Job + ModelEndpoint fixture builders
 * ===================================================================== */

interface JobOpts {
  readonly name: string;
  readonly namespace?: string;
  readonly agent: string;
  readonly model: string;
  readonly suspended: boolean;
  /** RFC 3339 creation timestamp — used for FIFO ordering. */
  readonly creationTimestamp?: string;
  readonly resourceVersion?: string;
  /**
   * Parent AgentTask UID — exposed via ownerReferences[0].uid so the
   * Wave 0 Audit emission can record `task.admitted.taskUid`. Defaults
   * to a deterministic `task-<name>-uid` so existing tests don't need
   * updates.
   */
  readonly taskUid?: string;
  /**
   * Parent AgentTask name — stamped on the Job via the
   * `kagent.knuteson.io/task` label by buildJobSpec. Defaults to the
   * Job's own name (matches buildJobSpec's `agentTaskNameToJobName`
   * convention closely enough for these tests).
   */
  readonly taskName?: string;
  /** v0.1.9 — task-tree depth stamped by buildJobSpec. Default 0 (root). */
  readonly taskDepth?: number;
}

function makeJob(opts: JobOpts): V1Job {
  const namespace = opts.namespace ?? 'default';
  // Mirror buildJobSpec's KAGENT_AGENT_SPEC encoding + label scheme.
  const agentSpec: { model: string } = { model: opts.model };
  const taskUid = opts.taskUid ?? `task-${opts.name}-uid`;
  const taskName = opts.taskName ?? opts.name;
  const env: Array<{ name: string; value: string }> = [
    { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify(agentSpec) },
    { name: 'KAGENT_AGENT_NAME', value: opts.agent },
  ];
  if (opts.taskDepth !== undefined) {
    env.push({ name: 'KAGENT_TASK_DEPTH', value: String(opts.taskDepth) });
  }
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: opts.name,
      namespace,
      labels: {
        [AGENT_LABEL]: opts.agent,
        // Wave 0 Audit reads this label to emit `task.admitted.taskName`.
        'kagent.knuteson.io/task': taskName,
        'kagent.knuteson.io/managed-by': 'kagent-operator',
      },
      // Wave 0 Audit reads ownerReferences[0].uid to emit
      // `task.admitted.taskUid`. buildJobSpec always sets this.
      ownerReferences: [
        {
          apiVersion: 'kagent.knuteson.io/v1alpha1',
          kind: 'AgentTask',
          name: taskName,
          uid: taskUid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
      ...(opts.creationTimestamp !== undefined && {
        creationTimestamp: new Date(opts.creationTimestamp),
      }),
      ...(opts.resourceVersion !== undefined && {
        resourceVersion: opts.resourceVersion,
      }),
    },
    spec: {
      suspend: opts.suspended,
      template: {
        spec: {
          containers: [
            {
              name: 'agent',
              image: 'placeholder',
              env,
            },
          ],
        },
      },
    },
  };
}

function makeModelEndpoint(opts: {
  name: string;
  namespace?: string;
  model: string;
  seed: number;
  max: number;
  observedInFlight?: number;
}): ModelEndpoint {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ModelEndpoint',
    metadata: { name: opts.name, namespace: opts.namespace ?? 'default' },
    spec: {
      model: opts.model,
      backendKind: 'ollama',
      backendUrl: 'http://example:11434',
      inFlight: { seed: opts.seed, max: opts.max },
    },
    ...(opts.observedInFlight !== undefined && {
      status: { observedInFlight: opts.observedInFlight },
    }),
  };
}

function makeAgent(name: string, spec: Partial<AgentSpec> & { model: string }): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name, namespace: 'default' },
    spec: { ...spec },
  };
}

/* =====================================================================
 * Pure helpers
 * ===================================================================== */

describe('extractModelFromJob', () => {
  it('reads model from KAGENT_AGENT_SPEC env JSON (v0.1 back-compat path)', () => {
    const job = makeJob({ name: 'j1', agent: 'a', model: 'workers-ai/x', suspended: true });
    expect(extractModelFromJob(job)).toBe('workers-ai/x');
  });

  it('prefers KAGENT_AGENT_MODEL env (v0.2.0 ConfigMap-projected path)', () => {
    // v0.2.0-typed-io drops the JSON env in favor of a ConfigMap
    // mount; admission only needs the model string for capacity
    // gating, so the operator surfaces it as a tiny dedicated env.
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [{ name: 'KAGENT_AGENT_MODEL', value: 'workers-ai/v2' }],
              },
            ],
          },
        },
      },
    };
    expect(extractModelFromJob(job)).toBe('workers-ai/v2');
  });

  it('KAGENT_AGENT_MODEL wins over a stale KAGENT_AGENT_SPEC during rollout', () => {
    // During the rollout where some Jobs still carry the legacy env,
    // the dedicated env ALWAYS wins so admission isn't double-decoding.
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [
                  { name: 'KAGENT_AGENT_MODEL', value: 'new/model' },
                  { name: 'KAGENT_AGENT_SPEC', value: JSON.stringify({ model: 'old/model' }) },
                ],
              },
            ],
          },
        },
      },
    };
    expect(extractModelFromJob(job)).toBe('new/model');
  });

  it('returns undefined when env is missing', () => {
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: { template: { spec: { containers: [{ name: 'agent', image: 'x' }] } } },
    };
    expect(extractModelFromJob(job)).toBeUndefined();
  });

  it('returns undefined when KAGENT_AGENT_SPEC is malformed JSON', () => {
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [{ name: 'KAGENT_AGENT_SPEC', value: 'not json' }],
              },
            ],
          },
        },
      },
    };
    expect(extractModelFromJob(job)).toBeUndefined();
  });

  it('returns undefined when KAGENT_AGENT_SPEC has no model field', () => {
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [{ name: 'KAGENT_AGENT_SPEC', value: '{"systemPrompt":"hi"}' }],
              },
            ],
          },
        },
      },
    };
    expect(extractModelFromJob(job)).toBeUndefined();
  });
});

describe('computeCapacity', () => {
  it('uses status.observedInFlight when present', () => {
    const me = makeModelEndpoint({
      name: 'e',
      model: 'm',
      seed: 1,
      max: 4,
      observedInFlight: 3,
    });
    expect(computeCapacity(me)).toBe(3);
  });

  it('falls back to spec.inFlight.seed when status absent', () => {
    const me = makeModelEndpoint({ name: 'e', model: 'm', seed: 2, max: 8 });
    expect(computeCapacity(me)).toBe(2);
  });

  it('falls back to seed when observedInFlight is explicitly undefined', () => {
    const me: ModelEndpoint = {
      ...makeModelEndpoint({ name: 'e', model: 'm', seed: 5, max: 10 }),
      status: {},
    };
    expect(computeCapacity(me)).toBe(5);
  });

  it('respects observedInFlight=0 (gateway can shrink to zero)', () => {
    const me = makeModelEndpoint({
      name: 'e',
      model: 'm',
      seed: 2,
      max: 4,
      observedInFlight: 0,
    });
    expect(computeCapacity(me)).toBe(0);
  });
});

describe('countInFlightByModel', () => {
  it('counts only un-suspended Jobs whose KAGENT_AGENT_SPEC.model matches', () => {
    const jobs: V1Job[] = [
      makeJob({ name: 'j1', agent: 'a', model: 'm1', suspended: false }),
      makeJob({ name: 'j2', agent: 'a', model: 'm1', suspended: false }),
      makeJob({ name: 'j3', agent: 'a', model: 'm1', suspended: true }), // suspended → not counted
      makeJob({ name: 'j4', agent: 'a', model: 'm2', suspended: false }), // diff model
    ];
    expect(countInFlightByModel(jobs, 'm1')).toBe(2);
    expect(countInFlightByModel(jobs, 'm2')).toBe(1);
  });
});

describe('countInFlightByAgent', () => {
  it('counts only un-suspended Jobs labeled with the agent', () => {
    const jobs: V1Job[] = [
      makeJob({ name: 'j1', agent: 'researcher', model: 'm1', suspended: false }),
      makeJob({ name: 'j2', agent: 'researcher', model: 'm1', suspended: true }),
      makeJob({ name: 'j3', agent: 'writer', model: 'm1', suspended: false }),
    ];
    expect(countInFlightByAgent(jobs, 'researcher')).toBe(1);
    expect(countInFlightByAgent(jobs, 'writer')).toBe(1);
    expect(countInFlightByAgent(jobs, 'absent')).toBe(0);
  });
});

/* =====================================================================
 * selectAdmittable — pure scheduler
 * ===================================================================== */

describe('selectAdmittable', () => {
  it('returns empty when no suspended Jobs exist', () => {
    const result = selectAdmittable({
      suspendedJobs: [],
      runningJobs: [],
      modelEndpoints: new Map(),
      agentMaxInFlight: new Map(),
    });
    expect(result).toEqual([]);
  });

  it('un-suspends a single Pending Job when capacity=1 is available', () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
    });
    expect(result).toEqual([{ namespace: 'default', name: 'j1' }]);
  });

  it('5 Pending, capacity=2 → un-suspends exactly 2 in FIFO order', () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'j2',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
      makeJob({
        name: 'j3',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:03Z',
      }),
      makeJob({
        name: 'j4',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:04Z',
      }),
      makeJob({
        name: 'j5',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:05Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 2, max: 8 })],
      ]),
      agentMaxInFlight: new Map(),
    });
    expect(result.map((r) => r.name)).toEqual(['j1', 'j2']);
  });

  it('respects per-Agent cap=2 when ModelEndpoint cap=10 (Agent cap binds tighter)', () => {
    const suspended: V1Job[] = [];
    for (let i = 1; i <= 5; i++) {
      suspended.push(
        makeJob({
          name: `j${String(i)}`,
          agent: 'researcher',
          model: 'm1',
          suspended: true,
          creationTimestamp: `2026-05-03T10:00:0${String(i)}Z`,
        }),
      );
    }
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 10, max: 10 })],
      ]),
      agentMaxInFlight: new Map([['researcher', 2]]),
    });
    expect(result.map((r) => r.name)).toEqual(['j1', 'j2']);
  });

  it('5 Pending across 2 Agents (A:3, B:2), no per-Agent cap, ModelEndpoint cap=4 → 4 admitted FIFO', () => {
    const suspended: V1Job[] = [
      makeJob({
        name: 'A1',
        agent: 'A',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'B1',
        agent: 'B',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
      makeJob({
        name: 'A2',
        agent: 'A',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:03Z',
      }),
      makeJob({
        name: 'B2',
        agent: 'B',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:04Z',
      }),
      makeJob({
        name: 'A3',
        agent: 'A',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:05Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 4, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
    });
    expect(result.map((r) => r.name)).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  it('leaves Pending Jobs unscheduled when ModelEndpoint missing for the model (fail-closed)', () => {
    const suspended = [
      makeJob({ name: 'j1', agent: 'a', model: 'unmapped-model', suspended: true }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map(),
      agentMaxInFlight: new Map(),
    });
    expect(result).toEqual([]);
  });

  it('uses status.observedInFlight when present (NOT spec.inFlight.seed)', () => {
    const suspended: V1Job[] = [];
    for (let i = 1; i <= 4; i++) {
      suspended.push(
        makeJob({
          name: `j${String(i)}`,
          agent: 'a',
          model: 'm1',
          suspended: true,
          creationTimestamp: `2026-05-03T10:00:0${String(i)}Z`,
        }),
      );
    }
    // seed=1, observedInFlight=3 → cap is 3 (post-AIMD), not 1
    const me = makeModelEndpoint({
      name: 'me1',
      model: 'm1',
      seed: 1,
      max: 4,
      observedInFlight: 3,
    });
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([['m1', me]]),
      agentMaxInFlight: new Map(),
    });
    expect(result.map((r) => r.name)).toEqual(['j1', 'j2', 'j3']);
  });

  it('subtracts already-running Jobs from the available capacity', () => {
    const running = [
      makeJob({ name: 'r1', agent: 'a', model: 'm1', suspended: false }),
      makeJob({ name: 'r2', agent: 'a', model: 'm1', suspended: false }),
    ];
    const suspended = [
      makeJob({
        name: 's1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
      makeJob({
        name: 's2',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: running,
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 3, max: 8 })],
      ]),
      agentMaxInFlight: new Map(),
    });
    // cap=3, already 2 running → only 1 free slot.
    expect(result.map((r) => r.name)).toEqual(['s1']);
  });

  it('admits across multiple models independently (m1 cap doesn’t starve m2)', () => {
    const suspended = [
      makeJob({
        name: 'a1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'b1',
        agent: 'b',
        model: 'm2',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
        ['m2', makeModelEndpoint({ name: 'me2', model: 'm2', seed: 1, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
    });
    expect(result.map((r) => r.name).sort()).toEqual(['a1', 'b1']);
  });

  it('respects per-Agent cap as it admits — 2nd Agent-X Job blocked even if 1st was just admitted', () => {
    const suspended = [
      makeJob({
        name: 'X1',
        agent: 'X',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'X2',
        agent: 'X',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
      makeJob({
        name: 'Y1',
        agent: 'Y',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:03Z',
      }),
    ];
    const result = selectAdmittable({
      suspendedJobs: suspended,
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me1', model: 'm1', seed: 5, max: 5 })],
      ]),
      agentMaxInFlight: new Map([['X', 1]]),
    });
    // X cap=1 — only X1 admitted for X. Y has no cap → Y1 admitted too.
    expect(result.map((r) => r.name).sort()).toEqual(['X1', 'Y1']);
  });
});

/* =====================================================================
 * v0.1.9 — depth cap helpers + scheduler integration
 *
 * Backstop for the in-pod `policy_denied:depth_exceeded` refusal so a
 * malicious / buggy agent-pod can't bypass the cluster cap. Two pieces:
 *
 *   - `extractTaskDepthFromJob` reads the operator-stamped
 *     KAGENT_TASK_DEPTH env (set by buildJobSpec from the AgentTask's
 *     own task-depth label).
 *   - `findDepthViolatingJobs` returns the suspended Jobs whose
 *     decoded depth > maxDepth — caller marks the underlying AgentTasks
 *     Failed.
 *
 * Plus: `selectAdmittable` skips depth-violators so they never get
 * un-suspended even if the Failed-marker hasn't fired yet.
 * ===================================================================== */

describe('extractTaskDepthFromJob (v0.1.9)', () => {
  it('returns the integer parsed from KAGENT_TASK_DEPTH', () => {
    const job = makeJob({
      name: 'j',
      agent: 'a',
      model: 'm',
      suspended: true,
      taskDepth: 3,
    });
    expect(extractTaskDepthFromJob(job)).toBe(3);
  });

  it('returns 0 when env var is absent (treats as root)', () => {
    const job = makeJob({ name: 'j', agent: 'a', model: 'm', suspended: true });
    expect(extractTaskDepthFromJob(job)).toBe(0);
  });

  it('returns 0 for malformed values (defensive — fail-closed)', () => {
    // Build a Job by hand so we can inject a non-numeric depth env.
    const job: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'j', namespace: 'default' },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [{ name: 'KAGENT_TASK_DEPTH', value: 'not-a-number' }],
              },
            ],
          },
        },
      },
    };
    expect(extractTaskDepthFromJob(job)).toBe(0);
  });
});

describe('findDepthViolatingJobs (v0.1.9)', () => {
  it('returns Jobs whose KAGENT_TASK_DEPTH exceeds maxDepth', () => {
    const ok = makeJob({ name: 'ok', agent: 'a', model: 'm', suspended: true, taskDepth: 4 });
    const violator = makeJob({
      name: 'too-deep',
      agent: 'a',
      model: 'm',
      suspended: true,
      taskDepth: 5,
    });
    const out = findDepthViolatingJobs([ok, violator], 4);
    expect(out.map((j) => j.metadata?.name)).toEqual(['too-deep']);
  });

  it('returns empty when no Job exceeds maxDepth', () => {
    const a = makeJob({ name: 'a', agent: 'a', model: 'm', suspended: true, taskDepth: 0 });
    const b = makeJob({ name: 'b', agent: 'a', model: 'm', suspended: true, taskDepth: 4 });
    expect(findDepthViolatingJobs([a, b], 4)).toEqual([]);
  });

  it('treats undefined depth env as 0 (never violates with default cap=4)', () => {
    const job = makeJob({ name: 'j', agent: 'a', model: 'm', suspended: true });
    expect(findDepthViolatingJobs([job], 4)).toEqual([]);
  });

  it('returns empty when maxDepth is undefined (cap not configured)', () => {
    const violator = makeJob({
      name: 'too-deep',
      agent: 'a',
      model: 'm',
      suspended: true,
      taskDepth: 99,
    });
    expect(findDepthViolatingJobs([violator], undefined)).toEqual([]);
  });
});

describe('selectAdmittable — depth cap (v0.1.9)', () => {
  it('skips suspended Jobs that exceed maxDepth (never un-suspends)', () => {
    const tooDeep = makeJob({
      name: 'over',
      agent: 'a',
      model: 'm1',
      suspended: true,
      taskDepth: 99,
      creationTimestamp: '2026-05-03T10:00:00Z',
    });
    const ok = makeJob({
      name: 'ok',
      agent: 'a',
      model: 'm1',
      suspended: true,
      taskDepth: 1,
      creationTimestamp: '2026-05-03T10:00:01Z',
    });
    const result = selectAdmittable({
      suspendedJobs: [tooDeep, ok],
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me', model: 'm1', seed: 4, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
      maxDepth: 4,
    });
    expect(result.map((r) => r.name)).toEqual(['ok']);
  });

  it('admits a Job at the depth boundary (depth = maxDepth)', () => {
    const atBoundary = makeJob({
      name: 'edge',
      agent: 'a',
      model: 'm1',
      suspended: true,
      taskDepth: 4,
    });
    const result = selectAdmittable({
      suspendedJobs: [atBoundary],
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me', model: 'm1', seed: 1, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
      maxDepth: 4,
    });
    expect(result.map((r) => r.name)).toEqual(['edge']);
  });

  it('with maxDepth undefined, behaves exactly as the pre-v0.1.9 scheduler', () => {
    const deep = makeJob({
      name: 'deep',
      agent: 'a',
      model: 'm1',
      suspended: true,
      taskDepth: 100,
    });
    const result = selectAdmittable({
      suspendedJobs: [deep],
      runningJobs: [],
      modelEndpoints: new Map([
        ['m1', makeModelEndpoint({ name: 'me', model: 'm1', seed: 1, max: 4 })],
      ]),
      agentMaxInFlight: new Map(),
      // maxDepth deliberately omitted — the cap is opt-in at admission
      // and admits anything the per-(model, agent) caps allow.
    });
    expect(result.map((r) => r.name)).toEqual(['deep']);
  });
});

/* =====================================================================
 * Reconciler — full evaluate() loop
 * ===================================================================== */

describe('buildAdmissionReconciler', () => {
  function makeReconciler(opts: {
    enabled?: boolean;
    suspendedJobs?: V1Job[];
    runningJobs?: V1Job[];
    modelEndpoints?: ModelEndpoint[];
    agents?: Map<string, Agent>;
    patchImpl?: ReturnType<typeof vi.fn>;
  }): {
    reconciler: ReturnType<typeof buildAdmissionReconciler>;
    patchSpy: ReturnType<typeof vi.fn>;
  } {
    const allJobs = [...(opts.suspendedJobs ?? []), ...(opts.runningJobs ?? [])];
    const listJobs: JobLister = (namespace) => {
      if (namespace === undefined) return allJobs;
      return allJobs.filter((j) => (j.metadata?.namespace ?? 'default') === namespace);
    };
    const listModelEndpoints: ModelEndpointLister = (namespace) => {
      const all = opts.modelEndpoints ?? [];
      if (namespace === undefined) return all;
      return all.filter((m) => (m.metadata.namespace ?? 'default') === namespace);
    };
    const lookupAgent: AgentLookupFn = (namespace, name) => {
      const key = `${namespace}/${name}`;
      return opts.agents?.get(key);
    };
    const patchSpy = opts.patchImpl ?? vi.fn().mockResolvedValue(undefined);
    const deps: AdmissionDeps = {
      enabled: opts.enabled ?? true,
      listJobs,
      listModelEndpoints,
      lookupAgent,
      unsuspendJob: patchSpy,
    };
    return { reconciler: buildAdmissionReconciler(deps), patchSpy };
  }

  it('disabled reconciler is a no-op even with Pending Jobs', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const { reconciler, patchSpy } = makeReconciler({
      enabled: false,
      suspendedJobs: suspended,
      modelEndpoints: [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 5, max: 10 })],
    });
    const summary = await reconciler.evaluate();
    expect(summary).toEqual({ admitted: 0, conflicts: 0, skipped: 0 });
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('un-suspends a Pending Job when capacity is available', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const { reconciler, patchSpy } = makeReconciler({
      suspendedJobs: suspended,
      modelEndpoints: [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(1);
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith('default', 'j1');
  });

  it('reads per-Agent cap from Agent.spec.maxInFlightTasks (CR lookup)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'researcher',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'j2',
        agent: 'researcher',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
      makeJob({
        name: 'j3',
        agent: 'researcher',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:03Z',
      }),
    ];
    const agents = new Map<string, Agent>();
    agents.set('default/researcher', makeAgent('researcher', { model: 'm1', maxInFlightTasks: 2 }));
    const { reconciler, patchSpy } = makeReconciler({
      suspendedJobs: suspended,
      modelEndpoints: [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 10, max: 10 })],
      agents,
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(2);
    expect(patchSpy).toHaveBeenCalledTimes(2);
  });

  it('handles concurrent un-suspend race — patch returns 409, reconciler re-evaluates with fresh view', async () => {
    // Setup: 2 suspended Jobs, capacity=2. Both j1 + j2 are
    // admittable on the first scheduling pass. The patch on j1
    // rejects with 409 — simulating another reconciler tick that
    // raced ahead and admitted j1 first. Per spec: do NOT retry the
    // same Job. Instead, refresh the view and re-evaluate; on the
    // second pass j1 appears as already-running (cap consumes 1
    // slot), j2 is still admittable in the remaining 1 slot, so
    // the reconciler patches j2 to un-suspend.
    const j1 = makeJob({
      name: 'j1',
      agent: 'a',
      model: 'm1',
      suspended: true,
      creationTimestamp: '2026-05-03T10:00:01Z',
      resourceVersion: '1',
    });
    const j2 = makeJob({
      name: 'j2',
      agent: 'a',
      model: 'm1',
      suspended: true,
      creationTimestamp: '2026-05-03T10:00:02Z',
      resourceVersion: '1',
    });
    let suspendedCallCount = 0;
    const dynamicListJobs: JobLister = () => {
      suspendedCallCount++;
      if (suspendedCallCount === 1) {
        // First pass — both Pending.
        return [j1, j2];
      }
      // Second pass: j1 is now running (the racer won).
      return [{ ...j1, spec: { ...j1.spec, suspend: false } }, j2];
    };
    const patchSpy = vi.fn().mockImplementation((_ns: string, name: string) => {
      if (name === 'j1') {
        const conflict = Object.assign(new Error('conflict'), { code: 409 });
        return Promise.reject(conflict);
      }
      return Promise.resolve(undefined);
    });
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: dynamicListJobs,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 2, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: patchSpy,
    });
    const summary = await reconciler.evaluate();
    // First pass: scheduler picks j1 + j2; patch on j1 returns 409.
    // Per spec: break out, re-evaluate. Second pass sees j1 running,
    // cap=2-1=1 free slot, j2 still admittable → patch succeeds.
    expect(summary.conflicts).toBe(1);
    expect(summary.admitted).toBe(1);
    const patchedNames = patchSpy.mock.calls.map((c: unknown[]) => c[1] as string);
    expect(patchedNames).toContain('j2');
  });

  it('handles ModelEndpoint missing (fail-closed) — leaves Pending Jobs alone', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'unmapped',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const { reconciler, patchSpy } = makeReconciler({
      suspendedJobs: suspended,
      modelEndpoints: [],
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('uses ModelEndpoint.status.observedInFlight in the live evaluate path', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
      makeJob({
        name: 'j2',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:02Z',
      }),
      makeJob({
        name: 'j3',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:03Z',
      }),
    ];
    const me = makeModelEndpoint({
      name: 'me1',
      model: 'm1',
      seed: 1,
      max: 4,
      observedInFlight: 2,
    });
    const { reconciler, patchSpy } = makeReconciler({
      suspendedJobs: suspended,
      modelEndpoints: [me],
    });
    const summary = await reconciler.evaluate();
    // observedInFlight=2 wins over seed=1 → 2 admissions.
    expect(summary.admitted).toBe(2);
    expect(patchSpy).toHaveBeenCalledTimes(2);
  });

  it('non-409 patch errors propagate as a per-Job error, not blanket evaluate failure', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const patchSpy = vi.fn().mockRejectedValue(new Error('apiserver down'));
    const { reconciler } = makeReconciler({
      suspendedJobs: suspended,
      modelEndpoints: [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      patchImpl: patchSpy,
    });
    // evaluate() should NOT throw — errors are logged + counted.
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(0);
    expect(summary.errors).toBe(1);
  });

  it('empty Pending queue → no-op summary', async () => {
    const { reconciler, patchSpy } = makeReconciler({
      suspendedJobs: [],
      modelEndpoints: [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 5, max: 10 })],
    });
    const summary = await reconciler.evaluate();
    expect(summary).toEqual({ admitted: 0, conflicts: 0, skipped: 0 });
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

/* =====================================================================
 * Event subscription — re-evaluate on Job + ModelEndpoint events
 * ===================================================================== */

describe('buildAdmissionReconciler — event triggers', () => {
  let evaluateSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    evaluateSpy = vi.fn();
  });

  it('exposes onJobEvent / onModelEndpointEvent — both call evaluate', async () => {
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => [],
      listModelEndpoints: () => [],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn(),
    });
    // Replace evaluate to count invocations.
    reconciler.evaluate = evaluateSpy.mockResolvedValue({
      admitted: 0,
      conflicts: 0,
      skipped: 0,
    });

    await reconciler.onJobEvent();
    await reconciler.onModelEndpointEvent();
    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });

  it('disabled reconciler ignores events without invoking evaluate', async () => {
    const realEvaluate = vi.fn().mockResolvedValue({ admitted: 0, conflicts: 0, skipped: 0 });
    const reconciler = buildAdmissionReconciler({
      enabled: false,
      listJobs: () => [],
      listModelEndpoints: () => [],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn(),
    });
    reconciler.evaluate = realEvaluate;
    await reconciler.onJobEvent();
    await reconciler.onModelEndpointEvent();
    expect(realEvaluate).not.toHaveBeenCalled();
  });
});

/* =====================================================================
 * Wave 0 Audit — `task.admitted` audit-event emission
 *
 * The reconciler MUST emit one audit event per successful admission,
 * carrying the parent AgentTask's identifying fields. Failure paths
 * (missing label, hook throws) MUST be observable + logged but never
 * break the dispatch path. See packages/audit-events/ for the
 * CloudEvents v1.0 envelope + best-effort publisher contract.
 * ===================================================================== */

describe('buildAdmissionReconciler — Wave 0 Audit emission', () => {
  it('emits exactly one task.admitted audit event per successful admission', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'researcher',
        model: 'workers-ai/llama-4-scout',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
        taskUid: 'task-uid-fixed',
        taskName: 'researcher-1',
      }),
    ];
    const allJobs = suspended;
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => allJobs,
      listModelEndpoints: () => [
        makeModelEndpoint({
          name: 'me1',
          model: 'workers-ai/llama-4-scout',
          seed: 1,
          max: 4,
        }),
      ],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn().mockResolvedValue(undefined),
      emitAudit: auditSpy,
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(1);
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy).toHaveBeenCalledWith({
      taskUid: 'task-uid-fixed',
      taskNamespace: 'default',
      taskName: 'researcher-1',
      agentName: 'researcher',
      model: 'workers-ai/llama-4-scout',
    });
  });

  it('emits audit per admission across multiple admitted jobs', async () => {
    const suspended: V1Job[] = [];
    for (let i = 1; i <= 3; i++) {
      suspended.push(
        makeJob({
          name: `j${String(i)}`,
          agent: 'researcher',
          model: 'm1',
          suspended: true,
          creationTimestamp: `2026-05-03T10:00:0${String(i)}Z`,
          taskUid: `task-uid-${String(i)}`,
          taskName: `t-${String(i)}`,
        }),
      );
    }
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 5, max: 5 })],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn().mockResolvedValue(undefined),
      emitAudit: auditSpy,
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(3);
    expect(auditSpy).toHaveBeenCalledTimes(3);
    const uids = auditSpy.mock.calls.map((c: unknown[]) => (c[0] as { taskUid: string }).taskUid);
    expect(uids.sort()).toEqual(['task-uid-1', 'task-uid-2', 'task-uid-3']);
  });

  it('does NOT emit audit when admission is disabled (master switch off)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const reconciler = buildAdmissionReconciler({
      enabled: false,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn().mockResolvedValue(undefined),
      emitAudit: auditSpy,
    });
    await reconciler.evaluate();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit audit when un-suspend fails (no false positives)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const unsuspend = vi.fn().mockRejectedValue(new Error('apiserver down'));
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: unsuspend,
      emitAudit: auditSpy,
    });
    await reconciler.evaluate();
    // The patch failed → no audit emission for that Job.
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit audit on 409 conflict (the racer wins)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const conflict = Object.assign(new Error('conflict'), { code: 409 });
    const unsuspend = vi.fn().mockRejectedValue(conflict);
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: unsuspend,
      emitAudit: auditSpy,
    });
    await reconciler.evaluate();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('emitAudit hook that rejects does NOT break the dispatch path (best-effort)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
      makeJob({
        name: 'j2',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:01Z',
      }),
    ];
    const auditSpy = vi.fn().mockRejectedValue(new Error('audit-publisher exploded'));
    const unsuspend = vi.fn().mockResolvedValue(undefined);
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 5, max: 5 })],
      lookupAgent: () => undefined,
      unsuspendJob: unsuspend,
      emitAudit: auditSpy,
    });
    const summary = await reconciler.evaluate();
    // Both Jobs admitted despite emitAudit failing.
    expect(summary.admitted).toBe(2);
    expect(unsuspend).toHaveBeenCalledTimes(2);
    expect(auditSpy).toHaveBeenCalledTimes(2);
  });

  it('skips emission (logs warning) when ownerReferences[0].uid is missing', async () => {
    const malformed: V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: 'j-malformed',
        namespace: 'default',
        labels: {
          [AGENT_LABEL]: 'a',
          'kagent.knuteson.io/task': 't-malformed',
          'kagent.knuteson.io/managed-by': 'kagent-operator',
        },
        creationTimestamp: new Date('2026-05-03T10:00:00Z'),
        // ownerReferences omitted
      },
      spec: {
        suspend: true,
        template: {
          spec: {
            containers: [
              {
                name: 'agent',
                image: 'x',
                env: [{ name: 'KAGENT_AGENT_SPEC', value: JSON.stringify({ model: 'm1' }) }],
              },
            ],
          },
        },
      },
    };
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => [malformed],
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn().mockResolvedValue(undefined),
      emitAudit: auditSpy,
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(1);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('absent emitAudit hook is a no-op (back-compat with non-audit installs)', async () => {
    const suspended = [
      makeJob({
        name: 'j1',
        agent: 'a',
        model: 'm1',
        suspended: true,
        creationTimestamp: '2026-05-03T10:00:00Z',
      }),
    ];
    const reconciler = buildAdmissionReconciler({
      enabled: true,
      listJobs: () => suspended,
      listModelEndpoints: () => [makeModelEndpoint({ name: 'me1', model: 'm1', seed: 1, max: 4 })],
      lookupAgent: () => undefined,
      unsuspendJob: vi.fn().mockResolvedValue(undefined),
      // no emitAudit provided
    });
    const summary = await reconciler.evaluate();
    expect(summary.admitted).toBe(1);
  });
});

/* =====================================================================
 * Wave 3 / Locality — pod-pressure circuit breaker
 * ===================================================================== */

describe('countPendingAgentPods', () => {
  it('counts pods in phase=Pending', async () => {
    const { countPendingAgentPods } = await import('./admission.js');
    const pods = [
      { status: { phase: 'Pending' } },
      { status: { phase: 'Pending' } },
      { status: { phase: 'Running' } },
      { status: { phase: 'Succeeded' } },
      {},
    ];
    expect(countPendingAgentPods(pods)).toBe(2);
  });

  it('returns 0 for empty input', async () => {
    const { countPendingAgentPods } = await import('./admission.js');
    expect(countPendingAgentPods([])).toBe(0);
  });
});

describe('checkPodPressure', () => {
  it('passes when observed <= threshold', async () => {
    const { checkPodPressure } = await import('./admission.js');
    expect(checkPodPressure(0, 50).ok).toBe(true);
    expect(checkPodPressure(50, 50).ok).toBe(true);
  });

  it('refuses with structured taxonomy when observed > threshold', async () => {
    const { checkPodPressure, POD_PRESSURE_REFUSAL_REASON } = await import('./admission.js');
    const result = checkPodPressure(51, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(POD_PRESSURE_REFUSAL_REASON);
      expect(result.observed).toBe(51);
      expect(result.threshold).toBe(50);
      expect(result.message).toContain('51');
      expect(result.message).toContain('50');
      expect(result.message).toContain('policy_denied:pod_pressure_threshold');
    }
  });

  it('passes when threshold is invalid (NaN/negative) — fail-OPEN to avoid bricking on misconfig', async () => {
    const { checkPodPressure } = await import('./admission.js');
    expect(checkPodPressure(100, Number.NaN).ok).toBe(true);
    expect(checkPodPressure(100, -1).ok).toBe(true);
  });

  it('passes when observed is invalid', async () => {
    const { checkPodPressure } = await import('./admission.js');
    expect(checkPodPressure(Number.NaN, 50).ok).toBe(true);
  });

  it('exposes the default threshold constant', async () => {
    const { DEFAULT_POD_PRESSURE_MAX_PENDING_PODS } = await import('./admission.js');
    expect(DEFAULT_POD_PRESSURE_MAX_PENDING_PODS).toBe(50);
  });
});
