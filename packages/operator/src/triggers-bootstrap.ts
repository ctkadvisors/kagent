/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Wire-up for the Wave 0 entry-point primitives — KagentSchedule
 * controller + HMAC-signed webhook receiver. Constructed once at
 * operator boot from `main.ts` (additive; does NOT touch the existing
 * env-injection block).
 *
 * Responsibilities:
 *   - Open a watch+informer on `KagentSchedule` CRDs and feed
 *     add/update/delete events into the in-memory schedule cache.
 *   - Create the AgentTask via the operator's `customApi` (cluster-
 *     scoped or namespaced per `KAGENT_WATCH_NAMESPACE`).
 *   - PATCH `KagentSchedule.status.{lastTickAt,nextTickAt}` after each
 *     successful tick.
 *   - Optionally bind the webhook HTTP server (port from env, default
 *     8088) when `KAGENT_TRIGGERS_WEBHOOK_ENABLED=true`.
 *
 * Both routes rely on the Wave 0 placeholder capability annotation
 * (`@kagent/triggers/render-task`); per-trigger caps land in Wave 2.
 *
 * Webhook trigger lookup: in v0.1.16 the receiver looks up its trigger
 * by the URL slug, expecting a matching `KagentSchedule` CR (the
 * schedule body doubles as the AgentTask template) AND a Secret keyed
 * by the trigger id. Future Wave-2 `WebhookTrigger` CRD can replace
 * this without a wire-format break.
 */

import {
  BatchV1Api,
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type ObjectCache,
  makeInformer,
} from '@kubernetes/client-node';

import {
  assessNamespaceIdle,
  buildScheduleController,
  startWebhookReceiver,
  type NamespaceIdleAssessment,
  type TaskView,
  type RenderedAgentTask,
  type ScheduleController,
  type ScheduleStatusPatch,
  type WebhookReceiverDeps,
  type WebhookTrigger,
} from '@kagent/triggers';

import { API_GROUP, API_VERSION, isKagentSchedule, type KagentSchedule } from './crds/index.js';
import { mergePatchOptions } from './k8s.js';

const KAGENT_SCHEDULE_PLURAL = 'kagentschedules';
const AGENT_TASK_PLURAL = 'agenttasks';

/** Default webhook listen port; configurable via env. */
const DEFAULT_WEBHOOK_PORT = 8088;

export interface TriggersBootstrapDeps {
  readonly kc: KubeConfig;
  readonly customApi: CustomObjectsApi;
  /**
   * Single namespace to scope the schedule informer to. Empty string
   * or undefined → cluster-wide.
   */
  readonly watchNamespace?: string | undefined;
  /**
   * Per-trigger HMAC secret resolver. Production: read from a
   * mounted Secret (one key per trigger id). Tests inject a stub.
   */
  readonly resolveTriggerSecret?: (triggerId: string) => string | undefined;
}

export interface TriggersBootstrapHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for diagnostic logging + tests. */
  readonly scheduleController: ScheduleController;
}

/**
 * Build a triggers wiring handle. Caller (main.ts) chooses whether
 * to call .start(); when KAGENT_TRIGGERS_ENABLED is false, main.ts
 * skips this entirely so no informers are opened.
 */
export function buildTriggersBootstrap(deps: TriggersBootstrapDeps): TriggersBootstrapHandle {
  const { kc, customApi, watchNamespace } = deps;
  const env = process.env;

  // ---- Schedule controller ------------------------------------------
  const createAgentTask = async (manifest: RenderedAgentTask): Promise<void> => {
    await customApi.createNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace: manifest.metadata.namespace,
      plural: AGENT_TASK_PLURAL,
      body: manifest,
    });
  };

  const patchScheduleStatus = async (
    namespace: string,
    name: string,
    patch: ScheduleStatusPatch,
  ): Promise<void> => {
    // Merge-patch, like every other status writer in this package: the
    // generated client defaults to a content type the API server answers
    // with 400, so no KagentSchedule ever recorded lastTickAt until now.
    await customApi.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: KAGENT_SCHEDULE_PLURAL,
        name,
        body: { status: patch },
      },
      mergePatchOptions,
    );
  };

  // `whenIdle` schedules ask whether their namespace is idle (triggers/idle.ts):
  // busy only while a live task waits for admission (its Job missing or
  // suspended); a running task is bounded by admission, an abandoned one is
  // ignored, and a schedule never fires while its own previous task is live.
  let batchApi: BatchV1Api | undefined;
  const assessIdle = async (namespace: string): Promise<NamespaceIdleAssessment> => {
    const tasks = (await customApi.listNamespacedCustomObject({
      group: API_GROUP,
      version: API_VERSION,
      namespace,
      plural: AGENT_TASK_PLURAL,
    })) as { items?: readonly TaskView[] };
    batchApi ??= kc.makeApiClient(BatchV1Api);
    const jobs = await batchApi.listNamespacedJob({
      namespace,
      labelSelector: 'kagent.knuteson.io/managed-by=kagent-operator',
    });
    const assessment = assessNamespaceIdle(tasks.items ?? [], jobs.items, new Date());
    if (assessment.abandoned.length > 0) {
      console.warn(
        `[kagent-triggers] ${namespace}: ignoring ${String(assessment.abandoned.length)} abandoned task(s) past their deadline: ${assessment.abandoned.slice(0, 5).join(', ')}`,
      );
    }
    return assessment;
  };

  const scheduleController = buildScheduleController({
    createAgentTask,
    patchScheduleStatus,
    assessIdle,
  });

  // ---- KagentSchedule informer --------------------------------------
  const listFn = async (): Promise<KubernetesListObject<KagentSchedule>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      typeof watchNamespace === 'string' && watchNamespace.length > 0
        ? await customApi.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: watchNamespace,
            plural: KAGENT_SCHEDULE_PLURAL,
          })
        : await customApi.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: KAGENT_SCHEDULE_PLURAL,
          });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<KagentSchedule>;
  };
  const watchPath =
    typeof watchNamespace === 'string' && watchNamespace.length > 0
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/${KAGENT_SCHEDULE_PLURAL}`
      : `/apis/${API_GROUP}/${API_VERSION}/${KAGENT_SCHEDULE_PLURAL}`;
  const informer: Informer<KagentSchedule> & ObjectCache<KagentSchedule> =
    makeInformer<KagentSchedule>(kc, watchPath, listFn);

  const upsertFromCache = (obj: KagentSchedule): void => {
    if (!isKagentSchedule(obj)) return;
    if (obj.metadata.name === undefined || obj.metadata.namespace === undefined) return;
    scheduleController.upsert({
      metadata: {
        name: obj.metadata.name,
        namespace: obj.metadata.namespace,
        ...(obj.metadata.uid !== undefined && { uid: obj.metadata.uid }),
      },
      spec: obj.spec,
      // `whenIdle` measures its gap from the last tick the API recorded.
      ...(obj.status?.lastTickAt !== undefined && {
        status: { lastTickAt: obj.status.lastTickAt },
      }),
    });
  };
  const removeFromCache = (obj: KagentSchedule): void => {
    if (obj.metadata.name === undefined || obj.metadata.namespace === undefined) return;
    scheduleController.remove(obj.metadata.namespace, obj.metadata.name);
  };

  informer.on('add', upsertFromCache);
  informer.on('update', upsertFromCache);
  informer.on('delete', removeFromCache);
  informer.on('error', (err) => {
    console.error('[kagent-triggers] schedule informer error:', err);
    setTimeout(() => {
      void informer.start();
    }, 5000);
  });

  // ---- Webhook receiver ---------------------------------------------
  // Looks up the trigger id against the in-memory schedule cache
  // (informer-backed). Per-trigger HMAC secrets come from
  // `deps.resolveTriggerSecret` — which `main.ts` plumbs from a
  // mounted Secret (one key per trigger id).
  const lookupTrigger = (id: string): WebhookTrigger | undefined => {
    const items = informer.list();
    for (const item of items) {
      if (item.metadata.name === id && item.metadata.namespace !== undefined) {
        const secret = deps.resolveTriggerSecret?.(id);
        if (secret === undefined) return undefined;
        return {
          id,
          namespace: item.metadata.namespace,
          taskTemplate: item.spec.taskTemplate,
          secret,
        };
      }
    }
    return undefined;
  };

  const webhookDeps: WebhookReceiverDeps = {
    lookupTrigger,
    createAgentTask,
  };

  const webhookEnabled = env.KAGENT_TRIGGERS_WEBHOOK_ENABLED === 'true';
  const webhookPort = (() => {
    const raw = env.KAGENT_TRIGGERS_WEBHOOK_PORT;
    if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_WEBHOOK_PORT;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : DEFAULT_WEBHOOK_PORT;
  })();

  let webhookHandle: { close(): Promise<void> } | undefined;

  return {
    scheduleController,

    async start(): Promise<void> {
      await informer.start();
      scheduleController.start();
      if (webhookEnabled) {
        webhookHandle = startWebhookReceiver(webhookPort, webhookDeps);
        console.log(`[kagent-triggers] webhook receiver listening on :${String(webhookPort)}`);
      } else {
        console.log(
          '[kagent-triggers] webhook receiver disabled (set KAGENT_TRIGGERS_WEBHOOK_ENABLED=true to enable)',
        );
      }
    },

    async stop(): Promise<void> {
      scheduleController.stop();
      try {
        await informer.stop();
      } catch (err) {
        console.error('[kagent-triggers] schedule informer stop failed:', err);
      }
      if (webhookHandle !== undefined) {
        try {
          await webhookHandle.close();
        } catch (err) {
          console.error('[kagent-triggers] webhook close failed:', err);
        }
      }
    },
  };
}
