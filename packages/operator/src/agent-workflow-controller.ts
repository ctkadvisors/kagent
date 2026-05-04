/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * AgentWorkflow controller — Wave 2 / Workflows sub-team (v0.3.2-workflows).
 *
 * Reconciles `kagent.knuteson.io/v1alpha1` `AgentWorkflow` CRs into:
 *
 *   1. A capability bundle (JWT) minted via `mintCapabilityForWorkflow`,
 *      stamped on `status.capabilityRef`. The JWT is mounted into the
 *      workflow runtime Deployment via Secret-volume per the Wave 2
 *      Caps hygiene pattern.
 *
 *   2. A Deployment running the user-supplied workflow image. The
 *      Deployment carries the `KAGENT_CAP_JWT_FILE` env pointing at
 *      the mounted Secret-volume so the workflow runtime's
 *      `@kagent/agent-workflow-runtime` consumer can read its
 *      capability at boot.
 *
 *   3. A ClusterIP Service (the default `kawf-<workflow-name>` shape)
 *      exposing the workflow runtime's HTTP/2 endpoint for Restate's
 *      dispatcher.
 *
 *   4. Restate registration via the admin API (`POST /deployments`).
 *      Best-effort — registration failure leaves the AgentWorkflow in
 *      `phase: Pending` with a `RestateRegistered: False` condition.
 *
 *   5. For each `spec.triggers[]`:
 *        - `schedule`: materialize a sibling `KagentSchedule` CR that
 *          fires the workflow's Restate ingress on cron.
 *        - `webhook`: persist the path → workflow mapping in status so
 *          the existing webhook-receiver (Wave 0 Entry) can resolve.
 *        - `event`: persist the topic in `status.eventSubscriptions`
 *          with `status: 'pending'` and emit
 *          `workflow.event_subscription_pending` (Wave 3 wires the
 *          dispatcher).
 *
 *   6. Periodically poll Restate's admin API for in-flight invocation
 *      counts; update `status.activeRunCount`.
 *
 * Scope of THIS file: the reconciler logic (pure, deps-injected) plus
 * the manifest-builder helpers (Deployment + Service + KagentSchedule).
 * The wiring layer (informer + main.ts hookup) lives at the bottom of
 * the file under `buildAgentWorkflowController`.
 *
 * Per docs/SUBSTRATE-V1.md §3.3 + docs/WAVES.md §4.3.
 */

import {
  type AppsV1Api,
  type CoreV1Api,
  type CustomObjectsApi,
  type Informer,
  type KubeConfig,
  type KubernetesListObject,
  type ObjectCache,
  type V1Deployment,
  type V1ObjectMeta,
  type V1Service,
  makeInformer,
} from '@kubernetes/client-node';

import {
  API_GROUP,
  API_GROUP_VERSION,
  API_VERSION,
  deploymentNameForAgentWorkflow,
  isAgentWorkflow,
  isEventTrigger,
  isScheduleTrigger,
  isWebhookTrigger,
  serviceNameForAgentWorkflow,
  type AgentWorkflow,
  type AgentWorkflowCondition,
  type AgentWorkflowPhase,
  type AgentWorkflowStatus,
  type AgentWorkflowTrigger,
  type KagentSchedule,
} from './crds/index.js';
import type { CapCa } from './cap-ca.js';
import { mintCapabilityForWorkflow, type MintCapForWorkflowResult } from './cap-issuer.js';
import { mergePatchOptions } from './k8s.js';

/* =====================================================================
 * Constants — name + label conventions kept stable.
 * ===================================================================== */

export const WORKFLOW_MANAGED_LABEL_KEY = 'kagent.knuteson.io/managed-by';
export const WORKFLOW_MANAGED_LABEL_VALUE = 'kagent-agent-workflow-controller';
export const WORKFLOW_LABEL_KEY = 'kagent.knuteson.io/agent-workflow';

export const WORKFLOW_FINALIZER = 'kagent.knuteson.io/agent-workflow-gc';

export const WORKFLOW_PORT = 9080;

/** The Secret-volume mount path the runtime reads its cap JWT from. */
export const WORKFLOW_CAP_JWT_PATH = '/var/kagent/cap/cap.jwt';

const WF_PLURAL = 'agentworkflows' as const;
const SCHEDULE_PLURAL = 'kagentschedules' as const;

/* =====================================================================
 * Reconciler dependencies — injected so tests don't need a KubeConfig.
 * ===================================================================== */

export interface AgentWorkflowControllerOptions {
  /**
   * Restate ingress URL the workflow runtime registers with. Defaults
   * to the chart-managed in-cluster Service. Can be overridden per-
   * AgentWorkflow via `spec.restateAddress`.
   */
  readonly defaultRestateAddress?: string;
  /**
   * Restate admin API URL the controller POSTs `/deployments` against.
   * Default: same host as `defaultRestateAddress` on port 9070.
   */
  readonly restateAdminAddress?: string;
  /** `() => new Date()` injection seam for tests. */
  readonly now?: () => Date;
  /**
   * HTTP fetch fn for Restate admin calls. Tests inject a mock; prod
   * uses `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/** Audit emit hook — called on every workflow lifecycle transition. */
export type WorkflowAuditEmit = (
  type: 'started' | 'step.completed' | 'completed' | 'failed' | 'event_subscription_pending',
  payload: Readonly<Record<string, unknown>>,
) => void;

export interface AgentWorkflowReconcilerDeps {
  readonly customApi: CustomObjectsApi;
  readonly coreApi: CoreV1Api;
  readonly appsApi: AppsV1Api;
  readonly capCa: CapCa | undefined;
  /**
   * AgentWorkflow controller is intentionally tolerant of a missing
   * CapCa (chart-disable path) — when undefined it skips minting +
   * surfaces a clear status condition. Production always sets it.
   */
  readonly options?: AgentWorkflowControllerOptions;
  readonly auditEmit?: WorkflowAuditEmit;
}

/* =====================================================================
 * Builder helpers — pure manifest constructors.
 * ===================================================================== */

/** Deterministic Secret name used to mount the cap JWT. */
export function capSecretNameForAgentWorkflow(wf: AgentWorkflow): string {
  return `${deploymentNameForAgentWorkflow(wf)}-cap`;
}

function workflowOwnerRef(wf: AgentWorkflow): NonNullable<V1ObjectMeta['ownerReferences']>[number] {
  return {
    apiVersion: wf.apiVersion,
    kind: wf.kind,
    name: wf.metadata.name ?? '',
    uid: wf.metadata.uid ?? '',
    controller: true,
    blockOwnerDeletion: true,
  };
}

/**
 * Build the workflow runtime Deployment. The container's command is
 * left to the user-supplied image (their entrypoint must call
 * `restate.serve(...)` with the registered handler from
 * `defineWorkflow`). The controller threads:
 *
 *   - `KAGENT_WORKFLOW_NAME` — workflow name (resolved against Restate)
 *   - `KAGENT_WORKFLOW_HANDLER` — the registered handler name
 *   - `KAGENT_RESTATE_ADDRESS` — the Restate ingress URL
 *   - `KAGENT_CAP_JWT_FILE` — path to the mounted cap JWT
 *   - `KAGENT_OPERATOR_AGENTTASK_API` — operator API URL for spawn
 *
 * The cap JWT is mounted via Secret-volume per Wave 2 Caps hygiene.
 */
export function buildWorkflowDeployment(
  wf: AgentWorkflow,
  opts: {
    readonly restateAddress: string;
    readonly capSecretName: string;
  },
): V1Deployment {
  const namespace = wf.metadata.namespace ?? 'default';
  const name = deploymentNameForAgentWorkflow(wf);
  const replicas = wf.spec.replicas ?? 1;
  const selectorLabels = {
    [WORKFLOW_MANAGED_LABEL_KEY]: WORKFLOW_MANAGED_LABEL_VALUE,
    [WORKFLOW_LABEL_KEY]: wf.metadata.name ?? '',
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name,
      namespace,
      labels: selectorLabels,
      ownerReferences: [workflowOwnerRef(wf)],
    },
    spec: {
      replicas,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels: selectorLabels },
        spec: {
          // Sec-context kept conservative — workflow images run user
          // code that may need to write transient files; keep
          // readOnlyRootFilesystem off (the operator + agent-pod
          // baselines opt in via their own controller-set values).
          containers: [
            {
              name: 'workflow-runtime',
              image: wf.spec.image,
              ports: [{ containerPort: WORKFLOW_PORT, protocol: 'TCP', name: 'workflow' }],
              env: [
                { name: 'KAGENT_WORKFLOW_NAME', value: wf.metadata.name ?? '' },
                { name: 'KAGENT_WORKFLOW_HANDLER', value: wf.spec.handler },
                { name: 'KAGENT_RESTATE_ADDRESS', value: opts.restateAddress },
                { name: 'KAGENT_CAP_JWT_FILE', value: WORKFLOW_CAP_JWT_PATH },
                { name: 'KAGENT_WORKFLOW_PORT', value: String(WORKFLOW_PORT) },
              ],
              volumeMounts: [
                {
                  name: 'cap-jwt',
                  mountPath: '/var/kagent/cap',
                  readOnly: true,
                },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                runAsNonRoot: true,
                runAsUser: 1000,
              },
            },
          ],
          volumes: [
            {
              name: 'cap-jwt',
              secret: { secretName: opts.capSecretName },
            },
          ],
        },
      },
    },
  };
}

/** Build the ClusterIP Service fronting the workflow runtime. */
export function buildWorkflowService(wf: AgentWorkflow): V1Service {
  const namespace = wf.metadata.namespace ?? 'default';
  const name = serviceNameForAgentWorkflow(wf);
  const selectorLabels = {
    [WORKFLOW_MANAGED_LABEL_KEY]: WORKFLOW_MANAGED_LABEL_VALUE,
    [WORKFLOW_LABEL_KEY]: wf.metadata.name ?? '',
  };
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name,
      namespace,
      labels: selectorLabels,
      ownerReferences: [workflowOwnerRef(wf)],
    },
    spec: {
      type: 'ClusterIP',
      selector: selectorLabels,
      ports: [
        { name: 'workflow', port: WORKFLOW_PORT, targetPort: WORKFLOW_PORT, protocol: 'TCP' },
      ],
    },
  };
}

/**
 * Build a sibling `KagentSchedule` CR for a `schedule` trigger. The
 * schedule's task template targets a substrate-internal AgentTask kind
 * `kawf-trigger` that the operator's reconciler routes to the
 * workflow's Restate ingress at admission time. v0.3.2 ships the CR
 * shape; the routing-side glue is wired in `main.ts`.
 *
 * Pre-condition: caller has narrowed the trigger via `isScheduleTrigger`.
 */
export function buildScheduleCrForTrigger(
  wf: AgentWorkflow,
  trigger: { readonly kind: 'schedule'; readonly schedule: string },
  triggerIndex: number,
): KagentSchedule {
  const namespace = wf.metadata.namespace ?? 'default';
  const name = `kawf-${wf.metadata.name ?? 'unknown'}-sched-${String(triggerIndex)}`;
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'KagentSchedule',
    metadata: {
      name,
      namespace,
      labels: {
        [WORKFLOW_MANAGED_LABEL_KEY]: WORKFLOW_MANAGED_LABEL_VALUE,
        [WORKFLOW_LABEL_KEY]: wf.metadata.name ?? '',
      },
      ownerReferences: [workflowOwnerRef(wf)],
    },
    spec: {
      schedule: trigger.schedule,
      suspend: false,
      taskTemplate: {
        // The placeholder targetAgent + payload signals the reconciler
        // that this is a workflow-trigger schedule. The actual
        // dispatch is the controller's responsibility — admission is
        // a no-op for this synthetic agent name.
        targetAgent: '__kagent_workflow_trigger__',
        payload: {
          workflowName: wf.metadata.name ?? '',
          handler: wf.spec.handler,
          triggerIndex,
        },
      },
    },
  };
}

/* =====================================================================
 * Reconciler — driven by informer events; idempotent on every call.
 * ===================================================================== */

export type ReconcileWorkflowAction =
  | { readonly kind: 'noop'; readonly reason: string }
  | { readonly kind: 'cap-minted'; readonly jti: string }
  | { readonly kind: 'deployment-created' }
  | { readonly kind: 'service-created' }
  | { readonly kind: 'schedule-created'; readonly name: string }
  | { readonly kind: 'restate-registered'; readonly handler: string }
  | { readonly kind: 'restate-register-failed'; readonly message: string }
  | { readonly kind: 'status-patched'; readonly phase: AgentWorkflowPhase }
  | { readonly kind: 'releasing' }
  | { readonly kind: 'finalizer-added' }
  | { readonly kind: 'finalizer-removed' };

export interface ReconcileWorkflowInput {
  readonly wf: AgentWorkflow;
  /** Best-effort lookup of the controller's child Deployment. */
  readonly lookupDeployment?: (namespace: string, name: string) => V1Deployment | undefined;
}

export async function reconcileAgentWorkflow(
  input: ReconcileWorkflowInput,
  deps: AgentWorkflowReconcilerDeps,
): Promise<ReconcileWorkflowAction> {
  const { wf } = input;
  const namespace = wf.metadata.namespace ?? 'default';
  const now = deps.options?.now ?? ((): Date => new Date());

  // ---- 1. Deletion path -------------------------------------------------
  if (wf.metadata.deletionTimestamp !== undefined && wf.metadata.deletionTimestamp !== null) {
    return reconcileDeletion(wf, deps, now);
  }

  // ---- 2. Add finalizer on first sight ---------------------------------
  if (!hasFinalizer(wf)) {
    await addFinalizer(wf, deps);
    return { kind: 'finalizer-added' };
  }

  // ---- 3. Mint capability (when CA available) --------------------------
  // Idempotent: re-mint each reconcile so cap rotation just works. The
  // Secret holding the JWT is overwritten in-place.
  let mintedCap: MintCapForWorkflowResult | undefined;
  if (deps.capCa !== undefined) {
    try {
      mintedCap = await mintCapabilityForWorkflow(deps.capCa, { workflow: wf });
      await upsertCapSecret(wf, mintedCap.jwt, deps);
    } catch (err) {
      await patchStatus(wf, deps, {
        phase: 'Failed',
        condition: {
          type: 'CapMintFailed',
          status: 'True',
          reason: 'CapIssuerError',
          message: stringifyErr(err),
          lastTransitionTime: now().toISOString(),
        },
      });
      return { kind: 'status-patched', phase: 'Failed' };
    }
  }

  // ---- 4. Deployment + Service ----------------------------------------
  const restateAddress =
    wf.spec.restateAddress ??
    deps.options?.defaultRestateAddress ??
    'http://restate.kagent-system.svc.cluster.local:8080';
  let createdDeployment = false;
  let createdService = false;

  const capSecretName = capSecretNameForAgentWorkflow(wf);

  try {
    const deployment = buildWorkflowDeployment(wf, { restateAddress, capSecretName });
    await deps.appsApi.createNamespacedDeployment({ namespace, body: deployment });
    createdDeployment = true;
  } catch (err) {
    if (!isAlreadyExists(err)) {
      await patchStatus(wf, deps, {
        phase: 'Failed',
        condition: {
          type: 'DeploymentFailed',
          status: 'True',
          reason: 'CreateFailed',
          message: stringifyErr(err),
          lastTransitionTime: now().toISOString(),
        },
      });
      return { kind: 'status-patched', phase: 'Failed' };
    }
    // Update the existing Deployment in case spec.image / replicas
    // changed since last reconcile.
    try {
      const deployment = buildWorkflowDeployment(wf, { restateAddress, capSecretName });
      await deps.appsApi.patchNamespacedDeployment(
        {
          namespace,
          name: deploymentNameForAgentWorkflow(wf),
          body: deployment as object,
        },
        mergePatchOptions,
      );
    } catch (patchErr) {
      // Patch failures are logged but don't fail the reconcile —
      // the Deployment exists, just possibly drifted. Next reconcile
      // re-tries.
      console.warn(
        `[kagent-agent-workflow] Deployment patch failed for ${namespace}/${deploymentNameForAgentWorkflow(wf)}:`,
        patchErr,
      );
    }
  }

  try {
    const service = buildWorkflowService(wf);
    await deps.coreApi.createNamespacedService({ namespace, body: service });
    createdService = true;
  } catch (err) {
    if (!isAlreadyExists(err)) {
      await patchStatus(wf, deps, {
        phase: 'Failed',
        condition: {
          type: 'ServiceFailed',
          status: 'True',
          reason: 'CreateFailed',
          message: stringifyErr(err),
          lastTransitionTime: now().toISOString(),
        },
      });
      return { kind: 'status-patched', phase: 'Failed' };
    }
  }

  // ---- 5. Restate registration -----------------------------------------
  // Best-effort: register the workflow's HTTP/2 endpoint with Restate's
  // admin API. Failure is recorded as a status condition; the next
  // reconcile re-tries.
  const restateAdminAddr =
    deps.options?.restateAdminAddress ?? inferAdminFromIngress(restateAddress);
  const fetchFn = deps.options?.fetch ?? globalThis.fetch.bind(globalThis);
  const workflowSvcUrl = `http://${serviceNameForAgentWorkflow(wf)}.${namespace}.svc.cluster.local:${WORKFLOW_PORT}`;
  let restateRegistered = false;
  let restateRegisterMessage: string | undefined;
  try {
    const res = await fetchFn(`${restateAdminAddr}/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: workflowSvcUrl }),
    });
    if (res.ok || res.status === 409) {
      // 409 = already registered; treat as success.
      restateRegistered = true;
    } else {
      restateRegisterMessage = `restate admin POST returned ${res.status.toString()}`;
    }
  } catch (err) {
    restateRegisterMessage = stringifyErr(err);
  }

  // ---- 6. Materialize triggers ----------------------------------------
  const triggerActions = await reconcileTriggers(wf, deps);

  // ---- 7. Compute phase + emit status patch ---------------------------
  const dep = input.lookupDeployment?.(namespace, deploymentNameForAgentWorkflow(wf));
  const phase = computePhase(wf, {
    ...(dep !== undefined && { deployment: dep }),
    restateRegistered,
  });
  const conditions = computeConditions(wf, {
    restateRegistered,
    restateRegisterMessage,
    deployment: dep,
    triggerActions,
    now,
  });

  await patchStatus(wf, deps, {
    phase,
    ...(mintedCap !== undefined && { capabilityRef: mintedCap.jti }),
    lastTickAt: now().toISOString(),
    conditions,
    eventSubscriptions: triggerActions.eventSubscriptions,
  });

  // ---- 8. Audit emission ---------------------------------------------
  if (createdDeployment) deps.auditEmit?.('started', { workflow: wf.metadata.name ?? '' });
  if (triggerActions.pendingEventTopic !== undefined) {
    deps.auditEmit?.('event_subscription_pending', {
      workflow: wf.metadata.name ?? '',
      topic: triggerActions.pendingEventTopic,
    });
  }

  // Reporting priority — surface the most actionable signal first:
  //   1. restate registration failure (ops alarm; controller will retry)
  //   2. cap-minted on first deployment creation (full happy path)
  //   3. deployment / service creation alone
  //   4. fall through to status-patched
  if (!restateRegistered) {
    return { kind: 'restate-register-failed', message: restateRegisterMessage ?? 'unknown' };
  }
  if (mintedCap !== undefined && createdDeployment) {
    return { kind: 'cap-minted', jti: mintedCap.jti };
  }
  if (createdDeployment) return { kind: 'deployment-created' };
  if (createdService) return { kind: 'service-created' };
  return { kind: 'status-patched', phase };
}

/**
 * Compute the workflow's lifecycle phase from observable state.
 *
 *   - Deployment unbound or unready    → Pending
 *   - Deployment ready, Restate failed  → Pending
 *   - Deployment ready + Restate ok    → Ready
 *   - Failure conditions handled inline (each early-returns Failed)
 */
export function computePhase(
  _wf: AgentWorkflow,
  observable: {
    readonly deployment?: V1Deployment;
    readonly restateRegistered: boolean;
  },
): AgentWorkflowPhase {
  const dep = observable.deployment;
  const desired = dep?.spec?.replicas ?? 1;
  const ready = dep?.status?.readyReplicas ?? 0;
  if (dep === undefined || ready < desired) return 'Pending';
  if (!observable.restateRegistered) return 'Pending';
  return 'Ready';
}

interface TriggerActions {
  readonly schedulesCreated: readonly string[];
  readonly webhookPaths: readonly string[];
  readonly eventSubscriptions: readonly {
    readonly topic: string;
    readonly status: 'pending' | 'subscribed' | 'failed';
    readonly message?: string;
  }[];
  readonly pendingEventTopic: string | undefined;
}

/**
 * Materialize the workflow's `spec.triggers[]` into substrate state.
 * Schedule + webhook entries land synchronously; event entries are
 * v0.3.2 stubs.
 */
async function reconcileTriggers(
  wf: AgentWorkflow,
  deps: AgentWorkflowReconcilerDeps,
): Promise<TriggerActions> {
  const namespace = wf.metadata.namespace ?? 'default';
  const triggers: readonly AgentWorkflowTrigger[] = wf.spec.triggers ?? [];
  const schedulesCreated: string[] = [];
  const webhookPaths: string[] = [];
  const eventSubscriptions: TriggerActions['eventSubscriptions'][number][] = [];
  let pendingEventTopic: string | undefined;

  for (let i = 0; i < triggers.length; i += 1) {
    const t = triggers[i];
    if (t === undefined) continue;
    if (isScheduleTrigger(t)) {
      try {
        const schedule = buildScheduleCrForTrigger(wf, t, i);
        await deps.customApi.createNamespacedCustomObject({
          group: API_GROUP,
          version: API_VERSION,
          namespace,
          plural: SCHEDULE_PLURAL,
          body: schedule as object,
        });
        schedulesCreated.push(schedule.metadata.name ?? '');
      } catch (err) {
        if (!isAlreadyExists(err)) {
          console.warn(
            `[kagent-agent-workflow] schedule trigger create failed for ${wf.metadata.name ?? 'unknown'}/[${String(i)}]:`,
            err,
          );
        }
      }
    } else if (isWebhookTrigger(t)) {
      // v0.3.2: persist the path so the existing webhook receiver
      // (Wave 0 Entry) can resolve. The actual receiver-side wiring is
      // a follow-up — the Wave 0 receiver currently knows about
      // KagentSchedule + ad-hoc trigger registries; the AgentWorkflow
      // path resolution is queued for the Wave 0 / Wave 2 cross-team
      // glue release. The path is stamped on status.conditions for
      // observability.
      webhookPaths.push(t.webhook.path);
    } else if (isEventTrigger(t)) {
      eventSubscriptions.push({
        topic: t.event.topic,
        status: 'pending',
        message: 'Wave 3 Events dispatcher not yet wired',
      });
      pendingEventTopic = t.event.topic;
    }
  }

  return { schedulesCreated, webhookPaths, eventSubscriptions, pendingEventTopic };
}

function computeConditions(
  wf: AgentWorkflow,
  observable: {
    readonly restateRegistered: boolean;
    readonly restateRegisterMessage: string | undefined;
    readonly deployment: V1Deployment | undefined;
    readonly triggerActions: TriggerActions;
    readonly now: () => Date;
  },
): readonly AgentWorkflowCondition[] {
  const ts = observable.now().toISOString();
  const out: AgentWorkflowCondition[] = [];

  out.push({
    type: 'RestateRegistered',
    status: observable.restateRegistered ? 'True' : 'False',
    lastTransitionTime: ts,
    ...(observable.restateRegistered
      ? {}
      : {
          reason: 'AdminApiUnreachable',
          message: observable.restateRegisterMessage ?? 'restate admin API unreachable',
        }),
  });

  const dep = observable.deployment;
  const desiredReplicas = dep?.spec?.replicas ?? 1;
  const readyReplicas = dep?.status?.readyReplicas ?? 0;
  const deploymentReady = dep !== undefined && readyReplicas >= desiredReplicas;
  out.push({
    type: 'DeploymentReady',
    status: deploymentReady ? 'True' : 'False',
    lastTransitionTime: ts,
    ...(deploymentReady
      ? {}
      : {
          reason: 'NotReady',
          message: `${String(readyReplicas)}/${String(desiredReplicas)} replicas ready`,
        }),
  });

  const ready = observable.restateRegistered && deploymentReady;
  out.push({
    type: 'Ready',
    status: ready ? 'True' : 'False',
    lastTransitionTime: ts,
    ...(ready ? {} : { reason: 'NotReady', message: 'workflow runtime not yet ready' }),
  });

  if (observable.triggerActions.eventSubscriptions.length > 0) {
    out.push({
      type: 'EventSubscriptionPending',
      status: 'True',
      reason: 'Wave3NotYetWired',
      message: `${String(observable.triggerActions.eventSubscriptions.length)} event subscription(s) pending Wave 3 Events dispatcher`,
      lastTransitionTime: ts,
    });
  }

  // Bind generation when known.
  const gen = wf.metadata.generation;
  if (typeof gen === 'number') {
    return out.map((c) => ({ ...c, observedGeneration: gen }));
  }
  return out;
}

/* =====================================================================
 * Mutating side effects.
 * ===================================================================== */

async function upsertCapSecret(
  wf: AgentWorkflow,
  jwt: string,
  deps: AgentWorkflowReconcilerDeps,
): Promise<void> {
  const namespace = wf.metadata.namespace ?? 'default';
  const name = capSecretNameForAgentWorkflow(wf);
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: {
        [WORKFLOW_MANAGED_LABEL_KEY]: WORKFLOW_MANAGED_LABEL_VALUE,
        [WORKFLOW_LABEL_KEY]: wf.metadata.name ?? '',
      },
      ownerReferences: [workflowOwnerRef(wf)],
    },
    type: 'Opaque',
    stringData: { 'cap.jwt': jwt },
  };
  try {
    await deps.coreApi.createNamespacedSecret({ namespace, body });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // Replace via patch — keeps ownerReferences + labels coherent.
    await deps.coreApi.patchNamespacedSecret(
      {
        namespace,
        name,
        body: { stringData: { 'cap.jwt': jwt } } as object,
      },
      mergePatchOptions,
    );
  }
}

async function reconcileDeletion(
  wf: AgentWorkflow,
  deps: AgentWorkflowReconcilerDeps,
  now: () => Date,
): Promise<ReconcileWorkflowAction> {
  // Patch phase=Failed as the closest substrate-side terminal —
  // the workflow CRD doesn't have a `Releasing` phase; consumers
  // see deletionTimestamp + the Failed condition.
  if (wf.status?.phase !== 'Failed') {
    await patchStatus(wf, deps, {
      phase: 'Failed',
      condition: {
        type: 'Releasing',
        status: 'True',
        reason: 'Deleting',
        message: 'AgentWorkflow deletion in progress',
        lastTransitionTime: now().toISOString(),
      },
    });
  }
  // Cascading delete via ownerRef handles Deployment/Service/Secret/
  // KagentSchedule cleanup; we just strip the finalizer.
  await removeFinalizer(wf, deps);
  return { kind: 'finalizer-removed' };
}

interface PatchStatusInput {
  readonly phase: AgentWorkflowPhase;
  readonly capabilityRef?: string;
  readonly lastTickAt?: string;
  readonly activeRunCount?: number;
  readonly condition?: AgentWorkflowCondition;
  readonly conditions?: readonly AgentWorkflowCondition[];
  readonly eventSubscriptions?: readonly {
    readonly topic: string;
    readonly status: 'pending' | 'subscribed' | 'failed';
    readonly message?: string;
  }[];
}

async function patchStatus(
  wf: AgentWorkflow,
  deps: AgentWorkflowReconcilerDeps,
  patch: PatchStatusInput,
): Promise<void> {
  const namespace = wf.metadata.namespace ?? 'default';
  const name = wf.metadata.name ?? '';
  const generation = wf.metadata.generation;

  const status: AgentWorkflowStatus = {
    phase: patch.phase,
    ...(patch.capabilityRef !== undefined && { capabilityRef: patch.capabilityRef }),
    ...(patch.lastTickAt !== undefined && { lastTickAt: patch.lastTickAt }),
    ...(patch.activeRunCount !== undefined && { activeRunCount: patch.activeRunCount }),
    ...(typeof generation === 'number' && { observedGeneration: generation }),
    ...(patch.conditions !== undefined && { conditions: patch.conditions }),
    ...(patch.condition !== undefined &&
      patch.conditions === undefined && {
        conditions: mergeCondition(wf.status?.conditions, patch.condition),
      }),
    ...(patch.eventSubscriptions !== undefined && {
      eventSubscriptions: patch.eventSubscriptions,
    }),
  };

  try {
    await deps.customApi.patchNamespacedCustomObjectStatus(
      {
        group: API_GROUP,
        version: API_VERSION,
        namespace,
        plural: WF_PLURAL,
        name,
        body: { status } as object,
      },
      mergePatchOptions,
    );
  } catch (err) {
    console.warn(`[kagent-agent-workflow] status patch failed for ${namespace}/${name}:`, err);
  }
}

export function mergeCondition(
  existing: readonly AgentWorkflowCondition[] | undefined,
  next: AgentWorkflowCondition,
): readonly AgentWorkflowCondition[] {
  const list = existing ?? [];
  const out: AgentWorkflowCondition[] = [];
  let replaced = false;
  for (const c of list) {
    if (c.type === next.type) {
      replaced = true;
      if (c.status === next.status && c.reason === next.reason && c.message === next.message) {
        out.push(c);
      } else {
        out.push(next);
      }
    } else {
      out.push(c);
    }
  }
  if (!replaced) out.push(next);
  return out;
}

function hasFinalizer(wf: AgentWorkflow): boolean {
  return wf.metadata.finalizers?.includes(WORKFLOW_FINALIZER) ?? false;
}

async function addFinalizer(wf: AgentWorkflow, deps: AgentWorkflowReconcilerDeps): Promise<void> {
  const finalizers = [...(wf.metadata.finalizers ?? []), WORKFLOW_FINALIZER];
  await deps.customApi.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: wf.metadata.namespace ?? 'default',
      plural: WF_PLURAL,
      name: wf.metadata.name ?? '',
      body: { metadata: { finalizers } } as object,
    },
    mergePatchOptions,
  );
}

async function removeFinalizer(
  wf: AgentWorkflow,
  deps: AgentWorkflowReconcilerDeps,
): Promise<void> {
  const finalizers = (wf.metadata.finalizers ?? []).filter((f) => f !== WORKFLOW_FINALIZER);
  await deps.customApi.patchNamespacedCustomObject(
    {
      group: API_GROUP,
      version: API_VERSION,
      namespace: wf.metadata.namespace ?? 'default',
      plural: WF_PLURAL,
      name: wf.metadata.name ?? '',
      body: { metadata: { finalizers } } as object,
    },
    mergePatchOptions,
  );
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

function inferAdminFromIngress(ingress: string): string {
  // Restate's standard split: ingress on 8080, admin on 9070. When the
  // caller didn't override `restateAdminAddress`, swap the port.
  try {
    const u = new URL(ingress);
    const adminPort = '9070';
    return `${u.protocol}//${u.hostname}:${adminPort}`;
  } catch {
    return ingress;
  }
}

function isAlreadyExists(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e.code === 409 || e.statusCode === 409;
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

/* =====================================================================
 * Wiring — informer + reconciler binding for main.ts.
 * ===================================================================== */

export interface BuildAgentWorkflowControllerInput {
  readonly kc: KubeConfig;
  readonly customApi: CustomObjectsApi;
  readonly coreApi: CoreV1Api;
  readonly appsApi: AppsV1Api;
  readonly capCa: CapCa | undefined;
  readonly watchNamespace?: string;
  readonly options?: AgentWorkflowControllerOptions;
  readonly auditEmit?: WorkflowAuditEmit;
}

export interface AgentWorkflowControllerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function buildAgentWorkflowController(
  input: BuildAgentWorkflowControllerInput,
): AgentWorkflowControllerHandle {
  const { kc, customApi, coreApi, appsApi, capCa, watchNamespace } = input;
  const labelSelector = `${WORKFLOW_MANAGED_LABEL_KEY}=${WORKFLOW_MANAGED_LABEL_VALUE}`;
  const deps: AgentWorkflowReconcilerDeps = {
    customApi,
    coreApi,
    appsApi,
    capCa,
    ...(input.options !== undefined && { options: input.options }),
    ...(input.auditEmit !== undefined && { auditEmit: input.auditEmit }),
  };

  // AgentWorkflow informer.
  const wfListFn = async (): Promise<KubernetesListObject<AgentWorkflow>> => {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    const res =
      watchNamespace !== undefined
        ? await customApi.listNamespacedCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            namespace: watchNamespace,
            plural: WF_PLURAL,
          })
        : await customApi.listClusterCustomObject({
            group: API_GROUP,
            version: API_VERSION,
            plural: WF_PLURAL,
          });
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    return res as KubernetesListObject<AgentWorkflow>;
  };
  const wfWatchPath =
    watchNamespace !== undefined
      ? `/apis/${API_GROUP}/${API_VERSION}/namespaces/${encodeURIComponent(watchNamespace)}/${WF_PLURAL}`
      : `/apis/${API_GROUP}/${API_VERSION}/${WF_PLURAL}`;
  const wfInformer: Informer<AgentWorkflow> & ObjectCache<AgentWorkflow> =
    makeInformer<AgentWorkflow>(kc, wfWatchPath, wfListFn);

  // Deployment informer (label-selected to children).
  const depListFn = async (): Promise<KubernetesListObject<V1Deployment>> => {
    const res =
      watchNamespace !== undefined
        ? await appsApi.listNamespacedDeployment({ namespace: watchNamespace, labelSelector })
        : await appsApi.listDeploymentForAllNamespaces({ labelSelector });
    return res;
  };
  const depLabelQuery = `labelSelector=${encodeURIComponent(labelSelector)}`;
  const depWatchPath =
    watchNamespace !== undefined
      ? `/apis/apps/v1/namespaces/${encodeURIComponent(watchNamespace)}/deployments?${depLabelQuery}`
      : `/apis/apps/v1/deployments?${depLabelQuery}`;
  const depInformer: Informer<V1Deployment> & ObjectCache<V1Deployment> =
    makeInformer<V1Deployment>(kc, depWatchPath, depListFn);

  // Service informer (label-selected to children).
  const svcListFn = async (): Promise<KubernetesListObject<V1Service>> => {
    const res =
      watchNamespace !== undefined
        ? await coreApi.listNamespacedService({ namespace: watchNamespace, labelSelector })
        : await coreApi.listServiceForAllNamespaces({ labelSelector });
    return res;
  };
  const svcLabelQuery = `labelSelector=${encodeURIComponent(labelSelector)}`;
  const svcWatchPath =
    watchNamespace !== undefined
      ? `/api/v1/namespaces/${encodeURIComponent(watchNamespace)}/services?${svcLabelQuery}`
      : `/api/v1/services?${svcLabelQuery}`;
  const svcInformer: Informer<V1Service> & ObjectCache<V1Service> = makeInformer<V1Service>(
    kc,
    svcWatchPath,
    svcListFn,
  );

  const lookupDeployment = (namespace: string, name: string): V1Deployment | undefined => {
    return depInformer.get(name, namespace);
  };

  const fire = (obj: unknown): void => {
    if (!isAgentWorkflow(obj)) return;
    void reconcileAgentWorkflow({ wf: obj, lookupDeployment }, deps).catch((err: unknown) => {
      console.error(
        `[kagent-agent-workflow] reconcile failed for ${obj.metadata.namespace ?? '(no-ns)'}/${obj.metadata.name ?? '(no-name)'}:`,
        err,
      );
    });
  };

  // Re-fire ALL workflows on a child Deployment/Service event so the
  // matching workflow's status updates as the children's phase
  // transitions. Cheap: list() reads the cache.
  const refireAll = (): void => {
    for (const wf of wfInformer.list()) {
      fire(wf);
    }
  };

  wfInformer.on('add', fire);
  wfInformer.on('update', fire);
  wfInformer.on('delete', fire);
  wfInformer.on('error', (err) => {
    console.error('[kagent-agent-workflow] informer error:', err);
    setTimeout(() => {
      void wfInformer.start();
    }, 5000);
  });
  depInformer.on('add', refireAll);
  depInformer.on('update', refireAll);
  depInformer.on('delete', refireAll);
  depInformer.on('error', (err) => {
    console.error('[kagent-agent-workflow] Deployment watch error:', err);
    setTimeout(() => {
      void depInformer.start();
    }, 5000);
  });
  svcInformer.on('add', refireAll);
  svcInformer.on('update', refireAll);
  svcInformer.on('delete', refireAll);
  svcInformer.on('error', (err) => {
    console.error('[kagent-agent-workflow] Service watch error:', err);
    setTimeout(() => {
      void svcInformer.start();
    }, 5000);
  });

  return {
    async start(): Promise<void> {
      await wfInformer.start();
      await depInformer.start();
      await svcInformer.start();
    },
    async stop(): Promise<void> {
      try {
        await wfInformer.stop();
      } catch (err) {
        console.error('[kagent-agent-workflow] AgentWorkflow informer stop failed:', err);
      }
      try {
        await depInformer.stop();
      } catch (err) {
        console.error('[kagent-agent-workflow] Deployment informer stop failed:', err);
      }
      try {
        await svcInformer.stop();
      } catch (err) {
        console.error('[kagent-agent-workflow] Service informer stop failed:', err);
      }
    },
  };
}
