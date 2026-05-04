/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-K — `spawn_child_task` built-in tool.
 *
 * The agent-pod's existing builtin-tools.ts handles network tools
 * (http_get, rss_fetch, extract_text, write_artifact). This module is
 * a sibling that owns the WS-K substrate primitives — the tools an
 * agent-loop calls to MAKE a substrate-managed call (spawn child),
 * not to make a network/IO call.
 *
 * Tool contract per docs/AGENT-SELF-SERVICE.md §4.3:
 *
 *   spawn_child_task({ agentName, originalUserMessage, runConfig?, payload? })
 *     → { name, namespace, uid }
 *
 * Guardrails (each fails as `policy_denied:` so the LLM sees a
 * structured error, identical to the SSRF-guard pattern in
 * `builtin-tools.ts:assertUrlIsSafe`):
 *
 *   1. agentName !== parent.agentName (single-hop self-cycle reject)
 *   2. fail-closed when both allowedChildAgents and
 *      allowedChildTemplates are empty/unset
 *   3. agentName ∈ parent's Agent.spec.allowedChildAgents OR the
 *      target Agent's `kagent.knuteson.io/from-template` label is
 *      in Agent.spec.allowedChildTemplates (v0.1.3 — admits content-
 *      addressed Agents materialized by ensure_agent_from_template
 *      without enumerating their names)
 *   4. concurrent direct children < parent's maxConcurrentChildren
 *   5. originalUserMessage ≤ 32KB
 *   6. runConfig.timeoutSeconds clamped to remaining parent budget
 *      (prevents child-outlives-parent pathology)
 */

import type { ContentBlock } from '@kagent/agent-loop';
import { defineInProcessTool, InProcessToolProvider } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

import type { AgentSpecEnv } from './env.js';
import { FROM_TEMPLATE_LABEL } from './k8s-task-creator.js';
import type { ChildTaskInput, K8sTaskCreator, ParentIdentity } from './k8s-task-creator.js';

/** 32 KB cap on `originalUserMessage` per AGENT-SELF-SERVICE.md §4.4 #5. */
export const SPAWN_CHILD_MAX_MESSAGE_BYTES = 32_768;

/** Default direct-child concurrency cap when `Agent.spec.maxConcurrentChildren` is unset. */
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 10;

/**
 * v0.1.9 — cluster-level cap on AgentTask spawn-tree depth. Mirrored at
 * the operator's admission path; the in-pod tool fails fast here so the
 * LLM sees a structured `policy_denied:depth_exceeded` long before a
 * Job is created. Helm-overridable via `agentPod.maxDepth` →
 * `KAGENT_AGENT_POD_MAX_DEPTH` on the operator deployment, which then
 * forwards into spawned Jobs as the same env var. main.ts threads the
 * env into `defineSpawnChildTask`'s `maxDepth` opt; tests pass it
 * directly.
 */
export const DEFAULT_AGENT_POD_MAX_DEPTH = 4;

/** Cap on `agentName` length — K8s RFC1123 label is ≤253. */
const MAX_AGENT_NAME_BYTES = 253;

/** Random-suffix alphabet used for child-task names. */
const NAME_ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The set of inputs every `spawn_*` / `wait_*` tool needs at registration
 * time. The runner constructs this once at boot from the parsed
 * `PodConfig` + the in-cluster K8s client; per-call deps come from
 * `ToolInvocationContext` (provided by the executor).
 */
export interface SpawnToolDeps {
  /** Parent task identity — UID/name/namespace from PodConfig. */
  readonly parent: ParentIdentity;
  /** Parent agent's name, for the no-self-spawn guardrail. */
  readonly parentAgentName: string;
  /** Parent agent's spec — for `allowedChildAgents` + `maxConcurrentChildren`. */
  readonly parentAgentSpec: AgentSpecEnv;
  /** K8s client wrapper for create + list-children. */
  readonly k8s: K8sTaskCreator;
  /**
   * Returns the parent task's wall-clock budget in seconds remaining.
   * Used to clamp `runConfig.timeoutSeconds` so children can't outlive
   * the parent's Job activeDeadlineSeconds. Returns `undefined` when
   * the parent has no deadline (rare; smoke-test, dev runs).
   */
  readonly remainingBudgetSeconds?: () => number | undefined;
  /**
   * v0.1.11 — return the parent agent-pod's current W3C traceparent
   * header value (or `undefined` if OTel is not wired). The spawn
   * handler stamps the returned string onto `runConfig.traceparent` of
   * the child AgentTask spec, which the operator's job-spec builder
   * then threads as `OTEL_TRACEPARENT` env on the spawned Job. End
   * effect: the child's trace tree becomes a child of the parent's
   * trace, not a sibling.
   *
   * Production wires this in `main.ts` from `buildTraceparentFromRunId`
   * over the parent's task UID; tests can pass a fixed string or
   * `undefined` to exercise the OTel-disabled branch.
   */
  readonly getTraceparent?: () => string | undefined;
  /** Test-injectable name generator. Production uses crypto-random suffix. */
  readonly generateChildName?: (parentName: string) => string;
  /**
   * v0.1.9 — cluster-level depth cap. When the resulting child depth
   * (`parent.depth + 1`) would exceed this, the spawn refuses with
   * `policy_denied:depth_exceeded`. Defaults to
   * `DEFAULT_AGENT_POD_MAX_DEPTH` (4) when unset. main.ts pipes
   * `KAGENT_AGENT_POD_MAX_DEPTH` env into here at boot.
   */
  readonly maxDepth?: number;
}

interface SpawnArgs {
  readonly agentName: string;
  readonly originalUserMessage: string;
  readonly runConfig?: {
    readonly timeoutSeconds?: number;
  };
  readonly payload?: unknown;
}

/**
 * Build the spawn_child_task tool definition. The ToolProvider returned
 * by `buildSpawnToolProvider` is what the runner stitches into its
 * `ToolProvider[]` alongside `InProcessToolProvider({ id: 'builtin', ...})`.
 */
export function defineSpawnChildTask(deps: SpawnToolDeps): InProcessToolDefinition {
  const generate = deps.generateChildName ?? defaultGenerateChildName;
  const allow = new Set<string>(deps.parentAgentSpec.allowedChildAgents ?? []);
  const allowTemplates = new Set<string>(deps.parentAgentSpec.allowedChildTemplates ?? []);
  const cap = deps.parentAgentSpec.maxConcurrentChildren ?? DEFAULT_MAX_CONCURRENT_CHILDREN;
  // v0.1.9 — cluster-level depth cap. Defensive: clamp non-finite /
  // negative values up to the safe default so a misconfigured
  // KAGENT_AGENT_POD_MAX_DEPTH env can't disable the cap entirely.
  const maxDepth =
    typeof deps.maxDepth === 'number' && Number.isInteger(deps.maxDepth) && deps.maxDepth >= 0
      ? deps.maxDepth
      : DEFAULT_AGENT_POD_MAX_DEPTH;
  const parentDepth =
    typeof deps.parent.depth === 'number' &&
    Number.isInteger(deps.parent.depth) &&
    deps.parent.depth >= 0
      ? deps.parent.depth
      : 0;

  return defineInProcessTool({
    name: 'spawn_child_task',
    description:
      'Create a child AgentTask under the current task. Returns immediately ' +
      'with {name, namespace, uid}. Use wait_for_child_task or ' +
      'wait_for_children_all to block until the child reaches a terminal ' +
      "phase. The agentName must be in this Agent's allowedChildAgents, " +
      'OR the target Agent must carry a `kagent.knuteson.io/from-template` ' +
      "label whose value is in this Agent's allowedChildTemplates (lets you " +
      'spawn dynamically materialized agents from ensure_agent_from_template). ' +
      'Also refuses self-spawn, exceeded concurrent-children cap, or oversize prompts.',
    inputSchema: {
      type: 'object',
      required: ['agentName', 'originalUserMessage'],
      properties: {
        agentName: { type: 'string', minLength: 1, maxLength: MAX_AGENT_NAME_BYTES },
        originalUserMessage: {
          type: 'string',
          minLength: 1,
          maxLength: SPAWN_CHILD_MAX_MESSAGE_BYTES,
        },
        runConfig: {
          type: 'object',
          properties: {
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86_400 },
          },
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Opaque structured data forwarded to the child as AgentTask.spec.payload.',
        },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'task-graph', 'write'],
    handler: async (rawArgs) => {
      const args = parseSpawnArgs(rawArgs);

      // Guardrail 0 — cluster-level depth cap (v0.1.9). The cheapest
      // check: pure arithmetic, no K8s round-trip. Hoisted to the top
      // so a runaway recursion bottoms out fast even when other
      // guardrails would also block. Refusal taxonomy is
      // `policy_denied:depth_exceeded` — exact string matched by the
      // operator's admission path so per-trace observability rolls up.
      if (parentDepth + 1 > maxDepth) {
        throw new Error(
          `policy_denied:depth_exceeded — child would land at depth ${String(parentDepth + 1)} (parent depth=${String(parentDepth)}); cluster cap is ${String(maxDepth)} (KAGENT_AGENT_POD_MAX_DEPTH)`,
        );
      }

      // Guardrail 1 — single-hop self-cycle. Hoisted ABOVE the allow-
      // list check so the error stays specific even when the spec
      // happens to whitelist the parent's own name (or a template
      // that materializes to it). Operator's WS-I covers multi-hop.
      if (args.agentName === deps.parentAgentName) {
        throw new Error(
          `policy_denied: cannot spawn a child against the same agent as the parent ("${args.agentName}") — would create an immediate cycle`,
        );
      }

      // Guardrail 2 — both allowlists empty/unset = fail-closed.
      if (allow.size === 0 && allowTemplates.size === 0) {
        throw new Error(
          `policy_denied: agent "${deps.parentAgentName}" has no allowedChildAgents (set Agent.spec.allowedChildAgents or Agent.spec.allowedChildTemplates in GitOps to permit children)`,
        );
      }

      // Guardrail 3 — name must match either list. Try the cheap
      // exact-match path first (no K8s API call); fall back to the
      // template-label lookup only when the name isn't directly listed
      // and templates are configured.
      if (!allow.has(args.agentName)) {
        let admittedByTemplate = false;
        if (allowTemplates.size > 0) {
          const target = await deps.k8s.getAgentByName(deps.parent.namespace, args.agentName);
          if (target === undefined) {
            const known = describeAllow(allow, allowTemplates);
            throw new Error(
              `policy_denied: agent "${args.agentName}" not found in namespace "${deps.parent.namespace}" (allowed: ${known})`,
            );
          }
          const fromTemplate = target.labels[FROM_TEMPLATE_LABEL];
          if (typeof fromTemplate === 'string' && allowTemplates.has(fromTemplate)) {
            admittedByTemplate = true;
          } else {
            const known = describeAllow(allow, allowTemplates);
            const reason =
              typeof fromTemplate === 'string'
                ? `from-template label "${fromTemplate}" is not in allowedChildTemplates`
                : `target Agent has no "${FROM_TEMPLATE_LABEL}" label and is not in allowedChildAgents`;
            throw new Error(`policy_denied: ${reason} (allowed: ${known})`);
          }
        }
        if (!admittedByTemplate) {
          const known = describeAllow(allow, allowTemplates);
          throw new Error(
            `policy_denied: agent "${args.agentName}" is not in allowedChildAgents (allowed: ${known})`,
          );
        }
      }

      // Guardrail 4 — concurrent-children cap.
      const live = await deps.k8s.listLiveChildren(deps.parent);
      if (live.length >= cap) {
        throw new Error(
          `policy_denied: parent task has ${String(live.length)} non-terminal children, at cap=${String(cap)} (Agent.spec.maxConcurrentChildren); wait for a child to terminate before spawning another`,
        );
      }

      // Guardrail 5 — message size cap (the JSON schema enforces it
      // structurally too, but defensive depth-check).
      if (Buffer.byteLength(args.originalUserMessage, 'utf8') > SPAWN_CHILD_MAX_MESSAGE_BYTES) {
        throw new Error(
          `policy_denied: originalUserMessage exceeds ${String(SPAWN_CHILD_MAX_MESSAGE_BYTES)}-byte cap`,
        );
      }

      // Guardrail 6 — clamp child timeout to remaining parent budget.
      // The local `runConfig` widens to ChildTaskInput's runConfig
      // shape (which includes the v0.1.11 `traceparent`) so the W3C
      // Trace Context stamping below can compose with the args-supplied
      // timeout cleanly.
      let runConfig: ChildTaskInput['runConfig'] = args.runConfig;
      const remaining = deps.remainingBudgetSeconds?.();
      if (
        remaining !== undefined &&
        Number.isFinite(remaining) &&
        runConfig?.timeoutSeconds !== undefined &&
        runConfig.timeoutSeconds > remaining
      ) {
        runConfig = { ...runConfig, timeoutSeconds: Math.max(1, Math.floor(remaining)) };
      }

      // v0.1.11 — W3C Trace Context propagation. Capture the parent
      // agent-pod's current traceparent header (or undefined when OTel
      // isn't wired) and stamp it onto the child spec's runConfig.
      // Operator's job-spec builder picks this up and threads it as
      // OTEL_TRACEPARENT env so the child's OtelTraceSink seeds its
      // root span context with the parent's span — child trace tree
      // becomes a child of the parent's, not a sibling.
      //
      // Empty / undefined returns from getTraceparent are silently
      // treated as "no parent context to propagate" — root tasks (and
      // any spawn from a non-OTel'd pod) just don't carry the field.
      const traceparent = deps.getTraceparent?.();
      if (typeof traceparent === 'string' && traceparent.length > 0) {
        runConfig = { ...(runConfig ?? {}), traceparent };
      }

      const childName = generate(deps.parent.name);
      const created = await deps.k8s.createChildTask(deps.parent, {
        name: childName,
        targetAgent: args.agentName,
        originalUserMessage: args.originalUserMessage,
        ...(runConfig !== undefined && { runConfig }),
        ...(args.payload !== undefined && { payload: args.payload }),
      });

      return jsonContent({
        name: created.name,
        namespace: created.namespace,
        uid: created.uid,
      });
    },
  });
}

/** Bundle the spawn tool (and any future siblings) into one provider. */
export function buildSpawnToolProvider(deps: SpawnToolDeps): InProcessToolProvider {
  return new InProcessToolProvider({
    id: 'kagent-substrate',
    tools: [defineSpawnChildTask(deps)],
  });
}

/** Default child-name generator: `<parentName>-c-<rand6>`. */
export function defaultGenerateChildName(parentName: string): string {
  const buf = new Uint8Array(6);
  globalThis.crypto.getRandomValues(buf);
  let suffix = '';
  for (const b of buf) suffix += NAME_ALPHA[b % NAME_ALPHA.length];
  // Cap parent prefix to leave room for the suffix + separator within
  // the K8s RFC1123 label cap (253). 240 leaves margin even for long
  // names; trim deterministically.
  const prefix = parentName.length > 240 ? parentName.slice(0, 240) : parentName;
  return `${prefix}-c-${suffix}`;
}

/* =====================================================================
 * Type-checked argument extraction
 * ===================================================================== */

function parseSpawnArgs(raw: Record<string, unknown>): SpawnArgs {
  const agentName = raw.agentName;
  if (typeof agentName !== 'string' || agentName.length === 0) {
    throw new Error('spawn_child_task: agentName is required');
  }
  if (agentName.length > MAX_AGENT_NAME_BYTES) {
    throw new Error(`spawn_child_task: agentName exceeds ${String(MAX_AGENT_NAME_BYTES)}-char cap`);
  }
  const originalUserMessage = raw.originalUserMessage;
  if (typeof originalUserMessage !== 'string' || originalUserMessage.length === 0) {
    throw new Error('spawn_child_task: originalUserMessage is required');
  }
  let runConfig: SpawnArgs['runConfig'];
  if (raw.runConfig !== undefined && raw.runConfig !== null) {
    if (typeof raw.runConfig !== 'object' || Array.isArray(raw.runConfig)) {
      throw new Error('spawn_child_task: runConfig must be an object');
    }
    const rc = raw.runConfig as Record<string, unknown>;
    if (rc.timeoutSeconds !== undefined && rc.timeoutSeconds !== null) {
      if (
        typeof rc.timeoutSeconds !== 'number' ||
        !Number.isInteger(rc.timeoutSeconds) ||
        rc.timeoutSeconds < 1 ||
        rc.timeoutSeconds > 86_400
      ) {
        throw new Error(
          'spawn_child_task: runConfig.timeoutSeconds must be an integer in [1, 86400]',
        );
      }
      runConfig = { timeoutSeconds: rc.timeoutSeconds };
    }
  }
  const payload = raw.payload;
  return {
    agentName,
    originalUserMessage,
    ...(runConfig !== undefined && { runConfig }),
    ...(payload !== undefined && { payload }),
  };
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function describeAllow(agents: ReadonlySet<string>, templates: ReadonlySet<string>): string {
  const parts: string[] = [];
  if (agents.size > 0) parts.push(`agents=[${Array.from(agents).sort().join(', ')}]`);
  if (templates.size > 0) parts.push(`templates=[${Array.from(templates).sort().join(', ')}]`);
  return parts.length > 0 ? parts.join('; ') : '(none)';
}

/** Kept for symmetry with `builtin-tools.ts` — re-export the provider class. */
export { InProcessToolProvider };
export type {
  ChildSnapshot,
  ChildTaskCreated,
  ChildTaskInput,
  K8sTaskCreator,
  LiveChildSummary,
  ParentIdentity,
} from './k8s-task-creator.js';
