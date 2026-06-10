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
  /**
   * Gateway-owned tool profile grant. The agent-pod sends this value to
   * KAGENT_TOOL_GATEWAY_URL and uses the gateway's returned descriptors
   * as the concrete tool allowlist. This lets the cluster operator
   * define rich agent types centrally without copying raw browser/code/
   * MCP/http tool names into every Agent CR.
   */
  readonly toolProfileRef?: string;
  /** Alias for toolProfileRef using the user-facing "agent type" term. */
  readonly agentType?: string;
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
  /**
   * v0.4.0-events — Wave 3 / Events sub-team. Each entry is a CONCRETE
   * topic (no NATS wildcards). Carried verbatim from
   * `Agent.spec.publishes[].topic`; the in-pod `publish_event` tool
   * gates registration on the presence of at least one entry AND
   * cross-checks every emission's topic against this set.
   */
  readonly publishes?: readonly {
    readonly topic: string;
    readonly schema?: Readonly<Record<string, unknown>>;
  }[];
  /**
   * v0.4.0-events — Wave 3 / Events sub-team. Threaded for
   * completeness so in-pod observability can surface "what topics
   * could have triggered this run". The agent-pod itself does NOT
   * subscribe — the operator's `EventDispatcher` provisions the NATS
   * pull-consumers.
   */
  readonly subscribes?: readonly {
    readonly topic: string;
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly trigger?: { readonly inputBinding?: string };
  }[];
  /**
   * v0.3.0-capabilities — pass-through of the same Agent's
   * `capabilityClaims`. The publish_event tool reads
   * `capabilityClaims.publish` here when the cap-bundle JWT mount is
   * absent (legacy / pre-Wave-2 deploy) so admission's authority
   * surface is consulted regardless of issuer-controller wiring.
   *
   * Substrate-opaque otherwise.
   */
  readonly capabilityClaims?: Readonly<Record<string, unknown>>;
}

/**
 * v0.4.0-events — capability gate for the `publish_event` substrate
 * tool. Returns true when the Agent declares at least one entry in
 * `publishes[]`. The tool is registered ONLY when this is true,
 * mirroring the artifact-input gate above.
 */
export function agentHasEventPublishes(spec: AgentSpecEnv): boolean {
  return Array.isArray(spec.publishes) && spec.publishes.length > 0;
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
  readonly toolGatewayUrl?: string;
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
  /**
   * v0.4.3-identity (Wave 3 / Identity sub-team). When
   * `KAGENT_LITELLM_USE_SVID=true`, the agent-pod's LLM client wires
   * an SVID-backed mTLS context against the SPIRE workload-API socket.
   */
  readonly identity: PodIdentityConfig;
  /**
   * v0.4.1-blackboard — Wave 3 / Blackboard sub-team. The resolved
   * root-task UID for this task's tree. Surfaced so K8sTaskCreator's
   * `parent.rootUid` field is populated when this pod spawns
   * children — every descendant shares the same bucket. Optional —
   * legacy pods carry undefined and the spawn path treats the
   * parent's own UID as the new root.
   */
  readonly rootTaskUid?: string;
  /**
   * v0.1.9 — model context-window size in tokens, projected by the
   * operator from `agent.modelClasses[<class>].contextWindowTokens`
   * (per docs/CONTEXT-AWARENESS.md §4.1) onto every spawned pod's
   * `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` env var. The runner threads
   * this verbatim onto `RunBudget.contextWindowTokens` so the agent
   * loop's pre-call safety-net (piece 3) and `context_pressure_ignored`
   * detector (piece 4) can read one source of truth.
   *
   * Absence is normal back-compat — modelClass entries that don't
   * declare a window leave this undefined, and all four context-awareness
   * pieces degrade to no-op.
   */
  readonly contextWindowTokens?: number;
  /**
   * Audit C2 H12 — provenance of agent.spec + task.spec. `'configmap'`
   * when both came from the operator-mounted files at
   * `/var/kagent/config/`; `'env-json'` when either fell back to the
   * v0.1 KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC env-JSON path; `'mixed'`
   * if the rare case of one ConfigMap + one env-JSON arose (defensive
   * — should never happen in practice since the operator emits both
   * paths atomically).
   *
   * Stamped onto OTel attributes (`kagent.spec.source`) and the boot
   * line so on-call can confirm "which path did this pod take?" from
   * trace data alone.
   */
  readonly specSource: SpecSource | 'mixed';
}

/**
 * v0.4.3-identity — agent-pod-side identity config snapshot.
 */
export interface PodIdentityConfig {
  readonly useSvidForLlm: boolean;
  readonly spiffeId: string | undefined;
  readonly svidCertPath: string | undefined;
  readonly svidKeyPath: string | undefined;
  readonly svidBundlePath: string | undefined;
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

  // Audit C2 H12 — enforce the env-JSON spec payload cap BEFORE we try
  // to parse. When both env-JSONs are absent (ConfigMap path takes
  // over), the cap is a no-op (sum=0 ≤ cap). When either is set, the
  // sum gates pre-parse so a pathological env produces a structured
  // CrashLoop reason instead of the generic ARG_MAX exec failure.
  assertEnvJsonSpecBudget(env);

  const agentLoad = loadAgentSpec(env, readFile);
  const taskLoad = loadTaskSpec(env, readFile);
  const agentSpec = agentLoad.spec;
  const taskSpec = taskLoad.spec;
  // Mixed source is defensive: the operator emits both paths
  // atomically, but a partial-mount edge case (e.g., ConfigMap volume
  // mount succeeded for one file but not the other) would surface
  // here rather than silently picking one path.
  const specSource: SpecSource | 'mixed' =
    agentLoad.source === taskLoad.source ? agentLoad.source : 'mixed';

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
  const toolGatewayUrl =
    typeof env.KAGENT_TOOL_GATEWAY_URL === 'string' && env.KAGENT_TOOL_GATEWAY_URL.length > 0
      ? env.KAGENT_TOOL_GATEWAY_URL
      : undefined;
  const logLevel = env.LOG_LEVEL === 'debug' ? 'debug' : 'info';
  const traceContentMode = parseTraceContentMode(env.KAGENT_TRACE_CONTENT_MODE);
  const taskDepth = parseTaskDepth(env.KAGENT_TASK_DEPTH);
  const identity = parseIdentityConfig(env);
  // v0.4.1-blackboard — root-task UID from operator-stamped
  // KAGENT_BLACKBOARD_BUCKET (`kagent-kv-<root-uid>`). Undefined for
  // pre-Wave 3 deploys; spawn path treats parent UID as root then.
  const rootTaskUid = parseRootTaskUidFromBucket(env.KAGENT_BLACKBOARD_BUCKET);
  // v0.1.9 — model context-window from operator-projected env (Piece 1
  // of the context-awareness slate). Absence is back-compat normal;
  // malformed values warn-and-degrade so a typo doesn't take down the
  // pod.
  const contextWindowTokens = parseContextWindowTokens(env.KAGENT_AGENT_MODEL_CONTEXT_WINDOW);

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
    ...(toolGatewayUrl !== undefined && { toolGatewayUrl }),
    logLevel,
    traceContentMode,
    taskDepth,
    identity,
    ...(rootTaskUid !== undefined && { rootTaskUid }),
    ...(contextWindowTokens !== undefined && { contextWindowTokens }),
    specSource,
  };
  // Audit C2 H12 — boot-line stamp so logs reveal which path the pod
  // took. Distinct from KAGENT_SPEC_SOURCE env (which downstream
  // tooling can read from process.env without re-deriving) — this
  // line is the human-grep target.
  console.log(`[kagent-agent-pod] spec source: ${specSource}`);
  // Audit-rev2 M11 — when the deprecated env-JSON fallback path is
  // taken, emit a structured WARN naming the v0.3.0 removal target.
  // Operators who built tooling against `KAGENT_AGENT_SPEC` /
  // `KAGENT_TASK_SPEC` env-vars need a runtime signal that the path
  // is on the way out; the ROADMAP entry tracks the timeline.
  // ConfigMap-path takes silently — it's the new normal. `'mixed'` is
  // the partial-mount edge case (also worth a WARN — the operator
  // emits both paths atomically, so one missing is unexpected).
  if (specSource === 'env-json') {
    console.warn(
      '[kagent-agent-pod] DEPRECATED: spec source is env-JSON ' +
        '(KAGENT_AGENT_SPEC / KAGENT_TASK_SPEC). The ConfigMap mount at ' +
        '/var/kagent/config/{agent,task}.spec.json is the supported path. ' +
        'env-JSON fallback is targeted for removal in v0.3.0-cas (single-release ' +
        'back-compat tail per docs/ROADMAP.md Phase 4 §"Move Agent + Task spec ' +
        'injection off env JSON").',
    );
  } else if (specSource === 'mixed') {
    console.warn(
      '[kagent-agent-pod] UNEXPECTED: spec source is "mixed" — agent.spec and ' +
        'task.spec resolved from different paths (one ConfigMap, one env-JSON). ' +
        'The operator emits both paths atomically; mixed is the partial-mount ' +
        'edge case. Investigate the pod-spec for missing volumeMounts.',
    );
  }
  return config;
}

/**
 * v0.4.3-identity — parse the Wave 3 SVID env contract into a
 * `PodIdentityConfig`. Defaults are explicit so an operator running
 * with identity disabled still gets a typed `identity.useSvidForLlm
 * = false` value. Exported for the unit-test suite.
 */
export function parseIdentityConfig(
  env: Readonly<Record<string, string | undefined>>,
): PodIdentityConfig {
  const useSvidForLlm = env.KAGENT_LITELLM_USE_SVID === 'true';
  return {
    useSvidForLlm,
    spiffeId:
      typeof env.KAGENT_SPIFFE_ID === 'string' && env.KAGENT_SPIFFE_ID.length > 0
        ? env.KAGENT_SPIFFE_ID
        : undefined,
    svidCertPath:
      typeof env.KAGENT_SVID_CERT_FILE === 'string' && env.KAGENT_SVID_CERT_FILE.length > 0
        ? env.KAGENT_SVID_CERT_FILE
        : undefined,
    svidKeyPath:
      typeof env.KAGENT_SVID_KEY_FILE === 'string' && env.KAGENT_SVID_KEY_FILE.length > 0
        ? env.KAGENT_SVID_KEY_FILE
        : undefined,
    svidBundlePath:
      typeof env.KAGENT_SVID_BUNDLE_FILE === 'string' && env.KAGENT_SVID_BUNDLE_FILE.length > 0
        ? env.KAGENT_SVID_BUNDLE_FILE
        : undefined,
  };
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
 * Lower bound on `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`. Mirrors
 * `CONTEXT_WINDOW_TOKENS_MIN` in `packages/operator/src/main.ts`. Below
 * this the safety-net over-trips regardless of agent behavior — every
 * non-trivial run hits the 95% threshold immediately. Audit-rev2 NH4
 * follow-up — defense-in-depth at the agent-pod side mirrors the
 * operator-side guard so a non-chart-mediated env override (e.g.
 * manual Job manifest, future non-chart deploy) still gets the same
 * graceful-degrade-with-warn posture.
 *
 * Kept loose enough (1000) that test fixtures provoking deterministic
 * 95% utilization with sub-K-token budgets continue to work — those
 * fixtures don't go through this env path; they construct `RunBudget`
 * directly.
 */
export const CONTEXT_WINDOW_TOKENS_MIN = 1000;

/**
 * Upper bound on `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`. Mirrors
 * `CONTEXT_WINDOW_TOKENS_MAX` in `packages/operator/src/main.ts` (2^21
 * = 2_097_152) — already larger than any production model as of
 * 2026-05-07 (Gemini 1.5 Pro is 1M, Claude 3 Opus is 200K, GPT-4o is
 * 128K). Above this the tokenUtilization percentage always reports
 * near-zero, silently disabling the substrate's 95% safety-net AND the
 * `context_pressure_ignored` detector.
 *
 * Audit-rev2 NH4 follow-up — the operator-side `parseModelClassesEnv`
 * already enforces this bound, so the chart-mediated path never produces
 * an out-of-range value. This guard catches the non-chart-mediated case
 * (manual env override on a Job manifest) so the silent-disable
 * trapdoor can't sneak through any deploy mechanism.
 */
export const CONTEXT_WINDOW_TOKENS_MAX = 2_097_152;

/**
 * v0.1.9 — parse `KAGENT_AGENT_MODEL_CONTEXT_WINDOW` into a positive
 * integer (the model's declared context-window size in tokens). Returns
 * undefined for absent / empty input — back-compat normal case.
 *
 * Defensive: any malformed value (`'0'`, `'-1'`, `'1.5'`, `'NaN'`,
 * non-numeric strings) logs a single console.warn and returns undefined
 * instead of throwing — the contract from docs/CONTEXT-AWARENESS.md §7
 * is that absence (or any failure to parse) MUST degrade to no-op for
 * pieces 2/3/4. A typo on the operator chart should never take down a
 * long-running AgentTask.
 *
 * Audit-rev2 NH4 follow-up (= W1-Operator's filed sub-task in
 * `evidence/audit-rev2/W1-Operator-REPORT.md` §6): also bounds the value
 * within `[CONTEXT_WINDOW_TOKENS_MIN, CONTEXT_WINDOW_TOKENS_MAX]`. The
 * upper-bound case is the silent-disable trapdoor (a fat-fingered
 * `999_999_999_999` would mean cumulative/window is always near zero,
 * disabling the safety-net). The lower-bound case is the over-trip
 * trapdoor (e.g. `999`). Mirror of `parseModelClassesEnv` at the
 * operator side — three distinct WARN shapes per misconfig category.
 *
 * Exported for unit tests.
 */
export function parseContextWindowTokens(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[kagent-agent-pod] KAGENT_AGENT_MODEL_CONTEXT_WINDOW='${raw}' is not a positive integer; ` +
        `ignoring (context-awareness pieces 2/3/4 will degrade to no-op).`,
    );
    return undefined;
  }
  if (n > CONTEXT_WINDOW_TOKENS_MAX) {
    console.warn(
      `[kagent-agent-pod] KAGENT_AGENT_MODEL_CONTEXT_WINDOW=${n} is above CONTEXT_WINDOW_TOKENS_MAX=${CONTEXT_WINDOW_TOKENS_MAX} — ` +
        `values this large silently disable the substrate's context-pressure safety-net ` +
        `(used/contextWindowTokens always near zero); ignoring (pieces 2/3/4 degrade to no-op).`,
    );
    return undefined;
  }
  if (n < CONTEXT_WINDOW_TOKENS_MIN) {
    console.warn(
      `[kagent-agent-pod] KAGENT_AGENT_MODEL_CONTEXT_WINDOW=${n} is below CONTEXT_WINDOW_TOKENS_MIN=${CONTEXT_WINDOW_TOKENS_MIN} — ` +
        `values this small over-trip the safety-net regardless of agent behavior; ` +
        `ignoring (pieces 2/3/4 degrade to no-op).`,
    );
    return undefined;
  }
  return n;
}

/**
 * v0.4.1-blackboard — Parse the root-task UID out of
 * `KAGENT_BLACKBOARD_BUCKET=kagent-kv-<root-uid>`. Returns undefined
 * when the env is absent / malformed. Defensive: an unparseable value
 * silently maps to undefined rather than throwing — the agent loop
 * runs without blackboard tools rather than refusing to boot.
 * Exported for unit tests.
 */
export function parseRootTaskUidFromBucket(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const prefix = 'kagent-kv-';
  if (!raw.startsWith(prefix)) return undefined;
  const rest = raw.slice(prefix.length);
  return rest.length > 0 ? rest : undefined;
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
 * Audit C2 H12 (2026-05-06) — combined env-JSON spec payload cap.
 *
 * The env-JSON path (`KAGENT_AGENT_SPEC` + `KAGENT_TASK_SPEC`) is the
 * v0.1 back-compat fallback. It is bounded by Linux `ARG_MAX` (~128
 * KiB on most distros, but unevenly enforced — can OOM a pod's argv
 * load before parseEnv runs) and by etcd's per-object size cap.
 *
 * 256 KiB is an intentionally-loose ceiling — well above any realistic
 * Agent.spec + AgentTask.spec footprint, well below the smallest
 * ARG_MAX a hardened kernel might enforce. The check runs at parse
 * time so a pathological env produces a structured CrashLoop reason
 * instead of a generic exec failure with no operator-visible signal.
 *
 * The cap applies to the env-JSON path ONLY. ConfigMap-mounted files
 * have a separate operator-side cap (W3-Operator scope, follow-up to
 * `packages/operator/src/job-spec.ts:666-671`).
 *
 * Exported so tests can drive the boundary without re-deriving it.
 */
export const ENV_JSON_SPEC_PAYLOAD_MAX_BYTES = 262_144; // 256 KiB

/**
 * Audit C2 H12 — provenance of agent.spec + task.spec for trace
 * metadata + grep-able pod logs. Stamped onto the OTel attribute
 * `kagent.spec.source` (per docs/SUBSTRATE-V1.md §4.1) and
 * stringified into the boot-line log so an on-call can answer
 * "which path did this pod take?" without reaching for kubectl
 * describe.
 */
export type SpecSource = 'configmap' | 'env-json';

/**
 * v0.2.0-typed-io — read agent.spec from the mounted ConfigMap when
 * the file exists, falling back to the v0.1 KAGENT_AGENT_SPEC env JSON
 * for one release of back-compat. Either path must yield a valid
 * AgentSpecEnv with `model` set; parseEnv enforces that downstream.
 *
 * Audit C2 H12 — when the env-JSON path is taken, enforces the
 * `ENV_JSON_SPEC_PAYLOAD_MAX_BYTES` combined cap and returns the
 * source so parseEnv can stamp `KAGENT_SPEC_SOURCE` on PodConfig.
 */
function loadAgentSpec(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): { spec: AgentSpecEnv; source: SpecSource } {
  const fileBody = readFile(CONFIG_AGENT_SPEC_PATH);
  if (fileBody !== undefined) {
    return {
      spec: parseJson<AgentSpecEnv>(fileBody, CONFIG_AGENT_SPEC_PATH),
      source: 'configmap',
    };
  }
  // Back-compat env-JSON path. The combined cap with KAGENT_TASK_SPEC
  // is enforced in `parseEnv` (it has visibility into both raw env
  // values); this loader only verifies the var is present.
  return {
    spec: parseJson<AgentSpecEnv>(requireEnv(env, 'KAGENT_AGENT_SPEC'), 'KAGENT_AGENT_SPEC'),
    source: 'env-json',
  };
}

function loadTaskSpec(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): { spec: TaskSpecEnv; source: SpecSource } {
  const fileBody = readFile(CONFIG_TASK_SPEC_PATH);
  if (fileBody !== undefined) {
    return {
      spec: parseJson<TaskSpecEnv>(fileBody, CONFIG_TASK_SPEC_PATH),
      source: 'configmap',
    };
  }
  return {
    spec: parseJson<TaskSpecEnv>(requireEnv(env, 'KAGENT_TASK_SPEC'), 'KAGENT_TASK_SPEC'),
    source: 'env-json',
  };
}

/**
 * Audit C2 H12 — pre-parse cap on the env-JSON spec payload. Sums the
 * UTF-8 byte length of `KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC` and
 * throws a structured error when the sum exceeds
 * `ENV_JSON_SPEC_PAYLOAD_MAX_BYTES`. Runs ONLY when at least one of
 * the env-JSON inputs is the source — a pod taking the ConfigMap
 * path bypasses the cap entirely (operator-side bound applies there).
 *
 * Exported for the unit-test suite.
 */
export function assertEnvJsonSpecBudget(env: Readonly<Record<string, string | undefined>>): void {
  const agentRaw = env.KAGENT_AGENT_SPEC ?? '';
  const taskRaw = env.KAGENT_TASK_SPEC ?? '';
  const agentBytes = Buffer.byteLength(agentRaw, 'utf8');
  const taskBytes = Buffer.byteLength(taskRaw, 'utf8');
  const total = agentBytes + taskBytes;
  if (total > ENV_JSON_SPEC_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `env_json_spec_too_large: KAGENT_AGENT_SPEC (${String(agentBytes)} bytes) + ` +
        `KAGENT_TASK_SPEC (${String(taskBytes)} bytes) = ${String(total)} bytes ` +
        `exceeds ${String(ENV_JSON_SPEC_PAYLOAD_MAX_BYTES)} byte cap. ` +
        `Migrate to ConfigMap-mounted spec at /var/kagent/config/{agent,task}.spec.json ` +
        `(operator default since v0.2.0-typed-io).`,
    );
  }
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
