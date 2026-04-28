/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-E — Status authority + monotonic transitions.
 *
 * Two pure helpers callers wire into every `status` write so the
 * AgentTask phase field can never regress and so failure context can
 * accumulate without overwriting the terminal `phase`:
 *
 *   - `nextPhase(current, proposed)` — returns the phase that should
 *     actually be written, or `null` when the proposed transition is
 *     a regression (callers MUST treat `null` as "skip the patch").
 *     Terminal phases (`Completed` / `Failed`) are absorbing: once a
 *     task enters one, only the same terminal phase is allowed
 *     (idempotent re-write OK; cross-terminal transitions blocked).
 *
 *   - `mergeCondition(existing, incoming)` — folds an incoming
 *     condition into the existing list. Same-`type` entries are
 *     replaced in place; `lastTransitionTime` is preserved when
 *     `status` did not change (Kubernetes condition convention). New
 *     types are appended.
 *
 * Both helpers are pure — they touch no clock and no API surface, so
 * the caller passes timestamps explicitly. This keeps the unit tests
 * deterministic and lets the same helpers run from either the
 * operator or (in v0.2) a future agent-pod-side validator.
 *
 * Why this lives outside `reconcile.ts`: the rules apply to ALL writers
 * of `AgentTask.status` — the dispatch path, the markFailed path, the
 * external failure path, and (by the helpers' shape) the agent-pod's
 * terminal write whenever we lift it into the operator's control plane.
 */

import type { AgentTaskCondition, AgentTaskPhase } from './crds/index.js';

/**
 * Returns the phase that should be written, or `null` if the proposed
 * transition is a regression and must be ignored.
 *
 * Allowed transitions:
 *   - undefined → any phase
 *   - Pending → Pending | Dispatched | Completed | Failed
 *   - Dispatched → Dispatched | Completed | Failed
 *   - Completed → Completed (idempotent re-write OK; everything else
 *     including Failed is BLOCKED)
 *   - Failed → Failed (idempotent re-write OK; everything else
 *     including Completed is BLOCKED)
 *
 * Idempotent same-phase rewrites return the proposed phase (callers
 * may still want to update other status fields on the same patch).
 */
export function nextPhase(
  current: AgentTaskPhase | undefined,
  proposed: AgentTaskPhase,
): AgentTaskPhase | null {
  // No current phase — anything goes.
  if (current === undefined) return proposed;

  // Same phase — idempotent rewrite is always OK.
  if (current === proposed) return proposed;

  // Terminal phases are absorbing. Cross-terminal (Completed → Failed
  // or Failed → Completed) is the canonical regression we're guarding
  // against. Likewise, neither terminal can move back to Pending or
  // Dispatched.
  if (current === 'Completed' || current === 'Failed') return null;

  // Dispatched → Pending is a regression.
  if (current === 'Dispatched' && proposed === 'Pending') return null;

  // Everything else (Pending → *, Dispatched → terminal) is a forward
  // edge.
  return proposed;
}

/**
 * Produce a Conditions-merge for an incoming condition.
 *
 * Behavior:
 *   - If no condition with the same `type` exists, append `incoming`.
 *   - If a condition with the same `type` exists AND its `status` is
 *     unchanged, preserve the existing `lastTransitionTime` (the
 *     transition didn't happen — only the message/reason may have
 *     changed). Other fields take from `incoming`.
 *   - If a condition with the same `type` exists AND its `status`
 *     changed, replace it wholesale with `incoming` (the new
 *     `lastTransitionTime` reflects the transition).
 *
 * Returns a fresh array — never mutates `existing`.
 */
export function mergeCondition(
  existing: readonly AgentTaskCondition[] | undefined,
  incoming: AgentTaskCondition,
): readonly AgentTaskCondition[] {
  const list = existing ?? [];
  const idx = list.findIndex((c) => c.type === incoming.type);
  if (idx === -1) {
    return [...list, incoming];
  }
  const prior = list[idx];
  if (prior === undefined) {
    // unreachable given findIndex contract, but keep TS happy
    return [...list, incoming];
  }
  const merged: AgentTaskCondition =
    prior.status === incoming.status
      ? { ...incoming, lastTransitionTime: prior.lastTransitionTime }
      : { ...incoming };
  const next = [...list];
  next[idx] = merged;
  return next;
}
