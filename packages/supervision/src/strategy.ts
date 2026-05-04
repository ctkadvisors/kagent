/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Pure-functional supervision-strategy engine.
 *
 * `evaluateStrategy(strategy, failure, siblings)` is the single entry
 * point. It is referentially transparent: the same inputs always
 * produce the same `SupervisionDecision`. No K8s, no NATS, no clocks,
 * no hidden state. The operator reconciler is the I/O layer; this is
 * the decision core.
 *
 * `siblings[]` MUST contain the FAILED child as well — the engine
 * filters/positions it during evaluation. Callers that already
 * fetched the sibling list via the
 * `kagent.knuteson.io/parent-task-uid` label selector can pass it
 * straight through; if the list happens not to include the failed
 * child (informer-cache lag), the engine still returns a sensible
 * decision (treating the failed child as appended).
 *
 * Note on cap-claim gating (per WAVES.md §4.2 deliverable 3):
 *   The simplest design is to leave strategy choice ungated — every
 *   Agent freely chooses its own supervision behavior, and the
 *   substrate enforces the resulting actions purely. An adversarial
 *   multi-tenant deployment can opt into a cap-claim allowlist via
 *   `cap.claims.supervisionStrategies: [...]` — `assertStrategyAllowed`
 *   below is the predicate. v0.3.1 ships with the predicate in place
 *   but NOT wired by the operator (the cap-issuer doesn't yet emit
 *   the `supervisionStrategies` claim category). When Wave 4 / Tenancy
 *   lands, the operator can flip on cap-gating without re-shaping the
 *   engine. Documented here so the design choice is explicit.
 */

import type { CapabilityClaims } from '@kagent/capability-types';

import type {
  FailedChild,
  SiblingTask,
  SupervisionDecision,
  SupervisionStrategy,
  TaskRef,
} from './types.js';

/**
 * `Pending | Dispatched` — the in-flight phase set. Terminal
 * (`Completed | Failed`) siblings are not subject to terminate /
 * restart actions; the engine filters them out before targeting.
 */
function isInFlight(s: SiblingTask): boolean {
  return s.phase === 'Pending' || s.phase === 'Dispatched';
}

/**
 * Stable sort by `startedAt` (RFC 3339 ISO timestamps sort
 * lexicographically). Tasks without a `startedAt` fall to the end —
 * `rest_for_one`'s "started after the failed child" semantics treats
 * never-yet-started siblings as logically later.
 *
 * Returns a NEW array; the input is not mutated.
 */
function orderByStart(siblings: readonly SiblingTask[]): SiblingTask[] {
  // Stable sort by startedAt ASC, undefined-last. Preserves
  // input-order for ties (Array.prototype.sort is stable since ES2019
  // node 12+, which we comfortably exceed).
  const indexed = siblings.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const at = a.s.startedAt;
    const bt = b.s.startedAt;
    if (at === undefined && bt === undefined) return a.i - b.i;
    if (at === undefined) return 1;
    if (bt === undefined) return -1;
    if (at === bt) return a.i - b.i;
    return at < bt ? -1 : 1;
  });
  return indexed.map(({ s }) => s);
}

/**
 * Locate the failed child within the sibling list. Returns -1 when
 * absent — the engine still emits a sensible decision in that case
 * (treats the failed child as appended at the end), keeping the
 * informer-cache-lag race fail-soft.
 */
function findFailedIndex(ordered: readonly SiblingTask[], failed: TaskRef): number {
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]?.ref.uid === failed.uid) return i;
  }
  return -1;
}

/**
 * Core entry point. Pure function: given the parent Agent's strategy,
 * the failed child, and the snapshot of all siblings (including the
 * failed child itself), return a `SupervisionDecision` describing the
 * action set the operator must apply.
 *
 * The engine NEVER consults `maxRestarts` directly — that's the
 * operator's concern. After this engine returns `restart`, the
 * operator increments `restartCount` and compares against
 * `Agent.spec.maxRestarts`; if exceeded, the operator overrides the
 * decision and fails the task closed with `reason:
 * restart_limit_exceeded`. Keeping the restart-cap policy out of the
 * engine keeps the engine stateless + lets the operator emit a
 * distinct audit event for the cap-trip case.
 */
export function evaluateStrategy(
  strategy: SupervisionStrategy,
  failure: FailedChild,
  siblings: readonly SiblingTask[],
): SupervisionDecision {
  switch (strategy) {
    case 'one_for_one':
      return decideOneForOne(strategy, failure);
    case 'one_for_all':
      return decideOneForAll(strategy, failure, siblings);
    case 'rest_for_one':
      return decideRestForOne(strategy, failure, siblings);
    case 'escalate':
      return decideEscalate(strategy, failure);
    default: {
      // Defensive: TS makes this unreachable, but a runtime
      // unrecognized strategy degrades to one_for_one (safest default).
      const _exhaustive: never = strategy;
      void _exhaustive;
      return decideOneForOne('one_for_one', failure);
    }
  }
}

function decideOneForOne(strategy: SupervisionStrategy, failure: FailedChild): SupervisionDecision {
  return {
    action: 'restart',
    strategy,
    targets: [failure.ref],
    reason: `one_for_one: restart only the failed child (reason=${failure.reason})`,
  };
}

function decideOneForAll(
  strategy: SupervisionStrategy,
  failure: FailedChild,
  siblings: readonly SiblingTask[],
): SupervisionDecision {
  // Targets: every in-flight sibling + the failed child (the failed
  // child is included even when it appears in the sibling list with a
  // non-terminal phase, since the operator already classified it as
  // failed and we want the full tree-restart set to include it).
  const targets: TaskRef[] = [];
  const seen = new Set<string>();
  for (const s of siblings) {
    if (!isInFlight(s)) continue;
    if (s.ref.uid === failure.ref.uid) continue;
    if (seen.has(s.ref.uid)) continue;
    seen.add(s.ref.uid);
    targets.push(s.ref);
  }
  // Always include the failed child (de-duped). It's the trigger; the
  // operator must restart it as part of the tree.
  if (!seen.has(failure.ref.uid)) {
    targets.push(failure.ref);
  }
  return {
    action: 'terminate-and-restart-tree',
    strategy,
    targets,
    reason: `one_for_all: terminate ${targets.length.toString()} task(s) + restart whole subtree (failed=${failure.ref.uid}, reason=${failure.reason})`,
  };
}

function decideRestForOne(
  strategy: SupervisionStrategy,
  failure: FailedChild,
  siblings: readonly SiblingTask[],
): SupervisionDecision {
  const ordered = orderByStart(siblings);
  const idx = findFailedIndex(ordered, failure.ref);

  // When the failed child is missing from the snapshot (informer lag),
  // we treat it as appended at the end — meaning ALL in-flight
  // siblings before it stay alive, only the failed child restarts.
  // That degrades rest_for_one to one_for_one in this rare race; the
  // alternative (terminate everything) would over-correct.
  if (idx === -1) {
    return {
      action: 'terminate-and-restart-subset',
      strategy,
      targets: [failure.ref],
      reason:
        'rest_for_one: failed child not in sibling snapshot (informer lag); ' +
        `restarting only the failed child (reason=${failure.reason})`,
    };
  }

  // Targets: the failed child + every sibling AT-OR-AFTER it in
  // start-order that is still in-flight. The failed child is always
  // first so the operator's targets[] order is restart-order.
  const targets: TaskRef[] = [failure.ref];
  const seen = new Set<string>([failure.ref.uid]);
  for (let i = idx + 1; i < ordered.length; i++) {
    const s = ordered[i];
    if (s === undefined) continue;
    if (!isInFlight(s)) continue;
    if (seen.has(s.ref.uid)) continue;
    seen.add(s.ref.uid);
    targets.push(s.ref);
  }
  return {
    action: 'terminate-and-restart-subset',
    strategy,
    targets,
    reason: `rest_for_one: terminate failed child + ${(targets.length - 1).toString()} sibling(s) started after it (reason=${failure.reason})`,
  };
}

function decideEscalate(strategy: SupervisionStrategy, failure: FailedChild): SupervisionDecision {
  return {
    action: 'escalate-to-parent',
    strategy,
    targets: [failure.ref],
    reason: `escalate: propagate failure to parent task (reason=${failure.reason})`,
  };
}

/**
 * Optional cap-claim gate (per docs/WAVES.md §4.2 deliverable 3,
 * design-choice docs at the top of this module).
 *
 * Predicate-only — the engine itself never invokes this; the operator
 * may call it BEFORE `evaluateStrategy` if it wants adversarial
 * multi-tenant strategy gating. When the parent's cap claims declare
 * `supervisionStrategies: [allowlist]`, only those entries are
 * permitted. When the claim is absent, every strategy is permitted
 * (back-compat with the simplest design).
 *
 * Returns `null` when the strategy is allowed, or a refusal reason
 * string when denied. The operator surfaces denial as
 * `policy_denied:supervision_strategy_not_permitted` and falls back
 * to the substrate default `one_for_one`.
 */
export function assertStrategyAllowed(
  strategy: SupervisionStrategy,
  claims: CapabilityClaims | undefined,
): string | null {
  if (claims === undefined) return null;
  // The capability-types schema doesn't include `supervisionStrategies`
  // as a first-class category yet. To keep this forward-compatible
  // without a CRD churn, we treat it as an opt-in extension under a
  // typed cast — every consumer that wants strict cap-gating opts in
  // by populating `claims.supervisionStrategies` (and accepting the
  // not-yet-typed nature of the field). When Wave 4 lands, this becomes
  // a real category in `CapabilityClaims`.
  const allowed = (claims as { supervisionStrategies?: readonly string[] }).supervisionStrategies;
  if (allowed === undefined) return null; // not gated → permitted
  if (allowed.includes(strategy)) return null;
  return (
    `strategy '${strategy}' not in cap.claims.supervisionStrategies allowlist ` +
    `[${allowed.join(', ')}]`
  );
}
