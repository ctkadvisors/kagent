/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Env-var parsing for the agent-pod runtime. The operator's
 * job-spec-builder (packages/operator/src/job-spec.ts) injects all
 * KAGENT_* variables; this module turns them into a typed config
 * object the runner consumes.
 */

export interface AgentSpecEnv {
  readonly model: string;
  readonly systemPrompt?: string;
  /**
   * v0.1.6 — declarative reference to a Langfuse-managed prompt. When
   * set AND the agent-pod was started with KAGENT_LANGFUSE_HOST etc.,
   * the runner fetches this prompt at boot and uses it as the system
   * prompt. Falls back to `systemPrompt` literal on fetch failure;
   * boot-fails when neither is available.
   *
   * `version` is optional — when omitted, Langfuse returns the
   * production-promoted version (or latest if none promoted).
   */
  readonly systemPromptRef?: {
    readonly name: string;
    readonly version?: number;
  };
  readonly tools?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly sandboxProfile?: 'default' | 'strict';
  /**
   * WS-K — agent-self-allowlist for `spawn_child_task`. The operator
   * threads this verbatim into KAGENT_AGENT_SPEC. The spawn tool reads
   * it to gate child agent names BEFORE issuing the K8s create. Empty
   * / unset = no children may be spawned (fail-closed) UNLESS
   * `allowedChildTemplates` matches.
   */
  readonly allowedChildAgents?: readonly string[];
  /**
   * v0.1.3 — companion to `allowedChildAgents` that admits children by
   * the `kagent.knuteson.io/from-template` label on the target Agent
   * CR (set by the WS-M template-instantiator). Lets parents permit a
   * whole class of materialized agents (e.g. every `summarizer-*`
   * Agent the operator mints from the `summarizer` template) without
   * enumerating their content-addressed names.
   *
   * Fail-closed: an Agent missing the from-template label is NEVER
   * admitted via this list — only Agents the operator's
   * template-server stamped with a known template name. Both lists
   * union (matching either admits).
   */
  readonly allowedChildTemplates?: readonly string[];
  /** WS-K — direct-child concurrency cap. Default 10 in the spawn tool. */
  readonly maxConcurrentChildren?: number;
  /**
   * v0.1.4 — declarative LLM request-tuning knobs threaded into every
   * `chat()` call this Agent's loop makes. Maps 1:1 to `ChatRequest`'s
   * `temperature` / `maxTokens` / `stopSequences` fields, then to the
   * OpenAI body fields `temperature` / `max_tokens` / `stop`. Unset
   * fields fall through to the LLM provider's defaults — the substrate
   * never invents values.
   */
  readonly llmParams?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stopSequences?: readonly string[];
  };
  /**
   * Opt-in per-Agent fairness cap (LLM-gateway bundle, spec §3.4).
   * Mirror of `AgentSpec.maxInFlightTasks` from the operator's CRD
   * surface. The agent-pod itself does not enforce this — it lives in
   * the operator's admission reconciler — but the value is threaded
   * through `KAGENT_AGENT_SPEC` for completeness so any in-pod
   * observability surface (e.g. workbench-side fixtures) can read the
   * cap without a separate CRD round-trip. Absent = unlimited at the
   * admission layer.
   */
  readonly maxInFlightTasks?: number;
}

/**
 * Mirror of `AgentTaskRunConfig` from `@kagent/operator/crds`. Defined
 * locally to avoid pulling the operator (and its `nats` /
 * `@kubernetes/client-node` transitive surface) into the agent-pod
 * dependency tree just for a 4-field interface — same pattern used
 * for `ArtifactRef` in `runner.ts`. Keep in sync with the operator's
 * canonical definition + the CRD YAML schema.
 */
export interface AgentTaskRunConfigEnv {
  readonly tokenLimit?: number;
  readonly costLimitUsd?: number;
  readonly maxIterations?: number;
  readonly timeoutSeconds?: number;
}

export interface TaskSpecEnv {
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly payload: unknown;
  /**
   * @deprecated Prefer `runConfig.timeoutSeconds`. Resolution: when both
   * are set, `runConfig.timeoutSeconds` wins. This field is preserved
   * for backward compatibility with pre-WS-G AgentTask resources.
   */
  readonly timeoutSeconds?: number;
  readonly runConfig?: AgentTaskRunConfigEnv;
  readonly parentTask?: string;
  readonly originalUserMessage?: string;
  readonly parentDistillation?: string;
  readonly expectedTools?: readonly string[];
}

export interface PodConfig {
  readonly taskId: string;
  readonly taskName: string;
  readonly taskNamespace: string;
  readonly agentName: string;
  readonly agentSpec: AgentSpecEnv;
  readonly taskSpec: TaskSpecEnv;
  readonly litellmBaseUrl: string;
  readonly litellmApiKey?: string;
  readonly logLevel: 'debug' | 'info';
  /**
   * Content-capture policy for OTel/Langfuse traces, parsed from
   * `KAGENT_TRACE_CONTENT_MODE`. Defaults to `'preview'` so production
   * traces don't silently ship full prompts to Langfuse — opt into
   * `'full'` explicitly when debugging. Reserved value `'artifact-ref'`
   * (depends on Phase 5 P3 artifact writer) is rejected at parse time.
   * Stored as the raw parsed string; `OtelTraceSink` re-parses via
   * `parseContentMode` to keep the env contract in one place.
   */
  readonly traceContentMode: 'none' | 'preview' | 'full';
}

const DEFAULT_LITELLM_BASE_URL = 'http://litellm.kagent-system.svc.cluster.local:4000/v1';

/**
 * Parse the operator-injected env vars into a PodConfig. Throws
 * descriptively on missing required fields so the agent pod fails
 * fast at boot rather than mid-loop.
 */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): PodConfig {
  const taskId = requireEnv(env, 'KAGENT_TASK_ID');
  const taskName = requireEnv(env, 'KAGENT_TASK_NAME');
  const taskNamespace = requireEnv(env, 'KAGENT_TASK_NAMESPACE');
  const agentName = requireEnv(env, 'KAGENT_AGENT_NAME');
  const agentSpec = parseJson<AgentSpecEnv>(
    requireEnv(env, 'KAGENT_AGENT_SPEC'),
    'KAGENT_AGENT_SPEC',
  );
  const taskSpec = parseJson<TaskSpecEnv>(requireEnv(env, 'KAGENT_TASK_SPEC'), 'KAGENT_TASK_SPEC');

  if (typeof agentSpec.model !== 'string' || agentSpec.model.length === 0) {
    throw new Error('KAGENT_AGENT_SPEC.model is required');
  }

  const litellmBaseUrl = env.KAGENT_LITELLM_BASE_URL ?? DEFAULT_LITELLM_BASE_URL;
  const logLevel = env.LOG_LEVEL === 'debug' ? 'debug' : 'info';
  const traceContentMode = parseTraceContentMode(env.KAGENT_TRACE_CONTENT_MODE);

  const config: PodConfig = {
    taskId,
    taskName,
    taskNamespace,
    agentName,
    agentSpec,
    taskSpec,
    litellmBaseUrl,
    ...(env.KAGENT_LITELLM_API_KEY !== undefined && {
      litellmApiKey: env.KAGENT_LITELLM_API_KEY,
    }),
    logLevel,
    traceContentMode,
  };
  return config;
}

/**
 * Parse `KAGENT_TRACE_CONTENT_MODE`. Centralized here (rather than
 * delegated to `parseContentMode` from `@kagent/trace-sinks`) to keep
 * env-parsing failures surfacing through the same `parseEnv` channel
 * the operator + Helm chart contract is built around. The trace-sinks
 * helper is the runtime authority for the env value's semantic
 * mapping into a `ContentMode` and is re-applied inside `OtelTraceSink`
 * — this fn just rejects malformed values fast at boot.
 */
function parseTraceContentMode(raw: string | undefined): 'none' | 'preview' | 'full' {
  if (raw === undefined || raw === '') return 'preview';
  if (raw === 'none' || raw === 'preview' || raw === 'full') return raw;
  if (raw === 'artifact-ref') {
    throw new Error(
      "KAGENT_TRACE_CONTENT_MODE='artifact-ref' is reserved — depends on the Phase 5 P3 artifact writer (write_artifact tool + kagent-artifacts PVC), not yet wired. Use 'preview' or 'full' until then.",
    );
  }
  throw new Error(
    `KAGENT_TRACE_CONTENT_MODE='${raw}' is not a valid value; expected one of: none, preview, full`,
  );
}

function requireEnv(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const v = env[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`required env var ${key} is missing or empty`);
  }
  return v;
}

function parseJson<T>(raw: string, key: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `failed to parse ${key} as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
