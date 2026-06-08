/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Composes the per-route Hono apps into a single mountable Hono
 * application. Kept separate from `server.ts` so test harnesses can
 * exercise the route surface against an in-memory cache without
 * booting a Node HTTP server.
 *
 * Auth: header-trust (X-Forwarded-User from Traefik forward-auth). See
 * `auth.ts` — fail-closed by default; only `WORKBENCH_AUTH_REQUIRED=false`
 * disables enforcement. `/healthz` and `/readyz` always bypass the
 * middleware so kubelet probes work regardless of upstream shim health.
 */

import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import type { CoreV1Api } from '@kubernetes/client-node';

import type { AuditEvent } from '@kagent/audit-events';

import { buildAuthMiddleware } from './auth.js';
import type { SnapshotCache } from './cache.js';
import type { GatewayClient } from './gateway-client.js';
import type { SseBroker } from './sse.js';
import { agentsRoute } from './routes/agents.js';
import { architectRoute, type ArchitectLike } from './routes/architect.js';
import { clusterRoute } from './routes/cluster.js';
import { dispositionsRoute } from './routes/dispositions.js';
import { gatewayRoute } from './routes/gateway.js';
import { healthzRoute } from './routes/healthz.js';
import { reviewQueueRoute } from './routes/review-queue.js';
import { streamRoute } from './routes/stream.js';
import { tasksRoute } from './routes/tasks.js';
import { uiProxyRoute } from './routes/ui-proxy.js';

export interface RouterDeps {
  readonly cache: SnapshotCache;
  readonly broker: SseBroker;
  readonly ready: () => boolean;
  /**
   * Loopback URL of the workbench-ui sidecar. When set, non-API
   * routes proxy to it; when omitted, non-API routes 404 (which is
   * the right behavior out-of-cluster + in tests). The chart's
   * deployment.yaml sets `WORKBENCH_UI_UPSTREAM=http://127.0.0.1:8081`.
   */
  readonly uiUpstream?: string;
  /**
   * Test-injectable fetch for the UI proxy. Defaults to global fetch.
   */
  readonly proxyFetch?: typeof fetch;
  /**
   * When true (default), all routes other than `/healthz` and
   * `/readyz` require an `X-Forwarded-User` header. Setting this to
   * false disables enforcement (header still threaded through to
   * handlers when present). Resolve from `WORKBENCH_AUTH_REQUIRED`
   * via `resolveAuthRequired()` in `auth.ts`.
   */
  readonly authRequired?: boolean;
  /**
   * Optional Langfuse base URL (e.g. `https://langfuse.knuteson.io`).
   * When set, the tasks route populates a `traceLink` field on the
   * TaskDetail response so the UI can render a "View trace" deep-link.
   * Trace IDs derive from `traceIdFromRunId` in `@kagent/trace-sinks`
   * (sha256(runId)[0..32]) — the dto's `traceLink()` mapper handles the
   * derivation; this field just supplies the base URL.
   */
  readonly langfuseBaseUrl?: string;
  /**
   * K8s CustomObjects client for the WS-J write surface (POST /api/tasks).
   * When omitted, POST returns 503 — kept opt-in so a chart install with
   * `actions.create=false` is provably write-proof.
   */
  readonly customApi?: CustomObjectsApi;
  /**
   * Default namespace for POST when the request body omits one. Set to
   * the workbench-api's release namespace (typically `kagent-system`).
   */
  readonly defaultNamespace?: string;
  /**
   * Live HTTP client to the kagent LLM gateway's `/admin/*` surface.
   * When omitted, `/api/gateway/capacity` and `/api/gateway/usage`
   * return 503 — same opt-in posture as `customApi` for POST.
   */
  readonly gatewayClient?: GatewayClient;
  /**
   * kagent Studio Architect chat client (gateway-backed). When omitted,
   * `/api/architect/*` is not mounted — same opt-in posture as
   * `gatewayClient`. The write side (`/try`) additionally requires
   * `customApi`; the read/generate side (`/draft`) only needs this.
   */
  readonly architect?: ArchitectLike;
  /** Namespace Studio drafts are instantiated into. Default 'kagent-draft'. */
  readonly draftNamespace?: string;
  /**
   * Always-available read-side K8s client. The Gateway page uses it to
   * enrich capacity rows with the underlying ModelEndpoint CR's
   * `metadata.{name,namespace}`. Distinct from the write-gated
   * `customApi` field — present in any in-cluster boot, omitted in
   * KAGENT_NO_INFORMER mode.
   */
  readonly readCustomApi?: CustomObjectsApi;
  /**
   * Gates the PATCH /api/modelendpoints/* route. Mirrors the
   * `WORKBENCH_ACTIONS_ENABLED` env knob already used for POST
   * /api/tasks. Default false → PATCH 503s.
   */
  readonly writesEnabled?: boolean;
  /**
   * CoreV1 client for the Cluster page's node listing. Reads only;
   * uses the same kubeconfig as the informers. When omitted (test
   * mode / KAGENT_NO_INFORMER), `/api/cluster/*` routes 503.
   */
  readonly coreApi?: CoreV1Api;
  /**
   * Phase 1 / DISP-03 — audit-event publisher for `disposition.*`
   * events. When undefined, the dispositions route still computes
   * the projection but emits no audit events; production wires this
   * to a connected `AuditPublisher` shared with the rest of the
   * substrate audit stream.
   */
  readonly auditPublisher?: { publish(event: AuditEvent): Promise<void> };
  /**
   * Phase 1 / DISP-03 — `/api/dispositions` route options.
   */
  readonly disposition?: {
    /**
     * IANA timezone for the daily counter boundary. Only `'UTC'` is
     * supported in v0.2 — non-UTC values fall back to UTC and log a
     * warning at router-build time. Forward-compat hook for IANA
     * names (e.g. `'America/Chicago'`) once a multi-timezone
     * deployment justifies the implementation.
     */
    readonly dailyBoundaryTimezone?: string;
    /**
     * Namespaces to query for disposition ConfigMaps. When undefined
     * or empty, the route lists cluster-wide via
     * `listConfigMapForAllNamespaces`. Production wires this from
     * `KAGENT_WATCH_NAMESPACES` (comma-separated env var).
     */
    readonly watchNamespaces?: readonly string[];
  };
}

export function buildRouter(deps: RouterDeps): Hono {
  const app = new Hono();

  // Auth middleware — runs FIRST so unauthenticated requests never
  // reach the route handlers. The middleware itself short-circuits on
  // /healthz and /readyz, so probes always pass.
  const authRequired = deps.authRequired ?? true;
  app.use('*', buildAuthMiddleware({ required: authRequired }));

  // Liveness/readiness — mounted at the root. Probes hit the pod
  // port directly (not via Ingress).
  app.route('/', healthzRoute({ cache: deps.cache, ready: deps.ready }));

  // API surface — read-only GETs only in v0.1. Each route owns its
  // own /api/* prefix internally; mounting at '/' here keeps the
  // surface flat for a future SemVer-aware mount move.
  app.route(
    '/',
    tasksRoute({
      cache: deps.cache,
      ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
      ...(deps.customApi !== undefined && { customApi: deps.customApi }),
      ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
    }),
  );
  app.route('/', agentsRoute({ cache: deps.cache }));
  app.route('/', streamRoute({ broker: deps.broker }));
  app.route(
    '/',
    gatewayRoute({
      ...(deps.gatewayClient !== undefined && { gatewayClient: deps.gatewayClient }),
      // Prefer the always-on read client; fall back to the gated
      // customApi for tests / older harnesses that only thread the
      // write-side. Either client can do the read, since
      // listClusterCustomObject doesn't require RBAC for write verbs.
      ...((deps.readCustomApi ?? deps.customApi) !== undefined && {
        customApi: deps.readCustomApi ?? deps.customApi,
      }),
      writesEnabled: deps.writesEnabled === true && deps.customApi !== undefined,
      // NEW-M1 — when set, PATCH /api/modelendpoints/:ns/:name rejects
      // requests whose `:ns` differs from the workbench's release
      // namespace. The chart sets WORKBENCH_DEFAULT_NAMESPACE to
      // .Release.Namespace; main.ts threads it through here.
      ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
    }),
  );
  app.route(
    '/',
    clusterRoute({
      cache: deps.cache,
      ...(deps.coreApi !== undefined && { coreApi: deps.coreApi }),
    }),
  );

  // Phase 1 / DISP-03 — `/api/dispositions` projection. Mounted only
  // when a CoreV1 read client is wired (same posture as
  // `clusterRoute`); the route handles the missing-customApi case
  // internally by returning empty `items` rather than rendering
  // unverified rows.
  if (deps.coreApi !== undefined) {
    // Forward-compat sanity: only 'UTC' is supported in v0.2; emit
    // ONE warning at router build time for non-UTC values so a
    // misconfigured Helm value is visible in workbench-api logs.
    const tz = deps.disposition?.dailyBoundaryTimezone;
    if (typeof tz === 'string' && tz.length > 0 && tz !== 'UTC') {
      console.warn(
        `[workbench-api] disposition.dailyBoundaryTimezone: only UTC is supported in v0.2; got "${tz}" — falling back to UTC`,
      );
    }
    const readCustomForOrphan = deps.readCustomApi ?? deps.customApi;
    app.route(
      '/api/dispositions',
      dispositionsRoute({
        coreApi: deps.coreApi,
        ...(readCustomForOrphan !== undefined && { readCustomApi: readCustomForOrphan }),
        ...(deps.gatewayClient !== undefined && { gatewayClient: deps.gatewayClient }),
        ...(deps.auditPublisher !== undefined && { auditPublisher: deps.auditPublisher }),
        ...(deps.disposition?.watchNamespaces !== undefined &&
          deps.disposition.watchNamespaces.length > 0 && {
            watchNamespaces: deps.disposition.watchNamespaces,
          }),
      }),
    );
  }

  // Phase 4 / REV-01 — `/api/review-queue` projection. Pure-read GET
  // handler; POST stubs registered in the factory (Plan 04-03 W2
  // implements them). No new RouterDeps fields — review-queue consumes
  // cache, customApi, auditPublisher, defaultNamespace, langfuseBaseUrl
  // which are already threaded through existing routes.
  app.route(
    '/api/review-queue',
    reviewQueueRoute({
      cache: deps.cache,
      ...(deps.customApi !== undefined && { customApi: deps.customApi }),
      ...(deps.auditPublisher !== undefined && { auditPublisher: deps.auditPublisher }),
      ...(deps.defaultNamespace !== undefined && { defaultNamespace: deps.defaultNamespace }),
      ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
    }),
  );

  // kagent Studio — `/api/architect/*` (chat-to-create). Mounted only
  // when an Architect chat client is wired (gateway env present). The
  // `/draft` generate path needs only the client; `/try` additionally
  // gates on `customApi` internally (503 when absent). MUST be mounted
  // before the `/api/*` not-found reservation below (first-match-wins).
  if (deps.architect !== undefined) {
    app.route(
      '/api/architect',
      architectRoute({
        architect: deps.architect,
        ...(deps.customApi !== undefined && { customApi: deps.customApi }),
        ...(deps.draftNamespace !== undefined && { draftNamespace: deps.draftNamespace }),
        ...(deps.langfuseBaseUrl !== undefined && { langfuseBaseUrl: deps.langfuseBaseUrl }),
      }),
    );
  }

  // Reserve the API namespace before the SPA proxy catches unmatched
  // GETs. Without this, `/api/typo` can return the UI's index.html
  // with 200 because nginx's SPA fallback handles every unknown path.
  const apiNotFound = (c: import('hono').Context) =>
    c.json({ error: 'not-found', path: c.req.path }, 404);
  app.all('/api', apiNotFound);
  app.all('/api/*', apiNotFound);

  // Sidecar UI proxy — catches every non-API path the routes above
  // didn't claim. Hono's first-match-wins routing means the API
  // routes always take precedence; this proxy fields `/`,
  // `/index.html`, `/assets/*`, etc. In test mode (no upstream
  // configured), keep the JSON 404 so harnesses can still assert
  // miss behavior.
  if (deps.uiUpstream !== undefined && deps.uiUpstream.length > 0) {
    app.route(
      '/',
      uiProxyRoute({
        upstream: deps.uiUpstream,
        ...(deps.proxyFetch !== undefined && { fetch: deps.proxyFetch }),
      }),
    );
  } else {
    // No upstream — keep the JSON 404 so test harnesses can still
    // assert miss behavior, and out-of-cluster CLI tests don't try
    // to fetch a sidecar that doesn't exist.
    app.notFound((c) => c.json({ error: 'not-found', path: c.req.path }, 404));
  }

  return app;
}
