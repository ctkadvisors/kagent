/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * GET /api/dispositions — Phase 1 / DISP-03 read projection.
 *
 * Computes per-Agent disposition rows from existing telemetry:
 *   - Spec fields ← sibling ConfigMap labeled
 *     `kagent.knuteson.io/agent-disposition=true` (annotation
 *     `kagent.knuteson.io/agent-ref=<ns>/<name>` ties to Agent).
 *   - spentTokensToday ← sum of (inputTokens + outputTokens) across
 *     GatewayUsageRow filtered by agentName + occurredAt >=
 *     dailyBoundaryUtc.
 *   - proposalsToday ← parseInt of ConfigMap annotation
 *     `kagent.knuteson.io/proposals-today` (operator-written;
 *     defaults to 0; reset to 0 on `proposals-today-day` mismatch).
 *   - postsToday ← always 0 in v0.2 (Posts/Channels are Future
 *     Research).
 *
 * Over-budget emission: when overBudget is true, one
 * `disposition.over_budget` event per reason is emitted PER
 * (agentRef, reason) PER UTC-day. In-process de-dup map
 * (acceptable for v0.2 observation phase per CONTEXT.md research
 * Q11 #5; restart loses state but the observation window is small).
 *
 * NO new persistence primitive — D2.
 * NO NATS consumer in workbench-api — proposalsToday is read from
 *   the operator-written ConfigMap annotation (BLOCKER #2 resolution).
 * NO new CRD / no new reconciler / no new admission webhook.
 *
 * Orphan filter: a ConfigMap whose `kagent.knuteson.io/agent-ref`
 * points at a missing Agent is excluded from `items` so
 * schema-validation seed ConfigMaps and stale overlays never become
 * live Command Center rows.
 */

import { Hono } from 'hono';
import type { CoreV1Api, CustomObjectsApi, V1ConfigMap } from '@kubernetes/client-node';

import {
  DISPOSITION_LABEL,
  DISPOSITION_PROPOSALS_TODAY_ANNOTATION,
  DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION,
  parseDispositionConfigMap,
  type DispositionOverlayRow,
} from '@kagent/dto';
import { makeEvent, type AuditEvent } from '@kagent/audit-events';

import type { GatewayClient } from '../gateway-client.js';

/**
 * Subset of `CoreV1Api` the route uses. Lets tests pass a minimal
 * stub without standing up the whole client.
 */
export type DispositionsCoreApi = Pick<
  CoreV1Api,
  'listConfigMapForAllNamespaces' | 'listNamespacedConfigMap'
>;

/**
 * Subset of `CustomObjectsApi` the route uses to verify Agent
 * existence (orphan-overlay filter).
 */
export type DispositionsCustomApi = Pick<CustomObjectsApi, 'getNamespacedCustomObject'>;

/** Logger surface — production passes `console.warn`. */
export interface DispositionsRouteLogger {
  warn(message: string): void;
}

export interface DispositionsRouteDeps {
  /** Required for the projection to enumerate disposition ConfigMaps. */
  readonly coreApi?: DispositionsCoreApi;
  /**
   * Required to verify Agent existence (orphan-overlay filter). When
   * undefined, the projection returns an empty `items` array rather
   * than rendering unverified rows — schema-validation fixtures and
   * stale overlays must not appear as live Command Center rows.
   */
  readonly readCustomApi?: DispositionsCustomApi;
  /** Optional gateway client; when undefined, `spentTokensToday` is 0 for every row. */
  readonly gatewayClient?: GatewayClient;
  /**
   * Optional audit publisher. When undefined, the projection still
   * computes `overBudget` and `overBudgetReason` but emits no events.
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /** Test-injectable clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Namespaces to query. Defaults to cluster-wide
   * (`listConfigMapForAllNamespaces`). Production wires the chart's
   * `KAGENT_WATCH_NAMESPACES` env var through this field.
   */
  readonly watchNamespaces?: readonly string[];
  /** Optional logger; defaults to `console.warn`. */
  readonly logger?: DispositionsRouteLogger;
  /**
   * In-process de-dup Set; injectable for tests. Keys are
   * `${agentRef}|${reason}|${dailyBoundaryUtc}`. The Set is
   * persisted across requests within a single workbench-api process
   * so consecutive GETs with the same over-budget condition produce
   * exactly one audit event per (agentRef, reason) per UTC-day.
   */
  readonly overBudgetDedup?: Set<string>;
}

/** Group/version for kagent CRDs (Agent existence check). */
const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTS_PLURAL = 'agents';

/**
 * Compute UTC midnight of the given Date as a fresh Date. Pure;
 * the caller is responsible for converting to ISO 8601.
 */
function utcMidnightOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Format `now` as `YYYY-MM-DD` in UTC. Matches the operator-side
 * `formatUtcDay` helper in `proposals-counter.ts`; the day-window
 * annotation is read here and written there — both must agree.
 */
function formatUtcDay(now: Date): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Read + sanitize the proposals-today annotation pair on a
 * ConfigMap. Returns 0 when the annotation is absent, malformed, or
 * the day annotation does not match `todayDay` (rollover).
 *
 * T-03-01 mitigation: parser uses `Number.isFinite` and clamps
 * negative / fractional values to 0.
 */
export function readProposalsTodayAnnotation(cm: V1ConfigMap, todayDay: string): number {
  const annotations = cm.metadata?.annotations ?? {};
  const annDay = annotations[DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION];
  const annValue = annotations[DISPOSITION_PROPOSALS_TODAY_ANNOTATION];
  if (annDay !== todayDay) return 0;
  if (annValue === undefined || annValue === '') return 0;
  const parsed = Number(annValue);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function dispositionsRoute(deps: DispositionsRouteDeps): Hono {
  const app = new Hono();
  const dedup = deps.overBudgetDedup ?? new Set<string>();
  const now = deps.now ?? ((): Date => new Date());
  const logger: DispositionsRouteLogger = deps.logger ?? {
    warn: (m: string): void => {
      console.warn(m);
    },
  };

  app.get('/', async (c) => {
    if (deps.coreApi === undefined) {
      return c.json({ items: [] satisfies DispositionOverlayRow[] });
    }

    const today = now();
    const dailyBoundaryUtc = utcMidnightOf(today).toISOString();
    const todayDay = formatUtcDay(today);

    // List ConfigMaps with the disposition label across watch
    // namespaces (or cluster-wide). The K8s client-node v1.x signature
    // is object-form: { labelSelector } / { namespace, labelSelector }.
    // Returns a V1ConfigMapList directly (no .body envelope).
    const cms: V1ConfigMap[] = [];
    const namespaces = deps.watchNamespaces ?? [];
    const labelSelector = `${DISPOSITION_LABEL}=true`;
    try {
      if (namespaces.length === 0) {
        const list = await deps.coreApi.listConfigMapForAllNamespaces({ labelSelector });
        cms.push(...(list.items ?? []));
      } else {
        for (const ns of namespaces) {
          const list = await deps.coreApi.listNamespacedConfigMap({
            namespace: ns,
            labelSelector,
          });
          cms.push(...(list.items ?? []));
        }
      }
    } catch (err) {
      logger.warn(
        `dispositions: ConfigMap list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // On list failure, fail-soft: return empty items rather than 500.
      return c.json({ items: [] satisfies DispositionOverlayRow[] });
    }

    const items: DispositionOverlayRow[] = [];
    for (const cm of cms) {
      const parsed = parseDispositionConfigMap(cm);
      if (!parsed.ok) {
        logger.warn(
          `dispositions: skipping malformed ConfigMap ${cm.metadata?.namespace ?? '?'}/${
            cm.metadata?.name ?? '?'
          }: ${parsed.error}`,
        );
        continue;
      }
      const overlay = parsed.overlay;

      // Orphan-overlay filter (BLOCKER resolution): the schema-validate
      // seed ConfigMap and stale overlays must NOT render as live
      // Command Center rows. Verify the Agent exists before producing
      // the row.
      const exists = await agentExists(
        deps.readCustomApi,
        overlay.agentNamespace,
        overlay.agentName,
        logger,
      );
      if (!exists) {
        continue;
      }

      // proposalsToday from the operator-written annotation (single
      // source of truth, per RESEARCH.md Q11 + plan 02 narrowing
      // step). Read-only here.
      const proposalsToday = readProposalsTodayAnnotation(cm, todayDay);

      // spentTokensToday from gateway. Sum tokens across all usage
      // rows for this agentName since dailyBoundaryUtc.
      let spentTokensToday = 0;
      if (deps.gatewayClient !== undefined) {
        try {
          const usageRows = await deps.gatewayClient.usage({
            agentName: overlay.agentName,
            since: dailyBoundaryUtc,
            limit: 1000,
          });
          for (const row of usageRows) {
            spentTokensToday += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
          }
        } catch (err) {
          // T-03-02: gateway timeout / unreachable. Log + carry on
          // with spentTokensToday=0 so the row still renders. This
          // mirrors the existing /api/gateway/* posture (degrade
          // gracefully rather than 5xx the read-only endpoint).
          logger.warn(
            `dispositions: gateway usage failed for ${overlay.agentRef}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const tokensExceeded = spentTokensToday > overlay.idleBehavior.attentionBudget.tokensPerDay;
      const proposalsExceeded =
        proposalsToday > overlay.idleBehavior.proposalScope.maxProposalsPerDay;
      const overBudget = tokensExceeded || proposalsExceeded;
      const overBudgetReason: 'tokens_exceeded' | 'proposals_exceeded' | 'both' | undefined =
        tokensExceeded && proposalsExceeded
          ? 'both'
          : tokensExceeded
            ? 'tokens_exceeded'
            : proposalsExceeded
              ? 'proposals_exceeded'
              : undefined;

      // Emit over-budget audit event(s) — exactly once per
      // (agentRef, reason) per UTC-day-window.
      if (overBudget && deps.auditPublisher !== undefined) {
        const reasons: ('tokens_exceeded' | 'proposals_exceeded')[] = [];
        if (tokensExceeded) reasons.push('tokens_exceeded');
        if (proposalsExceeded) reasons.push('proposals_exceeded');
        for (const reason of reasons) {
          const dedupKey = `${overlay.agentRef}|${reason}|${dailyBoundaryUtc}`;
          if (dedup.has(dedupKey)) continue;
          dedup.add(dedupKey);
          try {
            await deps.auditPublisher.publish(
              makeEvent({
                type: 'disposition.over_budget',
                source: 'kagent.knuteson.io/workbench-api',
                subject: `Agent/${overlay.agentNamespace}/${overlay.agentName}`,
                data: {
                  agentRef: overlay.agentRef,
                  agentNamespace: overlay.agentNamespace,
                  agentName: overlay.agentName,
                  dispositionConfigMapName: overlay.configMapName,
                  reason,
                  observed: reason === 'tokens_exceeded' ? spentTokensToday : proposalsToday,
                  budget:
                    reason === 'tokens_exceeded'
                      ? overlay.idleBehavior.attentionBudget.tokensPerDay
                      : overlay.idleBehavior.proposalScope.maxProposalsPerDay,
                  dailyBoundaryUtc,
                },
              }),
            );
          } catch (err) {
            // Do NOT remove from dedup — exactly-once-or-zero is
            // acceptable per CONTEXT.md ("at most once per day per
            // (agent, kind) to avoid log floods"). T-03-06.
            logger.warn(
              `dispositions: over_budget publish failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }

      // overBudgetEventCountToday — count of distinct dedup entries
      // for this agentRef + today's dailyBoundaryUtc. Per ROADMAP
      // success criterion 4 ("budget remaining AND over-budget event
      // count per agent"). Filtering by `${overlay.agentRef}|` prefix
      // AND `|${dailyBoundaryUtc}` suffix keeps the count today-only
      // and agent-only. Bounded by len(reasons) which is currently 2.
      const dedupPrefix = `${overlay.agentRef}|`;
      const dedupSuffix = `|${dailyBoundaryUtc}`;
      let overBudgetEventCountToday = 0;
      for (const k of dedup) {
        if (k.startsWith(dedupPrefix) && k.endsWith(dedupSuffix)) overBudgetEventCountToday += 1;
      }

      items.push({
        agentRef: overlay.agentRef,
        namespace: overlay.agentNamespace,
        agentName: overlay.agentName,
        configMapName: overlay.configMapName,
        idleBehavior: overlay.idleBehavior,
        spentTokensToday,
        postsToday: 0,
        proposalsToday,
        overBudget,
        ...(overBudgetReason !== undefined && { overBudgetReason }),
        overBudgetEventCountToday,
        dailyBoundaryUtc,
      });
    }

    return c.json({ items });
  });

  return app;
}

/**
 * Verify the Agent referenced by the overlay exists. Orphan filter
 * for schema-validation seed ConfigMaps + stale overlays — these
 * MUST NOT render as live Command Center rows.
 *
 * If `readCustomApi` is undefined, returns false (fail-closed: a
 * row whose Agent existence cannot be verified is omitted, rather
 * than rendered unverified).
 */
async function agentExists(
  readCustomApi: DispositionsCustomApi | undefined,
  namespace: string,
  name: string,
  logger: DispositionsRouteLogger,
): Promise<boolean> {
  if (readCustomApi === undefined) {
    logger.warn(
      `dispositions: readCustomApi unavailable; cannot verify Agent existence for ${namespace}/${name}`,
    );
    return false;
  }
  try {
    await readCustomApi.getNamespacedCustomObject({
      group: KAGENT_GROUP,
      version: KAGENT_VERSION,
      namespace,
      plural: AGENTS_PLURAL,
      name,
    });
    return true;
  } catch (err) {
    // 404 is the expected orphan-overlay path; warn at info-level.
    // Other errors (RBAC, network) also produce false and a warning.
    logger.warn(
      `dispositions: skipping orphan overlay for missing Agent ${namespace}/${name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
