/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workbench Gateway page surface — `/api/gateway/*` and the
 * ModelEndpoint mutation routes.
 *
 *   GET  /api/gateway/capacity         — live AIMD state per (model, backend)
 *   GET  /api/gateway/usage            — recent gateway requests (last N)
 *   PATCH /api/modelendpoints/:ns/:name — tune `spec.inFlight.{seed,max,minSafe}`
 *
 * Authoritative data flow:
 *
 *   Workbench-UI  ──GET──▶  workbench-api ──/admin/capacity──▶  llm-gateway
 *                                                                       │
 *                                                                       └──▶ ModelEndpoint CR
 *                                                                            (informer cache)
 *
 *   Workbench-UI  ──PATCH─▶  workbench-api ──K8s API──▶  ModelEndpoint CR
 *                                                                  │
 *                                                                  └──▶ llm-gateway informer
 *                                                                       picks up new bounds
 *
 * The PATCH path goes via the K8s API (not via the gateway) so the
 * cluster's source-of-truth invariant holds: every config change still
 * passes through the API server, which means Argo's reconciler will
 * eventually see the drift if the homelab operator wants to converge
 * back to git. The gateway's `/admin/*` surface stays read-only by
 * design.
 */

import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';
import { Hono } from 'hono';

import type {
  GatewayClient,
  GatewayCapacityRow,
  GatewayProviderDispatchState,
  GatewayUsageRow,
} from '../gateway-client.js';

/**
 * `@kubernetes/client-node` v1.x's generated `patchNamespacedCustomObject`
 * defaults to `Content-Type: application/json-patch+json` (RFC 6902 ops
 * array). Our PATCH body is a merge-shaped object (`{spec:{inFlight:...}}`)
 * so K8s rejects it with `error decoding patch: cannot unmarshal object
 * into []handlers.jsonPatchOp`. Override the header per-call to switch
 * to RFC 7396 merge-patch semantics — same idiom job-annotator.ts uses
 * elsewhere in the operator codebase.
 */
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');

/**
 * Capacity row enriched with the CR's `metadata.{name,namespace}`.
 * Without this the UI can't reliably target the right CR for PATCH —
 * the gateway's response only carries `(model, backendUrl)` and CR
 * names don't follow a stable convention (homelab has
 * `nemotron-jetson` for model `nemotron-3-nano:4b`).
 */
export interface EnrichedCapacityRow extends GatewayCapacityRow {
  /** When the join finds no matching CR (gateway-only state), undefined. */
  readonly crName?: string;
  /** Same — undefined when no CR match. */
  readonly crNamespace?: string;
}

export interface GatewayRouteDeps {
  /** When omitted, the gateway capacity/usage routes 503. */
  readonly gatewayClient?: GatewayClient;
  /**
   * Always-on K8s client for ModelEndpoint reads (the capacity-row
   * → CR-name join). When omitted, the capacity response falls back
   * to gateway-only data without `crName`/`crNamespace` fields.
   */
  readonly customApi?: CustomObjectsApi;
  /**
   * When false (default), the PATCH /api/modelendpoints/* route
   * 503s — mirrors WORKBENCH_ACTIONS_ENABLED for POST /api/tasks.
   * Reads via customApi remain enabled either way.
   */
  readonly writesEnabled?: boolean;
  /**
   * NEW-L1 — TTL (ms) for the cached cluster-wide ModelEndpoint
   * listing. Default 5000 (matches M14's node-list TTL). Set to `0`
   * in tests to disable caching.
   */
  readonly modelEndpointIndexTtlMs?: number;
  /**
   * NEW-M1 — when set, PATCH /api/modelendpoints/:ns/:name rejects
   * requests with a `:ns` other than this value. Combined with the
   * H17 namespaced Role+RoleBinding, the workbench can only mutate
   * ModelEndpoints in its own release namespace. Empty / undefined =
   * no extra check (back-compat for harnesses that don't thread the
   * release namespace through).
   */
  readonly defaultNamespace?: string;
  /** Test-only clock override (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * NEW-L1 — TTL-cached loader. Mirrors `cluster.ts`'s `ttlCachedLoader`
 * shape but kept module-local so the two routes don't grow a shared
 * helper module just for one cache. Coalesces concurrent misses.
 */
function ttlCachedLoader<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number,
): () => Promise<T> {
  let cachedAt = 0;
  let cached: T | undefined;
  let inFlight: Promise<T> | null = null;
  return async function load_(): Promise<T> {
    const t = now();
    if (cached !== undefined && t - cachedAt < ttlMs) return cached;
    if (inFlight !== null) return inFlight;
    inFlight = load()
      .then((v) => {
        cached = v;
        cachedAt = now();
        return v;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const MODEL_ENDPOINT_PLURAL = 'modelendpoints';

/** Bounds we accept on PATCH — mirrors ModelEndpoint CRD validation.
 *
 * `MIN_SAFE_MIN` is 1 (NOT 0) — a `minSafe: 0` would let the AIMD
 * controller halve the cap to zero on a single error and never recover
 * (ceiling(0/2) === 0; additive increase from 0 is one-per-clean-window
 * which is fine but the multiplicative-decrease floor stays at 0
 * indefinitely, permanently throttling the (model, backend) pair). See
 * audit B5 — a PATCH with `minSafe: 0` is a one-shot DoS for the lifetime
 * of the gateway Pod. The model-watch path applies the same floor at
 * CR-watch time so a hand-edited CR with `spec.minSafe: 0` is also
 * clamped before reaching `aimd.updateBounds`. */
const SEED_MIN = 1;
const SEED_MAX = 256;
const MAX_MIN = 1;
const MAX_MAX = 1024;
const MIN_SAFE_MIN = 1;
const MIN_SAFE_MAX = 256;

interface CapacityResponse {
  readonly rows: readonly EnrichedCapacityRow[];
  readonly fetchedAt: string;
}

/**
 * Pull the `metadata.{name,namespace}` for every ModelEndpoint CR
 * cluster-wide. Failure → returns an empty index; the capacity handler
 * still serves gateway-only rows and the UI degrades gracefully.
 *
 * Index key is `<model>@@<backendUrl>` to match the gateway's identity
 * for a (model, endpoint) pair. Two CRs with the same (model, url) is
 * a misconfiguration; we keep the first observation and ignore later
 * duplicates.
 */
async function buildModelEndpointIndex(
  customApi: CustomObjectsApi,
): Promise<Map<string, { name: string; namespace: string }>> {
  const index = new Map<string, { name: string; namespace: string }>();
  try {
    const list = (await customApi.listClusterCustomObject({
      group: KAGENT_GROUP,
      version: KAGENT_VERSION,
      plural: MODEL_ENDPOINT_PLURAL,
    })) as {
      items?: ReadonlyArray<{
        metadata?: { name?: string; namespace?: string };
        spec?: { model?: string; backendUrl?: string };
      }>;
    };
    for (const item of list.items ?? []) {
      const model = item.spec?.model;
      const url = item.spec?.backendUrl;
      const name = item.metadata?.name;
      const namespace = item.metadata?.namespace;
      if (
        typeof model === 'string' &&
        typeof url === 'string' &&
        typeof name === 'string' &&
        typeof namespace === 'string'
      ) {
        const key = `${model}@@${url}`;
        if (!index.has(key)) index.set(key, { name, namespace });
      }
    }
  } catch (err) {
    console.warn('[workbench-api] ModelEndpoint list failed; capacity rows will lack crName:', err);
  }
  return index;
}

function enrichCapacityRows(
  rows: readonly GatewayCapacityRow[],
  index: Map<string, { name: string; namespace: string }>,
): readonly EnrichedCapacityRow[] {
  return rows.map((row) => {
    const match = index.get(`${row.model}@@${row.endpoint}`);
    if (match === undefined) return row;
    return { ...row, crName: match.name, crNamespace: match.namespace };
  });
}

interface UsageResponse {
  readonly rows: readonly GatewayUsageRow[];
  readonly fetchedAt: string;
}

function parseProviderDispatchPatchBody(raw: unknown): { readonly disabled: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('body must be a JSON object');
  }
  const disabled = (raw as Record<string, unknown>).disabled;
  if (typeof disabled !== 'boolean') {
    throw new Error('disabled must be a boolean');
  }
  return { disabled };
}

interface PatchInFlightBody {
  readonly seed?: number;
  readonly max?: number;
  readonly minSafe?: number;
}

/**
 * Validate the PATCH body. Throws `Error` with a user-meaningful
 * message on bad input — server.ts treats these as 400.
 */
export function parsePatchInFlightBody(raw: unknown): PatchInFlightBody {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof PatchInFlightBody]: PatchInFlightBody[K] } = {};
  if (obj.seed !== undefined) {
    if (
      !Number.isInteger(obj.seed) ||
      (obj.seed as number) < SEED_MIN ||
      (obj.seed as number) > SEED_MAX
    ) {
      throw new Error(`seed must be integer in [${String(SEED_MIN)},${String(SEED_MAX)}]`);
    }
    out.seed = obj.seed as number;
  }
  if (obj.max !== undefined) {
    if (
      !Number.isInteger(obj.max) ||
      (obj.max as number) < MAX_MIN ||
      (obj.max as number) > MAX_MAX
    ) {
      throw new Error(`max must be integer in [${String(MAX_MIN)},${String(MAX_MAX)}]`);
    }
    out.max = obj.max as number;
  }
  if (obj.minSafe !== undefined) {
    if (
      !Number.isInteger(obj.minSafe) ||
      (obj.minSafe as number) < MIN_SAFE_MIN ||
      (obj.minSafe as number) > MIN_SAFE_MAX
    ) {
      throw new Error(
        `minSafe must be integer in [${String(MIN_SAFE_MIN)},${String(MIN_SAFE_MAX)}]`,
      );
    }
    out.minSafe = obj.minSafe as number;
  }
  if (out.seed === undefined && out.max === undefined && out.minSafe === undefined) {
    throw new Error('body must specify at least one of: seed, max, minSafe');
  }
  // Cross-field invariant: seed ≤ max (CRD enforces; we mirror so a
  // bad UI form gets a 400 instead of an opaque K8s validation error).
  if (out.seed !== undefined && out.max !== undefined && out.seed > out.max) {
    throw new Error(`seed (${String(out.seed)}) must be ≤ max (${String(out.max)})`);
  }
  return out;
}

/**
 * Build the JSON-Merge-Patch body for the K8s API. Only sets the
 * fields the caller asked for so a partial PATCH (e.g. seed-only)
 * doesn't clobber max/minSafe. Strategic merge patch on a CRD is
 * field-by-field merge by default; merge-patch behaves the same.
 */
export function buildModelEndpointMergePatch(body: PatchInFlightBody): {
  spec: { inFlight: Record<string, number>; minSafe?: number };
} {
  const inFlight: Record<string, number> = {};
  if (body.seed !== undefined) inFlight.seed = body.seed;
  if (body.max !== undefined) inFlight.max = body.max;
  const spec: { inFlight: Record<string, number>; minSafe?: number } = { inFlight };
  if (body.minSafe !== undefined) spec.minSafe = body.minSafe;
  return { spec };
}

export function gatewayRoute(deps: GatewayRouteDeps): Hono {
  const app = new Hono();

  // NEW-L1 — cache the (potentially expensive) cluster-wide
  // `listClusterCustomObject` for ModelEndpoint behind a 5s TTL.
  // Without this every page refresh issued an uncached cluster-wide
  // list against the apiserver. The cache is per-route-instance so
  // tests can construct a fresh instance with a different TTL or 0
  // (cache disabled).
  const TTL_MS = deps.modelEndpointIndexTtlMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const customApi = deps.customApi;
  const loadIndex = (): Promise<Map<string, { name: string; namespace: string }>> => {
    if (customApi === undefined) {
      return Promise.resolve(new Map<string, { name: string; namespace: string }>());
    }
    return buildModelEndpointIndex(customApi);
  };
  const cachedLoadIndex = TTL_MS > 0 ? ttlCachedLoader(loadIndex, TTL_MS, now) : loadIndex;

  app.get('/api/gateway/capacity', async (c) => {
    if (deps.gatewayClient === undefined) {
      return c.json(
        {
          error: 'gateway-client-not-configured',
          message:
            'workbench-api is not wired to a gateway admin endpoint — set gatewayAdmin.* in the chart values',
        },
        503,
      );
    }
    try {
      const rows = await deps.gatewayClient.capacity();
      // Best-effort enrich with CR identity. Failure of the K8s list
      // doesn't fail the response — the UI is still useful with just
      // the gateway-side state. NEW-L1: index is cached at 5s TTL.
      const index = await cachedLoadIndex();
      const enriched = enrichCapacityRows(rows, index);
      const body: CapacityResponse = { rows: enriched, fetchedAt: new Date().toISOString() };
      return c.json(body);
    } catch (err) {
      console.warn('[workbench-api] /api/gateway/capacity error:', err);
      return c.json(
        {
          error: 'gateway-unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.get('/api/gateway/usage', async (c) => {
    if (deps.gatewayClient === undefined) {
      return c.json(
        {
          error: 'gateway-client-not-configured',
        },
        503,
      );
    }
    const url = new URL(c.req.url);
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const model = url.searchParams.get('model') ?? undefined;
    const taskUid = url.searchParams.get('taskUid') ?? undefined;
    const agentName = url.searchParams.get('agentName') ?? undefined;
    try {
      const rows = await deps.gatewayClient.usage({
        ...(limit !== undefined && Number.isFinite(limit) && limit > 0 && { limit }),
        ...(since !== undefined && { since }),
        ...(model !== undefined && { model }),
        ...(taskUid !== undefined && { taskUid }),
        ...(agentName !== undefined && { agentName }),
      });
      const body: UsageResponse = { rows, fetchedAt: new Date().toISOString() };
      return c.json(body);
    } catch (err) {
      console.warn('[workbench-api] /api/gateway/usage error:', err);
      return c.json(
        {
          error: 'gateway-unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.get('/api/gateway/provider-dispatch', async (c) => {
    if (deps.gatewayClient === undefined) {
      return c.json({ error: 'gateway-client-not-configured' }, 503);
    }
    try {
      const state: GatewayProviderDispatchState = await deps.gatewayClient.providerDispatch();
      return c.json(state);
    } catch (err) {
      console.warn('[workbench-api] /api/gateway/provider-dispatch error:', err);
      return c.json(
        {
          error: 'gateway-unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.patch('/api/gateway/provider-dispatch', async (c) => {
    if (deps.gatewayClient === undefined) {
      return c.json({ error: 'gateway-client-not-configured' }, 503);
    }
    if (deps.writesEnabled !== true) {
      return c.json(
        {
          error: 'write-surface-disabled',
          message:
            'workbench-api was started with WORKBENCH_ACTIONS_ENABLED=false — provider dispatch control is unavailable',
        },
        503,
      );
    }
    let parsed: { readonly disabled: boolean };
    try {
      parsed = parseProviderDispatchPatchBody((await c.req.json()) as unknown);
    } catch (err) {
      return c.json(
        {
          error: 'invalid-body',
          message: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }
    try {
      const state: GatewayProviderDispatchState =
        await deps.gatewayClient.setProviderDispatchDisabled(parsed.disabled);
      return c.json(state);
    } catch (err) {
      console.warn('[workbench-api] PATCH /api/gateway/provider-dispatch error:', err);
      return c.json(
        {
          error: 'gateway-unreachable',
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.patch('/api/modelendpoints/:namespace/:name', async (c) => {
    if (deps.writesEnabled !== true || deps.customApi === undefined) {
      return c.json(
        {
          error: 'write-surface-disabled',
          message:
            'workbench-api was started with WORKBENCH_ACTIONS_ENABLED=false — PATCH is unavailable',
        },
        503,
      );
    }
    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
    if (typeof namespace !== 'string' || namespace.length === 0) {
      return c.json({ error: 'invalid-namespace' }, 400);
    }
    if (typeof name !== 'string' || name.length === 0) {
      return c.json({ error: 'invalid-name' }, 400);
    }
    // NEW-M1 — enforce namespace match against the workbench's release
    // namespace. The actions Role+RoleBinding (kagent-workbench chart,
    // post-H17) is already namespace-scoped, so apiserver would reject
    // a cross-namespace PATCH with 403. Enforcing here as well gives
    // the user a clean 403 with a recognizable error shape, AND
    // protects in test/dev contexts where the chart's RBAC isn't
    // applied. Combined with B6 (spoofable X-Forwarded-User), this
    // closes the cross-namespace tuning vector that NEW-M1 surfaced.
    if (
      typeof deps.defaultNamespace === 'string' &&
      deps.defaultNamespace.length > 0 &&
      namespace !== deps.defaultNamespace
    ) {
      return c.json(
        {
          error: 'namespace-not-permitted',
          message: `PATCH limited to the workbench's release namespace (${deps.defaultNamespace}); requested ${namespace}`,
        },
        403,
      );
    }

    let parsedBody: PatchInFlightBody;
    try {
      const raw = (await c.req.json()) as unknown;
      parsedBody = parsePatchInFlightBody(raw);
    } catch (err) {
      return c.json(
        {
          error: 'invalid-body',
          message: err instanceof Error ? err.message : String(err),
        },
        400,
      );
    }

    const mergePatch = buildModelEndpointMergePatch(parsedBody);

    try {
      // Use JSON merge-patch (Content-Type: application/merge-patch+json).
      // Strategic merge patch isn't defined on CRDs in v1, so the K8s
      // client's default MERGE_PATCH path is the right idiom.
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: MODEL_ENDPOINT_PLURAL,
          name,
          body: mergePatch,
        },
        MERGE_PATCH_OPTIONS,
      );
      return c.json({
        ok: true,
        namespace,
        name,
        applied: parsedBody,
      });
    } catch (err) {
      const code =
        (err as { code?: number; statusCode?: number }).code ??
        (err as { code?: number; statusCode?: number }).statusCode ??
        500;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[workbench-api] PATCH /api/modelendpoints/${namespace}/${name} failed code=${String(code)}: ${message}`,
      );
      if (code === 404) {
        return c.json({ error: 'not-found', namespace, name }, 404);
      }
      return c.json(
        {
          error: 'patch-failed',
          message,
        },
        500,
      );
    }
  });

  return app;
}
