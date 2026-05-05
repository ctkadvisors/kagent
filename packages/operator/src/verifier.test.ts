/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Verifier reconciler tests — v0.1.7-rig.2 substrate verifier.
 *
 * Coverage matrix:
 *   - shouldRunVerifier (gate)
 *   - pickDispatchMode (path selection)
 *   - truncateReason / renderLlmJudgePrompt / parseVerifierJudgeReply (pure helpers)
 *   - script-path: ConfigMap + Job creation, ownerRef shape, exit-0 → pass,
 *     exit-1 → fail with stdout tail, timeout
 *   - llmJudge-path: Langfuse fetch, gateway POST, JSON parse pass/fail/non-JSON,
 *     gateway timeout, gateway error status
 *   - misconfig: both paths set → fail-closed; neither path set → fail-closed;
 *     gateway not configured → fail-closed
 *   - idempotency: second event with status.verification set → no-op
 *   - audit emissions on all three terminal cases
 *   - status patch shape
 */

import type { V1ConfigMap, V1Job, V1JobCondition } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';

import type { AgentTask } from './crds/index.js';
import {
  buildVerifierReconciler,
  extractParentOutputForJudge,
  parseVerifierJudgeReply,
  pickDispatchMode,
  renderLlmJudgePrompt,
  shouldRunVerifier,
  truncateReason,
  VERIFIER_JOB_LABEL,
  type VerifierAuditHooks,
  type VerifierDispatchDeps,
} from './verifier.js';

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  const base = {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: {
      name: 'researcher-1',
      namespace: 'default',
      uid: 'task-uid-1234',
      ...(overrides.metadata ?? {}),
    },
    spec: {
      targetAgent: 'researcher',
      payload: { topic: 'k3s' },
      ...(overrides.spec ?? {}),
    },
    status: {
      phase: 'Completed' as const,
      result: { content: 'k3s is great', verdict: 'ok' },
      ...(overrides.status ?? {}),
    },
  };
  return base as unknown as AgentTask;
}

function recordingAudit(): {
  hooks: VerifierAuditHooks;
  started: ReturnType<typeof vi.fn>;
  completed: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
} {
  const started = vi.fn(() => Promise.resolve());
  const completed = vi.fn(() => Promise.resolve());
  const failed = vi.fn(() => Promise.resolve());
  return {
    hooks: {
      emitVerifierStarted: started,
      emitVerifierCompleted: completed,
      emitVerifierFailed: failed,
    },
    started,
    completed,
    failed,
  };
}

interface FakeApi {
  customApi: VerifierDispatchDeps['customApi'];
  batchApi: VerifierDispatchDeps['batchApi'];
  coreApi: VerifierDispatchDeps['coreApi'];
  patches: ReturnType<typeof vi.fn>;
  jobs: V1Job[];
  configMaps: { name: string; data: Record<string, string> }[];
  setJobOutcome: (outcome: V1Job['status']) => void;
  setReadTask: (task: AgentTask) => void;
}

function fakeApi(): FakeApi {
  let jobOutcome: V1Job['status'] = { active: 1 };
  let readTask: AgentTask | undefined;
  const jobs: V1Job[] = [];
  const configMaps: { name: string; data: Record<string, string> }[] = [];
  const patches = vi.fn(() => Promise.resolve(undefined));
  const customApi = {
    patchNamespacedCustomObjectStatus: patches,
    getNamespacedCustomObject: vi.fn(({ name }: { name: string }) =>
      Promise.resolve(
        readTask ?? {
          apiVersion: 'kagent.knuteson.io/v1alpha1',
          kind: 'AgentTask',
          metadata: { name, namespace: 'default', uid: 'task-uid-1234' },
          spec: { targetAgent: 'researcher' },
          status: { phase: 'Completed' },
        },
      ),
    ),
  } as unknown as VerifierDispatchDeps['customApi'];
  const batchApi = {
    createNamespacedJob: vi.fn(({ body }: { body: V1Job }) => {
      jobs.push(body);
      return Promise.resolve(body);
    }),
    readNamespacedJob: vi.fn(({ name }: { name: string }) => {
      const job = jobs.find((j) => j.metadata?.name === name);
      if (job === undefined) {
        const err = new Error('not found');
        (err as { code?: number }).code = 404;
        return Promise.reject(err);
      }
      return Promise.resolve({ ...job, status: jobOutcome });
    }),
  } as unknown as VerifierDispatchDeps['batchApi'];
  const coreApi = {
    createNamespacedConfigMap: vi.fn(({ body }: { body: V1ConfigMap }) => {
      configMaps.push({
        name: String(body.metadata?.name ?? ''),
        data: body.data ?? {},
      });
      return Promise.resolve(body);
    }),
  } as unknown as VerifierDispatchDeps['coreApi'];
  return {
    customApi,
    batchApi,
    coreApi,
    patches,
    jobs,
    configMaps,
    setJobOutcome: (outcome) => {
      jobOutcome = outcome;
    },
    setReadTask: (task) => {
      readTask = task;
    },
  };
}

// ---------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------

describe('shouldRunVerifier (gate)', () => {
  it('refuses non-Completed phases', () => {
    const task = makeTask({
      status: { phase: 'Failed' },
      spec: { targetAgent: 'x', verifyContract: { llmJudgePromptRef: { name: 'p' } } },
    } as Partial<AgentTask>);
    expect(shouldRunVerifier(task)).toBe(false);
  });

  it('refuses tasks without verifyContract', () => {
    const task = makeTask();
    expect(shouldRunVerifier(task)).toBe(false);
  });

  it('refuses tasks already verified', () => {
    const task = makeTask({
      spec: {
        targetAgent: 'x',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
      status: {
        phase: 'Completed',
        verification: { passed: true, mode: 'llmJudge', completedAt: '2026-05-05T00:00:00Z' },
      },
    } as Partial<AgentTask>);
    expect(shouldRunVerifier(task)).toBe(false);
  });

  it('refuses empty contracts (forward-compat schema-only)', () => {
    const task = makeTask({
      spec: { targetAgent: 'x', verifyContract: {} },
    } as Partial<AgentTask>);
    expect(shouldRunVerifier(task)).toBe(false);
  });

  it('admits Completed + verifyContract.llmJudgePromptRef + no verification', () => {
    const task = makeTask({
      spec: {
        targetAgent: 'x',
        verifyContract: { llmJudgePromptRef: { name: 'p', version: 1 } },
      },
    } as Partial<AgentTask>);
    expect(shouldRunVerifier(task)).toBe(true);
  });

  it('admits Completed + verifyContract.scriptRef', () => {
    const task = makeTask({
      spec: {
        targetAgent: 'x',
        verifyContract: { scriptRef: { name: 's' } },
      },
    } as Partial<AgentTask>);
    expect(shouldRunVerifier(task)).toBe(true);
  });
});

describe('pickDispatchMode', () => {
  it('chooses script when only scriptRef is set', () => {
    expect(pickDispatchMode({ scriptRef: { name: 's' } })).toEqual({ mode: 'script' });
  });
  it('chooses llmJudge when only llmJudgePromptRef is set', () => {
    expect(pickDispatchMode({ llmJudgePromptRef: { name: 'p' } })).toEqual({ mode: 'llmJudge' });
  });
  it('returns misconfig:both_paths_set when both are set', () => {
    expect(
      pickDispatchMode({
        scriptRef: { name: 's' },
        llmJudgePromptRef: { name: 'p' },
      }),
    ).toEqual({ mode: 'misconfig', reason: 'verifier_misconfig:both_paths_set' });
  });
  it('returns misconfig:no_paths_set when neither is set', () => {
    expect(pickDispatchMode({})).toEqual({
      mode: 'misconfig',
      reason: 'verifier_misconfig:no_paths_set',
    });
  });
});

describe('truncateReason', () => {
  it('returns short strings unchanged', () => {
    expect(truncateReason('hello')).toBe('hello');
  });
  it('truncates long strings + appends marker', () => {
    const long = 'a'.repeat(8192);
    const out = truncateReason(long, 100);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('(truncated)')).toBe(true);
  });
});

describe('renderLlmJudgePrompt', () => {
  it('substitutes {{outputs}}', () => {
    expect(renderLlmJudgePrompt('Check: {{outputs}}', '{"x":1}')).toBe('Check: {"x":1}');
  });
  it('tolerates whitespace inside the template tag', () => {
    expect(renderLlmJudgePrompt('Check: {{ outputs }}', '"y"')).toBe('Check: "y"');
  });
  it('substitutes multiple occurrences', () => {
    expect(renderLlmJudgePrompt('{{outputs}} and {{outputs}}', '5')).toBe('5 and 5');
  });
});

describe('extractParentOutputForJudge', () => {
  it('returns null for null/undefined', () => {
    expect(extractParentOutputForJudge(null)).toBeNull();
    expect(extractParentOutputForJudge(undefined)).toBeNull();
  });

  it('returns primitives as-is (rare; preserves shape)', () => {
    expect(extractParentOutputForJudge('plain')).toBe('plain');
    expect(extractParentOutputForJudge(42)).toBe(42);
    expect(extractParentOutputForJudge(true)).toBe(true);
  });

  it('unwraps { content: <plain string> } to the string', () => {
    expect(extractParentOutputForJudge({ content: 'k3s is great' })).toBe('k3s is great');
  });

  it('unwraps + parses { content: "<json-stringified object>" } to the parsed value', () => {
    expect(
      extractParentOutputForJudge({ content: '{"answer":"K stands for Kubernetes."}' }),
    ).toEqual({ answer: 'K stands for Kubernetes.' });
  });

  it('strips a single fenced ```json``` block from content before parsing', () => {
    expect(extractParentOutputForJudge({ content: '```json\n{"answer":"x"}\n```' })).toEqual({
      answer: 'x',
    });
  });

  it('strips a bare ``` fence from content before parsing', () => {
    expect(extractParentOutputForJudge({ content: '```\n{"a":1}\n```' })).toEqual({ a: 1 });
  });

  it('returns the raw content string when JSON parse fails', () => {
    expect(extractParentOutputForJudge({ content: 'not JSON, just prose.' })).toBe(
      'not JSON, just prose.',
    );
  });

  it('returns the value as-is when content is non-string (e.g. number)', () => {
    expect(extractParentOutputForJudge({ content: 42 })).toBe(42);
  });

  it('returns the empty string as-is when content is empty/whitespace', () => {
    expect(extractParentOutputForJudge({ content: '' })).toBe('');
    expect(extractParentOutputForJudge({ content: '   ' })).toBe('   ');
  });

  it('does NOT unwrap when shape has fields beyond `content` (preserves data)', () => {
    const env = { content: 'k3s is great', verdict: 'ok' };
    expect(extractParentOutputForJudge(env)).toEqual(env);
  });

  it('returns the object as-is when it has no `content` key', () => {
    const obj = { answer: 'direct' };
    expect(extractParentOutputForJudge(obj)).toEqual(obj);
  });

  it('renders cleanly into the judge prompt — string answer case', () => {
    const judgeInput = extractParentOutputForJudge({ content: 'k3s is great' });
    expect(renderLlmJudgePrompt('Outputs: {{outputs}}', JSON.stringify(judgeInput))).toBe(
      'Outputs: "k3s is great"',
    );
  });

  it('renders cleanly into the judge prompt — structured answer case', () => {
    const judgeInput = extractParentOutputForJudge({
      content: '{"answer":"K stands for Kubernetes."}',
    });
    expect(renderLlmJudgePrompt('Outputs: {{outputs}}', JSON.stringify(judgeInput))).toBe(
      'Outputs: {"answer":"K stands for Kubernetes."}',
    );
  });
});

describe('parseVerifierJudgeReply', () => {
  it('parses bare JSON', () => {
    expect(parseVerifierJudgeReply('{"verdict":"pass","reason":"shape ok"}')).toEqual({
      verdict: 'pass',
      reason: 'shape ok',
    });
  });
  it('parses JSON inside ```json fences', () => {
    const fenced = '```json\n{"verdict":"fail","reason":"missing field"}\n```';
    expect(parseVerifierJudgeReply(fenced)).toEqual({
      verdict: 'fail',
      reason: 'missing field',
    });
  });
  it('parses JSON inside bare ``` fences', () => {
    expect(parseVerifierJudgeReply('```\n{"verdict":"pass","reason":""}\n```')).toEqual({
      verdict: 'pass',
      reason: '',
    });
  });
  it('returns null on non-JSON', () => {
    expect(parseVerifierJudgeReply('not json at all')).toBeNull();
  });
  it('returns null on JSON with unknown verdict', () => {
    expect(parseVerifierJudgeReply('{"verdict":"maybe","reason":"x"}')).toBeNull();
  });
  it('returns null on empty content', () => {
    expect(parseVerifierJudgeReply('')).toBeNull();
    expect(parseVerifierJudgeReply('   ')).toBeNull();
  });
  it('returns null on JSON-array (not object)', () => {
    expect(parseVerifierJudgeReply('[1,2,3]')).toBeNull();
  });
  it('handles missing reason gracefully', () => {
    expect(parseVerifierJudgeReply('{"verdict":"pass"}')).toEqual({
      verdict: 'pass',
      reason: '',
    });
  });
});

// ---------------------------------------------------------------------
// scriptRef path tests
// ---------------------------------------------------------------------

function failedJobStatus(reason: string, message: string): V1Job['status'] {
  const cond: V1JobCondition = {
    type: 'Failed',
    status: 'True',
    reason,
    message,
    lastTransitionTime: new Date(),
  };
  return { failed: 1, conditions: [cond] };
}

describe('verifier — scriptRef path', () => {
  it('creates Job + ConfigMap with ownerRef on parent task; exit-0 → passed:true', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome({ succeeded: 1 });
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: { scriptRef: { name: 'json-shape-checker' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      jobPollIntervalMs: 5,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.action).toBe('verified');
    expect(result.verdict?.passed).toBe(true);
    expect(result.verdict?.mode).toBe('script');
    // ConfigMap created.
    expect(fixture.configMaps).toHaveLength(1);
    expect(fixture.configMaps[0]?.data?.['input.json']).toContain('"taskUid":"task-uid-1234"');
    // Job created with ownerRef.
    expect(fixture.jobs).toHaveLength(1);
    const job = fixture.jobs[0];
    expect(job?.metadata?.ownerReferences?.[0]?.uid).toBe('task-uid-1234');
    expect(job?.metadata?.ownerReferences?.[0]?.controller).toBe(true);
    expect(job?.metadata?.ownerReferences?.[0]?.blockOwnerDeletion).toBe(true);
    expect(job?.metadata?.labels?.[VERIFIER_JOB_LABEL]).toBe('true');
    // Status patch landed.
    expect(fixture.patches).toHaveBeenCalledTimes(1);
    expect(audit.started).toHaveBeenCalledTimes(1);
    expect(audit.completed).toHaveBeenCalledTimes(1);
    expect(audit.failed).not.toHaveBeenCalled();
  });

  it('exit-1 → passed:false with script_failed reason carrying the condition message', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome(
      failedJobStatus(
        'BackoffLimitExceeded',
        'verifier said: missing field "verdict" (exit code 1)',
      ),
    );
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: { scriptRef: { name: 'json-shape-checker' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      jobPollIntervalMs: 5,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.action).toBe('verified');
    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.mode).toBe('script');
    expect(result.verdict?.reason).toContain('script_exit_1');
    expect(result.verdict?.reason).toContain('missing field');
    expect(audit.failed).toHaveBeenCalledTimes(1);
    expect(audit.completed).not.toHaveBeenCalled();
  });

  it('Job DeadlineExceeded condition → reason verifier_timeout', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome(
      failedJobStatus('DeadlineExceeded', 'Job was active longer than specified deadline'),
    );
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: { scriptRef: { name: 'slow-script' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      jobPollIntervalMs: 5,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toContain('verifier_timeout');
  });

  it('treats AlreadyExists (409) on Job/ConfigMap as success and re-uses existing', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome({ succeeded: 1 });
    const conflictErr: Error & { code?: number } = new Error('already exists');
    conflictErr.code = 409;
    (fixture.batchApi.createNamespacedJob as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      conflictErr,
    );
    (fixture.coreApi.createNamespacedConfigMap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      conflictErr,
    );
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: { scriptRef: { name: 's' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({ ...fixture, jobPollIntervalMs: 5 });
    // Pre-seed the Job in the fake apiserver so the polling loop sees
    // the succeeded outcome.
    fixture.jobs.push({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'researcher-1-verify', namespace: 'default' },
      spec: {},
      status: {},
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------
// llmJudgePromptRef path tests
// ---------------------------------------------------------------------

function fakeFetch(resp: { status?: number; body?: unknown } | { reject: Error }): typeof fetch {
  // Cast through unknown — vi.fn's signature isn't structurally identical
  // to typeof fetch's overloaded shape, so the eslint rule's assertion-
  // unnecessary check would fire on a direct cast. Going through unknown
  // keeps both ends honest.
  const fn = vi.fn(() => {
    if ('reject' in resp) {
      return Promise.reject(resp.reject);
    }
    const status = resp.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(resp.body),
    } as unknown as Response);
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return fn as unknown as typeof fetch;
}

describe('verifier — llmJudgePromptRef path', () => {
  it('fetches prompt from Langfuse, renders {{outputs}}, POSTs to gateway, parses pass verdict', async () => {
    const fixture = fakeApi();
    const audit = recordingAudit();
    const fetchPrompt = vi.fn((name: string, version?: number) => {
      expect(name).toBe('rc-pilot-verifier-jsonshape');
      expect(version).toBe(1);
      return Promise.resolve('Verifier prompt — outputs were: {{outputs}}');
    });
    const fetchSpy = vi.fn((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        messages: { content: string }[];
        model: string;
      };
      // Prompt must have been rendered.
      expect(body.messages[0]?.content).toContain('"content":"k3s is great"');
      expect(body.model).toBe('gpt-4o-mini');
      expect(url).toBe('http://gateway/v1/chat/completions');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"verdict":"pass","reason":"shape ok"}' } }],
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: {
          llmJudgePromptRef: { name: 'rc-pilot-verifier-jsonshape', version: 1 },
        },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      fetchPrompt,
      fetch: fetchSpy,
      gatewayBaseUrl: 'http://gateway/v1',
      gatewayApiKey: 'sk-test',
      defaultModel: 'gpt-4o-mini',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(true);
    expect(result.verdict?.mode).toBe('llmJudge');
    expect(result.judgeRef).toBe('rc-pilot-verifier-jsonshape@1');
    expect(fetchPrompt).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(audit.started).toHaveBeenCalledTimes(1);
    expect(audit.completed).toHaveBeenCalledTimes(1);
    // Status patch shape.
    const callArgs = fixture.patches.mock.calls[0]?.[0] as {
      body: { status: { verification: { passed: boolean; mode: string; completedAt: string } } };
    };
    expect(callArgs.body.status.verification.passed).toBe(true);
    expect(callArgs.body.status.verification.mode).toBe('llmJudge');
  });

  it('unwraps `{ content: <json-string> }` so the judge sees the structured answer (RC pilot shape)', async () => {
    // Reproduces the rc-pilot envelope: agent-pod wraps the structured
    // answer the agent emitted in `{ content: ... }`. Without the
    // unwrap fix, the judge sees `{"content":"{\"answer\":...}"}` and
    // correctly fails. With the fix, the judge sees the raw
    // `{"answer":"K stands for Kubernetes."}` and can evaluate the
    // contract authored against that shape.
    const fixture = fakeApi();
    const audit = recordingAudit();
    const fetchPrompt = vi.fn(() =>
      Promise.resolve('Outputs were: {{outputs}}. Reply JSON {verdict, reason}.'),
    );
    const fetchSpy = vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
      const rendered = body.messages[0]?.content ?? '';
      // Pre-fix this would have been the literal nested string
      // `"content":"{\"answer\":\"K stands for Kubernetes.\"}"`.
      // Post-fix, the judge sees the parsed structured answer directly.
      expect(rendered).toContain('{"answer":"K stands for Kubernetes."}');
      expect(rendered).not.toContain('"content"');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"verdict":"pass","reason":"shape ok"}' } }],
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;
    const task = makeTask({
      spec: {
        targetAgent: 'researcher',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
      status: {
        phase: 'Completed' as const,
        // Single-key envelope; matches what agent-pod actually writes.
        result: { content: '{"answer":"K stands for Kubernetes."}' },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      fetchPrompt,
      fetch: fetchSpy,
      gatewayBaseUrl: 'http://gateway/v1',
      gatewayApiKey: 'sk-test',
      defaultModel: 'gpt-4o-mini',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('parses fail verdict → passed:false with verdict:fail reason', async () => {
    const fixture = fakeApi();
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      fetchPrompt: () => Promise.resolve('p'),
      fetch: fakeFetch({
        body: {
          choices: [
            { message: { content: '{"verdict":"fail","reason":"output is prose, not JSON"}' } },
          ],
        },
      }),
      gatewayBaseUrl: 'http://gateway/v1',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toContain('verdict:fail');
    expect(result.verdict?.reason).toContain('output is prose');
    expect(audit.failed).toHaveBeenCalledTimes(1);
  });

  it('non-JSON content → passed:false with verifier_returned_non_json', async () => {
    const fixture = fakeApi();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      fetchPrompt: () => Promise.resolve('p'),
      fetch: fakeFetch({
        body: {
          choices: [{ message: { content: 'hello, this is just prose.' } }],
        },
      }),
      gatewayBaseUrl: 'http://gateway/v1',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('verifier_returned_non_json');
  });

  it('Langfuse fetch failure → passed:false with langfuse_fetch_failed', async () => {
    const fixture = fakeApi();
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'unknown-prompt' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      fetchPrompt: () => Promise.reject(new Error('Langfuse 404')),
      fetch: fakeFetch({ body: {} }),
      gatewayBaseUrl: 'http://gateway/v1',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('langfuse_fetch_failed');
    expect(audit.failed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'langfuse_fetch_failed' }),
    );
  });

  it('gateway non-200 → passed:false with gateway_error:<status>', async () => {
    const fixture = fakeApi();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      fetchPrompt: () => Promise.resolve('p'),
      fetch: fakeFetch({ status: 502, body: {} }),
      gatewayBaseUrl: 'http://gateway/v1',
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('gateway_error:502');
  });

  it('gateway timeout (AbortError) → passed:false with verifier_timeout', async () => {
    const fixture = fakeApi();
    const audit = recordingAudit();
    const abortErr = new Error('aborted');
    abortErr.name = 'TimeoutError';
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      fetchPrompt: () => Promise.resolve('p'),
      fetch: fakeFetch({ reject: abortErr }),
      gatewayBaseUrl: 'http://gateway/v1',
      gatewayTimeoutMs: 50,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('verifier_timeout');
    expect(audit.failed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'verifier_timeout' }),
    );
  });

  it('refuses with gateway_unconfigured when KAGENT_LLM_GATEWAY_BASE_URL is unset', async () => {
    const fixture = fakeApi();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      fetchPrompt: () => Promise.resolve('p'),
      // no gatewayBaseUrl
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('verifier_misconfig:gateway_unconfigured');
  });

  it('refuses with langfuse_unconfigured when fetchPrompt is unwired', async () => {
    const fixture = fakeApi();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      gatewayBaseUrl: 'http://gateway/v1',
      // no fetchPrompt
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('verifier_misconfig:langfuse_unconfigured');
  });
});

// ---------------------------------------------------------------------
// Misconfig + idempotency
// ---------------------------------------------------------------------

describe('verifier — misconfiguration', () => {
  it('both paths set → fail-closed with verifier_misconfig:both_paths_set, status patched + audit.failed', async () => {
    const fixture = fakeApi();
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: {
          scriptRef: { name: 's' },
          llmJudgePromptRef: { name: 'p' },
        },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.verdict?.passed).toBe(false);
    expect(result.verdict?.reason).toBe('verifier_misconfig:both_paths_set');
    // No Job + no ConfigMap created — fail before dispatch.
    expect(fixture.jobs).toHaveLength(0);
    expect(fixture.configMaps).toHaveLength(0);
    expect(audit.started).toHaveBeenCalledTimes(1);
    expect(audit.failed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'verifier_misconfig:both_paths_set' }),
    );
  });
});

describe('verifier — idempotency', () => {
  it('second event with status.verification set → no-op (action: skipped)', async () => {
    const fixture = fakeApi();
    const reconciler = buildVerifierReconciler({ ...fixture });
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
      status: {
        phase: 'Completed',
        verification: { passed: true, mode: 'llmJudge', completedAt: '2026-05-05T00:00:00Z' },
      },
    } as Partial<AgentTask>);

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.action).toBe('skipped');
    expect(fixture.patches).not.toHaveBeenCalled();
  });

  it('skips when re-read shows verification already set (race-window guard)', async () => {
    const fixture = fakeApi();
    const reconciler = buildVerifierReconciler({ ...fixture });
    // Informer-cache snapshot: no verification yet.
    const stale = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
    } as Partial<AgentTask>);
    // Re-read returns: a peer already patched verification.
    const fresh = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
      status: {
        phase: 'Completed',
        verification: { passed: false, mode: 'llmJudge', completedAt: '2026-05-05T00:00:00Z' },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(fresh);

    const result = await reconciler.onAgentTaskUpdate(stale);

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('idempotent-hit');
    expect(fixture.patches).not.toHaveBeenCalled();
  });

  it('coalesces concurrent dispatches via the per-uid mutex', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome({ succeeded: 1 });
    const audit = recordingAudit();
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { scriptRef: { name: 's' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: audit.hooks,
      jobPollIntervalMs: 5,
    });

    // Fire two events concurrently. The mutex should serialize them
    // and the second call inherits the first's result.
    const [r1, r2] = await Promise.all([
      reconciler.onAgentTaskUpdate(task),
      reconciler.onAgentTaskUpdate(task),
    ]);
    expect(r1.action).toBe('verified');
    expect(r2.action).toBe('verified');
    // Only ONE Job creation regardless of which actually-ran.
    expect(
      (fixture.batchApi.createNamespacedJob as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------
// Defensive
// ---------------------------------------------------------------------

describe('verifier — defensive', () => {
  it('skips tasks without metadata.uid', async () => {
    const fixture = fakeApi();
    const reconciler = buildVerifierReconciler({ ...fixture });
    // Direct construction (bypasses makeTask's default uid).
    const task: AgentTask = {
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'AgentTask',
      metadata: { name: 'no-uid', namespace: 'default' },
      spec: {
        targetAgent: 'r',
        verifyContract: { llmJudgePromptRef: { name: 'p' } },
      },
      status: { phase: 'Completed', result: 'x' },
    } as AgentTask;

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('missing-uid');
  });

  it('does not throw when audit hook itself throws', async () => {
    const fixture = fakeApi();
    fixture.setJobOutcome({ succeeded: 1 });
    const broken: VerifierAuditHooks = {
      emitVerifierStarted: vi.fn(() => Promise.reject(new Error('audit nope'))),
      emitVerifierCompleted: vi.fn(() => Promise.reject(new Error('audit nope'))),
      emitVerifierFailed: vi.fn(() => Promise.reject(new Error('audit nope'))),
    };
    const task = makeTask({
      spec: {
        targetAgent: 'r',
        verifyContract: { scriptRef: { name: 's' } },
      },
    } as Partial<AgentTask>);
    fixture.setReadTask(task);
    const reconciler = buildVerifierReconciler({
      ...fixture,
      audit: broken,
      jobPollIntervalMs: 5,
    });

    const result = await reconciler.onAgentTaskUpdate(task);

    expect(result.action).toBe('verified');
    expect(result.verdict?.passed).toBe(true);
  });
});
