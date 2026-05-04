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
 *
 * `signal` is an externally-owned cancellation handle (e.g.
 * agent-pod's SIGTERM-driven shutdown controller — see `main.ts`).
 * When supplied, it is composed with the timeout-derived signal via
 * `AbortSignal.any` so EITHER source can cancel the run.
 */
export interface RunDeps {
  readonly llm?: LLMClient;
  readonly sinks?: readonly TraceSink[];
  readonly toolProviders?: readonly ToolProvider[];
  readonly signal?: AbortSignal;
  /**
   * WS-K — substrate tools (spawn_child_task, plus future siblings)
   * appended to the resolved built-in providers when present. The
   * runner builds this in `main.ts` from the in-cluster K8s client
   * when `KAGENT_SPAWN_CHILD_ENABLED=true` is on the env. Tests pass
   * a fake provider directly. When undefined, the spawn tool is not
   * registered at all — an LLM that tries to call it gets the
   * executor's standard "unknown tool" error.
   */
  readonly spawnTools?: ToolProvider;
  /**
   * v0.4.0-events — Wave 3 events sub-team. `publish_event` tool
   * provider, registered when the Agent declares at least one
   * `publishes[]` entry AND `KAGENT_EVENTS_NATS_URL` is set. Composed
   * with `spawnTools` + `builtin` so the executor sees one flat
   * resolution surface.
   */
  readonly eventsTools?: ToolProvider;
  /**
   * v0.1.6 — Langfuse-managed prompt fetcher. Production wires this
   * in main.ts from KAGENT_LANGFUSE_HOST + creds (see
   * `buildLangfusePromptFetcher`). Tests inject directly. When the
   * Agent has a systemPromptRef but this is undefined, we treat that
   * as a config-time error and boot-fail.
   */
  readonly fetchPrompt?: (name: string, version?: number) => Promise<string>;
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
  const llm = deps.llm ?? buildLlmClient(config);

  // v0.1.6 — resolve the system prompt. Order:
  //   1. If systemPromptRef set AND a fetcher is wired → try Langfuse.
  //      Success → use that.
  //   2. Else (or fetch failed): fall back to systemPrompt literal.
  //   3. Both unresolved + ref was set → boot-fail (config-time error).
  const resolvedSystemPrompt = await resolveSystemPrompt(config, deps);

  const registry = new AgentRegistry();
  registry.register({
    type: config.agentName,
    name: config.agentName,
    description: '',
    primaryPhases: [],
    secondaryPhases: [],
    skills: [],
    baseConfidence: 1.0,
    ...(resolvedSystemPrompt !== undefined && {
      systemPrompt: resolvedSystemPrompt,
    }),
    ...(config.agentSpec.llmParams !== undefined && {
      llmParams: config.agentSpec.llmParams,
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

  // WS-G — resolve the per-run knobs from `runConfig` if present,
  // falling back to the deprecated top-level `timeoutSeconds`.
  // `runConfig.timeoutSeconds` wins on conflict (per CRD docstring).
  const rc = config.taskSpec.runConfig;
  const effectiveTimeoutSeconds = rc?.timeoutSeconds ?? config.taskSpec.timeoutSeconds;
  const effectiveTokenLimit = rc?.tokenLimit;
  const effectiveCostLimit = rc?.costLimitUsd;
  const effectiveMaxIter = rc?.maxIterations;

  // Honor the resolved timeout via AbortSignal so a hung LLM call
  // (unreachable LiteLLM, model never streams a token, etc.) surfaces
  // as a `cancelled` terminal status instead of pinning the pod until
  // the K8s Job's activeDeadlineSeconds fires. Compose with the
  // caller-supplied `deps.signal` (used by main.ts's SIGTERM
  // controller) via Node 22 native `AbortSignal.any` so EITHER source
  // can cancel the run.
  const timeoutSignal =
    typeof effectiveTimeoutSeconds === 'number' && effectiveTimeoutSeconds > 0
      ? AbortSignal.timeout(effectiveTimeoutSeconds * 1000)
      : undefined;
  const signal = composeSignals(deps.signal, timeoutSignal);

  const result = await executor.run({
    agentType: config.agentName,
    messages,
    runId: config.taskId,
    ...(signal !== undefined && { signal }),
    ...(effectiveTokenLimit !== undefined && { tokenLimit: effectiveTokenLimit }),
    ...(effectiveCostLimit !== undefined && { costLimitUsd: effectiveCostLimit }),
    ...(effectiveMaxIter !== undefined && { maxIterations: effectiveMaxIter }),
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
 * Construct the OpenAI-compatible LLM client the agent-pod uses to talk
 * to the kagent LLM gateway. Stamps the v0.1.7 attribution headers
 * `X-Kagent-Task-UID` (= AgentTask UID, i.e. `KAGENT_TASK_ID`) and
 * `X-Kagent-Agent` (= `KAGENT_AGENT_NAME`) on every outbound request so
 * the gateway's usage_records rows join back to the originating task +
 * agent. The gateway already parses these headers
 * (packages/llm-gateway/src/headers.ts); without them every usage row
 * lands with task_uid=null and per-task throughput becomes invisible.
 *
 * Exported so tests can pass a fake `fetch` and assert the wire-level
 * headers without booting the full executor. Production callers go
 * through `runAgentTask`.
 */
export function buildLlmClient(
  config: PodConfig,
  fetchImpl?: typeof globalThis.fetch,
): OpenAICompatibleLLMClient {
  return new OpenAICompatibleLLMClient({
    baseUrl: config.litellmBaseUrl,
    model: config.agentSpec.model,
    ...(config.litellmApiKey !== undefined && { apiKey: config.litellmApiKey }),
    defaultHeaders: {
      'X-Kagent-Task-UID': config.taskId,
      'X-Kagent-Agent': config.agentName,
    },
    ...(fetchImpl !== undefined && { fetch: fetchImpl }),
  });
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
 * URI-scheme filtering: only refs whose URI begins with `pvc://` are
 * included in the durable artifact list. `inline://...` refs are
 * intentionally dropped — the substrate contract is "RunResult.artifacts
 * MUST be followable to real bytes", and inline refs are explicitly
 * non-persisted (the bytes live in `status.result.content`, not on a
 * disk). Schemes other than `pvc://` / `inline://` (e.g. `s3://` for
 * v0.2 backends) are kept on a forward-compatible basis.
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
    if (ref === null) continue;
    // Drop inline-only refs — they are not durably persisted, so
    // downstream consumers (operator status patcher, Workbench,
    // sibling agents) would get a 404 if they tried to follow the URI.
    if (ref.uri.startsWith('inline://')) continue;
    out.push(ref);
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
 * the built-in registry, then conditionally append the WS-K substrate
 * tools (spawn_child_task) when:
 *
 *   - `KAGENT_SPAWN_CHILD_ENABLED=true` is set on the pod env, AND
 *   - `deps.spawnTools` is non-undefined (the runner builds it from
 *     the in-cluster K8s client at boot).
 *
 * Per AGENT-SELF-SERVICE.md §11 Q5: default-OFF in WS-K, opt-in via
 * Helm value once the demo flow needs it.
 *
 * Exported for the runner test suite; production callers go through
 * `runAgentTask`.
 *
 * Throws on unknown tool names with a clear, operator-actionable message.
 */
export function resolveToolProviders(config: PodConfig, deps: RunDeps): readonly ToolProvider[] {
  if (deps.toolProviders !== undefined) return deps.toolProviders;
  const out: ToolProvider[] = [];
  const builtin = resolveBuiltinTools(config.agentSpec.tools);
  if (builtin !== null) out.push(builtin);
  if (deps.spawnTools !== undefined) out.push(deps.spawnTools);
  if (deps.eventsTools !== undefined) out.push(deps.eventsTools);
  return out;
}

/**
 * Compose two optional `AbortSignal` sources into one — used by
 * `runAgentTask` to merge the caller-supplied shutdown signal with the
 * timeout-derived signal. Returns undefined when neither is set;
 * returns the single source when only one is set; uses Node 22's
 * native `AbortSignal.any` when both are set.
 *
 * Exported for the runner test suite.
 */
export function composeSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal | undefined,
): AbortSignal | undefined {
  if (caller === undefined && timeout === undefined) return undefined;
  if (caller === undefined) return timeout;
  if (timeout === undefined) return caller;
  return AbortSignal.any([caller, timeout]);
}

/**
 * v0.1.6 — resolve the system prompt from Langfuse-managed reference
 * with literal fallback. Three branches per `Agent.spec`:
 *
 *   - `systemPromptRef` set + fetcher wired: try Langfuse. On success,
 *     use that; on failure, fall back to literal `systemPrompt` if
 *     present, else throw (config-time boot failure).
 *   - `systemPromptRef` set + NO fetcher wired: throw (operator
 *     misconfigured — set langfuseHost or remove the ref).
 *   - `systemPromptRef` unset: use the literal as-is (back-compat).
 */
export async function resolveSystemPrompt(
  config: PodConfig,
  deps: RunDeps,
): Promise<string | undefined> {
  const ref = config.agentSpec.systemPromptRef;
  if (ref === undefined) return config.agentSpec.systemPrompt;

  if (deps.fetchPrompt === undefined) {
    if (config.agentSpec.systemPrompt !== undefined) {
      // Misconfig but recoverable — log + use literal.

      console.warn(
        `[runner] Agent.spec.systemPromptRef set but no Langfuse fetcher wired; ` +
          `falling back to literal systemPrompt`,
      );
      return config.agentSpec.systemPrompt;
    }
    throw new Error(
      `Agent.spec.systemPromptRef.name="${ref.name}" requires KAGENT_LANGFUSE_HOST + creds (none found in env). ` +
        `Either wire Langfuse on the operator chart (langfuse.enabled=true) or remove the ref.`,
    );
  }

  try {
    return await deps.fetchPrompt(ref.name, ref.version);
  } catch (err) {
    if (config.agentSpec.systemPrompt !== undefined) {
      console.warn(
        `[runner] Langfuse fetch for prompt "${ref.name}" failed (${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to literal systemPrompt`,
      );
      return config.agentSpec.systemPrompt;
    }
    throw new Error(
      `Langfuse fetch for systemPromptRef "${ref.name}" failed and no literal systemPrompt fallback set: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}
