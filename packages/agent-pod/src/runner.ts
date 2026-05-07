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
  type RunBudget,
  type TerminalStatus,
  type ToolProvider,
  type TraceEntry,
  type TraceSink,
} from '@kagent/agent-loop';
import { OpenAICompatibleLLMClient } from '@kagent/openai-compat';
import { StdoutSink } from '@kagent/trace-sinks';

import {
  createArtifactRegistry,
  tryParseArtifactRefFromToolOutput,
  type ArtifactRegistry,
} from './artifacts.js';
import { resolveBuiltinTools } from './builtin-tools.js';
import type { AgentSpecEnv, PodConfig } from './env.js';
import { agentHasArtifactInputOrOutput } from './env.js';
import { loadIdentityHandle, type IdentityHandle } from './svid-client.js';

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
 * Audit-rev2 M10 — substrate-side default wall-clock timeout when
 * `runConfig.timeoutSeconds` (and the deprecated top-level
 * `timeoutSeconds`) are both absent. 1800s = 30 minutes — generous
 * enough for typical research / summarization workloads, short enough
 * that a hung LLM call doesn't pin the pod for hours. Operators with
 * legitimately long-running flows set the field explicitly. Exported
 * for the runner test suite + downstream consumers that want to read
 * the same default (e.g. job-spec validation).
 */
export const DEFAULT_TASK_TIMEOUT_SECONDS = 1800;

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
   * v0.4.1-blackboard — Wave 3 Blackboard sub-team. Provider hosting
   * the four blackboard tools. Wired by main.ts when
   * `KAGENT_BLACKBOARD_BUCKET` + `KAGENT_NATS_URL` are set.
   */
  readonly blackboardTools?: ToolProvider;
  /**
   * v0.4.0-events — Wave 3 events sub-team. `publish_event` tool
   * provider, registered when the Agent declares at least one
   * `publishes[]` entry AND `KAGENT_EVENTS_NATS_URL` is set.
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
  /**
   * v0.4.3-identity (Wave 3) — pre-resolved SVID handle. Production
   * wiring leaves this undefined and `runAgentTask` calls
   * `resolveIdentityHandle(config)` to build it from the env paths.
   * Tests inject directly to assert the SVID-on-the-wire path
   * without touching `node:fs`.
   */
  readonly identityHandle?: IdentityHandle | null;
  /**
   * v0.5.0-tenancy — Wave 4 / Tenancy sub-team. Optional verified
   * capability bundle. When present, the runner reads `claims.tenant`
   * and stamps `X-Kagent-Tenant` on every outbound LLM gateway call
   * per docs/GATEWAY-CONTRACT.md §3. When absent (legacy / pre-Wave-4
   * deploy without the JWT mount), the header is omitted.
   *
   * Decoupled type — the runner only needs the `claims.tenant` field;
   * the full `CapabilityBundle` shape lives in `@kagent/capability-types`.
   */
  readonly capabilityBundle?: { readonly claims?: { readonly tenant?: string } };
  /**
   * v0.1 P3 — in-pod artifact registry. The `write_artifact` tool
   * pushes successful refs into this registry as they are produced;
   * `RunResult.artifacts` is built from `registry.snapshot()` UNION
   * the trace-collation fallback. When undefined, the runner mints a
   * fresh registry — production callers should not pass this in.
   * Tests inject one to assert specific contents without driving the
   * full agent loop.
   */
  readonly artifactRegistry?: ArtifactRegistry;
  /**
   * v0.1.9 / NB1 fix — see docs/CONTEXT-AWARENESS.md §4.4 and
   * `evidence/audit-rev2/C2.md` §2 NB1.
   *
   * Forward-only callback fired exactly once when the executor
   * allocates the run's `RunBudget`. Production wiring uses this hook
   * in `main.ts` to capture the live mutable budget reference, then
   * feed `tokenUtilizationSnapshot` (the `defineGetMyContext` dep)
   * with a thunk that reads `cumulativeInputTokens +
   * cumulativeOutputTokens` AT TOOL-CALL time. Without this hook, the
   * `get_my_context` tool's tokenUtilization snapshot fell back to
   * `{ used: 0, modelWindow: null }` unconditionally — making the
   * marquee context-awareness feature inert in production while tests
   * (which inject the snapshot directly) stayed green.
   *
   * The runner forwards this verbatim onto `executor.run({
   * onBudgetReady })`. Optional + observation-only; any throw inside
   * the callback is swallowed by the executor.
   */
  readonly onBudgetReady?: (budget: RunBudget) => void;
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
  // v0.4.3-identity — when the operator set KAGENT_LITELLM_USE_SVID=true
  // we resolve a handle to the local SPIRE-managed SVID files BEFORE
  // building the LLM client; the client's mTLS dispatcher is wired off
  // the handle's getMtlsContext(). When the env flag is unset, the
  // handle is null and the client takes the bearer-token path
  // unchanged (Wave 0 secrets-hygiene contract).
  const identityHandle = deps.identityHandle ?? resolveIdentityHandle(config);
  // v0.5.0-tenancy — extract `claims.tenant` from the verified cap
  // bundle (loaded by main.ts via `loadCapabilityOptional`). Absent
  // cap = absent header (legacy / pre-Wave-4 install).
  const tenantClaim = deps.capabilityBundle?.claims?.tenant;
  const llm =
    deps.llm ??
    buildLlmClient(config, undefined, identityHandle ?? undefined, tenantClaim ?? undefined);

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

  // P3 — mint (or accept an injected) artifact registry BEFORE the
  // tool providers are resolved, so the `write_artifact` handler can
  // push successful refs into the same instance the run-result harvest
  // reads from. ONE registry per run; persists for the entire executor
  // loop so mid-run reads (status flush) see partial state.
  const artifactRegistry = deps.artifactRegistry ?? createArtifactRegistry();

  // Resolve tool providers: tests may inject explicitly via deps; in
  // production we read `Agent.spec.tools` and look each name up in the
  // built-in registry. Unknown names throw here at boot — fail fast so
  // the operator sees a `Failed` AgentTask with a clear runner error
  // rather than a silently-degraded loop.
  const toolProviders = resolveToolProviders(config, deps, { artifactRegistry });

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
  // Audit-rev2 M10 (= evidence/audit-rev2/C2.md §1 row M10): when no
  // timeout is declared on the task, stamp the substrate default
  // (`DEFAULT_TASK_TIMEOUT_SECONDS`) at admission time. Previously
  // `effectiveTimeoutSeconds === undefined` meant the pod could hang
  // indefinitely on a stuck LLM call (waiting only for the kubelet's
  // activeDeadlineSeconds to fire — which is set by the operator's
  // job-spec to the same task timeout, so an absent timeout there
  // produced no clean shutdown either). Stamping a default ensures
  // every admitted task has a wall-clock ceiling AND surfaces an
  // AbortSignal-driven cancellation path the SIGTERM handler can
  // observe. Operators that need a longer ceiling set
  // `runConfig.timeoutSeconds` explicitly.
  const declaredTimeoutSeconds = rc?.timeoutSeconds ?? config.taskSpec.timeoutSeconds;
  const effectiveTimeoutSeconds =
    typeof declaredTimeoutSeconds === 'number' && declaredTimeoutSeconds > 0
      ? declaredTimeoutSeconds
      : DEFAULT_TASK_TIMEOUT_SECONDS;
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
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutSeconds * 1000);
  const signal = composeSignals(deps.signal, timeoutSignal);

  // Piece 3 (CONTEXT-AWARENESS.md §4.5) — substrate-side context-window
  // safety-net threshold. Operator chart (`agentPod.contextSafetyThreshold`)
  // projects this onto every spawned pod's env at the
  // KAGENT_CONTEXT_SAFETY_THRESHOLD key; default 0.95 per §4.1. Read
  // here inline (not in env.ts) so this piece doesn't touch the env-reader
  // surface that Piece 2 owns. Malformed / out-of-range values fall back to
  // the default rather than throwing — the executor re-validates the
  // resolved threshold and would surface an `InvalidConfigError` for any
  // bogus value that did make it through.
  //
  // The companion `contextWindowTokens` env read
  // (`KAGENT_AGENT_MODEL_CONTEXT_WINDOW`) is owned by Piece 2; until it
  // lands, this threshold has no effect because the executor's safety-net
  // is gated on `RunBudget.contextWindowTokens !== undefined`.
  const contextSafetyThreshold = parseContextSafetyThreshold(
    process.env.KAGENT_CONTEXT_SAFETY_THRESHOLD,
  );

  const result = await executor.run({
    agentType: config.agentName,
    messages,
    runId: config.taskId,
    ...(signal !== undefined && { signal }),
    ...(effectiveTokenLimit !== undefined && { tokenLimit: effectiveTokenLimit }),
    ...(effectiveCostLimit !== undefined && { costLimitUsd: effectiveCostLimit }),
    ...(effectiveMaxIter !== undefined && { maxIterations: effectiveMaxIter }),
    // v0.1.9 — thread the operator-projected
    // KAGENT_AGENT_MODEL_CONTEXT_WINDOW (parsed onto config) onto
    // RunBudget.contextWindowTokens so the executor's pre-call safety-net
    // and the `context_pressure_ignored` detector read one source of
    // truth. Absent = the four context-awareness pieces degrade to no-op
    // (back-compat for v0.1.8 / classes that don't declare a window).
    ...(config.contextWindowTokens !== undefined && {
      contextWindowTokens: config.contextWindowTokens,
    }),
    ...(contextSafetyThreshold !== undefined && { contextSafetyThreshold }),
    // v0.1.9 / NB1 — forward the live-budget observer hook so main.ts
    // can wire `tokenUtilizationSnapshot` against the actual mutating
    // budget reference. See `RunDeps.onBudgetReady` JSDoc.
    ...(deps.onBudgetReady !== undefined && { onBudgetReady: deps.onBudgetReady }),
  });

  // v0.1.9 context-awareness — Piece 4 detector knob. Read the
  // operator-tunable pressure threshold (default 0.7) from env so the
  // chart value `agentPod.contextPressureThreshold` reaches the
  // `context_pressure_ignored` detector in `quality-flags.ts`. The
  // window itself rides on `result.budget.contextWindowTokens` set by
  // Piece 2's env plumbing; when unset (legacy / pre-v0.1.9) the
  // detector is a no-op regardless of threshold.
  const pressureThreshold = parseContextPressureThresholdEnv(
    process.env.KAGENT_CONTEXT_PRESSURE_THRESHOLD,
  );
  const flags = computeQualityFlags(
    [...result.traces],
    result.finalContent,
    userMessage,
    result.budget,
    pressureThreshold !== undefined ? { pressureThreshold } : {},
  );

  // P3 — collate ArtifactRefs.
  //
  // Source-of-truth ordering:
  //   1. The in-pod ArtifactRegistry (authoritative — the
  //      `write_artifact` handler pushes into it synchronously,
  //      survives trace truncation + non-completed terminal paths).
  //   2. Trace harvesting via `collectArtifactsFromTraces` is kept as
  //      a forward-compat fallback; refs found ONLY in the trace
  //      stream (e.g. injected by an external sidecar that emits
  //      tool_call entries) are merged in. Duplicates are deduped on
  //      `uri`.
  //
  // Both paths drop `inline://...` refs from `RunResult.artifacts`
  // because the substrate contract is "RunResult.artifacts is
  // followable to durable bytes."
  const artifacts = mergeArtifactSources(
    artifactRegistry.snapshot(),
    collectArtifactsFromTraces(result.traces),
  );

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
 * Merge two artifact sources (registry + trace harvest), deduping on
 * URI (registry-side wins on conflict because the registry was
 * populated synchronously inside the writer). `inline://` URIs are
 * dropped — the substrate contract for `RunResult.artifacts` is
 * "followable to durable bytes."
 *
 * Exported for the runner test suite.
 */
export function mergeArtifactSources(
  registry: readonly ArtifactRef[],
  fromTraces: readonly ArtifactRef[],
): readonly ArtifactRef[] {
  const byUri = new Map<string, ArtifactRef>();
  // Registry first so the same URI from a later trace harvest does not
  // overwrite the registry's authoritative metadata.
  for (const ref of registry) {
    if (typeof ref.uri !== 'string' || ref.uri.length === 0) continue;
    if (ref.uri.startsWith('inline://')) continue;
    byUri.set(ref.uri, ref);
  }
  for (const ref of fromTraces) {
    if (typeof ref.uri !== 'string' || ref.uri.length === 0) continue;
    if (ref.uri.startsWith('inline://')) continue;
    if (!byUri.has(ref.uri)) byUri.set(ref.uri, ref);
  }
  return [...byUri.values()];
}

/**
 * v0.1.9 context-awareness — parse `KAGENT_CONTEXT_PRESSURE_THRESHOLD`
 * into a float in `(0, 1]`. Returns undefined when:
 *   - The env is unset / empty.
 *   - The value is not a finite number.
 *   - The value is outside the `(0, 1]` range.
 *
 * Caller treats undefined as "use the detector's built-in default" (0.7).
 * Defensive — a malformed env value silently falls back to the default
 * rather than failing the run; the detector is observation-only and
 * misconfiguration here should not trip an AgentTask. Exported for the
 * unit-test suite.
 *
 * Audit-rev2 NH3 follow-up (= W1-Operator's filed sub-task in
 * `evidence/audit-rev2/W1-Operator-REPORT.md` §6): when the env is
 * present but parses out-of-range, log a structured WARN naming the
 * offending value + the legal range + the default the caller will fall
 * back to. The operator-chart guard now rejects out-of-range values
 * BEFORE they reach the pod (Helm-render-time fail), so this WARN
 * fires only on the non-chart-mediated path (manual Job manifest, future
 * non-chart deploy). Defense-in-depth — silent fall-through is the
 * smoking-gun shape the audit found at the operator side.
 */
export function parseContextPressureThresholdEnv(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(
      `[kagent-agent-pod] KAGENT_CONTEXT_PRESSURE_THRESHOLD='${raw}' is not a finite number; ` +
        `falling back to detector default (0.7). The legal range is (0, 1]. ` +
        `If you set this via the operator Helm chart, the chart-render guard should have rejected it; ` +
        `check for a manual env override on the Job manifest.`,
    );
    return undefined;
  }
  if (n <= 0 || n > 1) {
    console.warn(
      `[kagent-agent-pod] KAGENT_CONTEXT_PRESSURE_THRESHOLD=${n} is outside the legal range (0, 1]; ` +
        `falling back to detector default (0.7). Values <=0 or >1 silently disable the ` +
        `context_pressure_ignored detector — the chart-render guard normally rejects these.`,
    );
    return undefined;
  }
  return n;
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
 * v0.4.3-identity (Wave 3 / Identity): when `config.identity.useSvidForLlm
 * = true`, the client is built with an mTLS dispatcher backed by the
 * SVID material (cert + key + bundle PEMs from the pod-side files the
 * SPIRE-Agent / spiffe-helper sidecar materialized). When the SVID
 * material is unavailable (helper hasn't written yet, mock disabled),
 * we fall back to bearer auth and emit a WARN log — the runner stays
 * functional but loses the identity guarantee. The mTLS capability
 * probe (`probeGatewayMtls`) lives in `svid-client.ts` and is invoked
 * by `runAgentTask` BEFORE the first chat() call so a bearer-only
 * gateway also falls back gracefully.
 *
 * Exported so tests can pass a fake `fetch` and assert the wire-level
 * headers without booting the full executor. Production callers go
 * through `runAgentTask`.
 */
export function buildLlmClient(
  config: PodConfig,
  fetchImpl?: typeof globalThis.fetch,
  identityHandle?: IdentityHandle,
  /**
   * v0.5.0-tenancy — Wave 4 / Tenancy sub-team. Optional resolved
   * tenant id (from the agent-pod's mounted cap-bundle's
   * `claims.tenant`). When set, the client stamps `X-Kagent-Tenant`
   * onto every outbound request per docs/GATEWAY-CONTRACT.md §3.
   * When absent (legacy AgentTask without tenant assignment, or
   * pre-Wave-4 install), the header is omitted entirely (per the
   * sub-team brief: "When `claims.tenant` is absent, omit the header
   * — don't send empty").
   */
  tenant?: string,
): OpenAICompatibleLLMClient {
  // Defensive read — fixture/test PodConfigs from before v0.4.3 don't
  // carry an `identity` block. Treat missing-field as identity-off so
  // the legacy bearer path stays unchanged.
  const identity = config.identity ?? { useSvidForLlm: false, spiffeId: undefined };
  const headers: Record<string, string> = {
    'X-Kagent-Task-UID': config.taskId,
    'X-Kagent-Agent': config.agentName,
  };
  // v0.5.0-tenancy — gateway contract §3 attribution for per-tenant
  // routing/quota. Mirror the existing X-Kagent-Task-UID + X-Kagent-Agent
  // pattern; only stamp when the tenant is non-empty.
  if (typeof tenant === 'string' && tenant.length > 0) {
    headers['X-Kagent-Tenant'] = tenant;
  }
  if (identity.useSvidForLlm && identityHandle?.spiffeId !== undefined) {
    headers['X-Kagent-SPIFFE-ID'] = identityHandle.spiffeId;
  }
  // Decide credential mode: SVID-mTLS preferred when handle is wired
  // AND the material is available. Bearer fall-back when SVID material
  // is missing OR identity is off.
  const useSvid =
    identity.useSvidForLlm &&
    identityHandle !== undefined &&
    identityHandle.getMtlsContext() !== null;
  if (identity.useSvidForLlm && !useSvid) {
    console.warn(
      '[kagent-agent-pod/identity] KAGENT_LITELLM_USE_SVID=true but SVID material unavailable; ' +
        'falling back to bearer auth. SPIRE-helper sidecar may not have materialized yet.',
    );
  }
  return new OpenAICompatibleLLMClient({
    baseUrl: config.litellmBaseUrl,
    model: config.agentSpec.model,
    ...(!useSvid && config.litellmApiKey !== undefined && { apiKey: config.litellmApiKey }),
    defaultHeaders: headers,
    ...(fetchImpl !== undefined && { fetch: fetchImpl }),
  });
}

/**
 * v0.4.3-identity — agent-pod-side SVID handle resolver. When
 * `config.identity.useSvidForLlm=true`, build an `IdentityHandle`
 * against the SVID file paths from env. Returns null when identity is
 * off (the production-default).
 *
 * Defensive: reads `config.identity` optional chained so legacy
 * test-fixture PodConfigs (from before v0.4.3) don't crash here —
 * they get null (identity off) and continue down the bearer path.
 *
 * Exported for the runner test suite + main.ts production wiring.
 */
export function resolveIdentityHandle(config: PodConfig): IdentityHandle | null {
  const identity = config.identity;
  if (identity === undefined || !identity.useSvidForLlm) return null;
  return loadIdentityHandle({
    enabled: true,
    ...(identity.svidCertPath !== undefined && { certPath: identity.svidCertPath }),
    ...(identity.svidKeyPath !== undefined && { keyPath: identity.svidKeyPath }),
    ...(identity.svidBundlePath !== undefined && { bundlePath: identity.svidBundlePath }),
    ...(identity.spiffeId !== undefined && { spiffeId: identity.spiffeId }),
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
 * Audit C2.2 HIGH #1 (punchlist H7): substrate / blackboard / events
 * providers are NOT auto-trusted. Every tool name they expose must be
 * either listed in `Agent.spec.tools` OR satisfy an
 * `assertSubstrateToolAdmitted` predicate (see that helper for the
 * full implicit-when-X policy). Failing the cross-check is fail-FAST
 * at boot, matching the existing "unknown built-in tool" precedent in
 * `builtin-tools.ts:986`. The Audit found that an Agent without
 * `spawn_child_task` in its spec could nonetheless reach the global
 * federation lookup once the env-flag fired the substrate provider on;
 * this gate closes that gap.
 *
 * Exported for the runner test suite; production callers go through
 * `runAgentTask`.
 *
 * Throws on unknown tool names with a clear, operator-actionable message.
 */
export function resolveToolProviders(
  config: PodConfig,
  deps: RunDeps,
  /**
   * Optional injection of the in-pod artifact registry. When present
   * the built-in `write_artifact` tool pushes successful refs into it
   * (single source-of-truth for the run-result harvest). Defaults to
   * undefined for back-compat with existing call sites that build the
   * provider list standalone (e.g. test suites).
   */
  options: { artifactRegistry?: ArtifactRegistry } = {},
): readonly ToolProvider[] {
  if (deps.toolProviders !== undefined) return deps.toolProviders;
  const out: ToolProvider[] = [];

  // Collect tool names served by the substrate / blackboard / events
  // providers so resolveBuiltinTools accepts them as known when an
  // Agent.spec.tools entry references them. Without this, an Agent
  // that lists `spawn_child_task` in its tools dies at boot with
  // "unknown built-in tool" even though spawnTools serves the call.
  // describeTools() can be async on the ToolProvider union, but the
  // in-process providers we wire here are all synchronous; the cast
  // mirrors the pattern in builtin-tools.test.ts where tests narrow
  // the same way.
  const externallyProvidedNames = new Set<string>();
  for (const provider of [deps.spawnTools, deps.blackboardTools, deps.eventsTools]) {
    if (provider === undefined) continue;
    const descriptors = provider.describeTools() as readonly { name: string }[];
    for (const descriptor of descriptors) {
      externallyProvidedNames.add(descriptor.name);
    }
  }

  // Audit C2.2 HIGH #1 — cross-check substrate-provider tool names vs
  // Agent.spec.tools BEFORE we wire them in. Throws fail-FAST with a
  // single message naming every offender so the operator can fix the
  // manifest in one pass. Run BEFORE resolveBuiltinTools because both
  // gates are config-time errors and operators should see the
  // higher-impact one first.
  assertSubstrateToolsAdmitted(config.agentSpec, externallyProvidedNames);

  const builtin = resolveBuiltinTools(config.agentSpec.tools, {
    ...(options.artifactRegistry !== undefined && {
      artifactRegistry: options.artifactRegistry,
    }),
    externallyProvidedNames,
  });
  if (builtin !== null) out.push(builtin);
  if (deps.spawnTools !== undefined) out.push(deps.spawnTools);
  // v0.4.1-blackboard
  if (deps.blackboardTools !== undefined) out.push(deps.blackboardTools);
  // v0.4.0-events
  if (deps.eventsTools !== undefined) out.push(deps.eventsTools);
  return out;
}

/* =====================================================================
 * Substrate-tool allowlist cross-check.
 *
 * Audit C2.2 HIGH #1 / punchlist H7 — every tool name a substrate /
 * blackboard / events provider exposes must be admitted by ONE of:
 *
 *   1. Explicit listing in `Agent.spec.tools` (same allowlist semantics
 *      that gate `resolveBuiltinTools` — fail-FAST on a typo).
 *   2. An "implicit-when-X" predicate proving the Agent declared the
 *      matching schema-level intent. Current predicates:
 *
 *        spawn_child_task            ← allowedChildAgents.length>0 OR
 *        wait_for_child_task             allowedChildTemplates.length>0
 *        wait_for_children_all
 *        ensure_agent_from_template
 *
 *        publish_event               ← publishes[].length>0 OR
 *                                      capabilityClaims.publish.length>0
 *
 *        read_artifact               ← inputs|outputs[].kind=='artifact'
 *        write_artifact                  (delegates to env.ts predicate)
 *
 *        read_blackboard             ← any task-graph intent (spawn or
 *        write_blackboard                publishes) — blackboard is
 *        list_blackboard                 useful only in multi-agent
 *        append_blackboard               flows; chat-only Agents that
 *                                        want it must list explicitly.
 *
 *        get_my_context              ← UNIVERSAL (introspection-only;
 *                                      no authority widens via this
 *                                      tool).
 *
 * Names not in the registry above (anything an out-of-tree provider
 * happens to expose) fall through to the strict default — must be in
 * `Agent.spec.tools`. This preserves the contract that an Agent's
 * declared tool surface is authoritative.
 * ===================================================================== */

/** Tools admitted implicitly when the Agent declared spawn intent. */
const SPAWN_INTENT_TOOLS: ReadonlySet<string> = new Set([
  'spawn_child_task',
  'wait_for_child_task',
  'wait_for_children_all',
  'ensure_agent_from_template',
]);

/** Tools admitted implicitly when the Agent declared publish intent. */
const PUBLISH_INTENT_TOOLS: ReadonlySet<string> = new Set(['publish_event']);

/** Tools admitted implicitly when the Agent declared artifact I/O. */
const ARTIFACT_INTENT_TOOLS: ReadonlySet<string> = new Set(['read_artifact', 'write_artifact']);

/** Tools admitted implicitly when the Agent has any task-graph intent. */
const BLACKBOARD_TOOLS: ReadonlySet<string> = new Set([
  'read_blackboard',
  'write_blackboard',
  'list_blackboard',
  'append_blackboard',
]);

/** Universally-admitted introspection tools. */
const UNIVERSAL_TOOLS: ReadonlySet<string> = new Set(['get_my_context']);

function hasSpawnIntent(spec: AgentSpecEnv): boolean {
  const allowedAgents = spec.allowedChildAgents ?? [];
  const allowedTemplates = spec.allowedChildTemplates ?? [];
  return allowedAgents.length > 0 || allowedTemplates.length > 0;
}

function hasPublishIntent(spec: AgentSpecEnv): boolean {
  const publishes = spec.publishes;
  if (publishes !== undefined && publishes.length > 0) return true;
  // capabilityClaims is `Readonly<Record<string, unknown>>` at the env
  // layer — narrow defensively. The cap-issuer / shadow path uses
  // `claims.publish: string[]` (see main.ts:430-444).
  const claims = spec.capabilityClaims as { readonly publish?: unknown } | undefined;
  const publishClaim = claims?.publish;
  if (Array.isArray(publishClaim) && publishClaim.length > 0) return true;
  return false;
}

/**
 * Decide whether a single substrate tool name is admitted on this
 * Agent. Returns `null` on admit, or a human-readable reason string on
 * reject (the caller assembles the multi-offender error message).
 */
function reasonToRejectSubstrateTool(name: string, spec: AgentSpecEnv): string | null {
  // Explicit allowlist always wins — covers any tool name the operator
  // listed by hand, including names that have no implicit-when-X path.
  if (spec.tools !== undefined && spec.tools.includes(name)) return null;

  if (UNIVERSAL_TOOLS.has(name)) return null;

  if (SPAWN_INTENT_TOOLS.has(name)) {
    if (hasSpawnIntent(spec)) return null;
    return (
      `requires either explicit listing in Agent.spec.tools OR a non-empty ` +
      `Agent.spec.allowedChildAgents / allowedChildTemplates declaring spawn intent`
    );
  }

  if (PUBLISH_INTENT_TOOLS.has(name)) {
    if (hasPublishIntent(spec)) return null;
    return (
      `requires either explicit listing in Agent.spec.tools OR a non-empty ` +
      `Agent.spec.publishes[] / capabilityClaims.publish declaring publish intent`
    );
  }

  if (ARTIFACT_INTENT_TOOLS.has(name)) {
    if (agentHasArtifactInputOrOutput(spec)) return null;
    return (
      `requires either explicit listing in Agent.spec.tools OR an ` +
      `Agent.spec.inputs[] / outputs[] entry of kind:'artifact'`
    );
  }

  if (BLACKBOARD_TOOLS.has(name)) {
    if (hasSpawnIntent(spec) || hasPublishIntent(spec)) return null;
    return (
      `requires either explicit listing in Agent.spec.tools OR an ` +
      `Agent task-graph intent (allowedChildAgents/Templates or publishes[])`
    );
  }

  // Strict default for any unknown out-of-tree substrate tool name —
  // must be listed in Agent.spec.tools.
  return `must be listed in Agent.spec.tools (no implicit-when-X predicate matched)`;
}

/**
 * Throw fail-FAST at boot if any substrate-provider tool name is not
 * admitted on the current Agent spec. Mirrors the
 * `resolveBuiltinTools`-style "unknown built-in tool" error: one
 * message, every offender named, allowed list rendered for the
 * operator.
 *
 * Exported for direct unit testing (the runner test file in
 * `tool-allowlist.test.ts` drives this both through
 * `resolveToolProviders` and — implicitly — by asserting the same
 * messages at the boot path).
 */
export function assertSubstrateToolsAdmitted(
  spec: AgentSpecEnv,
  externallyProvidedNames: ReadonlySet<string>,
): void {
  if (externallyProvidedNames.size === 0) return;
  const rejected: { readonly name: string; readonly reason: string }[] = [];
  for (const name of externallyProvidedNames) {
    const reason = reasonToRejectSubstrateTool(name, spec);
    if (reason !== null) rejected.push({ name, reason });
  }
  if (rejected.length === 0) return;

  const allowed = spec.tools !== undefined ? [...spec.tools].sort() : [];
  const offenderList = rejected.map(({ name, reason }) => `  - "${name}": ${reason}`).join('\n');
  throw new Error(
    `substrate tool registration rejected: the following tool name(s) ` +
      `attempted to register but are not in Agent.spec.tools and no ` +
      `implicit-when-X predicate matched:\n${offenderList}\n` +
      `Agent.spec.tools (allowed): [${allowed.join(', ')}]. ` +
      `Edit Agent.spec.tools to admit explicitly, OR declare matching ` +
      `intent on the Agent spec (allowedChildAgents/Templates for spawn, ` +
      `publishes[]/capabilityClaims.publish for publish_event, ` +
      `inputs|outputs[].kind='artifact' for read/write_artifact).`,
  );
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

/**
 * Piece 3 (CONTEXT-AWARENESS.md §4.5) — parse the
 * `KAGENT_CONTEXT_SAFETY_THRESHOLD` env var into a float in `(0, 1]`.
 *
 * Returns `undefined` (so the executor applies its own default 0.95)
 * when the env var is unset, empty, malformed, or out of range. The
 * executor re-validates whatever we pass through; an explicit
 * out-of-range value passed in by the operator chart would surface as
 * `InvalidConfigError` at run time. Defensive fallback to undefined
 * here keeps the agent-pod boot resilient to a typo'd Helm value.
 *
 * Exported for the runner test suite.
 *
 * Audit-rev2 NH3 follow-up (= W1-Operator's filed sub-task in
 * `evidence/audit-rev2/W1-Operator-REPORT.md` §6): when the env is
 * present but parses out-of-range, log a structured WARN naming the
 * offending value + the legal range + the default the caller will fall
 * back to. The operator-chart guard now rejects out-of-range values
 * BEFORE they reach the pod (Helm-render-time fail), so this WARN
 * fires only on the non-chart-mediated path (manual Job manifest, future
 * non-chart deploy). Defense-in-depth — silent fall-through is the
 * smoking-gun shape the audit found at the operator side.
 */
export function parseContextSafetyThreshold(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(
      `[kagent-agent-pod] KAGENT_CONTEXT_SAFETY_THRESHOLD='${raw}' is not a finite number; ` +
        `falling back to executor default (0.95). The legal range is (0, 1]. ` +
        `If you set this via the operator Helm chart, the chart-render guard should have rejected it; ` +
        `check for a manual env override on the Job manifest.`,
    );
    return undefined;
  }
  if (n <= 0 || n > 1) {
    console.warn(
      `[kagent-agent-pod] KAGENT_CONTEXT_SAFETY_THRESHOLD=${n} is outside the legal range (0, 1]; ` +
        `falling back to executor default (0.95). Values <=0 or >1 silently disable the ` +
        `substrate's context-window safety-net — the chart-render guard normally rejects these.`,
    );
    return undefined;
  }
  return n;
}
