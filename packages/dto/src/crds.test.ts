/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  API_GROUP_VERSION,
  isChannel,
  isChannelBinding,
  isChannelSession,
  type Channel,
  type ChannelBinding,
  type ChannelSession,
} from './crds.js';

const channel: Channel = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Channel',
  metadata: { name: 'whatsapp-work', namespace: 'kagent-system' },
  spec: {
    provider: 'whatsapp',
    accountId: 'work',
    policy: {
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
    },
  },
  status: {
    phase: 'Pairing',
    pairing: { state: 'qr', qrCode: 'sensitive-qr-data' },
  },
};

const binding: ChannelBinding = {
  apiVersion: API_GROUP_VERSION,
  kind: 'ChannelBinding',
  metadata: { name: 'whatsapp-default', namespace: 'kagent-system' },
  spec: {
    channelRef: { name: 'whatsapp-work' },
    default: true,
    target: {
      agentRef: { name: 'operator-investigator' },
      runConfig: { timeoutSeconds: 600, maxIterations: 6 },
    },
  },
};

const session: ChannelSession = {
  apiVersion: API_GROUP_VERSION,
  kind: 'ChannelSession',
  metadata: { name: 'kcs-whatsapp-work-a1b2c3d4', namespace: 'kagent-system' },
  spec: {
    channelRef: { name: 'whatsapp-work' },
    provider: 'whatsapp',
    accountId: 'work',
    peer: { kind: 'dm', id: '+15551234567' },
    sessionKey: 'agent:operator-investigator:channel:whatsapp-work:account:work:dm:+15551234567',
    bindingRef: { name: 'whatsapp-default' },
    target: { agentRef: { name: 'operator-investigator' } },
  },
  status: {
    phase: 'Active',
    lastInboundAt: '2026-06-12T12:00:00Z',
    lastTaskRef: { namespace: 'kagent-system', name: 'channel-turn-abc', uid: 'task-uid' },
    lastOutboundTaskRef: {
      namespace: 'kagent-system',
      name: 'channel-turn-previous',
      uid: 'task-uid-previous',
    },
  },
};

describe('channel CRD guards', () => {
  it('accepts valid Channel, ChannelBinding, and ChannelSession resources', () => {
    expect(isChannel(channel)).toBe(true);
    expect(isChannelBinding(binding)).toBe(true);
    expect(isChannelSession(session)).toBe(true);
  });

  it('rejects malformed Channel resources', () => {
    expect(isChannel({ ...channel, apiVersion: 'kagent.knuteson.io/v2alpha1' })).toBe(false);
    expect(isChannel({ ...channel, kind: 'Agent' })).toBe(false);
    expect(isChannel({ ...channel, spec: { provider: '', accountId: 'work' } })).toBe(false);
    expect(isChannel({ ...channel, spec: { provider: 'whatsapp', accountId: '' } })).toBe(false);
  });

  it('rejects malformed ChannelBinding resources', () => {
    expect(
      isChannelBinding({ ...binding, spec: { ...binding.spec, channelRef: { name: '' } } }),
    ).toBe(false);
    expect(isChannelBinding({ ...binding, spec: { ...binding.spec, target: {} } })).toBe(false);
    expect(
      isChannelBinding({
        ...binding,
        spec: { ...binding.spec, target: { agentRef: { name: '' } } },
      }),
    ).toBe(false);
  });

  it('rejects malformed ChannelSession resources', () => {
    expect(isChannelSession({ ...session, spec: { ...session.spec, sessionKey: '' } })).toBe(false);
    expect(
      isChannelSession({ ...session, spec: { ...session.spec, peer: { kind: 'sms', id: 'x' } } }),
    ).toBe(false);
    expect(isChannelSession({ ...session, spec: { ...session.spec, target: {} } })).toBe(false);
  });
});
