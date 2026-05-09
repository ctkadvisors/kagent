/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * proposals-counter — Phase 1 / DISP-02 → DISP-03 bridge. The
 * operator's cap-issuer narrowing step calls `incrementProposalsToday`
 * when a proposal-claim mint succeeds for an Agent with a disposition
 * overlay. The function PATCHes the disposition ConfigMap's
 * annotations:
 *
 *   kagent.knuteson.io/proposals-today      ← incremented integer (string)
 *   kagent.knuteson.io/proposals-today-day  ← current UTC day (YYYY-MM-DD)
 *
 * The annotation IS the single source of truth that workbench-api's
 * dispositions projection (plan 03) READs to compute `proposalsToday` —
 * workbench-api never writes this annotation.
 *
 * Daily rollover semantics: if the existing day annotation mismatches
 * today's UTC day, the increment STARTS at 1 (the previous day's
 * count is implicitly reset).
 *
 * No new persistence primitive: ConfigMap annotations are an existing
 * Kubernetes primitive; the configmaps:patch RBAC was granted in
 * plan 01 task 3.
 *
 * Concurrency safety: parallel mints for the same Agent race on the
 * annotation write. The helper uses optimistic-concurrency via
 * JSON-Patch `test`+`replace` on `metadata.resourceVersion`; on HTTP
 * 409 conflict it re-reads and retries up to 3 times. Counter
 * exactness is sacrificed for system progress (counter is best-effort
 * observation, not a security gate) — after 3 conflicts the helper
 * logs a warning and returns void.
 */

import type { CoreV1Api } from '@kubernetes/client-node';

import {
  DISPOSITION_PROPOSALS_TODAY_ANNOTATION,
  DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION,
  type DispositionOverlay,
} from '@kagent/dto';

/** Maximum number of optimistic-concurrency retries before giving up. */
const PROPOSALS_TODAY_MAX_RETRIES = 3;

/**
 * Pure helper. No I/O. Tested independently. Computes the next
 * `(value, day)` annotation pair given the currently-observed values
 * and today's UTC day.
 *
 * Rules:
 *   - If `currentDay === todayDay` AND `currentValue` parses to a
 *     non-negative integer, increment that integer by 1.
 *   - Otherwise (day mismatch, missing, malformed) baseline is 0 and
 *     the next value is 1.
 *   - Day annotation is always overwritten with `todayDay` so a
 *     missed-rollover write self-corrects on the next increment.
 */
export function computeNextProposalsTodayPatch(args: {
  readonly currentValue: string | undefined;
  readonly currentDay: string | undefined;
  readonly todayDay: string;
}): { readonly nextValue: string; readonly nextDay: string } {
  const dayMatches = args.currentDay !== undefined && args.currentDay === args.todayDay;
  const parsed =
    args.currentValue !== undefined && args.currentValue !== ''
      ? Math.floor(Number(args.currentValue))
      : NaN;
  const baseline = dayMatches && Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  return { nextValue: String(baseline + 1), nextDay: args.todayDay };
}

/** Format `now` as `YYYY-MM-DD` UTC. */
export function formatUtcDay(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build the JSON-Patch (RFC 6902) payload that increments the
 * proposals-today annotation atomically against the captured
 * `resourceVersion`. Annotation keys use `~1` to escape `/` per
 * JSON-Pointer (RFC 6901).
 *
 * Returned as `unknown` so callers can hand it to
 * `patchNamespacedConfigMap` (which expects `body: any`) without an
 * `as any` cast at the call site. The structure is verified by tests.
 */
export function buildProposalsTodayPatchBody(args: {
  readonly resourceVersion: string;
  readonly nextValue: string;
  readonly nextDay: string;
}): unknown {
  return [
    { op: 'test', path: '/metadata/resourceVersion', value: args.resourceVersion },
    {
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today',
      value: args.nextValue,
    },
    {
      op: 'replace',
      path: '/metadata/annotations/kagent.knuteson.io~1proposals-today-day',
      value: args.nextDay,
    },
  ];
}

/**
 * Detect HTTP 409 Conflict from `@kubernetes/client-node` v1.x error
 * shape. The client surfaces status via `err.code`, `err.statusCode`,
 * or `err.response.statusCode` depending on the failure layer.
 */
function isConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    statusCode?: unknown;
    response?: { statusCode?: unknown };
  };
  const status =
    typeof e.response === 'object' && e.response !== null ? e.response.statusCode : undefined;
  return e.code === 409 || e.statusCode === 409 || status === 409;
}

/**
 * Subset of the K8s CoreV1Api surface we need. Eases mocking in tests
 * (no need to construct a full CoreV1Api stub).
 */
export type ProposalsCounterCoreApi = Pick<
  CoreV1Api,
  'patchNamespacedConfigMap' | 'readNamespacedConfigMap'
>;

export interface ProposalsCounterLogger {
  warn(message: string): void;
  info?(message: string): void;
}

const defaultLogger: Required<ProposalsCounterLogger> = {
  warn: (m: string) => {
    console.warn(m);
  },
  info: (m: string) => {
    console.debug(m);
  },
};

/**
 * Increment the `kagent.knuteson.io/proposals-today` annotation on
 * the disposition ConfigMap by 1, writing today's UTC day into
 * `kagent.knuteson.io/proposals-today-day`. Best-effort: this helper
 * never throws — patch failures are caught and logged. Mint
 * reliability outweighs counter exactness.
 *
 * Optimistic-concurrency CAS loop: capture `metadata.resourceVersion`
 * on read; issue a JSON-Patch `test`+`replace`; on 409 conflict
 * re-read and retry up to 3 times before logging warn-and-returning.
 */
export async function incrementProposalsToday(args: {
  readonly coreApi: ProposalsCounterCoreApi;
  readonly overlay: DispositionOverlay;
  readonly now: Date;
  readonly logger?: ProposalsCounterLogger;
}): Promise<void> {
  const log = args.logger ?? defaultLogger;
  const todayDay = formatUtcDay(args.now);

  for (let attempt = 0; attempt <= PROPOSALS_TODAY_MAX_RETRIES; attempt++) {
    try {
      const cm = await args.coreApi.readNamespacedConfigMap({
        name: args.overlay.configMapName,
        namespace: args.overlay.configMapNamespace,
      });
      const annotations = cm.metadata?.annotations ?? {};
      const resourceVersion = cm.metadata?.resourceVersion;
      if (typeof resourceVersion !== 'string' || resourceVersion === '') {
        log.warn(
          `proposals-counter: missing resourceVersion for ${args.overlay.agentRef}; skipping CAS`,
        );
        return;
      }
      const next = computeNextProposalsTodayPatch({
        currentValue: annotations[DISPOSITION_PROPOSALS_TODAY_ANNOTATION],
        currentDay: annotations[DISPOSITION_PROPOSALS_TODAY_DAY_ANNOTATION],
        todayDay,
      });
      const body = buildProposalsTodayPatchBody({
        resourceVersion,
        nextValue: next.nextValue,
        nextDay: next.nextDay,
      });
      // The @kubernetes/client-node v1.x default Content-Type for
      // `patchNamespacedConfigMap` is `application/json-patch+json`
      // (RFC 6902, expects an array of ops) — exactly what we send.
      // No header override needed; see job-annotator.ts for the
      // merge-patch override pattern when the CT needs flipping.
      await args.coreApi.patchNamespacedConfigMap({
        name: args.overlay.configMapName,
        namespace: args.overlay.configMapNamespace,
        body,
      });
      return; // success
    } catch (err) {
      if (isConflict(err) && attempt < PROPOSALS_TODAY_MAX_RETRIES) {
        log.info?.(
          `proposals-counter: 409 conflict for ${args.overlay.agentRef} attempt=${String(attempt + 1)}; retrying`,
        );
        continue;
      }
      if (isConflict(err)) {
        log.warn(
          `proposals-counter: gave up after ${String(PROPOSALS_TODAY_MAX_RETRIES)} conflicts for ${args.overlay.agentRef}`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`proposals-counter: increment failed for ${args.overlay.agentRef}: ${message}`);
      return;
    }
  }
}
