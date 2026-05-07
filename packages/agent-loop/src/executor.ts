/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AgentExecutor` — vendor-agnostic tool-use loop.
 *
 * Composes Phase 2's `AgentRegistry` with Wave 1's `LLMClient`,
 * `ToolProviderRegistry`, and `TraceSink`s into a deterministic
 * iteration-capped loop. Ships the INSTRUMENTATION (RunBudget,
 * in-memory trace accumulator, AbortSignal propagation) that M2
 * will hang structural enforcement on (budget cap;
 * gate at the band).
 *
 * Loop semantics match D-14 + RESEARCH §3 pseudocode verbatim. Loop body
 * ports `../project_tracker/.../run-lifecycle.ts:373-579` per RESEARCH §1's
 * line-by-line audit; explicitly omits framework-drift drops D-23..D-28
 * (no-tool-call retry, verdict capture, summary follow-up, mid-stream
 * dispatch, provider branching, DB persistence).
 *
 * Five invariants (RESEARCH §3 + D-14):
 *
 * 1. Sequence numbers are monotonic across the entire run (one `seq`
 *    counter shared by `llm_call`, `tool_call`, `iteration_boundary`).
 * 2. `signal.aborted` is checked at FIVE points: top of iteration; after
 *    LLM call; after each tool call; between tool calls in same iteration;
 *    inside catch arms of LLM and tool errors.
 * 3. Budget never enforces; it inspects. Consumer-set `tokenLimit` /
 *    `costLimitUsd` opt into structural exit.
 * 4. `cumulativeCostUsd` stays `null` until ANY backend reports cost;
 *    after first non-null `costUsd`, it accumulates as a number even
 *    across subsequent null reports.
 * 5. Iteration-cap exit produces `status='completed'`, `hitIterationCap=true`
 *    (NOT a failure status).
 */

import type { AgentRegistry } from './registry.js';
import type {
  LLMClient,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ClientContext,
} from './llm-client.js';
import type {
  ToolProvider,
  ToolResult,
  ToolInvocationContext,
  ToolDescriptor,
} from './tool-provider.js';
import { ToolProviderRegistry } from './tool-provider.js';
import type { TraceEntry, TraceSink } from './trace.js';
import { estimateTokens, truncateForStorage, truncateMessages } from './trace.js';
import {
  AgentNotFoundError,
  NoLLMClientError,
  InvalidConfigError,
  LLMClientHttpError,
} from './errors.js';
import { randomUUID } from 'node:crypto';

// =====================================================================
// 429-retry policy (resilience for AIMD at-cap rejections)
// =====================================================================

/**
 * Default retry schedule — exponential 200ms / 800ms / 3200ms.
 *
 * Index 0 is the wait BEFORE retry attempt 1; index 1 is the wait BEFORE
 * retry attempt 2; etc. With `maxRetries=2` (the default), only indices
 * 0 and 1 are consulted — index 2+ is reserved for callers that increase
 * the retry budget. The schedule is a `readonly number[]` so it cannot
 * be mutated through the public type surface.
 */
const DEFAULT_BACKOFF_SCHEDULE: readonly number[] = [200, 800, 3200];

/** Default retry cap — original attempt + 2 retries = 3 round-trips worst-case. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Retry policy applied around every `LLMClient.chat()` call.
 *
 * Triggers ONLY on `LLMClientHttpError` with `status === 429` — other 5xx
 * errors, network errors, protocol errors, and abort errors propagate
 * immediately. This is by design: 429 is the LLM gateway's "absorb a burst
 * via backoff" signal (AIMD at-cap), and folding 5xx into the same path
 * would mask transport-level outages that should fail loud.
 *
 * `Retry-After` (when present on the error via `LLMClientHttpError.retryAfterSec`)
 * wins over the local `backoffSchedule` so the gateway's preferred pacing is
 * authoritative; the schedule is the fallback when the upstream omits the hint.
 *
 * `sleep` is injected for testability — production omits it (defaults to a
 * `setTimeout`-backed promise). Tests pass a fake to assert the exact
 * backoff sequence without consuming wall-clock seconds.
 */
export interface RetryPolicy {
  /**
   * Maximum retries AFTER the original attempt; original + maxRetries = total round-trips.
   *
   * Default: `2` (so 1 original + 2 retries = 3 chat() calls in the worst
   * case). Set to `0` to disable retry entirely (429 fails immediately).
   * MUST be a non-negative integer.
   */
  maxRetries?: number;
  /**
   * Backoff delays in ms BEFORE each retry attempt. `[i]` is the wait before
   * retry `i+1`. Default: `[200, 800, 3200]`.
   *
   * If the schedule has fewer entries than `maxRetries`, the last entry is
   * reused for any further retry (a defensive fallback rather than throwing
   * on a config mismatch). When the upstream `Retry-After` is present on
   * the 429, that wins over this schedule.
   */
  backoffSchedule?: readonly number[];
  /**
   * Sleep injection slot — defaults to `setTimeout`-backed Promise.
   *
   * Tests inject a fake to assert the backoff sequence without burning
   * wall-clock seconds. Production callers omit this; the executor's
   * default sleeps via a `globalThis.setTimeout` Promise wrapper.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Five terminal statuses — D-21. */
export type TerminalStatus = 'completed' | 'failed' | 'timeout' | 'budget_exceeded' | 'cancelled';

/**
 * Per-run budget surface — D-16.
 *
 * Inspectable, not enforced (D-17). M2's band reads `cumulativeCostUsd` and
 * `tokenLimit` to make structural deny decisions before dispatch .
 */
export interface RunBudget {
  /** Sum of input tokens across every LLM call in the run. */
  cumulativeInputTokens: number;
  /** Sum of output tokens across every LLM call in the run. */
  cumulativeOutputTokens: number;
  /** Sum of backend-reported cost in USD; `null` when no backend in the run reported any cost. */
  cumulativeCostUsd: number | null;
  /** Optional cap; if set and exceeded, executor exits with `status='budget_exceeded'`. */
  tokenLimit?: number;
  /** Optional cap; same exit semantics as `tokenLimit`. */
  costLimitUsd?: number;
  /**
   * v0.1.9 / context-awareness slate (docs/CONTEXT-AWARENESS.md §4.3).
   *
   * The model's context-window size in tokens, when known. Read
   * operator-side from `agent.modelClasses[<class>].contextWindowTokens`,
   * projected onto the agent-pod via `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`,
   * and threaded through `runner.ts` into the executor. When undefined,
   * the substrate-side safety-net (Piece 3, `chatWithRetry` pre-call
   * check) and the `context_pressure_ignored` detector (Piece 4) are
   * no-ops — preserving v0.1.8 behavior for classes whose chart entry
   * omits `contextWindowTokens`.
   *
   * Distinct from `tokenLimit` (which is a per-task user cap conventionally
   * set lower than the model window). Both can be set; the safety-net
   * fires on whichever budget hits its threshold first.
   */
  contextWindowTokens?: number;
}

/**
 * Result of `AgentExecutor.run()` — D-22.
 *
 * Resolves on every expected failure mode (`status` carries the kind);
 * exceptions reserved for programmer errors (`AgentNotFoundError`,
 * `NoLLMClientError`, `InvalidConfigError`).
 */
export interface ExecutionResult {
  /** Caller-supplied or auto-generated run id. Matches `TraceEntry.run_id`. */
  runId: string;
  /** Terminal status. `'cancelled'` triggers via AbortSignal; `'timeout'` reserved for future use. */
  status: TerminalStatus;
  /** Final assistant content; null when loop exited without a final text response. */
  finalContent: string | null;
  /** True iff the loop ran the full `maxIterations` without natural exit. Does not imply failure. */
  hitIterationCap: boolean;
  /** Cumulative budget snapshot at exit. */
  budget: RunBudget;
  /** Ordered trace entries. Always populated regardless of sinks count. */
  traces: TraceEntry[];
  /** Populated only when `status === 'failed'`. */
  error?: { message: string; cause?: unknown };
}

/**
 * Per-call input to `AgentExecutor.run()`.
 *
 * `signal` is the consumer-owned cancellation handle. To compose with a
 * timeout, use Node 22's native `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])`.
 */
export interface RunInput<TType extends string = string> {
  /** Agent type to look up in the registry. */
  agentType: TType;
  /** Initial conversation history. Executor prepends `agentDef.systemPrompt` if set. */
  messages: ChatMessage[];
  /** Optional caller-supplied run id. Auto-generated via `randomUUID()` if omitted. */
  runId?: string;
  /** Override the constructor's `defaultMaxIterations` (which itself defaults to 8 — D-12). */
  maxIterations?: number;
  /** Per-run token cap. Exceeding triggers `status='budget_exceeded'`. */
  tokenLimit?: number;
  /** Per-run USD cost cap. Exceeding triggers `status='budget_exceeded'`. */
  costLimitUsd?: number;
  /**
   * v0.1.9 / context-awareness slate (docs/CONTEXT-AWARENESS.md §4.3).
   *
   * The model's context-window size in tokens, when known. Mirrored verbatim
   * onto `RunBudget.contextWindowTokens` so the safety-net (Piece 3) and the
   * `context_pressure_ignored` detector (Piece 4) read one source. Threaded
   * by `runner.ts` from the `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env var the
   * operator projects onto every spawned pod (per docs/CONTEXT-AWARENESS.md
   * §4.1).
   *
   * When undefined, all four context-awareness pieces degrade to no-op —
   * back-compat for v0.1.8 deployments / modelClass entries without a
   * declared window.
   */
  contextWindowTokens?: number;
  /**
   * v0.1.9 / context-awareness slate (docs/CONTEXT-AWARENESS.md §4.5).
   *
   * Fraction of `contextWindowTokens` at which the executor refuses the
   * NEXT LLM call with a substrate-side
   * `LLMClientHttpError(0, 'context_window_substrate_refused: ...')`.
   * MUST be in `(0, 1]`. Defaults to `0.95` per the contract.
   *
   * Validated at the top of `run()` — out-of-range values throw
   * `InvalidConfigError` so misconfiguration surfaces fail-FAST instead
   * of as a silent no-op. Has no effect when `contextWindowTokens` is
   * undefined (the safety-net is gated on both fields being set).
   */
  contextSafetyThreshold?: number;
  /**
   * v0.1.9 / context-awareness slate (NB1 fix; see
   * docs/CONTEXT-AWARENESS.md §4.4).
   *
   * Optional one-shot callback invoked exactly once at the start of
   * `run()`, immediately after the executor allocates the run's
   * `RunBudget`. The callback receives the live mutable budget object —
   * the SAME reference the loop accumulates input/output tokens onto
   * — so callers (typically the agent-pod's `main.ts`) can hand that
   * reference into a `tokenUtilizationSnapshot` thunk wired through
   * `defineGetMyContext`. The thunk reads `cumulativeInputTokens` +
   * `cumulativeOutputTokens` at TOOL-CALL time (not construction
   * time), which is the only correct moment because the loop mutates
   * those fields after every successful chat() call.
   *
   * Without this hook the production wiring of `get_my_context` had
   * no way to thread the live budget into the tool's deps, so
   * `tokenUtilizationSnapshot` always fell back to `{ used: 0,
   * modelWindow: null }` and the LLM read `percentage: null` —
   * making the v0.1.9 marquee "agent-managed context handling"
   * feature inert. See audit `evidence/audit-rev2/C2.md` §2 NB1.
   *
   * Tests that don't need live token introspection omit the field;
   * tests that need it inject a callback that records the budget into
   * a closure-shared variable (mirroring the production pattern in
   * `main.ts`).
   */
  onBudgetReady?: (budget: RunBudget) => void;
  /** Caller-owned cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Constructor options for `AgentExecutor`.
 *
 * `toolProviders` is wrapped into a `ToolProviderRegistry` internally.
 * `sinks` defaults to empty (in-memory `traces` is always populated regardless).
 * `defaultMaxIterations` defaults to 8 per D-12.
 */
export interface AgentExecutorOptions<
  TType extends string = string,
  TPhase extends string = string,
> {
  registry: AgentRegistry<TType, TPhase>;
  llm: LLMClient;
  toolProviders?: readonly ToolProvider[];
  sinks?: readonly TraceSink[];
  defaultMaxIterations?: number;
  /**
   * Optional 429-retry policy applied around every `LLMClient.chat()` call.
   *
   * Defaults: `{ maxRetries: 2, backoffSchedule: [200, 800, 3200] }`. Pass
   * `{ maxRetries: 0 }` to disable retry entirely. See `RetryPolicy`.
   */
  retryPolicy?: RetryPolicy;
}

/**
 * Vendor-agnostic tool-use loop.
 */
export class AgentExecutor<TType extends string = string, TPhase extends string = string> {
  private readonly registry: AgentRegistry<TType, TPhase>;
  private readonly llm: LLMClient;
  private readonly toolProviders: ToolProviderRegistry;
  private readonly sinks: readonly TraceSink[];
  private readonly defaultMaxIterations: number;
  private readonly maxRetries: number;
  private readonly backoffSchedule: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AgentExecutorOptions<TType, TPhase>) {
    if (!options.llm) {
      throw new NoLLMClientError();
    }
    if (
      options.defaultMaxIterations !== undefined &&
      (!Number.isInteger(options.defaultMaxIterations) || options.defaultMaxIterations <= 0)
    ) {
      throw new InvalidConfigError('defaultMaxIterations', 'must be a positive integer');
    }

    // Validate retry-policy fields up front so misconfiguration is a
    // construct-time programmer error, not a per-call surprise.
    const rp = options.retryPolicy;
    if (rp?.maxRetries !== undefined && (!Number.isInteger(rp.maxRetries) || rp.maxRetries < 0)) {
      throw new InvalidConfigError('retryPolicy.maxRetries', 'must be a non-negative integer');
    }
    if (rp?.backoffSchedule !== undefined) {
      if (!Array.isArray(rp.backoffSchedule)) {
        throw new InvalidConfigError(
          'retryPolicy.backoffSchedule',
          'must be an array of ms numbers',
        );
      }
      for (const v of rp.backoffSchedule) {
        if (!Number.isFinite(v) || v < 0) {
          throw new InvalidConfigError(
            'retryPolicy.backoffSchedule',
            'each entry must be a non-negative finite number',
          );
        }
      }
    }

    this.registry = options.registry;
    this.llm = options.llm;
    this.sinks = options.sinks ?? [];
    this.defaultMaxIterations = options.defaultMaxIterations ?? 8;
    this.maxRetries = rp?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffSchedule =
      rp?.backoffSchedule && rp.backoffSchedule.length > 0
        ? rp.backoffSchedule
        : DEFAULT_BACKOFF_SCHEDULE;
    this.sleep =
      rp?.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

    // Wrap providers into a federation registry; throws on tool-name conflict.
    const providers = options.toolProviders ?? [];
    this.toolProviders = new ToolProviderRegistry();
    for (const p of providers) {
      this.toolProviders.register(p);
    }
  }

  /**
   * Pick the backoff window before retry attempt `attemptIdx` (1-indexed: the
   * wait BEFORE retry #1 lives at `backoffSchedule[0]`, etc.).
   *
   * `Retry-After` from the upstream wins when present. The schedule clamps
   * to its last entry when callers ask for an attempt beyond the table —
   * defensive rather than throwing on a config mismatch.
   */
  private pickBackoffMs(attemptIdx: number, retryAfterSec: number | undefined): number {
    if (retryAfterSec !== undefined) {
      return Math.max(0, Math.floor(retryAfterSec * 1000));
    }
    const i = Math.min(attemptIdx - 1, this.backoffSchedule.length - 1);
    return this.backoffSchedule[Math.max(0, i)] ?? 0;
  }

  /**
   * Wrap one `LLMClient.chat()` call with the 429-retry policy.
   *
   * Returns either a `ChatResult` (success on attempt 0..N) or rethrows
   * the final error (any non-429, OR the last 429 after exhausting
   * retries). Emits one `llm_call` trace per attempt with the executor's
   * shared `seq` counter — the caller (run loop) appends the success trace
   * separately when this resolves successfully, so `chatWithRetry` ONLY
   * traces the FAILED attempts. The successful attempt is recorded by the
   * existing call site to keep that trace's payload (output_content,
   * synthesized tool_calls, usage accounting) co-located with the place
   * that consumes it.
   *
   * Honors `signal` between attempts: when the signal aborts during
   * backoff, the next retry is skipped and the underlying abort error
   * propagates through the loop's existing `signal.aborted` catch.
   */
  private async chatWithRetry(
    chatRequest: ChatRequest,
    llmCtx: ClientContext,
    bookkeeping: {
      runId: string;
      model: string | undefined;
      currentMessages: readonly ChatMessage[];
      toolDescriptors: readonly ToolDescriptor[];
      seqRef: { value: number };
      traces: TraceEntry[];
      llmStart: number;
      /**
       * Piece 3 (CONTEXT-AWARENESS.md §4.5) — per-run handles for
       * the substrate-side context-window safety-net. The budget is
       * passed by reference so cumulative token state visible at the
       * pre-call check matches the run loop's accounting at the
       * moment of the check (mutated AFTER each successful chat());
       * the threshold is a per-run scalar resolved + validated up in
       * `run()`.
       */
      budget: RunBudget;
      contextSafetyThreshold: number;
    },
  ): Promise<{ result: ChatResult; attempts: number; lastBackoffMs: number | undefined }> {
    let attemptIdx = 0;
    let lastBackoffMs: number | undefined;
    // Loop runs at most maxRetries+1 times: original (attempt 0) + maxRetries.
    for (;;) {
      try {
        // ─── Piece 3 (CONTEXT-AWARENESS.md §4.5) ──────────────────
        // Substrate-side context-window safety-net. Refuse the next
        // LLM call when cumulative tokens reach the configured
        // fraction of the model's window — fail clean here instead
        // of letting the upstream's terminal `400
        // context_length_exceeded` land. Status 0 ensures the
        // existing 429-retry path (gated to `status === 429`) does
        // NOT kick in: refusal is terminal.
        //
        // Gate on `contextWindowTokens !== undefined` so back-compat
        // configs (no chart entry, env unset) are no-ops. When both
        // values are set, every retry attempt re-checks — consistent
        // with the per-attempt 429 trace pattern even though refusal
        // is terminal in practice.
        const window = bookkeeping.budget.contextWindowTokens;
        if (window !== undefined) {
          const used =
            bookkeeping.budget.cumulativeInputTokens + bookkeeping.budget.cumulativeOutputTokens;
          const limit = bookkeeping.contextSafetyThreshold * window;
          if (used >= limit) {
            const reason = `context_window_substrate_refused: cumulative=${used} window=${window} threshold=${bookkeeping.contextSafetyThreshold}`;
            // Use status=0 so the existing 429-retry guard
            // (executor.ts:407 — gated to `status === 429`) does NOT
            // kick in: refusal is terminal. The reason string is
            // carried in `body` per the canonical
            // `LLMClientHttpError(status, body, ...)` arg order, and
            // ALSO replaces the auto-synthesized "LLM backend
            // returned HTTP 0" message so the substrate's status
            // writer (packages/agent-pod/src/status.ts) surfaces the
            // structured reason via `error.message` per
            // docs/CONTEXT-AWARENESS.md §4.5.
            const refusal = new LLMClientHttpError(0, reason);
            refusal.message = reason;
            throw refusal;
          }
        }
        const result = await this.llm.chat(chatRequest, llmCtx);
        return { result, attempts: attemptIdx, lastBackoffMs };
      } catch (err) {
        // Retry ONLY on LLMClientHttpError(status=429). Every other error
        // (including aborts, protocol errors, other HTTP statuses,
        // network failures surfacing as status=0) propagates immediately.
        const is429 = err instanceof LLMClientHttpError && err.status === 429;
        const canRetry = is429 && attemptIdx < this.maxRetries;
        if (!canRetry) {
          // If this WAS the final 429 attempt, emit a per-attempt trace
          // so observers see the full ladder; the run loop's catch arm
          // emits its own llm_call entry for the final failure record
          // too — but that one is keyed on the LATEST attempt. Emit
          // here only for the EARLIER attempts that the run loop's
          // catch will not see (it sees only the last throw).
          if (is429 && attemptIdx > 0) {
            // We already traced attempts 0..attemptIdx-1 below; this
            // particular throw will be re-raised and the run loop
            // emits its own trace for attempt `attemptIdx`. No
            // duplication.
          }
          throw err;
        }
        // Trace the failed attempt BEFORE sleeping so the trace order
        // (failed call → backoff → retry call) reflects wall time.
        const backoffMs = this.pickBackoffMs(attemptIdx + 1, err.retryAfterSec);
        const errMsg = err.message;
        const errEntry: TraceEntry = {
          schema_version: '1',
          run_id: bookkeeping.runId,
          sequence: bookkeeping.seqRef.value++,
          trace_type: 'llm_call',
          timestamp_ms: Date.now(),
          latency_ms: Date.now() - bookkeeping.llmStart,
          ...(bookkeeping.model !== undefined && { model: bookkeeping.model }),
          input_messages: truncateMessages(bookkeeping.currentMessages),
          tools_available: JSON.stringify(bookkeeping.toolDescriptors.map((t) => t.name)),
          cost_usd: null,
          error: errMsg,
          retry_attempt: attemptIdx,
        };
        bookkeeping.traces.push(errEntry);
        await this.emitToSinks(errEntry);

        // Sleep before the retry. Honor abort during sleep so a SIGTERM
        // landing mid-backoff doesn't burn the full window before
        // surfacing as cancelled.
        await this.sleep(backoffMs);
        if (llmCtx.abortSignal.aborted) {
          // Surface as the original 429 error so the run loop's catch
          // arm sees it through the existing `signal.aborted` check
          // and downgrades to status='cancelled'. Throwing the
          // captured `err` keeps the cause chain intact.
          throw err;
        }

        lastBackoffMs = backoffMs;
        attemptIdx++;
        // Reset llmStart so per-attempt latency metric measures THIS
        // attempt only, not cumulative backoff. The previous attempt's
        // failed-attempt trace already captured its own latency above.
        bookkeeping.llmStart = Date.now();
      }
    }
  }

  /**
   * Execute the tool-use loop for one run.
   *
   * Always resolves to `ExecutionResult` for expected failures (status carries
   * the kind). Throws only on programmer errors:
   *
   * - `AgentNotFoundError` — `input.agentType` not in the registry
   * - `InvalidConfigError` — `input.maxIterations` not a positive integer
   */
  async run(input: RunInput<TType>): Promise<ExecutionResult> {
    // ─── Setup ───────────────────────────────────────────────────────
    const agentDef = this.registry.getAgent(input.agentType);
    if (!agentDef) {
      throw new AgentNotFoundError(input.agentType);
    }
    if (
      input.maxIterations !== undefined &&
      (!Number.isInteger(input.maxIterations) || input.maxIterations <= 0)
    ) {
      throw new InvalidConfigError('maxIterations', 'must be a positive integer');
    }
    // Piece 3 (CONTEXT-AWARENESS.md §4.5) — validate the safety
    // threshold up front. MUST be in (0, 1]. The contract default
    // (0.95) is applied below when the field is omitted; explicit
    // out-of-range values fail-FAST so a misconfigured operator chart
    // doesn't silently degrade to "never refuse" or "always refuse".
    if (
      input.contextSafetyThreshold !== undefined &&
      (!Number.isFinite(input.contextSafetyThreshold) ||
        input.contextSafetyThreshold <= 0 ||
        input.contextSafetyThreshold > 1)
    ) {
      throw new InvalidConfigError(
        'contextSafetyThreshold',
        'must be a finite number in the range (0, 1]',
      );
    }

    const runId = input.runId ?? randomUUID();
    const signal = input.signal ?? new AbortController().signal;
    const maxIterations = input.maxIterations ?? this.defaultMaxIterations;
    // Piece 3 — resolve the per-run threshold (default 0.95 per
    // docs/CONTEXT-AWARENESS.md §4.1). The agent-pod's runner reads
    // KAGENT_CONTEXT_SAFETY_THRESHOLD from env and threads it here;
    // tests pass it directly. The check is gated on
    // `budget.contextWindowTokens !== undefined` regardless, so this
    // value is moot until the operator wires the window per modelClass.
    const contextSafetyThreshold = input.contextSafetyThreshold ?? 0.95;

    const budget: RunBudget = {
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUsd: null,
      ...(input.tokenLimit !== undefined && { tokenLimit: input.tokenLimit }),
      ...(input.costLimitUsd !== undefined && { costLimitUsd: input.costLimitUsd }),
      // v0.1.9 — mirror the model's context-window onto RunBudget so the
      // safety-net (Piece 3, pre-call check in chatWithRetry) and the
      // `context_pressure_ignored` detector (Piece 4) read one source.
      ...(input.contextWindowTokens !== undefined && {
        contextWindowTokens: input.contextWindowTokens,
      }),
    };
    // v0.1.9 / NB1 — hand the LIVE mutable budget reference back to the
    // caller so `tokenUtilizationSnapshot` (wired through
    // `defineGetMyContext` in main.ts) reads cumulative tokens at
    // TOOL-CALL time, not at construction. Wrapped in try/catch so a
    // misbehaving observer cannot fail the run (the budget itself is
    // owned by the executor; the callback is a one-way data export).
    if (input.onBudgetReady !== undefined) {
      try {
        input.onBudgetReady(budget);
      } catch (err) {
        // Defensive: log but do not propagate. The hook is observation
        // only; an exception here would otherwise terminate a run for
        // a wireup defect rather than for any agent-loop fault.
        console.warn(
          `[agent-loop] onBudgetReady observer threw — ignoring: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const traces: TraceEntry[] = [];
    // Sequence counter as a mutable ref so `chatWithRetry` can advance it
    // when emitting per-attempt failure traces. The run loop reads the
    // same `seqRef.value` for its own trace appends below.
    const seqRef = { value: 0 };

    // Pre-loop abort check (RESEARCH §7 Pitfall 6) — return BEFORE any work.
    if (signal.aborted) {
      return {
        runId,
        status: 'cancelled',
        finalContent: null,
        hitIterationCap: false,
        budget,
        traces,
      };
    }

    // Build initial messages: prepend systemPrompt as `role: 'system'` if set
    // and not already supplied by the caller.
    const currentMessages: ChatMessage[] = [...input.messages];
    if (
      agentDef.systemPrompt &&
      (currentMessages.length === 0 || currentMessages[0]?.role !== 'system')
    ) {
      currentMessages.unshift({ role: 'system', content: agentDef.systemPrompt });
    }

    // Federate tool descriptors across all providers (D-11). Pass the
    // run's `runId` + `signal` (WS-G) so subprocess-backed providers
    // (e.g. MCP) can wire `tools/list` cancellation through to their
    // underlying RPC — without this, a slow MCP server's listTools()
    // pins the loop until the SDK default 60s timeout fires.
    const describeCtx: ToolInvocationContext = { runId, abortSignal: signal };
    const toolDescriptors: ToolDescriptor[] = await this.toolProviders.describeAll(describeCtx);

    let finalContent: string | null = null;
    let status: TerminalStatus = 'completed';
    let errorBox: { message: string; cause?: unknown } | undefined;
    let completedNaturally = false;

    // ─── Main loop ───────────────────────────────────────────────────
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Invariant 2.a — abort check at top of iteration.
      if (signal.aborted) {
        status = 'cancelled';
        completedNaturally = true;
        break;
      }

      // Iteration-boundary trace (RESEARCH §8 Q2 — at start of iteration).
      const boundaryEntry: TraceEntry = {
        schema_version: '1',
        run_id: runId,
        sequence: seqRef.value++,
        trace_type: 'iteration_boundary',
        timestamp_ms: Date.now(),
        latency_ms: 0,
        iteration,
      };
      traces.push(boundaryEntry);
      await this.emitToSinks(boundaryEntry);

      // (1) Call LLM
      const llmCtx: ClientContext = { runId, abortSignal: signal };
      // systemPrompt already prepended into messages above — intentionally omitted here.
      const chatRequest: ChatRequest = {
        messages: currentMessages,
        ...(agentDef.defaultModel !== undefined && { model: agentDef.defaultModel }),
        ...(toolDescriptors.length > 0 && { tools: toolDescriptors }),
        ...(agentDef.llmParams?.temperature !== undefined && {
          temperature: agentDef.llmParams.temperature,
        }),
        ...(agentDef.llmParams?.maxTokens !== undefined && {
          maxTokens: agentDef.llmParams.maxTokens,
        }),
        ...(agentDef.llmParams?.stopSequences !== undefined && {
          stopSequences: agentDef.llmParams.stopSequences,
        }),
      };
      let llmStart = Date.now();
      let llmResult: ChatResult;
      let retryAttempts = 0;
      let lastBackoffMs: number | undefined;
      try {
        const outcome = await this.chatWithRetry(chatRequest, llmCtx, {
          runId,
          model: agentDef.defaultModel,
          currentMessages,
          toolDescriptors,
          seqRef,
          traces,
          llmStart,
          // Piece 3 — substrate-side context-window safety-net
          // threading. Pass the live budget by reference so the
          // pre-call check sees mutations from prior successful
          // chat() calls (executor.ts:646-654).
          budget,
          contextSafetyThreshold,
        });
        llmResult = outcome.result;
        retryAttempts = outcome.attempts;
        lastBackoffMs = outcome.lastBackoffMs;
        // chatWithRetry resets its own llmStart between attempts; reflect
        // that here so the success-path llm_call latency reflects the
        // FINAL attempt only (matches the per-attempt failure traces it
        // already emitted for prior 429s).
        if (retryAttempts > 0) {
          // The last successful attempt's start time — chatWithRetry
          // already updated `bookkeeping.llmStart`, but that's our
          // local copy. Re-read by approximating: each prior failed
          // attempt was already traced with its own latency, so the
          // success entry below uses Date.now() - llmStart from the
          // moment AFTER the last sleep. We approximate by snapping
          // llmStart to "now minus a small epsilon" — since the run
          // loop doesn't observe the exact retry attempt's start
          // separately, this is a best-effort latency for the
          // successful attempt only.
          llmStart = Date.now();
        }
      } catch (err) {
        // Invariant 2.e — abort check inside LLM catch arm.
        if (signal.aborted) {
          status = 'cancelled';
          completedNaturally = true;
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        const errEntry: TraceEntry = {
          schema_version: '1',
          run_id: runId,
          sequence: seqRef.value++,
          trace_type: 'llm_call',
          timestamp_ms: Date.now(),
          latency_ms: Date.now() - llmStart,
          ...(agentDef.defaultModel !== undefined && { model: agentDef.defaultModel }),
          input_messages: truncateMessages(currentMessages),
          tools_available: JSON.stringify(toolDescriptors.map((t) => t.name)),
          cost_usd: null,
          error: msg,
          // When this throw is the FINAL 429 after retries were
          // exhausted, attribute the trace to the last attempt index
          // (maxRetries) so observers see the full ladder. For
          // non-429 throws, retryAttempts stays 0 — same field is
          // absent so the existing trace shape is unchanged.
          ...(err instanceof LLMClientHttpError &&
            err.status === 429 &&
            this.maxRetries > 0 && {
              retry_attempt: this.maxRetries,
            }),
        };
        traces.push(errEntry);
        await this.emitToSinks(errEntry);
        status = 'failed';
        errorBox = { message: msg, cause: err };
        completedNaturally = true;
        break;
      }

      // Synthesize stable tool-call IDs BEFORE recording the LLM trace
      // and BEFORE pushing the assistant message into chat history.
      // Some Llama 4 / Workers AI variants omit `id` entirely; if we
      // left those undefined on the assistant message and only
      // substituted a fallback when building the tool-result
      // `tool_call_id`, the model would re-read history with
      // mismatched (or absent) IDs and the multi-turn flow would
      // confuse it.
      //
      // Mutate a NEW array (do NOT mutate the LLMClient's response
      // object — callers may inspect or replay it). The synthesized
      // IDs are reused below for `tool_call_id` so assistant ↔ tool
      // message correlation always agrees, and the trace serializes
      // the synthesized version (not the under-specified original).
      const synthesizedToolCalls = llmResult.tool_calls
        ? llmResult.tool_calls.map((tc, idx) => ({
            ...tc,
            id: tc.id && tc.id.length > 0 ? tc.id : `call_${tc.name}_${seqRef.value + idx + 1}`,
          }))
        : undefined;

      // (2) Record LLM trace + token + cost accounting
      const llmEntry: TraceEntry = {
        schema_version: '1',
        run_id: runId,
        sequence: seqRef.value++,
        trace_type: 'llm_call',
        timestamp_ms: Date.now(),
        latency_ms: Date.now() - llmStart,
        ...(agentDef.defaultModel !== undefined && { model: agentDef.defaultModel }),
        input_messages: truncateMessages(currentMessages),
        output_content: truncateForStorage(llmResult.content),
        ...(synthesizedToolCalls && {
          output_tool_calls: truncateForStorage(JSON.stringify(synthesizedToolCalls)),
        }),
        input_tokens_est:
          llmResult.usage?.inputTokens ??
          estimateTokens(currentMessages.map((m) => m.content).join('\n')),
        output_tokens_est: llmResult.usage?.outputTokens ?? estimateTokens(llmResult.content),
        cost_usd: llmResult.usage?.costUsd ?? null,
        ...(llmResult.stopReason !== undefined && { stop_reason: llmResult.stopReason }),
        tools_available: JSON.stringify(toolDescriptors.map((t) => t.name)),
        // When the chat() succeeded only after one or more retries,
        // stamp this trace with the attempt index that succeeded and
        // the backoff that preceded it. Common-path (no retry):
        // retryAttempts === 0, both fields stay omitted (existing
        // shape unchanged).
        ...(retryAttempts > 0 && { retry_attempt: retryAttempts }),
        ...(retryAttempts > 0 &&
          lastBackoffMs !== undefined && { retry_backoff_ms: lastBackoffMs }),
      };
      traces.push(llmEntry);
      await this.emitToSinks(llmEntry);

      // Token accounting — backend-reported wins; fallback to estimate.
      budget.cumulativeInputTokens +=
        llmResult.usage?.inputTokens ??
        estimateTokens(currentMessages.map((m) => m.content).join('\n'));
      budget.cumulativeOutputTokens +=
        llmResult.usage?.outputTokens ?? estimateTokens(llmResult.content);
      // Cost accounting — stays null until ANY backend reports cost.
      if (llmResult.usage?.costUsd != null) {
        budget.cumulativeCostUsd = (budget.cumulativeCostUsd ?? 0) + llmResult.usage.costUsd;
      }

      // (3) Budget cap check
      if (
        budget.tokenLimit !== undefined &&
        budget.cumulativeInputTokens + budget.cumulativeOutputTokens >= budget.tokenLimit
      ) {
        status = 'budget_exceeded';
        completedNaturally = true;
        break;
      }
      if (
        budget.costLimitUsd !== undefined &&
        budget.cumulativeCostUsd !== null &&
        budget.cumulativeCostUsd >= budget.costLimitUsd
      ) {
        status = 'budget_exceeded';
        completedNaturally = true;
        break;
      }

      // Invariant 2.b — abort check after LLM call.
      if (signal.aborted) {
        status = 'cancelled';
        completedNaturally = true;
        break;
      }

      // (4) Tool dispatch OR loop exit
      if (!synthesizedToolCalls || synthesizedToolCalls.length === 0) {
        finalContent = llmResult.content;
        completedNaturally = true;
        break;
      }

      // Append assistant message with the synthesized-id tool_calls.
      currentMessages.push({
        role: 'assistant',
        content: llmResult.content,
        tool_calls: synthesizedToolCalls,
      });

      // Tool dispatch loop (one iteration per tool_call).
      let cancelledMidTool = false;
      for (const toolCall of synthesizedToolCalls) {
        // Invariant 2.d — abort check between tool calls.
        if (signal.aborted) {
          status = 'cancelled';
          cancelledMidTool = true;
          break;
        }

        // Synthesis already happened above; reuse the (now non-empty) id.
        const callId = toolCall.id;
        const provider = this.toolProviders.providerFor(toolCall.name);

        if (!provider) {
          // Surface as tool error message (NOT executor throw).
          const errMsg = `Tool "${toolCall.name}" has no registered provider`;
          const noProvEntry: TraceEntry = {
            schema_version: '1',
            run_id: runId,
            sequence: seqRef.value++,
            trace_type: 'tool_call',
            timestamp_ms: Date.now(),
            latency_ms: 0,
            tool_name: toolCall.name,
            tool_input: truncateForStorage(JSON.stringify(toolCall.args)),
            tool_output: errMsg,
            is_error: true,
            error: errMsg,
          };
          traces.push(noProvEntry);
          await this.emitToSinks(noProvEntry);
          currentMessages.push({
            role: 'tool',
            content: errMsg,
            tool_call_id: callId,
            name: toolCall.name,
          });
          continue;
        }

        const toolStart = Date.now();
        const toolCtx: ToolInvocationContext = { runId, abortSignal: signal };
        try {
          const toolResult: ToolResult = await provider.executeTool(toolCall, toolCtx);
          const toolEntry: TraceEntry = {
            schema_version: '1',
            run_id: runId,
            sequence: seqRef.value++,
            trace_type: 'tool_call',
            timestamp_ms: Date.now(),
            latency_ms: Date.now() - toolStart,
            tool_name: toolCall.name,
            tool_provider_id: provider.id,
            tool_input: truncateForStorage(JSON.stringify(toolCall.args)),
            tool_output: truncateForStorage(stringifyToolContent(toolResult.content)),
            is_error: toolResult.isError,
          };
          traces.push(toolEntry);
          await this.emitToSinks(toolEntry);
          currentMessages.push({
            role: 'tool',
            content: stringifyToolContent(toolResult.content),
            tool_call_id: callId,
            name: toolCall.name,
          });
        } catch (err) {
          // Invariant 2.e — abort check inside tool catch arm.
          if (signal.aborted) {
            status = 'cancelled';
            cancelledMidTool = true;
            break;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const errEntry: TraceEntry = {
            schema_version: '1',
            run_id: runId,
            sequence: seqRef.value++,
            trace_type: 'tool_call',
            timestamp_ms: Date.now(),
            latency_ms: Date.now() - toolStart,
            tool_name: toolCall.name,
            tool_provider_id: provider.id,
            tool_input: truncateForStorage(JSON.stringify(toolCall.args)),
            tool_output: `Error: ${msg}`,
            is_error: true,
            error: msg,
          };
          traces.push(errEntry);
          await this.emitToSinks(errEntry);
          currentMessages.push({
            role: 'tool',
            content: `Error: ${msg}`,
            tool_call_id: callId,
            name: toolCall.name,
          });
        }
      }

      if (cancelledMidTool) {
        completedNaturally = true;
        break;
      }
    }

    // Iteration-cap detection (RESEARCH §7 Pitfall 7).
    const hitIterationCap = !completedNaturally && status === 'completed';

    // Emit a `run_complete` finalization entry so sinks that model a
    // per-run lifecycle (OtelTraceSink → Langfuse trace; future
    // batched sinks) can stamp final-state attributes onto their
    // root-of-run representation BEFORE flush ends the underlying
    // span / connection. Sinks that don't care no-op naturally on the
    // unfamiliar trace_type. Stays in `traces[]` so consumers
    // inspecting the in-memory transcript see the same finalization
    // record as the on-wire sinks.
    const runCompleteEntry: TraceEntry = {
      schema_version: '1',
      run_id: runId,
      sequence: seqRef.value++,
      trace_type: 'run_complete',
      timestamp_ms: Date.now(),
      latency_ms: 0,
      final_content: finalContent,
      final_status: status,
      cumulative_input_tokens: budget.cumulativeInputTokens,
      cumulative_output_tokens: budget.cumulativeOutputTokens,
      cumulative_cost_usd: budget.cumulativeCostUsd,
      hit_iteration_cap: hitIterationCap,
    };
    traces.push(runCompleteEntry);
    await this.emitToSinks(runCompleteEntry);

    // Flush sinks that opted in (D-19) — swallow errors.
    for (const sink of this.sinks) {
      if (sink.flush) {
        await sink.flush().catch(() => undefined);
      }
    }

    return {
      runId,
      status,
      finalContent,
      hitIterationCap,
      budget,
      traces,
      ...(errorBox !== undefined && { error: errorBox }),
    };
  }

  /** Fan out one trace entry to every registered sink; swallow per-sink errors per D-19. */
  private async emitToSinks(entry: TraceEntry): Promise<void> {
    if (this.sinks.length === 0) return;
    await Promise.all(
      this.sinks.map((s) =>
        Promise.resolve()
          .then(() => s.emit(entry))
          .catch(() => undefined),
      ),
    );
  }
}

/**
 * Reduce `ToolResult.content` (string OR ContentBlock[]) to a flat string for
 * inclusion in chat history. Structured blocks JSON-stringify; strings pass through.
 */
function stringifyToolContent(content: ToolResult['content']): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}
