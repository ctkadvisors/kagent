/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Loop runner — wires PodConfig (parsed env) into an `AgentExecutor`
 * and runs a single AgentTask end-to-end. Phase 3 C1 ships the
 * happy-path runner with no tool providers (chat-style agent); tool
 * provider wiring is gated behind concrete agent workloads in later
 * phases.
 */

import {
  AgentExecutor,
  AgentRegistry,
  computeQualityFlags,
  type ChatMessage,
  type ExecutionResult,
  type LLMClient,
  type TerminalStatus,
  type TraceEntry,
  type TraceSink,
} from '@kagent/agent-loop';
import { OpenAICompatibleLLMClient } from '@kagent/openai-compat';
import { StdoutSink } from '@kagent/trace-sinks';

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
 */
export interface RunDeps {
  readonly llm?: LLMClient;
  readonly sinks?: readonly TraceSink[];
}

/**
 * Run the agent loop against the LiteLLM endpoint configured in the
 * pod's env. No tool providers in v0.1 — the agent gets the user
 * message + system prompt and produces a final response. Run-end
 * detector middleware runs against the resulting trace + final
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

  const executor = new AgentExecutor({
    registry,
    llm,
    sinks,
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

  // Artifact wiring is additive: v0.1 has no writer plumbed into the
  // agent loop, so `artifacts` is omitted here. The slot exists in
  // `RunResult` so a future tool / middleware can populate it without
  // any substrate change. When that arrives, replace this comment with
  // a real read from the loop result (or a `RunDeps` injection seam).
  return {
    runId: result.runId,
    status: result.status,
    finalContent: result.finalContent,
    flags,
    traces: result.traces,
    budget: result.budget,
    ...(result.error !== undefined && { error: { message: result.error.message } }),
  };
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
