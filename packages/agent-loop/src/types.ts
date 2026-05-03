/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Type declarations for `AgentRegistry`.
 *
 * Type-only module — erased at emit time under `verbatimModuleSyntax: true`.
 * Contributes zero runtime bytes to `dist/`.
 *
 * Shape alignment with A2A v1.0 AgentCard is intentional (`skills`, `name`,
 * `description`, `version?`, `tags?`); see `docs/DECISIONS.md` ADR-008 and
 * See docs/HARNESS-LESSONS.md. Transport,
 * AgentCard export, and signed-card verification live in a future
 * `@ctkadvisors/agent-runtime-a2a` package; nothing in this module imports A2A SDKs.
 */

/**
 * Skill definition attached to an agent.
 *
 * A2A AgentSkill-aligned fields: `id`, `name`, `description`, `tags?`.
 * Runtime-native `phases` contributes to scoring (see
 * `AgentRegistry.calculateSuitabilityScore`).
 */
export interface AgentSkill<TPhase extends string = string> {
  /** Stable identifier, unique within an agent definition. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Short prose description. */
  description: string;
  /** Optional A2A-style free-form tags. */
  tags?: readonly string[];
  /** Phases this skill contributes to during scoring. */
  phases: TPhase[];
}

/**
 * Agent definition registered with an `AgentRegistry`.
 *
 * Generic parameters let consumers narrow `TType` and `TPhase` to their
 * own string unions at construction time; defaults to `string` for
 * unit-test ergonomics.
 */
export interface AgentDefinition<TType extends string = string, TPhase extends string = string> {
  // A2A-aligned identity
  /** Consumer-supplied agent-type tag; unique key in the registry. */
  type: TType;
  /** Human-readable agent name. */
  name: string;
  /** Short prose description of agent purpose. */
  description: string;
  /** Optional semver-style version tag. */
  version?: string;
  /** Optional A2A-style free-form tags. */
  tags?: readonly string[];

  // runtime-native scoring inputs
  /** Phases where this agent scores a primary-affinity bonus (+0.2). */
  primaryPhases: TPhase[];
  /** Phases where this agent scores a secondary-affinity bonus (+0.1). */
  secondaryPhases: TPhase[];
  /** Skills attached to this agent. Skill ids must be unique within the array. */
  skills: AgentSkill<TPhase>[];
  /** Baseline confidence score in the range [0, 1]; combined with phase and skill bonuses. */
  baseConfidence: number;

  // forward-compat slots (inert in M1; consumed by later phases)
  /** Optional default model hint (consumed by Phase 3+ executor). */
  defaultModel?: string;
  /** Optional default per-run USD budget cap hint (consumed by future cost-cap enforcement). */
  defaultBudgetUsd?: number;
  /** Optional tool-scope subset required to invoke this agent (filter input for D-17). */
  requiredScope?: readonly string[];
  /** Optional default toolset hint (consumed by Phase 5 tool providers). */
  defaultToolset?: readonly string[];
  /** Optional system prompt (consumed by Phase 3+ executor; the loop ships none). */
  systemPrompt?: string;
  /**
   * Optional LLM request-tuning knobs threaded into every `chat()` call
   * the executor makes for this agent. Maps 1:1 to the matching fields
   * on `ChatRequest` — the executor spreads them in at request-build time.
   * Defined as a forward-compat slot so consumers (kagent operator, etc.)
   * can declare per-agent temperature / max output tokens / stop sequences
   * declaratively. Unset fields fall through to the LLM provider's defaults.
   */
  llmParams?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly stopSequences?: readonly string[];
  };
}

/** Result row from `listSuitable(phase, toolScope?)`. */
export interface AgentSuitability<TType extends string = string, TPhase extends string = string> {
  /** The definition that produced this suitability entry. */
  agent: AgentDefinition<TType, TPhase>;
  /** Suitability score in the range [0, 1]; see `AgentRegistry.calculateSuitabilityScore`. */
  score: number;
}

/** Structured result from `recommendAgent(phase, toolScope?)`. */
export interface AgentRecommendation<TType extends string = string> {
  /** Top-ranked agent's type tag. */
  agentType: TType;
  /** Top-ranked agent's human-readable name. */
  agentName: string;
  /** Top-ranked agent's score in the range [0, 1]. */
  confidence: number;
  /** Human-readable rationale string; vocabulary-free (no phase-word leakage). */
  reasoning: string;
  /** Runner-up agents, ordered by descending score; empty if none. */
  alternatives: ReadonlyArray<{
    agentType: TType;
    agentName: string;
    confidence: number;
  }>;
}
