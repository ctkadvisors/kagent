/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Channel control-plane primitives.
 *
 * These CRD-facing types model external operator channels without
 * granting those channels any direct runtime authority. A channel
 * adapter may authenticate, normalize, and observe messages, but the
 * durable effect is still a bounded AgentTask routed through an
 * explicit ChannelBinding and recorded in a ChannelSession.
 */

import type { V1ObjectMeta } from '@kubernetes/client-node';

import {
  API_GROUP_VERSION,
  type AgentTask,
  type AgentTaskCondition,
  type AgentTaskRunConfig,
} from './types.js';

export const CHANNEL_LABEL = 'kagent.knuteson.io/channel' as const;
export const CHANNEL_ACCOUNT_LABEL = 'kagent.knuteson.io/channel-account' as const;
export const CHANNEL_PEER_KIND_LABEL = 'kagent.knuteson.io/channel-peer-kind' as const;
export const CHANNEL_PEER_HASH_LABEL = 'kagent.knuteson.io/channel-peer-hash' as const;
export const CHANNEL_SESSION_LABEL = 'kagent.knuteson.io/channel-session' as const;
export const CHANNEL_TURN_LABEL = 'kagent.knuteson.io/channel-turn' as const;
export const CHANNEL_PROVIDER_ANNOTATION = 'kagent.knuteson.io/channel-provider' as const;
export const CHANNEL_ACCOUNT_ANNOTATION = 'kagent.knuteson.io/channel-account' as const;
export const CHANNEL_PEER_ID_ANNOTATION = 'kagent.knuteson.io/channel-peer-id' as const;
export const CHANNEL_PEER_KIND_ANNOTATION = 'kagent.knuteson.io/channel-peer-kind' as const;
export const CHANNEL_THREAD_ANNOTATION = 'kagent.knuteson.io/channel-thread' as const;
export const CHANNEL_MESSAGE_ID_ANNOTATION = 'kagent.knuteson.io/channel-message-id' as const;
export const CHANNEL_BINDING_ANNOTATION = 'kagent.knuteson.io/channel-binding' as const;
export const CHANNEL_MESSAGE_ANNOTATION = 'kagent.knuteson.io/channel-message' as const;
export const CHANNEL_SESSION_KEY_ANNOTATION = 'kagent.knuteson.io/channel-session-key' as const;
export const CHANNEL_CREATED_BY = 'kagent-channel-controller' as const;
export const DEFAULT_CHANNEL_TIMEOUT_SECONDS = 300;
export const DEFAULT_CHANNEL_MAX_ITERATIONS = 8;

export type ChannelProvider = 'whatsapp' | 'workbench' | 'webhook' | (string & {});
export type ChannelPeerKind = 'dm' | 'group' | 'channel' | 'room';
export type ChannelDmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';
export type ChannelGroupPolicy = 'allowlist' | 'open' | 'disabled';

export interface ChannelLocalRef {
  readonly name: string;
}

export interface ChannelSecretKeyRef extends ChannelLocalRef {
  readonly key?: string;
}

export interface ChannelPvcRef {
  readonly claimName: string;
}

export interface ChannelPeer {
  readonly kind: ChannelPeerKind;
  readonly id: string;
}

export interface ChannelPolicy {
  /**
   * Direct-message policy. Defaults to `pairing`, matching the safer
   * WhatsApp/OpenClaw posture: unknown DM senders do not launch work
   * until a human pairs or allowlists them.
   */
  readonly dmPolicy?: ChannelDmPolicy;
  /** Sender allowlist for direct messages; `*` is an explicit wildcard. */
  readonly allowFrom?: readonly string[];
  /**
   * Group sender policy. Defaults to `allowlist` so a group mention
   * alone never bypasses sender authorization.
   */
  readonly groupPolicy?: ChannelGroupPolicy;
  /** Sender allowlist for group messages; falls back to allowFrom. */
  readonly groupAllowFrom?: readonly string[];
  /** Group/room allowlist. Omitted means every group is eligible. */
  readonly groups?: readonly string[];
}

export interface ChannelSessionStorage {
  /** Secret used by adapters that can persist compact auth material. */
  readonly secretRef?: ChannelLocalRef;
  /** PVC-backed auth/session directory for Web-style adapters. */
  readonly pvc?: ChannelPvcRef;
}

export interface ChannelWhatsAppSpec {
  /** Baileys/WhatsApp-Web auth directory inside the adapter pod. */
  readonly authDir?: string;
  /** Optional read-receipt behavior; adapter-specific but policy-visible. */
  readonly sendReadReceipts?: boolean;
  /** Maximum inbound/outbound media size accepted by this account. */
  readonly mediaMaxMb?: number;
}

export interface ChannelSpec {
  readonly provider: ChannelProvider;
  /** Per-provider account instance, e.g. OpenClaw's AccountId. */
  readonly accountId: string;
  readonly displayName?: string;
  /** Operator killswitch. When true, no inbound message may launch work. */
  readonly paused?: boolean;
  /** Provider credential or pairing bootstrap secret. */
  readonly authSecretRef?: ChannelSecretKeyRef;
  /** Durable adapter auth/session storage. */
  readonly sessionStorage?: ChannelSessionStorage;
  /** Inbound access and activation policy. */
  readonly policy?: ChannelPolicy;
  /** WhatsApp/Baileys-specific adapter settings. */
  readonly whatsapp?: ChannelWhatsAppSpec;
}

export type ChannelPhase = 'Pending' | 'Pairing' | 'Ready' | 'Paused' | 'Failed';

export interface ChannelPairingStatus {
  readonly state: 'unpaired' | 'qr' | 'paired' | 'failed';
  readonly qrCode?: string;
  readonly pairingCode?: string;
  readonly expiresAt?: string;
  readonly accountJid?: string;
  readonly message?: string;
}

export interface ChannelStatus {
  readonly phase?: ChannelPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly pairing?: ChannelPairingStatus;
  readonly lastHeartbeatAt?: string;
  readonly activeSessionCount?: number;
}

export interface Channel {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'Channel';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelSpec;
  readonly status?: ChannelStatus;
}

export interface ChannelBindingMatch {
  /**
   * Account instance selector. `*` matches any account on the channel
   * and ranks below a concrete account match.
   */
  readonly accountId?: string;
  /** Exact peer selector. A peer match without threadId inherits threads. */
  readonly peer?: ChannelPeer;
  /** Exact provider-native thread selector. */
  readonly threadId?: string;
}

export interface ChannelBindingTarget {
  readonly agentRef?: ChannelLocalRef;
  readonly capability?: string;
  readonly profileRef?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly runConfig?: AgentTaskRunConfig;
  readonly session?: {
    readonly scope?: 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';
    readonly mainKey?: string;
  };
}

export interface ChannelBindingSpec {
  readonly channelRef: ChannelLocalRef;
  readonly match?: ChannelBindingMatch;
  /** Final fallback for this channel, below channel/account/peer matches. */
  readonly default?: boolean;
  /** Binding-local killswitch; route selection skips paused bindings. */
  readonly paused?: boolean;
  readonly target: ChannelBindingTarget;
  readonly approval?: {
    readonly required?: boolean;
    readonly mode?: 'operator' | 'per-turn' | 'tool';
  };
}

export interface ChannelBindingStatus {
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly lastMatchedAt?: string;
}

export interface ChannelBinding {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ChannelBinding';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelBindingSpec;
  readonly status?: ChannelBindingStatus;
}

export type ChannelSessionPhase = 'Pending' | 'Active' | 'Paused' | 'Backoff' | 'Failed';

export interface ChannelTaskRef {
  readonly namespace: string;
  readonly name: string;
  readonly uid?: string;
}

export interface ChannelSessionSpec {
  readonly channelRef: ChannelLocalRef;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly sessionKey: string;
  readonly bindingRef?: ChannelLocalRef;
  readonly target: ChannelBindingTarget;
  readonly paused?: boolean;
}

export interface ChannelSessionStatus {
  readonly phase?: ChannelSessionPhase;
  readonly observedGeneration?: number;
  readonly conditions?: readonly AgentTaskCondition[];
  readonly lastInboundAt?: string;
  readonly lastOutboundAt?: string;
  readonly lastTaskRef?: ChannelTaskRef;
  readonly consecutiveFailures?: number;
  readonly backoffUntil?: string;
  readonly lastFailureReason?: string;
}

export interface ChannelSession {
  readonly apiVersion: typeof API_GROUP_VERSION;
  readonly kind: 'ChannelSession';
  readonly metadata: V1ObjectMeta;
  readonly spec: ChannelSessionSpec;
  readonly status?: ChannelSessionStatus;
}

export interface ChannelInboundEnvelope {
  readonly channelName: string;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly sender?: { readonly id: string; readonly displayName?: string };
  readonly messageId: string;
  readonly text: string;
}

export type ChannelPolicyDenyReason =
  | 'channel_paused'
  | 'dm_disabled'
  | 'dm_open_requires_wildcard'
  | 'dm_sender_not_allowed'
  | 'pairing_required'
  | 'group_disabled'
  | 'group_not_allowed'
  | 'group_sender_not_allowed';

export type ChannelPolicyDecision =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: ChannelPolicyDenyReason };

export interface ChannelRoute {
  readonly binding: ChannelBinding;
  readonly target: ChannelBindingTarget;
  readonly score: number;
}

export interface ChannelSessionIdentity {
  readonly channelName: string;
  readonly provider: ChannelProvider;
  readonly accountId: string;
  readonly peer: ChannelPeer;
  readonly threadId?: string;
  readonly targetAgent: string;
}

export interface BuildChannelTurnAgentTaskInput {
  readonly namespace: string;
  readonly name?: string;
  readonly generateName?: string;
  readonly route: Pick<ChannelRoute, 'binding' | 'target'>;
  readonly inbound: ChannelInboundEnvelope;
}

export function isChannel(obj: unknown): obj is Channel {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'Channel') return false;
  const spec = o.spec as { provider?: unknown; accountId?: unknown } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (!isNonEmptyString(spec.provider)) return false;
  if (!isNonEmptyString(spec.accountId)) return false;
  return true;
}

export function isChannelBinding(obj: unknown): obj is ChannelBinding {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'ChannelBinding') return false;
  const spec = o.spec as {
    channelRef?: { name?: unknown };
    target?: unknown;
  } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (!isNonEmptyString(spec.channelRef?.name)) return false;
  if (!isValidTarget(spec.target)) return false;
  return true;
}

export function isChannelSession(obj: unknown): obj is ChannelSession {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as { apiVersion?: unknown; kind?: unknown; spec?: unknown };
  if (o.apiVersion !== API_GROUP_VERSION) return false;
  if (o.kind !== 'ChannelSession') return false;
  const spec = o.spec as {
    channelRef?: { name?: unknown };
    provider?: unknown;
    accountId?: unknown;
    peer?: unknown;
    sessionKey?: unknown;
    target?: unknown;
  } | null;
  if (typeof spec !== 'object' || spec === null) return false;
  if (!isNonEmptyString(spec.channelRef?.name)) return false;
  if (!isNonEmptyString(spec.provider)) return false;
  if (!isNonEmptyString(spec.accountId)) return false;
  if (!isPeer(spec.peer)) return false;
  if (!isNonEmptyString(spec.sessionKey)) return false;
  if (!isValidTarget(spec.target)) return false;
  return true;
}

export function evaluateChannelInboundPolicy(
  channel: Channel,
  inbound: ChannelInboundEnvelope,
): ChannelPolicyDecision {
  if (channel.spec.paused === true) return { allowed: false, reason: 'channel_paused' };

  const policy = channel.spec.policy ?? {};
  if (inbound.peer.kind === 'dm') {
    const dmPolicy = policy.dmPolicy ?? 'pairing';
    if (dmPolicy === 'disabled') return { allowed: false, reason: 'dm_disabled' };
    const allowFrom = policy.allowFrom ?? [];
    if (containsPrincipal(allowFrom, inbound.peer.id)) return { allowed: true, reason: 'allowed' };
    if (dmPolicy === 'open') {
      return containsPrincipal(allowFrom, '*')
        ? { allowed: true, reason: 'allowed' }
        : { allowed: false, reason: 'dm_open_requires_wildcard' };
    }
    if (dmPolicy === 'pairing') return { allowed: false, reason: 'pairing_required' };
    return { allowed: false, reason: 'dm_sender_not_allowed' };
  }

  if (inbound.peer.kind === 'group') {
    const groupPolicy = policy.groupPolicy ?? 'allowlist';
    if (groupPolicy === 'disabled') return { allowed: false, reason: 'group_disabled' };
    const groups = policy.groups ?? [];
    if (groups.length > 0 && !containsPrincipal(groups, inbound.peer.id)) {
      return { allowed: false, reason: 'group_not_allowed' };
    }
    if (groupPolicy === 'open') return { allowed: true, reason: 'allowed' };
    const allowedSenders =
      policy.groupAllowFrom !== undefined && policy.groupAllowFrom.length > 0
        ? policy.groupAllowFrom
        : (policy.allowFrom ?? []);
    const senderId = inbound.sender?.id;
    if (senderId !== undefined && containsPrincipal(allowedSenders, senderId)) {
      return { allowed: true, reason: 'allowed' };
    }
    return { allowed: false, reason: 'group_sender_not_allowed' };
  }

  return { allowed: true, reason: 'allowed' };
}

export function routeChannelInbound(
  bindings: readonly ChannelBinding[],
  inbound: ChannelInboundEnvelope,
): ChannelRoute | undefined {
  const candidates: ChannelRoute[] = [];
  for (const binding of bindings) {
    const score = routeScore(binding, inbound);
    if (score === null) continue;
    candidates.push({ binding, target: binding.spec.target, score });
  }
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return (a.binding.metadata.name ?? '').localeCompare(b.binding.metadata.name ?? '');
  });
  return candidates[0];
}

export function sessionKeyForChannelRoute(
  route: Pick<ChannelRoute, 'binding' | 'target'>,
  inbound: ChannelInboundEnvelope,
): string {
  const targetAgent = targetIdentity(route.target);
  const session = route.target.session;
  const scope = session?.scope ?? 'per-account-channel-peer';
  const thread = inbound.threadId === undefined ? '' : `:thread:${inbound.threadId}`;

  if (scope === 'main') {
    return `agent:${targetAgent}:${session?.mainKey ?? 'main'}${thread}`;
  }
  if (scope === 'per-peer') {
    return `agent:${targetAgent}:${inbound.peer.kind}:${inbound.peer.id}${thread}`;
  }
  if (scope === 'per-channel-peer') {
    return `agent:${targetAgent}:channel:${inbound.channelName}:${inbound.peer.kind}:${inbound.peer.id}${thread}`;
  }
  return `agent:${targetAgent}:channel:${inbound.channelName}:account:${inbound.accountId}:${inbound.peer.kind}:${inbound.peer.id}${thread}`;
}

export function channelSessionName(input: ChannelSessionIdentity): string {
  const identity = [
    input.channelName,
    input.provider,
    input.accountId,
    input.peer.kind,
    input.peer.id,
    input.threadId ?? '',
    input.targetAgent,
  ].join('\u001f');
  const hash = fnv1aHex(identity);
  const base = slug(input.channelName || input.provider || 'channel');
  if (base.length === 0) return `kcs-${hash}`;
  return `kcs-${base.slice(0, 50)}-${hash}`.slice(0, 63);
}

export function buildChannelTurnAgentTask(input: BuildChannelTurnAgentTaskInput): AgentTask {
  const targetName = targetIdentity(input.route.target);
  const sessionKey = sessionKeyForChannelRoute(input.route, input.inbound);
  const sessionName = channelSessionName({
    channelName: input.inbound.channelName,
    provider: input.inbound.provider,
    accountId: input.inbound.accountId,
    peer: input.inbound.peer,
    ...(input.inbound.threadId !== undefined && { threadId: input.inbound.threadId }),
    targetAgent: targetName,
  });
  const turnName = input.name ?? input.generateName ?? 'channel-turn';
  const metadata: AgentTask['metadata'] = {
    namespace: input.namespace,
    labels: {
      'app.kubernetes.io/created-by': CHANNEL_CREATED_BY,
      'kagent.knuteson.io/managed-by': 'kagent-operator',
      [CHANNEL_LABEL]: safeLabelValue(input.inbound.channelName),
      [CHANNEL_ACCOUNT_LABEL]: safeLabelValue(input.inbound.accountId),
      [CHANNEL_PEER_KIND_LABEL]: input.inbound.peer.kind,
      [CHANNEL_PEER_HASH_LABEL]: fnv1aHex(`${input.inbound.peer.kind}:${input.inbound.peer.id}`),
      [CHANNEL_SESSION_LABEL]: sessionName,
      [CHANNEL_TURN_LABEL]: safeLabelValue(turnName),
    },
    annotations: {
      [CHANNEL_PROVIDER_ANNOTATION]: input.inbound.provider,
      [CHANNEL_ACCOUNT_ANNOTATION]: input.inbound.accountId,
      [CHANNEL_PEER_KIND_ANNOTATION]: input.inbound.peer.kind,
      [CHANNEL_PEER_ID_ANNOTATION]: input.inbound.peer.id,
      [CHANNEL_MESSAGE_ID_ANNOTATION]: input.inbound.messageId,
      [CHANNEL_BINDING_ANNOTATION]: input.route.binding.metadata.name ?? '',
      [CHANNEL_MESSAGE_ANNOTATION]: input.inbound.text,
      [CHANNEL_SESSION_KEY_ANNOTATION]: sessionKey,
      ...(input.inbound.threadId !== undefined && {
        [CHANNEL_THREAD_ANNOTATION]: input.inbound.threadId,
      }),
    },
  };
  if (input.name !== undefined) {
    metadata.name = input.name;
  } else {
    metadata.generateName = input.generateName ?? 'channel-turn-';
  }

  const target = input.route.target;
  if (target.agentRef === undefined && target.capability === undefined) {
    throw new Error('ChannelBinding target must resolve to agentRef or capability');
  }

  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata,
    spec: {
      ...(target.agentRef !== undefined && { targetAgent: target.agentRef.name }),
      ...(target.capability !== undefined && { targetCapability: target.capability }),
      originalUserMessage: formatChannelUserMessage(input.inbound),
      payload: {
        channel: input.inbound.channelName,
        provider: input.inbound.provider,
        accountId: input.inbound.accountId,
        peer: input.inbound.peer,
        ...(input.inbound.threadId !== undefined && { threadId: input.inbound.threadId }),
        ...(input.inbound.sender !== undefined && { sender: input.inbound.sender }),
        messageId: input.inbound.messageId,
        text: input.inbound.text,
        sessionName,
        sessionKey,
        binding: input.route.binding.metadata.name ?? '',
        profileRef: target.profileRef,
      },
      runConfig: boundedRunConfig(target.runConfig),
      idempotencyKey: channelIdempotencyKey(input.inbound),
    },
  };
}

function routeScore(binding: ChannelBinding, inbound: ChannelInboundEnvelope): number | null {
  if (binding.spec.paused === true) return null;
  if (binding.spec.channelRef.name !== inbound.channelName) return null;

  const match = binding.spec.match ?? {};
  let score = binding.spec.default === true ? 0 : 20;

  if (match.accountId !== undefined) {
    if (match.accountId !== '*' && match.accountId !== inbound.accountId) return null;
    score += match.accountId === '*' ? 20 : 40;
  }

  if (match.peer !== undefined) {
    if (match.peer.kind !== inbound.peer.kind || match.peer.id !== inbound.peer.id) return null;
    score += 80;
  }

  if (match.threadId !== undefined) {
    if (match.threadId !== inbound.threadId) return null;
    score += 100;
  }

  return score;
}

function targetIdentity(target: ChannelBindingTarget): string {
  if (target.agentRef !== undefined) return target.agentRef.name;
  if (target.capability !== undefined) return `cap:${target.capability}`;
  if (target.profileRef !== undefined) return `profile:${target.profileRef}`;
  return 'default';
}

function boundedRunConfig(runConfig: AgentTaskRunConfig | undefined): AgentTaskRunConfig {
  return {
    timeoutSeconds: runConfig?.timeoutSeconds ?? DEFAULT_CHANNEL_TIMEOUT_SECONDS,
    maxIterations: runConfig?.maxIterations ?? DEFAULT_CHANNEL_MAX_ITERATIONS,
    ...(runConfig?.tokenLimit !== undefined && { tokenLimit: runConfig.tokenLimit }),
    ...(runConfig?.costLimitUsd !== undefined && { costLimitUsd: runConfig.costLimitUsd }),
    ...(runConfig?.traceparent !== undefined && { traceparent: runConfig.traceparent }),
  };
}

function formatChannelUserMessage(inbound: ChannelInboundEnvelope): string {
  const lines = [
    `Channel: ${inbound.channelName}`,
    `Provider: ${inbound.provider}`,
    `Account: ${inbound.accountId}`,
    `Peer: ${inbound.peer.kind}:${inbound.peer.id}`,
  ];
  if (inbound.threadId !== undefined) lines.push(`Thread: ${inbound.threadId}`);
  if (inbound.sender !== undefined) {
    lines.push(
      `Sender: ${inbound.sender.id}${inbound.sender.displayName ? ` (${inbound.sender.displayName})` : ''}`,
    );
  }
  lines.push('', `Message:\n${inbound.text}`);
  return lines.join('\n');
}

function channelIdempotencyKey(inbound: ChannelInboundEnvelope): string {
  return `channel:${fnv1aHex(
    [
      inbound.channelName,
      inbound.provider,
      inbound.accountId,
      inbound.peer.kind,
      inbound.peer.id,
      inbound.threadId ?? '',
      inbound.messageId,
    ].join('\u001f'),
  )}`;
}

function isValidTarget(target: unknown): target is ChannelBindingTarget {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as {
    agentRef?: { name?: unknown };
    capability?: unknown;
    profileRef?: unknown;
    modelClass?: unknown;
    toolProfileRef?: unknown;
  };
  if (t.agentRef !== undefined && !isNonEmptyString(t.agentRef.name)) return false;
  if (t.capability !== undefined && !isNonEmptyString(t.capability)) return false;
  if (t.profileRef !== undefined && !isNonEmptyString(t.profileRef)) return false;
  if (t.modelClass !== undefined && !isNonEmptyString(t.modelClass)) return false;
  if (t.toolProfileRef !== undefined && !isNonEmptyString(t.toolProfileRef)) return false;
  return (
    isNonEmptyString(t.agentRef?.name) ||
    isNonEmptyString(t.capability) ||
    isNonEmptyString(t.profileRef)
  );
}

function isPeer(value: unknown): value is ChannelPeer {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as { kind?: unknown; id?: unknown };
  return isPeerKind(p.kind) && isNonEmptyString(p.id);
}

function isPeerKind(value: unknown): value is ChannelPeerKind {
  return value === 'dm' || value === 'group' || value === 'channel' || value === 'room';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function containsPrincipal(allowlist: readonly string[], principal: string): boolean {
  const normalized = normalizePrincipal(principal);
  for (const entry of allowlist) {
    if (entry === '*') return true;
    if (normalizePrincipal(entry) === normalized) return true;
  }
  return false;
}

function normalizePrincipal(value: string): string {
  return value.trim().toLowerCase();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function safeLabelValue(value: string): string {
  if (value.length <= 63 && /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value)) {
    return value;
  }
  const base = slug(value);
  const hash = fnv1aHex(value);
  if (base.length === 0) return hash;
  return `${base.slice(0, 54)}-${hash}`.slice(0, 63);
}

function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
