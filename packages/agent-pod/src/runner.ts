/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Loop runner — wires PodConfig (parsed env) into an `AgentExecutor`
 * and runs a single AgentTask end-to-end. Phase 3 C1 shipped the
 * chat-only happy-path; Platform-Priorities P2 wires `Agent.spec.tools`
 * into the executor so the researcher workload can fetch.
 *
 * Tool resolution rules (P2):
 *
 *   - Names in `Agent.spec.tools` are looked up in the built-in tool
 *     registry (`builtin-tools.ts`).
 *   - Unknown names fail FAST at boot with a clear error — silently
 *     dropping a tool the operator declared would mask a misconfigured
 *     Agent CR.
 *   - Empty / undefined `tools` yields no `ToolProvider` at all and the
 *     loop runs in chat-only mode (preserves the v0.1 behavior).
 *   - The general-purpose `ToolBroker` / `ToolBinding` CRD model lives in
 *     `docs/TOOL-BROKER.md` and lands at P6; until then the in-pod
 *     allowlist + SSRF guards in `builtin-tools.ts` are the policy
 *     boundary.
 */

import {
  AgentExecutor,
  AgentRegistry,
  computeQualityFlags,
  type ChatMessage,
  type ExecutionResult,
  type LLMClient,
  type TerminalStatus,
  type ToolProvider,
  type TraceEntry,
  type TraceSink,
} from '@kagent/agent-loop';
import { OpenAICompatibleLLMClient } from '@kagent/openai-compat';
import { StdoutSink } from '@kagent/trace-sinks';

import { tryParseArtifactRefFromToolOutput } from './artifacts.js';
import { resolveBuiltinTools } from './builtin-tools.js';
import type { PodConfig } from './env.js';

/**
 * Substrate-defined artifact handle. Structurally identical to the
 * canonical `ArtifactRef` in `@kagent/operator/crds/artifact-ref.ts`;
 * redeclared here to avoid pulling the operator (and its `nats` /
 * `@kubernetes/client-node` transitive surface) into the agent-pod
 * dependency tree just for a 6-field interface. The operator's status
 * patcher accepts this shape via structural typing — see
 * `docs/ARTIFACTS.md` for the canonical definition.
 *
 * v0.1 wires this *through* without producing any artifacts (no writer
 * yet); the field exists so a future tool inside the agent loop can
 * populate it without touching substrate code.
 */
export interface ArtifactRef {
  readonly uri: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly checksum?: string;
  readonly name?: string;
  readonly producedAt?: string;
}

/**
 * Output of a single agent-pod run. The pod's main.ts uses this to
 * drive the AgentTask.status writeback.
 */
export interface RunResult {
  readonly runId: string;
  readonly status: TerminalStatus;
  readonly finalContent: string | null;
  readonly flags: readonly string[];
  readonly traces: readonly TraceEntry[];
  readonly budget: ExecutionResult['budget'];
  readonly error?: { readonly message: string };
  /**
   * Optional artifact references produced during the run. Empty/undefined
   * = none. The substrate forwards these into the status patch as-is;
   * the byte payload is the agent loop's responsibility. See
   * `docs/ARTIFACTS.md`.
   */
  readonly artifacts?: readonly ArtifactRef[];
}

/**
 * Test-injection seam — overrides any of the otherwise-defaulted
 * collaborators. Production caller passes nothing.
 *
 * `toolProviders` overrides the built-in resolution path (used by tests
 * that want to assert a specific provider lineup without going through
 * `resolveBuiltinTools`). When undefined the runner builds providers
 * from `config.agentSpec.tools` against the built-in registry.
 */
export interface RunDeps {
  readonly llm?: LLMClient;
  readonly sinks?: readonly TraceSink[];
  readonly toolProviders?: readonly ToolProvider[];
}

/**
 * Run the agent loop against the LiteLLM endpoint configured in the
 * pod's env. `Agent.spec.tools` (when set) is resolved through the
 * built-in tool registry into a single `InProcessToolProvider`; the
 * executor then dispatches model-issued `tool_calls` against that
 * provider with the same trace + budget envelope as the chat-only path.
 * Run-end detector middleware runs against the resulting trace + final
 * message to surface F1/F2/F3 + synthesis_low_yield flags.
 */
export async function runAgentTask(config: PodConfig, deps: RunDeps = {}): Promise<RunResult> {
  const llm =
    deps.llm ??
    new OpenAICompatibleLLMClient({
      baseUrl: config.litellmBaseUrl,
      model: config.agentSpec.model,
      ...(config.litellmApiKey !== undefined && { apiKey: config.litellmApiKey }),
    });

  const registry = new AgentRegistry();
  registry.register({
    type: config.agentName,
    name: config.agentName,
    description: '',
    primaryPhases: [],
    secondaryPhases: [],
    skills: [],
    baseConfidence: 1.0,
    ...(config.agentSpec.systemPrompt !== undefined && {
      systemPrompt: config.agentSpec.systemPrompt,
    }),
  });

  const sinks = deps.sinks ?? [new StdoutSink()];

  // Resolve tool providers: tests may inject explicitly via deps; in
  // production we read `Agent.spec.tools` and look each name up in the
  // built-in registry. Unknown names throw here at boot — fail fast so
  // the operator sees a `Failed` AgentTask with a clear runner error
  // rather than a silently-degraded loop.
  const toolProviders = resolveToolProviders(config, deps);

  const executor = new AgentExecutor({
    registry,
    llm,
    sinks,
    ...(toolProviders.length > 0 && { toolProviders }),
  });

  const userMessage = pickUserMessage(config);
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }];

  // Honor AgentTask.spec.timeoutSeconds via AbortSignal so a hung LLM
  // call (unreachable LiteLLM, model never streams a token, etc.)
  // surfaces as a `cancelled` terminal status instead of pinning the
  // pod until the K8s Job's activeDeadlineSeconds fires.
  const timeoutSeconds = config.taskSpec.timeoutSeconds;
  const signal =
    typeof timeoutSeconds === 'number' && timeoutSeconds > 0
      ? AbortSignal.timeout(timeoutSeconds * 1000)
      : undefined;

  const result = await executor.run({
    agentType: config.agentName,
    messages,
    runId: config.taskId,
    ...(signal !== undefined && { signal }),
  });

  const flags = computeQualityFlags([...result.traces], result.finalContent, userMessage);

  // P3 — collate ArtifactRefs from `write_artifact` tool_call traces.
  // The atomic file write already happened inside the tool handler; we
  // just harvest the structured ref the handler emitted as its tool
  // result so the operator can thread it into AgentTask.status.artifacts.
  // Tool errors (isError=true traces) are skipped — a partial run still
  // surfaces any successful refs.
  const artifacts = collectArtifactsFromTraces(result.traces);

  return {
    runId: result.runId,
    status: result.status,
    finalContent: result.finalContent,
    flags,
    traces: result.traces,
    budget: result.budget,
    ...(result.error !== undefined && { error: { message: result.error.message } }),
    ...(artifacts.length > 0 && { artifacts }),
  };
}

/**
 * Scan an executor trace stream for `write_artifact` tool_call entries
 * and parse the ArtifactRef each one returned. Resilient: any trace
 * that fails the shape guard (truncated tool_output, malformed JSON,
 * missing `uri`) is silently skipped — the underlying file write
 * already succeeded, but if the trace is unparseable downstream
 * consumers will not see the ref. That is preferable to throwing and
 * failing the entire run for a trace-pipeline edge case.
 *
 * Exported for the runner test suite + any future middleware that
 * wants to inspect the same surface.
 */
export function collectArtifactsFromTraces(traces: readonly TraceEntry[]): readonly ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const t of traces) {
    if (t.trace_type !== 'tool_call') continue;
    if (t.tool_name !== 'write_artifact') continue;
    if (t.is_error === true) continue;
    const ref = tryParseArtifactRefFromToolOutput(t.tool_output);
    if (ref !== null) out.push(ref);
  }
  return out;
}

/**
 * Derive the LLM-facing user message from the AgentTask spec. The
 * originalUserMessage is the protocol-level required string when set;
 * falling back to a JSON-stringified payload keeps the agent runnable
 * for non-chat workloads (e.g. the homelab researcher's daily-digest
 * pattern, where the "task" is a topic descriptor not a chat turn).
 */
export function pickUserMessage(config: PodConfig): string {
  if (
    typeof config.taskSpec.originalUserMessage === 'string' &&
    config.taskSpec.originalUserMessage.length > 0
  ) {
    return config.taskSpec.originalUserMessage;
  }
  return JSON.stringify(config.taskSpec.payload);
}

/**
 * Resolve the providers list the executor will see — `deps.toolProviders`
 * wins (test injection), otherwise we look up `Agent.spec.tools` against
 * the built-in registry. Exported for the runner test suite; production
 * callers go through `runAgentTask`.
 *
 * Throws on unknown tool names with a clear, operator-actionable message.
 */
export function resolveToolProviders(config: PodConfig, deps: RunDeps): readonly ToolProvider[] {
  if (deps.toolProviders !== undefined) return deps.toolProviders;
  const builtin = resolveBuiltinTools(config.agentSpec.tools);
  return builtin === null ? [] : [builtin];
}
