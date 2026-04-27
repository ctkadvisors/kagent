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
import { AgentNotFoundError, NoLLMClientError, InvalidConfigError } from './errors.js';
import { randomUUID } from 'node:crypto';

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

    this.registry = options.registry;
    this.llm = options.llm;
    this.sinks = options.sinks ?? [];
    this.defaultMaxIterations = options.defaultMaxIterations ?? 8;

    // Wrap providers into a federation registry; throws on tool-name conflict.
    const providers = options.toolProviders ?? [];
    this.toolProviders = new ToolProviderRegistry();
    for (const p of providers) {
      this.toolProviders.register(p);
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

    const runId = input.runId ?? randomUUID();
    const signal = input.signal ?? new AbortController().signal;
    const maxIterations = input.maxIterations ?? this.defaultMaxIterations;

    const budget: RunBudget = {
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      cumulativeCostUsd: null,
      ...(input.tokenLimit !== undefined && { tokenLimit: input.tokenLimit }),
      ...(input.costLimitUsd !== undefined && { costLimitUsd: input.costLimitUsd }),
    };
    const traces: TraceEntry[] = [];
    let seq = 0;

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

    // Federate tool descriptors across all providers (D-11).
    const toolDescriptors: ToolDescriptor[] = await this.toolProviders.describeAll();

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
        sequence: seq++,
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
      };
      const llmStart = Date.now();
      let llmResult: ChatResult;
      try {
        llmResult = await this.llm.chat(chatRequest, llmCtx);
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
          sequence: seq++,
          trace_type: 'llm_call',
          timestamp_ms: Date.now(),
          latency_ms: Date.now() - llmStart,
          ...(agentDef.defaultModel !== undefined && { model: agentDef.defaultModel }),
          input_messages: truncateMessages(currentMessages),
          tools_available: JSON.stringify(toolDescriptors.map((t) => t.name)),
          cost_usd: null,
          error: msg,
        };
        traces.push(errEntry);
        await this.emitToSinks(errEntry);
        status = 'failed';
        errorBox = { message: msg, cause: err };
        completedNaturally = true;
        break;
      }

      // (2) Record LLM trace + token + cost accounting
      const llmEntry: TraceEntry = {
        schema_version: '1',
        run_id: runId,
        sequence: seq++,
        trace_type: 'llm_call',
        timestamp_ms: Date.now(),
        latency_ms: Date.now() - llmStart,
        ...(agentDef.defaultModel !== undefined && { model: agentDef.defaultModel }),
        input_messages: truncateMessages(currentMessages),
        output_content: truncateForStorage(llmResult.content),
        ...(llmResult.tool_calls && {
          output_tool_calls: truncateForStorage(JSON.stringify(llmResult.tool_calls)),
        }),
        input_tokens_est:
          llmResult.usage?.inputTokens ??
          estimateTokens(currentMessages.map((m) => m.content).join('\n')),
        output_tokens_est: llmResult.usage?.outputTokens ?? estimateTokens(llmResult.content),
        cost_usd: llmResult.usage?.costUsd ?? null,
        ...(llmResult.stopReason !== undefined && { stop_reason: llmResult.stopReason }),
        tools_available: JSON.stringify(toolDescriptors.map((t) => t.name)),
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
      if (!llmResult.tool_calls || llmResult.tool_calls.length === 0) {
        finalContent = llmResult.content;
        completedNaturally = true;
        break;
      }

      // Append assistant message with tool_calls to history.
      currentMessages.push({
        role: 'assistant',
        content: llmResult.content,
        tool_calls: llmResult.tool_calls,
      });

      // Tool dispatch loop (one iteration per tool_call).
      let cancelledMidTool = false;
      for (const toolCall of llmResult.tool_calls) {
        // Invariant 2.d — abort check between tool calls.
        if (signal.aborted) {
          status = 'cancelled';
          cancelledMidTool = true;
          break;
        }

        const callId = toolCall.id || `call_${toolCall.name}_${seq}`;
        const provider = this.toolProviders.providerFor(toolCall.name);

        if (!provider) {
          // Surface as tool error message (NOT executor throw).
          const errMsg = `Tool "${toolCall.name}" has no registered provider`;
          const noProvEntry: TraceEntry = {
            schema_version: '1',
            run_id: runId,
            sequence: seq++,
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
            sequence: seq++,
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
            sequence: seq++,
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
