/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ChatDelta, ChatRequest, ChatResult, LLMClient } from '@kagent/agent-loop';
import type { CapabilityBundle } from '@kagent/capability-types';
import { InProcessToolProvider } from '@kagent/in-process-tool-provider';
import { EventPublisher, type EventNatsConnectionLike } from '@kagent/events';
import { describe, expect, it } from 'vitest';

import { defineGetMyContext } from './builtin-tools.js';
import { definePublishEvent } from './builtin-tools-publish.js';
import type { PodConfig } from './env.js';
import {
  buildCancelledResult,
  buildShutdownPlan,
  buildTokenUtilizationBridge,
  selectPublishCapabilityBundle,
} from './main.js';
import { runAgentTask } from './runner.js';

const baseConfig: PodConfig = {
  taskId: 'task-uid-1',
  taskName: 't1',
  taskNamespace: 'default',
  agentName: 'researcher',
  agentSpec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
  },
  taskSpec: {
    payload: {},
  },
  litellmBaseUrl: 'http://litellm.test:4000/v1',
  logLevel: 'info',
  traceContentMode: 'preview',
};

describe('buildShutdownPlan (WS-G — SIGTERM orchestration helper)', () => {
  it('shouldRun=true on the first signal', () => {
    const plan = buildShutdownPlan('SIGTERM', false);
    expect(plan.signalName).toBe('SIGTERM');
    expect(plan.shouldRun).toBe(true);
  });

  it('shouldRun=false on re-entry (idempotent under repeated signals)', () => {
    const plan = buildShutdownPlan('SIGTERM', true);
    expect(plan.shouldRun).toBe(false);
  });

  it('passes through the signal name verbatim for both SIGTERM and SIGINT', () => {
    expect(buildShutdownPlan('SIGINT', false).signalName).toBe('SIGINT');
    expect(buildShutdownPlan('SIGTERM', false).signalName).toBe('SIGTERM');
  });
});

describe('buildCancelledResult (WS-G — pre-runner / mid-cancel synthesis)', () => {
  it('mirrors the runner cancelled-shape: status=cancelled, empty traces, error.message=signal', () => {
    const result = buildCancelledResult(baseConfig, 'SIGTERM');
    expect(result.runId).toBe(baseConfig.taskId);
    expect(result.status).toBe('cancelled');
    expect(result.finalContent).toBeNull();
    expect(result.flags).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.budget.cumulativeInputTokens).toBe(0);
    expect(result.budget.cumulativeOutputTokens).toBe(0);
    expect(result.budget.cumulativeCostUsd).toBeNull();
    expect(result.error?.message).toBe('cancelled: SIGTERM received');
  });

  it('reflects the SIGINT signal name in the error message', () => {
    const result = buildCancelledResult(baseConfig, 'SIGINT');
    expect(result.error?.message).toBe('cancelled: SIGINT received');
  });
});

/* =====================================================================
 * v0.1.11 — W3C Trace Context propagation seam.
 *
 * Two pure helpers exported from main.ts:
 *   - buildSpawnTraceparentGetter(taskId): returns a () => string
 *     callback the spawn tool plumbs into SpawnToolDeps. Always
 *     produces a deterministic v00 traceparent for the parent's
 *     own runId so the child can re-derive the same trace tree.
 *   - parseInheritedParentSpanContext(env): reads OTEL_TRACEPARENT
 *     out of process.env and returns a {traceId, spanId} suitable
 *     for OtelTraceSinkOptions.parentSpanContext, or undefined when
 *     the env is absent / malformed.
 * ===================================================================== */

describe('buildSpawnTraceparentGetter (v0.1.11)', () => {
  it('returns a callback that produces a W3C v00 traceparent for the parent task', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    const get = buildSpawnTraceparentGetter('task-uid-parent-1');
    const tp = get();
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('is deterministic — same taskId → same traceparent on every call', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    const get = buildSpawnTraceparentGetter('task-uid-stable');
    expect(get()).toBe(get());
  });

  it('different taskIds produce different traceparents (no trivial collision)', async () => {
    const { buildSpawnTraceparentGetter } = await import('./main.js');
    expect(buildSpawnTraceparentGetter('a')()).not.toBe(buildSpawnTraceparentGetter('b')());
  });
});

describe('parseInheritedParentSpanContext (v0.1.11)', () => {
  it('returns undefined when OTEL_TRACEPARENT is absent', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(parseInheritedParentSpanContext({})).toBeUndefined();
  });

  it('returns undefined when OTEL_TRACEPARENT is empty', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(parseInheritedParentSpanContext({ OTEL_TRACEPARENT: '' })).toBeUndefined();
  });

  it('returns undefined when OTEL_TRACEPARENT is malformed (logs + degrades)', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    expect(
      parseInheritedParentSpanContext({ OTEL_TRACEPARENT: 'not-a-traceparent' }),
    ).toBeUndefined();
  });

  it('returns the parent context when OTEL_TRACEPARENT is well-formed', async () => {
    const { parseInheritedParentSpanContext } = await import('./main.js');
    const ctx = parseInheritedParentSpanContext({
      OTEL_TRACEPARENT: '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01',
    });
    expect(ctx).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'fedcba9876543210',
    });
  });
});

/* =====================================================================
 * Audit C2.2 HIGH #2 — fail-closed publish capability selection.
 *
 * `selectPublishCapabilityBundle` is the single decision point the
 * publish-event wiring uses to pick which CapabilityBundle (if any) is
 * threaded to `EventPublisher` + `definePublishEvent`. The trust rule:
 * ONLY the operator-minted, JWKS-verified bundle counts. The Agent's
 * GitOps-mutable `spec.capabilityClaims.publish` MUST NOT be allowed to
 * synthesize a bundle that bypasses the cap-issuer signature check.
 * ===================================================================== */

describe('selectPublishCapabilityBundle (audit C2.2 — no synthetic fallback)', () => {
  const sampleOperatorBundle: CapabilityBundle = {
    iss: 'kagent.knuteson.io/operator',
    sub: 'task-uid:real',
    aud: ['kagent-substrate'],
    exp: Math.floor(Date.now() / 1000) + 600,
    jti: 'cap-real-1',
    claims: { publish: ['research.*'] },
  };

  it('returns the operator-minted bundle verbatim when one was loaded', () => {
    const out = selectPublishCapabilityBundle(sampleOperatorBundle, ['research.*']);
    expect(out).toBe(sampleOperatorBundle);
  });

  it('returns undefined when no operator JWT is mounted, even when Agent.spec.capabilityClaims.publish is non-empty', () => {
    const out = selectPublishCapabilityBundle(undefined, ['research.*', 'audit.completed']);
    expect(out).toBeUndefined();
  });

  it('returns undefined when no operator JWT is mounted and no agent-spec claims either', () => {
    const out = selectPublishCapabilityBundle(undefined, undefined);
    expect(out).toBeUndefined();
  });
});

describe('publish_event wiring (audit C2.2 — fail-closed when no operator JWT)', () => {
  interface FakeConn extends EventNatsConnectionLike {
    publishCalls: Array<{ subject: string; data: Uint8Array }>;
    publish(subject: string, data: Uint8Array): void;
    flush(): Promise<void>;
    close(): Promise<void>;
  }

  function makeFakeConn(): FakeConn {
    const conn: FakeConn = {
      publishCalls: [],
      publish(subject, data) {
        conn.publishCalls.push({ subject, data });
      },
      async flush() {
        await Promise.resolve();
      },
      async close() {
        await Promise.resolve();
      },
    };
    return conn;
  }

  const FAKE_CTX = {
    /* satisfies ToolInvocationContext minimally — handler doesn't read it. */
  } as unknown as Parameters<ReturnType<typeof definePublishEvent>['handler']>[1];

  it('refuses publish_event when no operator-signed JWT is mounted, even when Agent.spec.capabilityClaims.publish is non-empty', async () => {
    // Simulate the boot path: no operator-mounted CapabilityBundle (the
    // JWT file at KAGENT_CAP_JWT_FILE was absent), but the Agent CRD
    // spec carries a verbatim `capabilityClaims.publish = ['some.topic']`
    // — exactly the situation the audit flagged as "self-minted bundle
    // bypasses JWKS verification".
    const operatorBundle: CapabilityBundle | undefined = undefined;
    const agentSpecPublishClaims: readonly string[] = ['research.findings'];

    // Run the same selection logic main.ts will use post-fix.
    const wiredBundle = selectPublishCapabilityBundle(operatorBundle, agentSpecPublishClaims);

    // Post-fix invariant: NO synthetic bundle is produced.
    expect(wiredBundle).toBeUndefined();

    // Wire the publish_event tool the way main.ts does, with the wired
    // bundle. The publisher itself gets no `publishClaims` (mirrors the
    // post-fix conditional-spread in main.ts).
    const conn = makeFakeConn();
    const publisher = new EventPublisher({
      source: 'kagent.knuteson.io/agent-pod/researcher/task-uid-1',
      connectFn: () => Promise.resolve(conn),
      logger: { warn: () => {}, error: () => {} },
    });
    await publisher.connect('nats://stub');

    const tool = definePublishEvent({
      publisher,
      capabilityBundle: wiredBundle,
      declaredPublishes: new Set(agentSpecPublishClaims),
    });

    // The tool MUST refuse with policy_denied:no_capability — the LLM
    // sees a structured refusal, NATS sees zero publishes.
    await expect(
      tool.handler({ topic: 'research.findings', data: { x: 1 } }, FAKE_CTX),
    ).rejects.toThrow(/policy_denied:no_capability/);
    expect(conn.publishCalls).toHaveLength(0);
  });
});

/* =====================================================================
 * v0.1.9 / NB1 — `tokenUtilizationSnapshot` is wired through the FULL
 * production pattern.
 *
 * REGRESSION TEST for audit-rev2 BLOCKER NB1
 * (`evidence/audit-rev2/C2.md` §2 NB1).
 *
 * Before the fix, `defineGetMyContext` was constructed in `main.ts`
 * WITHOUT a `tokenUtilizationSnapshot` dep. The handler's
 * `deps.tokenUtilizationSnapshot?.()` optional-chain therefore fell
 * through to the `?? { used: 0, modelWindow: null }` literal on every
 * call — making the LLM read `tokenUtilization.percentage = null`
 * unconditionally, even mid-run. The unit test suite (which injects
 * the dep directly) stayed green; the marquee context-awareness
 * feature was dead in production.
 *
 * This test drives the FULL production wireup pattern (the same
 * holder + thunk + onBudgetReady triple `main.ts` uses), executes a
 * loop where the LLM consumes tokens then calls `get_my_context`,
 * and asserts the LLM observes a non-fallback live utilization
 * snapshot. It would FAIL before the fix and PASS after.
 *
 * Per `evidence/audit-rev2/WIRED-BUT-DEAD-CODE-PARADIGM.md` Step
 * Fix Shape #3, this is the regression test that drives the FULL
 * production wireup, not the unit-with-deps shape.
 * ===================================================================== */

describe('NB1 regression — tokenUtilizationSnapshot wired through production pattern', () => {
  /**
   * Build the smallest LLM client that exercises the wired-up loop
   * with token consumption. First chat() reports a tool_call to
   * `get_my_context` with realistic token usage (input=600, output=350
   * → cumulative=950). Second chat() returns a final string. The
   * handler observes the executor's mutated `RunBudget` AT TOOL-CALL
   * TIME — which is the moment NB1 was failing.
   */
  function llmThatCallsGetMyContextThenFinishes(): {
    llm: LLMClient;
    chatCalls(): number;
  } {
    let calls = 0;
    return {
      llm: {
        chat(_req: ChatRequest): Promise<ChatResult> {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({
              content: '',
              tool_calls: [{ id: 'gmc-1', name: 'get_my_context', args: {} }],
              stopReason: 'tool_use',
              // 600 + 350 = 950 cumulative tokens after this call.
              usage: { inputTokens: 600, outputTokens: 350 },
            });
          }
          return Promise.resolve({
            content: 'done.',
            stopReason: 'end_turn',
            usage: { inputTokens: 5, outputTokens: 5 },
          });
        },
        async *chatStream(_req: ChatRequest): AsyncIterable<ChatDelta> {
          yield { content: 'done.', stopReason: 'end_turn' };
          await Promise.resolve();
        },
      },
      chatCalls: () => calls,
    };
  }

  // Mirrors the main.ts production wireup verbatim:
  //   1. buildTokenUtilizationBridge captures the live RunBudget via
  //      onBudgetReady, exposes a thunk that reads cumulative tokens
  //      at TOOL-CALL time.
  //   2. defineGetMyContext is constructed BEFORE runAgentTask is
  //      called, with the thunk wired into its deps.
  //   3. runAgentTask is given the onBudgetReady callback and the
  //      pre-built tool provider.
  // The order matters because `defineGetMyContext` runs at boot
  // (before the executor allocates its budget), but the snapshot
  // reads at TOOL-CALL time (after the budget exists + has been
  // mutated).

  it('FULL wireup: get_my_context observes live tokenUtilization.used > 0 + modelWindow set + percentage numeric', async () => {
    const cfg: PodConfig = {
      taskId: 'task-uid-nb1',
      taskName: 't-nb1',
      taskNamespace: 'default',
      agentName: 'researcher',
      agentSpec: {
        model: 'workers-ai/x',
        // Agent must declare get_my_context for the substrate
        // tool-allowlist gate to admit it (universal admit also
        // works; we list explicitly to mirror the production
        // contract).
        tools: ['get_my_context'],
      },
      taskSpec: { payload: {} },
      litellmBaseUrl: 'http://litellm.test:4000/v1',
      logLevel: 'info',
      traceContentMode: 'preview',
      // Operator-projected KAGENT_AGENT_MODEL_CONTEXT_WINDOW. Without
      // this, modelWindow stays null and the test cannot distinguish
      // wired-correctly from wired-but-dead.
      contextWindowTokens: 131_072,
    };

    // Production wireup pattern (mirrors main.ts).
    const { onBudgetReady, tokenUtilizationSnapshot } = buildTokenUtilizationBridge(
      cfg.contextWindowTokens,
    );

    // Substrate-tools provider mirrors the in-pod-built provider from
    // main.ts (`InProcessToolProvider({ tools: [defineGetMyContext(...)] })`).
    const ctxDef = defineGetMyContext({
      podConfig: cfg,
      tokenUtilizationSnapshot,
    });

    const substrateTools = new InProcessToolProvider({
      id: 'kagent-substrate',
      tools: [ctxDef],
    });

    const llm = llmThatCallsGetMyContextThenFinishes();

    const result = await runAgentTask(cfg, {
      llm: llm.llm,
      sinks: [],
      spawnTools: substrateTools,
      // KEY: this is the production wire-up that NB1 was missing.
      onBudgetReady,
    });

    // Sanity — both LLM round-trips fired, the tool was called.
    expect(result.status).toBe('completed');
    expect(llm.chatCalls()).toBe(2);

    // The LLM observes `get_my_context`'s payload via the executor's
    // `tool_call` trace entry — the LLM literally sees the
    // tool_output string and reasons over it. Pull THAT exact value
    // out so the assertions reflect what the model would have read,
    // not just what the handler internally returned.
    const toolCallTrace = result.traces.find(
      (t) => t.trace_type === 'tool_call' && t.tool_name === 'get_my_context',
    );
    expect(toolCallTrace).toBeDefined();
    expect(toolCallTrace?.is_error).not.toBe(true);

    // Output is `[{type:'text', text:'<json>'}]` (ContentBlock[] from
    // jsonContent in defineGetMyContext). Parse it to inspect the
    // `tokenUtilization` block.
    const rawOutput = toolCallTrace?.tool_output;
    expect(typeof rawOutput).toBe('string');
    const blocks = JSON.parse(rawOutput as string) as Array<{ type: string; text: string }>;
    const innerJson = blocks[0]?.text;
    expect(typeof innerJson).toBe('string');
    const ctx = JSON.parse(innerJson as string) as {
      tokenUtilization?: { used?: unknown; modelWindow?: unknown; percentage?: unknown };
    };
    const observedUtilization = ctx.tokenUtilization ?? {};

    // The post-fix invariants — these are the EXACT three assertions
    // the audit task brief required:
    //   (1) tokenUtilization.used > 0 after token consumption
    //   (2) tokenUtilization.modelWindow === configured contextWindowTokens
    //   (3) tokenUtilization.percentage is a number (not null)
    expect(typeof observedUtilization.used).toBe('number');
    expect(observedUtilization.used as number).toBeGreaterThan(0);
    // 600 input + 350 output = 950 cumulative; the get_my_context
    // tool call happens AFTER the first chat() resolves, so the
    // executor has already credited those tokens onto the live budget.
    expect(observedUtilization.used).toBe(950);

    expect(observedUtilization.modelWindow).toBe(131_072);
    expect(observedUtilization.modelWindow).not.toBeNull();

    expect(typeof observedUtilization.percentage).toBe('number');
    expect(observedUtilization.percentage).not.toBeNull();
    // 950/131072 ≈ 0.00725; rounded to 4 decimals → 0.0072.
    expect(observedUtilization.percentage as number).toBeGreaterThan(0);
    expect(observedUtilization.percentage as number).toBeLessThan(0.01);
  });
});

/* =====================================================================
 * NH1 (audit-rev2 C2 §3) — `budget.tokensRemaining` reports REMAINING,
 * not the cap, when wired through the FULL production pattern.
 *
 * REGRESSION TEST for audit-rev2 HIGH NH1.
 *
 * Pre-fix, `defineGetMyContext`'s handler set
 * `budget.tokensRemaining = tokenLimit` unconditionally — the ceiling,
 * not the actual remaining capacity. Any agent prompt logic like "if
 * tokensRemaining < 5000, hand off" therefore never triggered.
 *
 * The fix passes `tokenUtilizationSnapshot` (already wired in
 * production via NB1's `buildTokenUtilizationBridge`) into
 * `defineGetMyContext` and uses `snapshot.used` to compute remaining.
 * Both `tokenLimit` and `snapshot.used` are the same currency
 * (cumulative input + output tokens off `RunBudget`), so
 * `tokensRemaining = max(0, tokenLimit - used)`.
 *
 * This test drives the FULL production wireup pattern (same
 * `buildTokenUtilizationBridge` + `onBudgetReady` triple `main.ts`
 * uses) across multiple iterations and asserts `tokensRemaining`
 * decreases monotonically as tokens are consumed.
 * ===================================================================== */

describe('NH1 regression — budget.tokensRemaining reports remaining (not cap) through production pattern', () => {
  /**
   * LLM stub that performs THREE iterations:
   *   - chat #1: tool_call to `get_my_context`, usage 600/350 → +950.
   *   - chat #2: tool_call to `get_my_context`, usage 800/200 → +1000 (cumulative 1950).
   *   - chat #3: final text, usage 5/5.
   * The third chat's usage is irrelevant to the assertions — we sample
   * `tokensRemaining` from the two get_my_context tool_call traces.
   */
  function llmThatCallsGetMyContextTwiceThenFinishes(): {
    llm: LLMClient;
    chatCalls(): number;
  } {
    let calls = 0;
    return {
      llm: {
        chat(_req: ChatRequest): Promise<ChatResult> {
          calls += 1;
          if (calls === 1) {
            return Promise.resolve({
              content: '',
              tool_calls: [{ id: 'gmc-1', name: 'get_my_context', args: {} }],
              stopReason: 'tool_use',
              usage: { inputTokens: 600, outputTokens: 350 },
            });
          }
          if (calls === 2) {
            return Promise.resolve({
              content: '',
              tool_calls: [{ id: 'gmc-2', name: 'get_my_context', args: {} }],
              stopReason: 'tool_use',
              usage: { inputTokens: 800, outputTokens: 200 },
            });
          }
          return Promise.resolve({
            content: 'done.',
            stopReason: 'end_turn',
            usage: { inputTokens: 5, outputTokens: 5 },
          });
        },
        async *chatStream(_req: ChatRequest): AsyncIterable<ChatDelta> {
          yield { content: 'done.', stopReason: 'end_turn' };
          await Promise.resolve();
        },
      },
      chatCalls: () => calls,
    };
  }

  it('FULL wireup: tokensRemaining decreases as tokens are consumed across iterations', async () => {
    const cfg: PodConfig = {
      taskId: 'task-uid-nh1',
      taskName: 't-nh1',
      taskNamespace: 'default',
      agentName: 'researcher',
      agentSpec: {
        model: 'workers-ai/x',
        tools: ['get_my_context'],
      },
      // Per-task user cap. tokenLimit=5000 means after 950 tokens
      // tokensRemaining should be 4050; after 1950 it should be 3050.
      taskSpec: { payload: {}, runConfig: { tokenLimit: 5_000 } },
      litellmBaseUrl: 'http://litellm.test:4000/v1',
      logLevel: 'info',
      traceContentMode: 'preview',
      contextWindowTokens: 131_072,
    };

    // Production wireup pattern (mirrors main.ts).
    const { onBudgetReady, tokenUtilizationSnapshot } = buildTokenUtilizationBridge(
      cfg.contextWindowTokens,
    );
    const ctxDef = defineGetMyContext({
      podConfig: cfg,
      tokenUtilizationSnapshot,
    });
    const substrateTools = new InProcessToolProvider({
      id: 'kagent-substrate',
      tools: [ctxDef],
    });

    const llm = llmThatCallsGetMyContextTwiceThenFinishes();
    const result = await runAgentTask(cfg, {
      llm: llm.llm,
      sinks: [],
      spawnTools: substrateTools,
      onBudgetReady,
    });

    expect(result.status).toBe('completed');
    expect(llm.chatCalls()).toBe(3);

    // Two get_my_context tool_calls in trace order.
    const ctxTraces = result.traces.filter(
      (t) => t.trace_type === 'tool_call' && t.tool_name === 'get_my_context',
    );
    expect(ctxTraces).toHaveLength(2);

    function readTokensRemaining(rawOutput: unknown): number {
      expect(typeof rawOutput).toBe('string');
      const blocks = JSON.parse(rawOutput as string) as Array<{ type: string; text: string }>;
      const innerJson = blocks[0]?.text;
      expect(typeof innerJson).toBe('string');
      const ctx = JSON.parse(innerJson as string) as {
        budget?: { tokensRemaining?: unknown };
      };
      const tr = ctx.budget?.tokensRemaining;
      expect(typeof tr).toBe('number');
      return tr as number;
    }

    // After chat #1 (950 tokens consumed): tokensRemaining = 5000 - 950 = 4050.
    const remainingAfterCall1 = readTokensRemaining(ctxTraces[0]?.tool_output);
    expect(remainingAfterCall1).toBe(4050);

    // After chat #2 (cumulative 1950): tokensRemaining = 5000 - 1950 = 3050.
    const remainingAfterCall2 = readTokensRemaining(ctxTraces[1]?.tool_output);
    expect(remainingAfterCall2).toBe(3050);

    // The whole point of NH1: monotonic decrease, not the ceiling.
    expect(remainingAfterCall2).toBeLessThan(remainingAfterCall1);
    // Pre-fix, BOTH calls would have observed `tokensRemaining: 5000`.
    expect(remainingAfterCall1).not.toBe(5000);
    expect(remainingAfterCall2).not.toBe(5000);
  });

  // Clamp-to-0 behavior is covered at the unit level in
  // builtin-tools.test.ts (`NH1: tokensRemaining clamps to 0 at and
  // past the limit`). End-to-end clamping cannot be driven through
  // `runAgentTask` because the executor's budget-cap check
  // (`executor.ts:831-838`) fires AFTER token accounting but BEFORE
  // tool dispatch — the loop terminates with `status='budget_exceeded'`
  // before `get_my_context` runs, so the LLM never observes the
  // post-overshoot snapshot in production. The unit test exercises the
  // handler directly to assert the `Math.max(0, ...)` clamp.
});

/* =====================================================================
 * `buildTokenUtilizationBridge` unit shape — pure helper invariants.
 * ===================================================================== */

describe('buildTokenUtilizationBridge (NB1 helper)', () => {
  it('returns used=0 + modelWindow=null when contextWindowTokens is undefined and onBudgetReady has not fired', () => {
    const { tokenUtilizationSnapshot } = buildTokenUtilizationBridge(undefined);
    expect(tokenUtilizationSnapshot()).toEqual({ used: 0, modelWindow: null });
  });

  it('returns modelWindow = configured contextWindowTokens even before onBudgetReady fires', () => {
    const { tokenUtilizationSnapshot } = buildTokenUtilizationBridge(131_072);
    expect(tokenUtilizationSnapshot()).toEqual({ used: 0, modelWindow: 131_072 });
  });

  it('after onBudgetReady fires, the snapshot reads cumulativeInputTokens + cumulativeOutputTokens LIVE from the captured ref', () => {
    const { onBudgetReady, tokenUtilizationSnapshot } = buildTokenUtilizationBridge(8000);
    const budget = {
      cumulativeInputTokens: 100,
      cumulativeOutputTokens: 50,
      cumulativeCostUsd: null,
    };
    onBudgetReady(budget);
    expect(tokenUtilizationSnapshot()).toEqual({ used: 150, modelWindow: 8000 });

    // Mutate the captured ref the way the executor does between
    // iterations — the snapshot MUST reflect the new value (live read,
    // not at-construction snapshot).
    budget.cumulativeInputTokens = 600;
    budget.cumulativeOutputTokens = 350;
    expect(tokenUtilizationSnapshot()).toEqual({ used: 950, modelWindow: 8000 });
  });
});
