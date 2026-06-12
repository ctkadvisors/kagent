/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * External channel control-plane projection.
 *
 * The route reads Channel, ChannelBinding, and ChannelSession CRDs from
 * SnapshotCache and deliberately sanitizes pairing secrets: list/detail
 * responses expose whether QR/pairing material exists, not the raw
 * WhatsApp QR payload. Operational mutation is limited to
 * `spec.paused`, gated by the same write-surface knob as other
 * Workbench actions.
 */

import { setHeaderOptions, type CustomObjectsApi } from '@kubernetes/client-node';
import { Hono } from 'hono';

import type {
  AgentTask,
  Channel,
  ChannelBinding,
  ChannelBindingTarget,
  ChannelPairingStatus,
  ChannelPolicy,
  ChannelSession,
} from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const CHANNEL_PLURAL = 'channels';
const MERGE_PATCH_OPTIONS = setHeaderOptions('Content-Type', 'application/merge-patch+json');

export interface ChannelsRouteDeps {
  readonly cache: SnapshotCache;
  readonly customApi?: CustomObjectsApi;
  readonly writesEnabled?: boolean;
  readonly defaultNamespace?: string;
}

interface SanitizedPairingStatus {
  readonly state?: string;
  readonly qrAvailable: boolean;
  readonly pairingCodeAvailable: boolean;
  readonly expiresAt?: string;
  readonly accountJid?: string;
  readonly message?: string;
}

interface ChannelPolicySummary {
  readonly dmPolicy: string;
  readonly allowFrom: readonly string[];
  readonly groupPolicy: string;
  readonly groupAllowFrom: readonly string[];
  readonly groups: readonly string[];
}

interface ChannelSummary {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly displayName?: string;
  readonly provider: string;
  readonly accountId: string;
  readonly paused: boolean;
  readonly phase?: string;
  readonly observedGeneration?: number;
  readonly pairing?: SanitizedPairingStatus;
  readonly policy: ChannelPolicySummary;
  readonly storage?: {
    readonly secretRef?: string;
    readonly pvc?: string;
  };
  readonly whatsapp?: {
    readonly authDir?: string;
    readonly sendReadReceipts?: boolean;
    readonly mediaMaxMb?: number;
  };
  readonly bindingCount: number;
  readonly sessionCount: number;
  readonly activeSessionCount: number;
  readonly lastHeartbeatAt?: string;
  readonly createdAt?: string;
}

interface BindingSummary {
  readonly namespace: string;
  readonly name: string;
  readonly paused: boolean;
  readonly default: boolean;
  readonly match?: {
    readonly accountId?: string;
    readonly peer?: { readonly kind: string; readonly id: string };
    readonly threadId?: string;
  };
  readonly target: ChannelTargetSummary;
  readonly approval?: {
    readonly required: boolean;
    readonly mode?: string;
  };
  readonly lastMatchedAt?: string;
}

interface ChannelTargetSummary {
  readonly agentRef?: string;
  readonly capability?: string;
  readonly profileRef?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly runConfig?: Record<string, number | string | boolean>;
  readonly sessionScope?: string;
}

interface ChannelSessionSummary {
  readonly namespace: string;
  readonly name: string;
  readonly phase?: string;
  readonly provider: string;
  readonly accountId: string;
  readonly peer: { readonly kind: string; readonly id: string };
  readonly threadId?: string;
  readonly bindingRef?: string;
  readonly target: ChannelTargetSummary;
  readonly paused: boolean;
  readonly lastInboundAt?: string;
  readonly lastOutboundAt?: string;
  readonly consecutiveFailures?: number;
  readonly backoffUntil?: string;
  readonly lastFailureReason?: string;
  readonly lastTask?: {
    readonly namespace: string;
    readonly name: string;
    readonly uid?: string;
    readonly phase?: string;
    readonly ui: string;
  };
}

interface ChannelDetail extends ChannelSummary {
  readonly bindings: readonly BindingSummary[];
  readonly sessions: readonly ChannelSessionSummary[];
}

export function channelsRoute(deps: ChannelsRouteDeps): Hono {
  const app = new Hono();

  app.get('/api/channels', (c) => {
    const channels = deps.cache
      .listChannels()
      .map((channel) => summarizeChannel(channel, deps.cache))
      .sort(compareChannelSummaries);
    return c.json({ items: channels });
  });

  app.get('/api/channels/:namespace/:name', (c) => {
    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
    const channel = deps.cache.getChannel(namespace, name);
    if (channel === undefined) return c.json({ error: 'not-found', namespace, name }, 404);
    return c.json(channelDetail(channel, deps.cache));
  });

  app.patch('/api/channels/:namespace/:name', async (c) => {
    if (deps.customApi === undefined || deps.writesEnabled !== true) {
      return c.json(
        {
          error:
            'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
        },
        503,
      );
    }

    const namespace = c.req.param('namespace');
    const name = c.req.param('name');
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

    const existing = deps.cache.getChannel(namespace, name);
    if (existing === undefined) return c.json({ error: 'not-found', namespace, name }, 404);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-body', message: 'request body is not valid JSON' }, 400);
    }

    const parsed = parsePatchBody(raw);
    if (parsed === undefined) {
      return c.json({ error: 'invalid-body', message: 'body must be { "paused": boolean }' }, 400);
    }

    try {
      await deps.customApi.patchNamespacedCustomObject(
        {
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace,
          plural: CHANNEL_PLURAL,
          name,
          body: { spec: { paused: parsed.paused } },
        },
        MERGE_PATCH_OPTIONS,
      );
      return c.json({ ok: true, namespace, name, paused: parsed.paused });
    } catch (err) {
      const status = extractK8sStatus(err);
      if (status === 403) {
        return c.json(
          {
            error: `RBAC denied: workbench-api ServiceAccount cannot patch Channel in ${namespace}`,
          },
          403,
        );
      }
      if (status === 404) return c.json({ error: 'not-found', namespace, name }, 404);
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[workbench-api] PATCH /api/channels/${namespace}/${name} failed status=${String(
          status ?? 500,
        )}: ${detail}`,
      );
      return c.json({ error: 'patch-failed', message: detail }, 500);
    }
  });

  return app;
}

function summarizeChannel(channel: Channel, cache: SnapshotCache): ChannelSummary {
  const namespace = channel.metadata.namespace ?? 'default';
  const name = channel.metadata.name ?? '';
  const bindings = bindingsFor(channel, cache);
  const sessions = sessionsFor(channel, cache);
  const activeSessionCount =
    channel.status?.activeSessionCount ??
    sessions.filter((session) => session.status?.phase === 'Active').length;
  return {
    id: `${namespace}/${name}`,
    namespace,
    name,
    ...(channel.spec.displayName !== undefined && { displayName: channel.spec.displayName }),
    provider: channel.spec.provider,
    accountId: channel.spec.accountId,
    paused: channel.spec.paused === true || channel.status?.phase === 'Paused',
    ...(channel.status?.phase !== undefined && { phase: channel.status.phase }),
    ...(channel.status?.observedGeneration !== undefined && {
      observedGeneration: channel.status.observedGeneration,
    }),
    ...(channel.status?.pairing !== undefined && {
      pairing: sanitizePairing(channel.status.pairing),
    }),
    policy: summarizePolicy(channel.spec.policy),
    ...(channel.spec.sessionStorage !== undefined && {
      storage: {
        ...(channel.spec.sessionStorage.secretRef?.name !== undefined && {
          secretRef: channel.spec.sessionStorage.secretRef.name,
        }),
        ...(channel.spec.sessionStorage.pvc?.claimName !== undefined && {
          pvc: channel.spec.sessionStorage.pvc.claimName,
        }),
      },
    }),
    ...(channel.spec.whatsapp !== undefined && {
      whatsapp: {
        ...(channel.spec.whatsapp.authDir !== undefined && {
          authDir: channel.spec.whatsapp.authDir,
        }),
        ...(channel.spec.whatsapp.sendReadReceipts !== undefined && {
          sendReadReceipts: channel.spec.whatsapp.sendReadReceipts,
        }),
        ...(channel.spec.whatsapp.mediaMaxMb !== undefined && {
          mediaMaxMb: channel.spec.whatsapp.mediaMaxMb,
        }),
      },
    }),
    bindingCount: bindings.length,
    sessionCount: sessions.length,
    activeSessionCount,
    ...(channel.status?.lastHeartbeatAt !== undefined && {
      lastHeartbeatAt: channel.status.lastHeartbeatAt,
    }),
    ...(channel.metadata.creationTimestamp !== undefined && {
      createdAt: iso(channel.metadata.creationTimestamp),
    }),
  };
}

function channelDetail(channel: Channel, cache: SnapshotCache): ChannelDetail {
  return {
    ...summarizeChannel(channel, cache),
    bindings: bindingsFor(channel, cache).map(summarizeBinding).sort(compareBindings),
    sessions: sessionsFor(channel, cache)
      .map((session) => summarizeSession(session, cache))
      .sort(compareSessions),
  };
}

function bindingsFor(channel: Channel, cache: SnapshotCache): readonly ChannelBinding[] {
  const namespace = channel.metadata.namespace ?? 'default';
  const name = channel.metadata.name ?? '';
  return cache
    .listChannelBindings()
    .filter(
      (binding) =>
        (binding.metadata.namespace ?? 'default') === namespace &&
        binding.spec.channelRef.name === name,
    );
}

function sessionsFor(channel: Channel, cache: SnapshotCache): readonly ChannelSession[] {
  const namespace = channel.metadata.namespace ?? 'default';
  const name = channel.metadata.name ?? '';
  return cache
    .listChannelSessions()
    .filter(
      (session) =>
        (session.metadata.namespace ?? 'default') === namespace &&
        session.spec.channelRef.name === name,
    );
}

function summarizeBinding(binding: ChannelBinding): BindingSummary {
  return {
    namespace: binding.metadata.namespace ?? 'default',
    name: binding.metadata.name ?? '',
    paused: binding.spec.paused === true,
    default: binding.spec.default === true,
    ...(binding.spec.match !== undefined && {
      match: {
        ...(binding.spec.match.accountId !== undefined && {
          accountId: binding.spec.match.accountId,
        }),
        ...(binding.spec.match.peer !== undefined && {
          peer: {
            kind: binding.spec.match.peer.kind,
            id: binding.spec.match.peer.id,
          },
        }),
        ...(binding.spec.match.threadId !== undefined && {
          threadId: binding.spec.match.threadId,
        }),
      },
    }),
    target: summarizeTarget(binding.spec.target),
    ...(binding.spec.approval !== undefined && {
      approval: {
        required: binding.spec.approval.required === true,
        ...(binding.spec.approval.mode !== undefined && { mode: binding.spec.approval.mode }),
      },
    }),
    ...(binding.status?.lastMatchedAt !== undefined && {
      lastMatchedAt: binding.status.lastMatchedAt,
    }),
  };
}

function summarizeSession(session: ChannelSession, cache: SnapshotCache): ChannelSessionSummary {
  const lastTaskRef = session.status?.lastTaskRef;
  const task =
    lastTaskRef !== undefined ? cache.getTask(lastTaskRef.namespace, lastTaskRef.name) : undefined;
  return {
    namespace: session.metadata.namespace ?? 'default',
    name: session.metadata.name ?? '',
    ...(session.status?.phase !== undefined && { phase: session.status.phase }),
    provider: session.spec.provider,
    accountId: session.spec.accountId,
    peer: { kind: session.spec.peer.kind, id: session.spec.peer.id },
    ...(session.spec.threadId !== undefined && { threadId: session.spec.threadId }),
    ...(session.spec.bindingRef?.name !== undefined && {
      bindingRef: session.spec.bindingRef.name,
    }),
    target: summarizeTarget(session.spec.target),
    paused: session.spec.paused === true,
    ...(session.status?.lastInboundAt !== undefined && {
      lastInboundAt: session.status.lastInboundAt,
    }),
    ...(session.status?.lastOutboundAt !== undefined && {
      lastOutboundAt: session.status.lastOutboundAt,
    }),
    ...(session.status?.consecutiveFailures !== undefined && {
      consecutiveFailures: session.status.consecutiveFailures,
    }),
    ...(session.status?.backoffUntil !== undefined && {
      backoffUntil: session.status.backoffUntil,
    }),
    ...(session.status?.lastFailureReason !== undefined && {
      lastFailureReason: session.status.lastFailureReason,
    }),
    ...(lastTaskRef !== undefined && {
      lastTask: taskRef(lastTaskRef, task),
    }),
  };
}

function summarizePolicy(policy: ChannelPolicy | undefined): ChannelPolicySummary {
  return {
    dmPolicy: policy?.dmPolicy ?? 'pairing',
    allowFrom: policy?.allowFrom ?? [],
    groupPolicy: policy?.groupPolicy ?? 'allowlist',
    groupAllowFrom: policy?.groupAllowFrom ?? [],
    groups: policy?.groups ?? [],
  };
}

function sanitizePairing(pairing: ChannelPairingStatus): SanitizedPairingStatus {
  return {
    state: pairing.state,
    qrAvailable: typeof pairing.qrCode === 'string' && pairing.qrCode.length > 0,
    pairingCodeAvailable: typeof pairing.pairingCode === 'string' && pairing.pairingCode.length > 0,
    ...(pairing.expiresAt !== undefined && { expiresAt: pairing.expiresAt }),
    ...(pairing.accountJid !== undefined && { accountJid: pairing.accountJid }),
    ...(pairing.message !== undefined && { message: pairing.message }),
  };
}

function summarizeTarget(target: ChannelBindingTarget): ChannelTargetSummary {
  return {
    ...(target.agentRef?.name !== undefined && { agentRef: target.agentRef.name }),
    ...(target.capability !== undefined && { capability: target.capability }),
    ...(target.profileRef !== undefined && { profileRef: target.profileRef }),
    ...(target.modelClass !== undefined && { modelClass: target.modelClass }),
    ...(target.toolProfileRef !== undefined && { toolProfileRef: target.toolProfileRef }),
    ...(target.runConfig !== undefined && {
      runConfig: numericRecord(target.runConfig as Record<string, unknown>),
    }),
    ...(target.session?.scope !== undefined && { sessionScope: target.session.scope }),
  };
}

function numericRecord(input: Record<string, unknown>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function taskRef(
  ref: { readonly namespace: string; readonly name: string; readonly uid?: string },
  task: AgentTask | undefined,
): NonNullable<ChannelSessionSummary['lastTask']> {
  return {
    namespace: ref.namespace,
    name: ref.name,
    uid: ref.uid ?? task?.metadata.uid ?? '',
    ...(task?.status?.phase !== undefined && { phase: task.status.phase }),
    ui: `/#/tasks/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`,
  };
}

function parsePatchBody(raw: unknown): { readonly paused: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const paused = (raw as { paused?: unknown }).paused;
  if (typeof paused !== 'boolean') return undefined;
  return { paused };
}

function extractK8sStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.response?.statusCode === 'number') return e.response.statusCode;
  return undefined;
}

function compareChannelSummaries(a: ChannelSummary, b: ChannelSummary): number {
  return a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
}

function compareBindings(a: BindingSummary, b: BindingSummary): number {
  if (a.default !== b.default) return a.default ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function compareSessions(a: ChannelSessionSummary, b: ChannelSessionSummary): number {
  const at = a.lastInboundAt ?? a.lastOutboundAt ?? '';
  const bt = b.lastInboundAt ?? b.lastOutboundAt ?? '';
  return bt.localeCompare(at) || a.name.localeCompare(b.name);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
