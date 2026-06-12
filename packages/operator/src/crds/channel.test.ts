/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildChannelTurnAgentTask,
  channelSessionName,
  evaluateChannelInboundPolicy,
  isChannel,
  isChannelBinding,
  isChannelSession,
  routeChannelInbound,
  sessionKeyForChannelRoute,
} from './channel.js';
import type { Channel, ChannelBinding, ChannelInboundEnvelope, ChannelSession } from './channel.js';
import { API_GROUP_VERSION } from './types.js';

const baseChannel: Channel = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Channel',
  metadata: { name: 'whatsapp-work', namespace: 'kagent-system' },
  spec: {
    provider: 'whatsapp',
    accountId: 'work',
    authSecretRef: { name: 'wa-work-auth' },
    sessionStorage: { pvc: { claimName: 'wa-work-auth' } },
    policy: {
      dmPolicy: 'allowlist',
      allowFrom: ['+15551234567'],
      groupPolicy: 'allowlist',
      groupAllowFrom: ['+15557654321'],
      groups: ['120363403215116621@g.us'],
    },
  },
};

const inboundDm: ChannelInboundEnvelope = {
  channelName: 'whatsapp-work',
  provider: 'whatsapp',
  accountId: 'work',
  peer: { kind: 'dm', id: '+15551234567' },
  messageId: 'msg-1',
  text: 'status?',
};

describe('Channel CRD guards', () => {
  it('accepts minimal valid channel resources', () => {
    expect(isChannel(baseChannel)).toBe(true);
  });

  it('rejects malformed channel resources', () => {
    expect(isChannel(null)).toBe(false);
    expect(isChannel({ ...baseChannel, apiVersion: 'kagent.knuteson.io/v2alpha1' })).toBe(false);
    expect(isChannel({ ...baseChannel, kind: 'Agent' })).toBe(false);
    expect(isChannel({ ...baseChannel, spec: { provider: '', accountId: 'work' } })).toBe(false);
    expect(isChannel({ ...baseChannel, spec: { provider: 'whatsapp', accountId: '' } })).toBe(
      false,
    );
  });

  it('accepts channel bindings that select a target agent profile', () => {
    const binding: ChannelBinding = {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'work-dm', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: { accountId: 'work', peer: { kind: 'dm', id: '+15551234567' } },
        target: {
          agentRef: { name: 'incident-investigator' },
          profileRef: 'incident-local-tools',
          modelClass: 'tool-caller-local',
          toolProfileRef: 'browser-code-local',
          runConfig: { maxIterations: 8, timeoutSeconds: 600, costLimitUsd: 0 },
        },
      },
    };

    expect(isChannelBinding(binding)).toBe(true);
    expect(isChannelBinding({ ...binding, spec: { ...binding.spec, target: {} } })).toBe(false);
  });

  it('accepts channel sessions with status isolation and backoff state', () => {
    const session: ChannelSession = {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelSession',
      metadata: { name: 'kcs-abc', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        provider: 'whatsapp',
        accountId: 'work',
        peer: { kind: 'dm', id: '+15551234567' },
        sessionKey:
          'agent:incident-investigator:channel:whatsapp-work:account:work:dm:+15551234567',
        target: { agentRef: { name: 'incident-investigator' }, profileRef: 'incident-local-tools' },
      },
      status: {
        phase: 'Backoff',
        consecutiveFailures: 3,
        backoffUntil: '2026-06-12T16:30:00.000Z',
        lastTaskRef: { namespace: 'kagent-system', name: 'kat-123', uid: 'uid-1' },
      },
    };

    expect(isChannelSession(session)).toBe(true);
    expect(isChannelSession({ ...session, spec: { ...session.spec, sessionKey: '' } })).toBe(false);
  });
});

describe('evaluateChannelInboundPolicy', () => {
  it('allows configured direct-message senders', () => {
    expect(evaluateChannelInboundPolicy(baseChannel, inboundDm)).toEqual({
      allowed: true,
      reason: 'allowed',
    });
  });

  it('denies direct-message senders outside allowlist', () => {
    expect(
      evaluateChannelInboundPolicy(baseChannel, {
        ...inboundDm,
        peer: { kind: 'dm', id: '+15550000000' },
      }),
    ).toEqual({ allowed: false, reason: 'dm_sender_not_allowed' });
  });

  it('returns pairing_required for unknown senders under pairing policy', () => {
    expect(
      evaluateChannelInboundPolicy(
        {
          ...baseChannel,
          spec: {
            ...baseChannel.spec,
            policy: { ...baseChannel.spec.policy, dmPolicy: 'pairing', allowFrom: [] },
          },
        },
        inboundDm,
      ),
    ).toEqual({ allowed: false, reason: 'pairing_required' });
  });

  it('blocks all inbound messages while the channel is paused', () => {
    expect(
      evaluateChannelInboundPolicy(
        { ...baseChannel, spec: { ...baseChannel.spec, paused: true } },
        inboundDm,
      ),
    ).toEqual({ allowed: false, reason: 'channel_paused' });
  });

  it('gates group messages by group allowlist and sender allowlist', () => {
    const allowedGroup: ChannelInboundEnvelope = {
      ...inboundDm,
      peer: { kind: 'group', id: '120363403215116621@g.us' },
      sender: { id: '+15557654321' },
    };
    expect(evaluateChannelInboundPolicy(baseChannel, allowedGroup)).toEqual({
      allowed: true,
      reason: 'allowed',
    });
    expect(
      evaluateChannelInboundPolicy(baseChannel, {
        ...allowedGroup,
        sender: { id: '+15550000000' },
      }),
    ).toEqual({ allowed: false, reason: 'group_sender_not_allowed' });
    expect(
      evaluateChannelInboundPolicy(baseChannel, {
        ...allowedGroup,
        peer: { kind: 'group', id: '120363403999999999@g.us' },
      }),
    ).toEqual({ allowed: false, reason: 'group_not_allowed' });
  });
});

describe('routeChannelInbound', () => {
  const bindings: readonly ChannelBinding[] = [
    {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'z-channel-default', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: {},
        default: true,
        target: { agentRef: { name: 'general-operator' }, profileRef: 'general' },
      },
    },
    {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'account-work', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: { accountId: 'work' },
        target: { agentRef: { name: 'work-router' }, profileRef: 'work' },
      },
    },
    {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'peer-incident', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: { accountId: 'work', peer: { kind: 'dm', id: '+15551234567' } },
        target: { agentRef: { name: 'incident-investigator' }, profileRef: 'incident' },
      },
    },
    {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'thread-deploy', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: {
          accountId: 'work',
          peer: { kind: 'dm', id: '+15551234567' },
          threadId: 'deploy-42',
        },
        target: { agentRef: { name: 'deploy-specialist' }, profileRef: 'deploy' },
      },
    },
  ];

  it('chooses exact thread before peer, account, and channel default', () => {
    const routed = routeChannelInbound(bindings, { ...inboundDm, threadId: 'deploy-42' });
    expect(routed?.binding.metadata.name).toBe('thread-deploy');
    expect(routed?.target.agentRef?.name).toBe('deploy-specialist');
  });

  it('inherits peer binding for another thread when no exact thread binding exists', () => {
    const routed = routeChannelInbound(bindings, { ...inboundDm, threadId: 'other-thread' });
    expect(routed?.binding.metadata.name).toBe('peer-incident');
    expect(routed?.target.agentRef?.name).toBe('incident-investigator');
  });

  it('falls back from account binding to channel default deterministically', () => {
    const accountRoute = routeChannelInbound(bindings, {
      ...inboundDm,
      peer: { kind: 'dm', id: '+15559990000' },
    });
    expect(accountRoute?.binding.metadata.name).toBe('account-work');

    const defaultRoute = routeChannelInbound(bindings, {
      ...inboundDm,
      accountId: 'personal',
      peer: { kind: 'dm', id: '+15559990000' },
    });
    expect(defaultRoute?.binding.metadata.name).toBe('z-channel-default');
  });

  it('breaks equal-score ties by binding name for stable routing', () => {
    const routed = routeChannelInbound(
      [
        {
          ...bindings[1],
          metadata: { name: 'b-account', namespace: 'kagent-system' },
        },
        {
          ...bindings[1],
          metadata: { name: 'a-account', namespace: 'kagent-system' },
          spec: { ...bindings[1].spec, target: { agentRef: { name: 'a' } } },
        },
      ],
      inboundDm,
    );
    expect(routed?.binding.metadata.name).toBe('a-account');
  });
});

describe('session keys', () => {
  it('isolates sessions by channel/account/peer/thread', () => {
    const base = routeChannelInbound(
      [
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'ChannelBinding',
          metadata: { name: 'peer-incident', namespace: 'kagent-system' },
          spec: {
            channelRef: { name: 'whatsapp-work' },
            match: { accountId: 'work' },
            target: { agentRef: { name: 'incident-investigator' }, profileRef: 'incident' },
          },
        },
      ],
      inboundDm,
    );
    expect(base).toBeDefined();
    const key = sessionKeyForChannelRoute(base!, inboundDm);
    expect(key).toBe(
      'agent:incident-investigator:channel:whatsapp-work:account:work:dm:+15551234567',
    );
    expect(sessionKeyForChannelRoute(base!, { ...inboundDm, accountId: 'personal' })).not.toBe(key);
    expect(
      sessionKeyForChannelRoute(base!, {
        ...inboundDm,
        peer: { kind: 'dm', id: '+15559990000' },
      }),
    ).not.toBe(key);
    expect(sessionKeyForChannelRoute(base!, { ...inboundDm, threadId: 'deploy-42' })).toBe(
      `${key}:thread:deploy-42`,
    );
  });

  it('generates stable DNS-label ChannelSession names from long route identities', () => {
    const a = channelSessionName({
      channelName: 'whatsapp-production-account-with-a-long-name',
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'group', id: '120363403215116621@g.us' },
      threadId: 'incident-thread-with-a-long-provider-native-id-1234567890',
      targetAgent: 'incident-investigator',
    });
    const b = channelSessionName({
      channelName: 'whatsapp-production-account-with-a-long-name',
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'group', id: '120363403215116621@g.us' },
      threadId: 'incident-thread-with-a-long-provider-native-id-1234567890',
      targetAgent: 'incident-investigator',
    });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).toMatch(/^kcs-[a-z0-9-]+$/);
  });
});

describe('buildChannelTurnAgentTask', () => {
  it('creates a bounded channel-labelled AgentTask for an inbound WhatsApp turn', () => {
    const binding: ChannelBinding = {
      apiVersion: API_GROUP_VERSION,
      kind: 'ChannelBinding',
      metadata: { name: 'incident-dm', namespace: 'kagent-system' },
      spec: {
        channelRef: { name: 'whatsapp-work' },
        match: { accountId: 'work', peer: { kind: 'dm', id: '+15551234567' } },
        target: {
          agentRef: { name: 'incident-investigator' },
          profileRef: 'incident-local-tools',
          modelClass: 'tool-caller-local',
          toolProfileRef: 'browser-code-local',
          runConfig: { timeoutSeconds: 900 },
        },
      },
    };
    const route = routeChannelInbound([binding], inboundDm);
    expect(route).toBeDefined();

    const task = buildChannelTurnAgentTask({
      namespace: 'kagent-system',
      name: 'wa-turn-1',
      route: route!,
      inbound: inboundDm,
    });

    expect(task.kind).toBe('AgentTask');
    expect(task.metadata.name).toBe('wa-turn-1');
    expect(task.metadata.namespace).toBe('kagent-system');
    expect(task.metadata.labels).toMatchObject({
      'app.kubernetes.io/created-by': 'kagent-channel-controller',
      'kagent.knuteson.io/channel': 'whatsapp-work',
      'kagent.knuteson.io/channel-account': 'work',
      'kagent.knuteson.io/channel-peer-kind': 'dm',
      'kagent.knuteson.io/channel-session': channelSessionName({
        channelName: 'whatsapp-work',
        provider: 'whatsapp',
        accountId: 'work',
        peer: { kind: 'dm', id: '+15551234567' },
        targetAgent: 'incident-investigator',
      }),
    });
    expect(task.metadata.annotations).toMatchObject({
      'kagent.knuteson.io/channel-provider': 'whatsapp',
      'kagent.knuteson.io/channel-peer-id': '+15551234567',
      'kagent.knuteson.io/channel-message-id': 'msg-1',
      'kagent.knuteson.io/channel-binding': 'incident-dm',
      'kagent.knuteson.io/channel-message': 'status?',
    });
    expect(task.spec.targetAgent).toBe('incident-investigator');
    expect(task.spec.targetCapability).toBeUndefined();
    expect(task.spec.originalUserMessage).toContain('Channel: whatsapp-work');
    expect(task.spec.originalUserMessage).toContain('Peer: dm:+15551234567');
    expect(task.spec.originalUserMessage).toContain('Message:\nstatus?');
    expect(task.spec.payload).toMatchObject({
      channel: 'whatsapp-work',
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'dm', id: '+15551234567' },
      messageId: 'msg-1',
      text: 'status?',
    });
    expect(task.spec.runConfig).toEqual({
      timeoutSeconds: 900,
      maxIterations: 8,
    });
    expect(task.spec.idempotencyKey).toMatch(/^channel:/);
  });

  it('targets a capability when the binding target is capability based', () => {
    const route = routeChannelInbound(
      [
        {
          apiVersion: API_GROUP_VERSION,
          kind: 'ChannelBinding',
          metadata: { name: 'capability-route', namespace: 'kagent-system' },
          spec: {
            channelRef: { name: 'whatsapp-work' },
            match: { accountId: 'work' },
            target: { capability: 'incident-investigation', runConfig: { maxIterations: 3 } },
          },
        },
      ],
      inboundDm,
    );
    expect(route).toBeDefined();

    const task = buildChannelTurnAgentTask({
      namespace: 'kagent-system',
      generateName: 'wa-turn-',
      route: route!,
      inbound: inboundDm,
    });

    expect(task.metadata.generateName).toBe('wa-turn-');
    expect(task.spec.targetAgent).toBeUndefined();
    expect(task.spec.targetCapability).toBe('incident-investigation');
    expect(task.spec.runConfig).toEqual({
      timeoutSeconds: 300,
      maxIterations: 3,
    });
  });
});
