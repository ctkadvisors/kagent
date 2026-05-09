/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * disposition-parser — Phase 1 / DISP-01.
 *
 * Single source of truth for the AgentDisposition overlay shape and
 * its parser. Used by:
 *   - @kagent/operator cap-issuer narrowing (DISP-02, plan 02)
 *   - @kagent/operator overlay-loader (DISP-01 helpers)
 *   - @kagent/workbench-api dispositions projection (DISP-03, plan 03)
 *   - @kagent/workbench-ui DispositionOverlay component (DISP-04, plan 04 — type-only)
 *
 * Why @kagent/dto: parser/validator pairs are DTO concerns; both
 * @kagent/operator and @kagent/workbench-api already depend on
 * @kagent/dto, so this avoids a new cross-package import edge.
 *
 * The overlay carrier is a sibling Kubernetes ConfigMap referenced
 * to its Agent by an annotation; the parser is fail-closed (V5 input
 * validation per CONTEXT.md "Security Domain") — every malformed
 * input returns `{ ok: false, error }` rather than throwing, so
 * callers can degrade to "no overlay" semantics safely.
 *
 * The overlay narrows; it never widens (D6, self-proposal):
 * mayProposeAgainst is intersected with the Agent's base claims; a
 * forged ConfigMap cannot grant a wider scope than the Agent's
 * underlying capability-JWT already authorizes.
 */

import type { V1ConfigMap } from '@kubernetes/client-node';
import { parse as parseYaml } from 'yaml';

/**
 * The three Phase-1 proposal categories. Aligned with C-governance-tiers
 * (templates, verifiers, capability-policy). Future kinds require an
 * empirical-signal evidence packet (see PROJECT.md Future Research
 * status flow) — do NOT extend this set without one.
 */
export type ProposalKind = 'templates' | 'verifiers' | 'capability-policy';

export const PROPOSAL_KINDS: readonly ProposalKind[] = Object.freeze([
  'templates',
  'verifiers',
  'capability-policy',
]);

/* Label / annotation constants — these are the canonical wire keys
 * used across the operator, workbench-api, and any Helm chart that
 * ships a disposition seed manifest.
 *
 * NOTE: Do NOT introduce `kagent.knuteson.io/proposals-today-reset-at`.
 * An earlier draft used that name; the canonical day-window key is
 * `kagent.knuteson.io/proposals-today-day` and only that one is
 * permitted. */
export const DISPOSITION_LABEL = 'kagent.knuteson.io/agent-disposition' as const;
export const DISPOSITION_AGENT_REF_ANNOTATION = 'kagent.knuteson.io/agent-ref' as const;
export const DISPOSITION_PROPOSALS_TODAY_ANNOTATION = 'kagent.knuteson.io/proposals-today' as const;
export const DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION =
  'kagent.knuteson.io/proposals-today-day' as const;

/**
 * Parsed disposition overlay. The shape mirrors `C-agent-disposition`
 * from the proto-society design intel — but ATTACHED AS AN OVERLAY,
 * not as a CRD (Phase 1 explicit non-goal).
 */
export interface DispositionOverlay {
  /** "namespace/name" — the Agent this overlay narrows. */
  readonly agentRef: string;
  readonly agentNamespace: string;
  readonly agentName: string;
  /** ConfigMap that carried the overlay. Useful for audit events. */
  readonly configMapName: string;
  readonly configMapNamespace: string;
  readonly idleBehavior: {
    readonly readChannels: readonly string[];
    readonly attentionBudget: {
      readonly tokensPerDay: number;
      readonly pollIntervalSeconds: number;
    };
    readonly proposalScope: {
      readonly mayProposeAgainst: readonly ProposalKind[];
      readonly maxProposalsPerDay: number;
    };
  };
}

export type ParseResult =
  | { readonly ok: true; readonly overlay: DispositionOverlay }
  | { readonly ok: false; readonly error: string };

const AGENT_REF_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * Parses a sibling ConfigMap into a `DispositionOverlay`.
 *
 * Validation rules (V5 input validation; fail closed):
 *   - `metadata.name` and `metadata.namespace` MUST be present
 *   - `metadata.annotations[DISPOSITION_AGENT_REF_ANNOTATION]` MUST exist
 *     and match `<namespace>/<name>` (lowercase + digits + hyphens)
 *   - `data['disposition.yaml']` MUST be a non-empty string parseable
 *     as YAML to a plain object
 *   - `idleBehavior` MUST be a plain object
 *   - `idleBehavior.readChannels` MUST be an array (every entry MUST be a string)
 *   - `idleBehavior.attentionBudget.tokensPerDay` MUST be a positive number
 *   - `idleBehavior.attentionBudget.pollIntervalSeconds` MUST be a positive number
 *   - `idleBehavior.proposalScope.mayProposeAgainst` MUST be an array
 *     of `ProposalKind` strings
 *   - `idleBehavior.proposalScope.maxProposalsPerDay` MUST be a non-negative number
 *
 * Returns `{ ok: false, error }` on every failure mode — including
 * thrown exceptions from the YAML parser. Callers MUST treat
 * `ok=false` as "no overlay; fall back to base Agent claims."
 */
export function parseDispositionConfigMap(cm: V1ConfigMap): ParseResult {
  const meta = cm.metadata;
  if (!meta) return { ok: false, error: 'ConfigMap.metadata is missing' };

  const configMapName = meta.name;
  const configMapNamespace = meta.namespace;
  if (typeof configMapName !== 'string' || configMapName.length === 0) {
    return { ok: false, error: 'ConfigMap.metadata.name is missing' };
  }
  if (typeof configMapNamespace !== 'string' || configMapNamespace.length === 0) {
    return { ok: false, error: 'ConfigMap.metadata.namespace is missing' };
  }

  const annotations = meta.annotations ?? {};
  const agentRef = annotations[DISPOSITION_AGENT_REF_ANNOTATION];
  if (typeof agentRef !== 'string' || agentRef.length === 0) {
    return {
      ok: false,
      error: `annotation ${DISPOSITION_AGENT_REF_ANNOTATION} is missing`,
    };
  }
  if (!AGENT_REF_RE.test(agentRef)) {
    return {
      ok: false,
      error: `annotation ${DISPOSITION_AGENT_REF_ANNOTATION}='${agentRef}' must match <namespace>/<name>`,
    };
  }
  const slashIndex = agentRef.indexOf('/');
  const agentNamespace = agentRef.slice(0, slashIndex);
  const agentName = agentRef.slice(slashIndex + 1);

  const data = cm.data ?? {};
  const yamlText = data['disposition.yaml'];
  if (typeof yamlText !== 'string' || yamlText.length === 0) {
    return { ok: false, error: "data['disposition.yaml'] must be a non-empty string" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `disposition.yaml YAML parse error: ${msg}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'disposition.yaml must parse to an object' };
  }

  const idleBehavior = parsed['idleBehavior'];
  if (!isPlainObject(idleBehavior)) {
    return { ok: false, error: 'idleBehavior must be an object' };
  }

  const readChannelsRaw = idleBehavior['readChannels'];
  if (!Array.isArray(readChannelsRaw)) {
    return { ok: false, error: 'idleBehavior.readChannels must be an array' };
  }
  const readChannels: string[] = [];
  for (let i = 0; i < readChannelsRaw.length; i++) {
    const entry: unknown = readChannelsRaw[i];
    if (typeof entry !== 'string') {
      return {
        ok: false,
        error: `idleBehavior.readChannels[${String(i)}] must be a string`,
      };
    }
    readChannels.push(entry);
  }

  const attentionBudgetRaw = idleBehavior['attentionBudget'];
  if (!isPlainObject(attentionBudgetRaw)) {
    return { ok: false, error: 'idleBehavior.attentionBudget must be an object' };
  }
  const tokensPerDay = attentionBudgetRaw['tokensPerDay'];
  if (typeof tokensPerDay !== 'number' || !Number.isFinite(tokensPerDay) || tokensPerDay <= 0) {
    return {
      ok: false,
      error: 'idleBehavior.attentionBudget.tokensPerDay must be a positive number',
    };
  }
  const pollIntervalSeconds = attentionBudgetRaw['pollIntervalSeconds'];
  if (
    typeof pollIntervalSeconds !== 'number' ||
    !Number.isFinite(pollIntervalSeconds) ||
    pollIntervalSeconds <= 0
  ) {
    return {
      ok: false,
      error: 'idleBehavior.attentionBudget.pollIntervalSeconds must be a positive number',
    };
  }

  const proposalScopeRaw = idleBehavior['proposalScope'];
  if (!isPlainObject(proposalScopeRaw)) {
    return { ok: false, error: 'idleBehavior.proposalScope must be an object' };
  }
  const mayProposeAgainstRaw = proposalScopeRaw['mayProposeAgainst'];
  if (!Array.isArray(mayProposeAgainstRaw)) {
    return {
      ok: false,
      error: 'idleBehavior.proposalScope.mayProposeAgainst must be an array',
    };
  }
  const mayProposeAgainst: ProposalKind[] = [];
  for (let i = 0; i < mayProposeAgainstRaw.length; i++) {
    const entry: unknown = mayProposeAgainstRaw[i];
    if (typeof entry !== 'string' || !isProposalKind(entry)) {
      return {
        ok: false,
        error: `mayProposeAgainst[${String(i)}]: '${String(entry)}' is not a known ProposalKind`,
      };
    }
    mayProposeAgainst.push(entry);
  }
  const maxProposalsPerDay = proposalScopeRaw['maxProposalsPerDay'];
  if (
    typeof maxProposalsPerDay !== 'number' ||
    !Number.isFinite(maxProposalsPerDay) ||
    maxProposalsPerDay < 0
  ) {
    return {
      ok: false,
      error: 'idleBehavior.proposalScope.maxProposalsPerDay must be a non-negative number',
    };
  }

  const overlay: DispositionOverlay = {
    agentRef,
    agentNamespace,
    agentName,
    configMapName,
    configMapNamespace,
    idleBehavior: {
      readChannels: Object.freeze(readChannels),
      attentionBudget: { tokensPerDay, pollIntervalSeconds },
      proposalScope: {
        mayProposeAgainst: Object.freeze(mayProposeAgainst),
        maxProposalsPerDay,
      },
    },
  };
  return { ok: true, overlay };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value);
}
