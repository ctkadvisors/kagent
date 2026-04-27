/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `AgentRegistry` — generic, in-memory registry for agent definitions.
 *
 * Consumers parameterize `TType` and `TPhase` with their own string unions
 * at construction; defaults to `string` for unit-test ergonomics.
 *
 * Ported from the source repo's singleton registry (D-03 erasure):
 * no module-level `agentRegistry` export, no static accessor, no
 * constructor-time bootstrap — the loop is neutral. Consumers compose
 * their own singleton in the composition root if they want one.
 *
 * Throws on duplicate `type` by default (D-04); opt into overwrite via
 * `register(def, { replace: true })`. Skill ids are validated unique
 * within each agent definition (D-09).
 *
 * Scoring (D-16): `clamp([0,1], baseConfidence + phaseBonus + 0.05 × matchingSkillCount)`
 * where `phaseBonus` is +0.2 (primary phase), +0.1 (secondary phase),
 * or -0.3 (neither). Determinism (D-18) is guaranteed by `Map` insertion
 * order and the absence of randomness in the formula.
 *
 * Scope filter (D-17): If `def.requiredScope` is non-empty AND `callerScope`
 * is not a superset, the agent is excluded from listing/recommendation
 * (equivalent to score 0). Absent or empty `requiredScope` means no
 * scope requirement.
 */

import type {
  AgentDefinition,
  AgentSkill,
  AgentSuitability,
  AgentRecommendation,
} from './types.js';
import { DuplicateAgentTypeError, DuplicateSkillIdError, UnknownAgentTypeError } from './errors.js';

/**
 * Pure scope-filter predicate. Module-private; exported only for the
 * unit-test file via `it.each` of the 13-row truth table (D-17).
 *
 * Truth table rows:
 *   required=undefined/[] → always PASS (no requirement)
 *   required=non-empty, caller=undefined/[] → FAIL
 *   required=non-empty, caller=non-empty → PASS iff required ⊆ caller
 */
function passesScopeFilter(
  requiredScope: readonly string[] | undefined,
  callerScope: readonly string[] | undefined,
): boolean {
  if (!requiredScope || requiredScope.length === 0) return true;
  if (!callerScope || callerScope.length === 0) return false;
  const caller = new Set(callerScope);
  return requiredScope.every((req) => caller.has(req));
}

export class AgentRegistry<TType extends string = string, TPhase extends string = string> {
  private readonly defs = new Map<TType, AgentDefinition<TType, TPhase>>();

  /**
   * Register an agent definition. Throws `DuplicateAgentTypeError` if
   * `def.type` is already registered (opt out with `{ replace: true }`).
   * Throws `DuplicateSkillIdError` if two entries in `def.skills` share
   * an `id`.
   */
  register(def: AgentDefinition<TType, TPhase>, options?: { replace?: boolean }): void {
    if (this.defs.has(def.type) && options?.replace !== true) {
      throw new DuplicateAgentTypeError(def.type);
    }
    const seen = new Set<string>();
    for (const skill of def.skills) {
      if (seen.has(skill.id)) {
        throw new DuplicateSkillIdError(def.type, skill.id);
      }
      seen.add(skill.id);
    }
    this.defs.set(def.type, def);
  }

  /** Look up an agent by type. Returns undefined for unregistered types. */
  getAgent(type: TType): AgentDefinition<TType, TPhase> | undefined {
    return this.defs.get(type);
  }

  /**
   * Return every registered definition in registration order.
   * Array is a fresh copy; mutating it does not affect the registry.
   */
  getAll(): AgentDefinition<TType, TPhase>[] {
    return Array.from(this.defs.values());
  }

  /**
   * Return the subset of an agent's skills whose `.phases` includes the
   * target phase. Returns `[]` for an unregistered type (parallels
   * Array.filter semantics; fail-fast is reserved for register-time
   * validation).
   */
  getSkillsForPhase(type: TType, phase: TPhase): AgentSkill<TPhase>[] {
    const agent = this.defs.get(type);
    if (!agent) return [];
    return agent.skills.filter((s) => s.phases.includes(phase));
  }

  /**
   * Compute suitability score for an agent against a phase.
   * Applies the D-17 scope filter first: if the agent's `requiredScope`
   * is not a subset of `toolScope`, returns 0.
   *
   * Formula (D-16): clamp([0,1], baseConfidence + phaseBonus + 0.05 × matchingSkillCount)
   *   phaseBonus = +0.2 if primaryPhases includes phase
   *              = +0.1 if secondaryPhases includes phase
   *              = -0.3 otherwise
   */
  calculateSuitabilityScore(type: TType, phase: TPhase, toolScope?: readonly string[]): number {
    const agent = this.defs.get(type);
    if (!agent) return 0;
    if (!passesScopeFilter(agent.requiredScope, toolScope)) return 0;

    let score = agent.baseConfidence;
    if (agent.primaryPhases.includes(phase)) {
      score += 0.2;
    } else if (agent.secondaryPhases.includes(phase)) {
      score += 0.1;
    } else {
      score -= 0.3;
    }

    const matchingSkills = this.getSkillsForPhase(type, phase);
    score += matchingSkills.length * 0.05;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Return every registered agent ranked by suitability score (descending)
   * against the given phase. Agents excluded by the scope filter are
   * dropped from the result (NOT included with score 0). Ties are broken
   * by registration (insertion) order — see D-18.
   */
  listSuitable(phase: TPhase, toolScope?: readonly string[]): AgentSuitability<TType, TPhase>[] {
    const rows: AgentSuitability<TType, TPhase>[] = [];
    for (const agent of this.defs.values()) {
      if (!passesScopeFilter(agent.requiredScope, toolScope)) continue;
      const score = this.calculateSuitabilityScore(agent.type, phase, toolScope);
      rows.push({ agent, score });
    }
    // Stable sort: Array.prototype.sort is stable in ES2019+ (all Node 22).
    // Insertion order is preserved for ties (D-18).
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  /**
   * Return a structured recommendation: top-scored agent plus up to
   * three runners-up. Throws `UnknownAgentTypeError('<no suitable agent>')`
   * if no agent remains after scope filtering (registry empty, or every
   * agent excluded).
   */
  recommendAgent(phase: TPhase, toolScope?: readonly string[]): AgentRecommendation<TType> {
    const ranked = this.listSuitable(phase, toolScope);
    const top = ranked[0];
    if (!top) {
      throw new UnknownAgentTypeError('<no suitable agent>');
    }
    const alternatives = ranked.slice(1, 4).map((row) => ({
      agentType: row.agent.type,
      agentName: row.agent.name,
      confidence: row.score,
    }));

    const topSkills = this.getSkillsForPhase(top.agent.type, phase);
    const skillNames = topSkills.map((s) => s.name).join(', ');

    return {
      agentType: top.agent.type,
      agentName: top.agent.name,
      confidence: top.score,
      reasoning: `Top match for phase "${phase}" with skills: ${skillNames}`,
      alternatives,
    };
  }
}
