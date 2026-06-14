/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { ExternalChannelDetail, ExternalChannelSummary } from './types.js';

vi.mock('./api.js', () => ({
  fetchChannelDetail: vi.fn(),
  fetchChannels: vi.fn(),
  setChannelPaused: vi.fn(),
  subscribeCacheEvents: vi.fn(),
}));

import {
  fetchChannelDetail,
  fetchChannels,
  setChannelPaused,
  subscribeCacheEvents,
} from './api.js';
import { ChannelsPage } from './ChannelsPage.js';

const mockFetchChannels = fetchChannels as ReturnType<typeof vi.fn>;
const mockFetchChannelDetail = fetchChannelDetail as ReturnType<typeof vi.fn>;
const mockSetChannelPaused = setChannelPaused as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;

function makeChannel(overrides: Partial<ExternalChannelSummary> = {}): ExternalChannelSummary {
  return {
    id: 'kagent-system/whatsapp-work',
    namespace: 'kagent-system',
    name: 'whatsapp-work',
    displayName: 'Work WhatsApp',
    provider: 'whatsapp',
    accountId: 'work',
    paused: false,
    phase: 'Pairing',
    pairing: {
      state: 'qr',
      qrAvailable: true,
      pairingCodeAvailable: false,
      expiresAt: '2026-06-12T10:05:00Z',
      message: 'scan pending',
    },
    policy: {
      dmPolicy: 'pairing',
      allowFrom: ['+15551234567'],
      groupPolicy: 'disabled',
      groupAllowFrom: [],
      groups: ['ops-room@g.us'],
    },
    storage: { pvc: 'kagent-kagent-operator-channel-whatsapp-auth' },
    whatsapp: { authDir: '/auth', sendReadReceipts: true },
    bindingCount: 1,
    sessionCount: 1,
    activeSessionCount: 1,
    lastHeartbeatAt: '2026-06-12T10:01:00Z',
    lastDeniedInbound: {
      at: '2026-06-12T10:04:30Z',
      reason: 'dm_sender_not_allowed',
      peer: { kind: 'dm', id: '15557654321@s.whatsapp.net' },
      sender: { id: '15557654321@s.whatsapp.net', displayName: 'Unlisted Sender' },
      messageId: 'wamid.denied',
    },
    ...overrides,
  };
}

function makeDetail(): ExternalChannelDetail {
  return {
    ...makeChannel(),
    bindings: [
      {
        namespace: 'kagent-system',
        name: 'whatsapp-work-operator-investigator',
        paused: false,
        default: true,
        target: {
          agentRef: 'operator-investigator',
          modelClass: 'tool-caller-default',
          runConfig: { timeoutSeconds: 600, maxIterations: 6 },
          sessionScope: 'per-account-channel-peer',
        },
        approval: { required: false, mode: 'operator' },
        lastMatchedAt: '2026-06-12T10:02:00Z',
      },
    ],
    sessions: [
      {
        namespace: 'kagent-system',
        name: 'kcs-whatsapp-work-a1b2c3d4',
        phase: 'Active',
        provider: 'whatsapp',
        accountId: 'work',
        peer: { kind: 'dm', id: '+15551234567' },
        threadId: 'direct',
        bindingRef: 'whatsapp-work-operator-investigator',
        target: { agentRef: 'operator-investigator' },
        paused: false,
        lastInboundAt: '2026-06-12T10:03:00Z',
        lastOutboundAt: '2026-06-12T10:04:00Z',
        lastTask: {
          namespace: 'kagent-system',
          name: 'channel-turn-abc',
          uid: 'task-uid',
          phase: 'Completed',
          ui: '/#/tasks/kagent-system/channel-turn-abc',
        },
      },
    ],
  };
}

describe('ChannelsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchChannels.mockResolvedValue([makeChannel()]);
    mockFetchChannelDetail.mockResolvedValue(makeDetail());
    mockSetChannelPaused.mockResolvedValue(undefined);
    mockSubscribeCacheEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders pairing, routing, policy, and session status for the selected channel', async () => {
    render(<ChannelsPage />);

    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /whatsapp-work/i })).toBeTruthy();
    expect((await screen.findAllByText('QR ready')).length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole('img', { name: 'WhatsApp pairing QR for Work WhatsApp' })
        .getAttribute('src'),
    ).toBe('/api/channels/kagent-system/whatsapp-work/pairing-qr.svg');
    expect(screen.getAllByText('operator-investigator').length).toBeGreaterThan(0);
    expect(screen.getAllByText('DM pairing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Groups disabled').length).toBeGreaterThan(0);
    expect(screen.getByText('Last denied inbound')).toBeTruthy();
    expect(screen.getByText('dm_sender_not_allowed')).toBeTruthy();
    expect(screen.getAllByText('dm:15557654321@s.whatsapp.net').length).toBeGreaterThan(0);
    expect(screen.getByText('Unlisted Sender')).toBeTruthy();
    expect(screen.queryByText('This text must not be written')).toBeNull();
    expect(screen.getByText('kcs-whatsapp-work-a1b2c3d4')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'open task channel-turn-abc' }).getAttribute('href')).toBe(
      '#/tasks/kagent-system/channel-turn-abc',
    );
  });

  it('calls the pause endpoint for the selected channel', async () => {
    render(<ChannelsPage />);

    const pause = await screen.findByRole('button', { name: /pause channel/i });
    fireEvent.click(pause);

    await waitFor(() => {
      expect(mockSetChannelPaused).toHaveBeenCalledWith('kagent-system', 'whatsapp-work', true);
    });
  });

  it('refreshes when channel stream events arrive', async () => {
    const stream: { onEvent: ((event: { readonly kind: string }) => void) | null } = {
      onEvent: null,
    };
    mockSubscribeCacheEvents.mockImplementation((next: (event: { readonly kind: string }) => void) => {
      stream.onEvent = next;
      return vi.fn();
    });

    render(<ChannelsPage />);
    await screen.findAllByText('QR ready');

    const emit = stream.onEvent;
    if (emit === null) throw new Error('stream subscription was not installed');
    emit({ kind: 'channelSession' });

    await waitFor(() => {
      expect(mockFetchChannels).toHaveBeenCalledTimes(2);
    });
  });
});
