/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Typed I/O surface — v0.2.0-typed-io (Wave 1 sub-team I/O).
 *
 * Re-exports + small helpers that act on the `Agent.spec.inputs[]` /
 * `Agent.spec.outputs[]` fields declared in `types.ts`. Carved into a
 * sibling module so admission code, the reconciler, and the agent-pod
 * env loader can all reach for the same predicates without dragging in
 * the full CRD type bundle.
 *
 * The Workspace + CAS sub-teams branch from THIS module's `kind` enum —
 * see docs/SUBSTRATE-V1.md §3.1 + §3.5 + WAVES.md §3.4. Workspace
 * consumes `kind: 'workspace'`; CAS consumes `kind: 'artifact'`.
 */

import type { Agent, AgentSpec, InputDecl, OutputDecl } from './types.js';

/**
 * Whether an `InputDecl` is required at AgentTask creation time. Defaults
 * to true — required-by-default, with an explicit `optional: true`
 * opt-out. `required: true` redundancy is allowed (it never overrides
 * `optional: true`).
 *
 * Admission consults this when validating
 * `AgentTask.spec.inputs[].name` covers every required entry on the
 * target Agent's `Agent.spec.inputs[]`.
 */
export function inputIsRequired(decl: InputDecl): boolean {
  if (decl.optional === true) return false;
  if (decl.required === false) return false;
  return true;
}

/**
 * Whether an `OutputDecl` is required at terminal-write time. Defaults
 * to true. The reconciler refuses an agent-pod's `phase=Completed`
 * status patch when any `required` Agent output is absent from
 * `AgentTask.status.outputs[]` — see `validateRequiredOutputsPresent`
 * below + the wiring in `reconcile.ts`.
 */
export function outputIsRequired(decl: OutputDecl): boolean {
  return decl.required !== false;
}

/**
 * The names of every required input on this Agent. Order-preserving
 * (the order callers see is the order the Agent author wrote them in)
 * so admission failure messages list the missing names in a stable
 * order across reconciler ticks.
 */
export function requiredInputNames(agent: Agent | AgentSpec): readonly string[] {
  const spec = 'spec' in agent ? agent.spec : agent;
  const inputs = spec.inputs ?? [];
  const out: string[] = [];
  for (const decl of inputs) {
    if (inputIsRequired(decl)) out.push(decl.name);
  }
  return out;
}

/**
 * The names of every required output on this Agent. Same ordering
 * contract as `requiredInputNames`.
 */
export function requiredOutputNames(agent: Agent | AgentSpec): readonly string[] {
  const spec = 'spec' in agent ? agent.spec : agent;
  const outputs = spec.outputs ?? [];
  const out: string[] = [];
  for (const decl of outputs) {
    if (outputIsRequired(decl)) out.push(decl.name);
  }
  return out;
}

/**
 * Validate the operator-level invariant on `Agent.spec.inputs[]`:
 * every input with `kind: 'workspace' | 'artifact'` MUST declare a
 * `mountPath`. Default-deny — the substrate never picks a path on the
 * agent's behalf (mount-path collisions would be silent + confusing).
 *
 * Returns the names of inputs that violate the invariant. Empty array
 * = valid. Admission reports the violations as
 * `reason: 'InvalidInputs'` with the names listed in the message.
 */
export function inputsMissingMountPath(agent: Agent | AgentSpec): readonly string[] {
  const spec = 'spec' in agent ? agent.spec : agent;
  const inputs = spec.inputs ?? [];
  const out: string[] = [];
  for (const decl of inputs) {
    if (decl.kind === 'scalar') continue;
    if (typeof decl.mountPath !== 'string' || decl.mountPath.length === 0) {
      out.push(decl.name);
    }
  }
  return out;
}
