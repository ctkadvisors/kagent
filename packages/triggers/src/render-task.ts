/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Render an AgentTask manifest from a `KagentSchedule.spec.taskTemplate`
 * (or a `WebhookTrigger`'s persisted body). Pure — no K8s API calls,
 * no clock reads when `now` is supplied; both controllers and the
 * webhook receiver call this with the exact instant they want stamped
 * on the resulting AgentTask.
 *
 * Design choice: the rendered AgentTask is named
 * `<source-name>-<unix-timestamp-seconds>` so two ticks within the
 * same minute (impossible for cron, but possible for back-to-back
 * webhooks) cannot collide. A monotonically-increasing seconds suffix
 * is human-readable in `kubectl get agenttasks`; uuids would be
 * opaque.
 */

const KAGENT_API_VERSION = 'kagent.knuteson.io/v1alpha1';

const KAGENT_LABEL_TRIGGER_KIND = 'kagent.knuteson.io/trigger-kind';
const KAGENT_LABEL_TRIGGER_NAME = 'kagent.knuteson.io/trigger-name';
const KAGENT_ANNOTATION_TRIGGERED_AT = 'kagent.knuteson.io/triggered-at';
const KAGENT_ANNOTATION_PLACEHOLDER_CAP = 'kagent.knuteson.io/placeholder-cap';

/** Wave 0 placeholder annotation per WAVES.md §2.6. Wave 2 replaces. */
export const PLACEHOLDER_CAPABILITY_VALUE = 'wave0-shared-all-rights';

export type TriggerKind = 'schedule' | 'webhook';

/**
 * The body the operator stores under `KagentSchedule.spec.taskTemplate`
 * and the controller renders verbatim. Mirrors `AgentTaskSpec` in
 * `@kagent/operator/src/crds/types.ts` but kept structurally typed
 * here so this package doesn't take an internal dep on `@kagent/operator`
 * (the operator depends on `@kagent/triggers`, not the reverse).
 */
export interface AgentTaskTemplateSpec {
  readonly targetAgent?: string;
  readonly targetCapability?: string;
  readonly payload: unknown;
  readonly timeoutSeconds?: number;
  readonly runConfig?: {
    readonly tokenLimit?: number;
    readonly costLimitUsd?: number;
    readonly maxIterations?: number;
    readonly timeoutSeconds?: number;
  };
  readonly originalUserMessage?: string;
  readonly parentDistillation?: string;
  readonly expectedTools?: readonly string[];
}

export interface RenderInput {
  /** Identity of the trigger (KagentSchedule or WebhookTrigger name). */
  readonly triggerName: string;
  /** Trigger kind — populates the `kagent.knuteson.io/trigger-kind` label. */
  readonly triggerKind: TriggerKind;
  /** Namespace of the rendered AgentTask (mirrors trigger's namespace). */
  readonly namespace: string;
  /** AgentTask body — usually `KagentSchedule.spec.taskTemplate`. */
  readonly taskTemplate: AgentTaskTemplateSpec;
  /** Tick instant; controller passes the cron's matched minute. */
  readonly now: Date;
  /**
   * Optional payload override — webhook receivers merge the POST body
   * into `taskTemplate.payload` (caller-supplied at request time wins).
   */
  readonly payloadOverride?: unknown;
}

export interface RenderedAgentTask {
  readonly apiVersion: typeof KAGENT_API_VERSION;
  readonly kind: 'AgentTask';
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
    readonly annotations: Readonly<Record<string, string>>;
  };
  readonly spec: AgentTaskTemplateSpec;
}

/** Maximum length of `metadata.name` per RFC 1123. */
const NAME_MAX_LEN = 63;

export function renderAgentTaskFromTemplate(input: RenderInput): RenderedAgentTask {
  const { triggerName, triggerKind, namespace, taskTemplate, now, payloadOverride } = input;
  if (typeof triggerName !== 'string' || triggerName.length === 0) {
    throw new Error('renderAgentTaskFromTemplate: triggerName is required');
  }
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new Error('renderAgentTaskFromTemplate: namespace is required');
  }
  if (taskTemplate === null || typeof taskTemplate !== 'object') {
    throw new Error('renderAgentTaskFromTemplate: taskTemplate is required');
  }
  if (taskTemplate.targetAgent === undefined && taskTemplate.targetCapability === undefined) {
    throw new Error(
      'renderAgentTaskFromTemplate: taskTemplate must set targetAgent OR targetCapability',
    );
  }
  if (taskTemplate.payload === undefined && payloadOverride === undefined) {
    throw new Error('renderAgentTaskFromTemplate: payload is required');
  }

  const unixSec = Math.floor(now.getTime() / 1000);
  const baseName = `${triggerName}-${String(unixSec)}`;
  const name = baseName.slice(0, NAME_MAX_LEN);

  const spec: AgentTaskTemplateSpec = {
    ...taskTemplate,
    payload: payloadOverride !== undefined ? payloadOverride : taskTemplate.payload,
  };

  const labels: Record<string, string> = {
    [KAGENT_LABEL_TRIGGER_KIND]: triggerKind,
    [KAGENT_LABEL_TRIGGER_NAME]: triggerName,
    'kagent.knuteson.io/managed-by': 'kagent-triggers',
  };
  const annotations: Record<string, string> = {
    [KAGENT_ANNOTATION_TRIGGERED_AT]: now.toISOString(),
    [KAGENT_ANNOTATION_PLACEHOLDER_CAP]: PLACEHOLDER_CAPABILITY_VALUE,
  };

  return {
    apiVersion: KAGENT_API_VERSION,
    kind: 'AgentTask',
    metadata: {
      name,
      namespace,
      labels,
      annotations,
    },
    spec,
  };
}
