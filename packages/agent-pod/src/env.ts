/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Env-var parsing for the agent-pod runtime. The operator's
 * job-spec-builder (packages/operator/src/job-spec.ts) injects all
 * KAGENT_* variables; this module turns them into a typed config
 * object the runner consumes.
 *
 * v0.2.0-typed-io — `KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC` env JSON
 * is REPLACED by a per-Job ConfigMap mounted at `/var/kagent/config/`
 * carrying `agent.spec.json` + `task.spec.json`. parseEnv reads those
 * files when present and falls back to the env-JSON path for one
 * release of back-compat (mid-rollout where the operator + agent-pod
 * images don't ship in lockstep).
 *
 * Reasons for the move (Phase 4.x hardening):
 *   - ARG_MAX cap (Linux env block + etcd 1 MiB per-object limit)
 *   - `kubectl describe pod` / `/proc/<pid>/environ` env leak
 */

import { readFileSync } from 'node:fs';

const CONFIG_DIR = '/var/kagent/config';
const CONFIG_AGENT_SPEC_PATH = `${CONFIG_DIR}/agent.spec.json`;
const CONFIG_TASK_SPEC_PATH = `${CONFIG_DIR}/task.spec.json`;

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
  /**
   * v0.2.0-typed-io / v0.2.2-cas — typed input declarations. Carried
   * verbatim from `Agent.spec.inputs[]`; the agent-pod's substrate
   * tools (currently `read_artifact`) gate registration on whether at
   * least one input has `kind: 'artifact'`. Substrate-side admission
   * validates the full schema at AgentTask creation time; the agent-pod
   * trusts the value here.
   */
  readonly inputs?: readonly {
    readonly name: string;
    readonly kind: 'workspace' | 'artifact' | 'scalar';
    readonly mediaType?: string;
    readonly mountPath?: string;
    readonly mode?: 'ro' | 'rw';
    readonly optional?: boolean;
    readonly required?: boolean;
  }[];
  /**
   * v0.2.0-typed-io / v0.2.2-cas — typed output declarations. Same
   * source-of-truth and capability-gate role as `inputs[]` above.
   */
  readonly outputs?: readonly {
    readonly name: string;
    readonly kind: 'artifact' | 'scalar';
    readonly mediaType?: string;
    readonly required?: boolean;
    readonly retention?: string;
  }[];
}

/**
 * v0.2.2-cas — capability gate for the `read_artifact` substrate tool.
 * Returns true when the Agent declares at least one input or output of
 * `kind: 'artifact'`. The tool is registered ONLY when this is true,
 * mirroring the spawn / templates substrate-tool pattern: presence in
 * `Agent.spec.tools` is necessary but not sufficient — the schema-level
 * declaration is the authoritative gate.
 */
export function agentHasArtifactInputOrOutput(spec: AgentSpecEnv): boolean {
  const inputs = spec.inputs ?? [];
  for (const i of inputs) {
    if (i.kind === 'artifact') return true;
  }
  const outputs = spec.outputs ?? [];
  for (const o of outputs) {
    if (o.kind === 'artifact') return true;
  }
  return false;
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
  /**
   * v0.1.11 — W3C Trace Context propagation. Mirror of
   * `AgentTaskRunConfig.traceparent`. The agent-pod itself does NOT
   * read this from `taskSpec.runConfig` — the operator's job-spec
   * builder is the one that threads the value into the spawned Job's
   * container env as `OTEL_TRACEPARENT`, which `main.ts` then reads
   * directly from `process.env`. The field is preserved in the env
   * mirror only so a JSON round-trip of `KAGENT_TASK_SPEC` doesn't
   * lose data.
   */
  readonly traceparent?: string;
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
  /**
   * v0.1.9 — task depth in the spawn tree. Operator stamps this on the
   * Job env from the AgentTask's `kagent.knuteson.io/task-depth` label
   * (default 0 / root). The agent-pod surfaces it on PodConfig so the
   * `spawn_child_task` depth-cap guardrail and the `get_my_context`
   * introspection tool read one source of truth. Defensive: malformed
   * values (negative / non-integer) parse to 0 — fail-closed.
   */
  readonly taskDepth: number;
}

const DEFAULT_LITELLM_BASE_URL = 'http://litellm.kagent-system.svc.cluster.local:4000/v1';

/**
 * Parse the operator-injected env vars into a PodConfig. Throws
 * descriptively on missing required fields so the agent pod fails
 * fast at boot rather than mid-loop.
 *
 * v0.2.0-typed-io — agent.spec + task.spec are sourced from the
 * mounted ConfigMap at `/var/kagent/config/{agent,task}.spec.json`
 * when present; otherwise we fall back to the v0.1 env-JSON path
 * (`KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC`) for one release.
 *
 * `readFile` is dependency-injected so unit tests can drive both
 * paths without real filesystem access.
 */
export function parseEnv(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined = defaultReadFile,
): PodConfig {
  const taskId = requireEnv(env, 'KAGENT_TASK_ID');
  const taskName = requireEnv(env, 'KAGENT_TASK_NAME');
  const taskNamespace = requireEnv(env, 'KAGENT_TASK_NAMESPACE');
  const agentName = requireEnv(env, 'KAGENT_AGENT_NAME');

  const agentSpec = loadAgentSpec(env, readFile);
  const taskSpec = loadTaskSpec(env, readFile);

  if (typeof agentSpec.model !== 'string' || agentSpec.model.length === 0) {
    throw new Error(
      'agent spec.model is required (from /var/kagent/config/agent.spec.json or KAGENT_AGENT_SPEC env)',
    );
  }

  if (taskSpec.parentDistillation !== undefined) {
    // v0.2.0-typed-io — `parentDistillation` is deprecated. Migration
    // target: `AgentTask.spec.inputs[].from.taskUid + output:
    // 'distillation'`. Field stays accepted for back-compat.
    console.warn(
      '[kagent-agent-pod] AgentTask.spec.parentDistillation is deprecated (v0.2.0-typed-io); ' +
        "migrate to AgentTask.spec.inputs[{ name: 'distillation', from: { taskUid, output } }].",
    );
  }

  const litellmBaseUrl = env.KAGENT_LITELLM_BASE_URL ?? DEFAULT_LITELLM_BASE_URL;
  const logLevel = env.LOG_LEVEL === 'debug' ? 'debug' : 'info';
  const traceContentMode = parseTraceContentMode(env.KAGENT_TRACE_CONTENT_MODE);
  const taskDepth = parseTaskDepth(env.KAGENT_TASK_DEPTH);

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
    taskDepth,
  };
  return config;
}

/**
 * Parse `KAGENT_TASK_DEPTH` from a string into a non-negative integer,
 * defaulting to 0 on absent / empty / malformed input. Mirror of the
 * operator-side `parseTaskDepthLabel` (job-spec.ts) — they both must
 * fail-closed so a hostile / corrupted value cannot make the in-pod
 * spawn-cap math go negative or NaN. Exported for the unit-test suite.
 */
export function parseTaskDepth(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
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

/**
 * v0.2.0-typed-io — read agent.spec from the mounted ConfigMap when
 * the file exists, falling back to the v0.1 KAGENT_AGENT_SPEC env JSON
 * for one release of back-compat. Either path must yield a valid
 * AgentSpecEnv with `model` set; parseEnv enforces that downstream.
 */
function loadAgentSpec(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): AgentSpecEnv {
  const fileBody = readFile(CONFIG_AGENT_SPEC_PATH);
  if (fileBody !== undefined) {
    return parseJson<AgentSpecEnv>(fileBody, CONFIG_AGENT_SPEC_PATH);
  }
  // Back-compat env-JSON path.
  return parseJson<AgentSpecEnv>(requireEnv(env, 'KAGENT_AGENT_SPEC'), 'KAGENT_AGENT_SPEC');
}

function loadTaskSpec(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): TaskSpecEnv {
  const fileBody = readFile(CONFIG_TASK_SPEC_PATH);
  if (fileBody !== undefined) {
    return parseJson<TaskSpecEnv>(fileBody, CONFIG_TASK_SPEC_PATH);
  }
  return parseJson<TaskSpecEnv>(requireEnv(env, 'KAGENT_TASK_SPEC'), 'KAGENT_TASK_SPEC');
}

/**
 * Default `readFile` implementation: returns the file's UTF-8 body
 * when present, undefined when ENOENT (no file). Any other error
 * (permission denied, EIO) bubbles up so a misconfigured mount fails
 * fast at boot instead of silently falling back to env.
 */
function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}
