/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AgentSummaryRow, ChannelSessionDetail, ChannelSessionSummary } from './types.js';

vi.mock('./api.js', () => ({
  fetchAgents: vi.fn(),
  fetchSessionDetail: vi.fn(),
  fetchSessionProfiles: vi.fn(),
  fetchSessions: vi.fn(),
  sendSessionMessage: vi.fn(),
  subscribeCacheEvents: vi.fn(),
  terminateTask: vi.fn(),
}));

import {
  fetchAgents,
  fetchSessionDetail,
  fetchSessionProfiles,
  fetchSessions,
  sendSessionMessage,
  subscribeCacheEvents,
  terminateTask,
} from './api.js';
import { SessionsPage } from './SessionsPage.js';

const mockFetchAgents = fetchAgents as ReturnType<typeof vi.fn>;
const mockFetchSessionDetail = fetchSessionDetail as ReturnType<typeof vi.fn>;
const mockFetchSessionProfiles = fetchSessionProfiles as ReturnType<typeof vi.fn>;
const mockFetchSessions = fetchSessions as ReturnType<typeof vi.fn>;
const mockSendSessionMessage = sendSessionMessage as ReturnType<typeof vi.fn>;
const mockSubscribeCacheEvents = subscribeCacheEvents as ReturnType<typeof vi.fn>;
const mockTerminateTask = terminateTask as ReturnType<typeof vi.fn>;

function makeSession(overrides: Partial<ChannelSessionSummary> = {}): ChannelSessionSummary {
  return {
    id: overrides.id ?? 'ops-room',
    namespace: 'kagent-system',
    targetAgent: 'controller',
    turnCount: 2,
    lastPhase: 'Completed',
    lastActivityAt: '2026-06-10T10:02:00Z',
    lastMessagePreview: 'Cluster is stable.',
    ...overrides,
  };
}

function makeDetail(id = 'ops-room'): ChannelSessionDetail {
  return {
    ...makeSession({ id }),
    messages: [
      {
        id: 'turn-1:user',
        role: 'user',
        content: 'What needs attention?',
        createdAt: '2026-06-10T10:00:00Z',
        task: {
          namespace: 'kagent-system',
          name: 'turn-1',
          uid: 'uid-turn-1',
          phase: 'Completed',
          ui: '/#/tasks/kagent-system/turn-1',
        },
      },
      {
        id: 'turn-1:assistant',
        role: 'assistant',
        content: 'Cluster is stable. One profile validation task completed.',
        createdAt: '2026-06-10T10:02:00Z',
        task: {
          namespace: 'kagent-system',
          name: 'turn-1',
          uid: 'uid-turn-1',
          phase: 'Completed',
          ui: '/#/tasks/kagent-system/turn-1',
        },
      },
    ],
  };
}

describe('SessionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSessionProfiles.mockResolvedValue([
      {
        id: 'agent:kagent-system/controller',
        profileName: 'controller',
        source: 'Agent',
        targetAgent: 'controller',
        namespace: 'kagent-system',
        modelClass: 'tool-caller-default',
        tools: [],
        capabilities: [],
        defaults: { runConfig: { timeoutSeconds: 300, maxIterations: 8 } },
        launchability: { state: 'ready', reasons: [] },
      },
    ]);
    mockFetchAgents.mockResolvedValue([
      { name: 'controller', namespace: 'kagent-system', modelClass: 'tool-caller-default' },
    ] satisfies AgentSummaryRow[]);
    mockFetchSessions.mockResolvedValue([makeSession(), makeSession({ id: 'deploy-room' })]);
    mockFetchSessionDetail.mockResolvedValue(makeDetail());
    mockSendSessionMessage.mockResolvedValue({
      sessionId: 'ops-room',
      task: {
        namespace: 'kagent-system',
        name: 'chat-fixed01',
        uid: 'uid-chat-fixed01',
        phase: 'Pending',
        ui: '/#/tasks/kagent-system/chat-fixed01',
      },
    });
    mockTerminateTask.mockResolvedValue(undefined);
    mockSubscribeCacheEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders all sessions and the selected timeline', async () => {
    render(<SessionsPage />);

    expect(await screen.findByRole('heading', { name: 'Sessions' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /ops-room/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /deploy-room/i })).toBeTruthy();
    expect(await screen.findByText('What needs attention?')).toBeTruthy();
    expect(
      screen.getByText('Cluster is stable. One profile validation task completed.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'open task turn-1' }).getAttribute('href')).toBe(
      '#/tasks/kagent-system/turn-1',
    );
    expect(mockFetchSessionDetail).toHaveBeenCalledWith('ops-room', expect.any(AbortSignal));
  });

  it('submits a message to the selected session and navigates to the created task link', async () => {
    render(<SessionsPage initialSessionId="ops-room" />);

    await screen.findByText('What needs attention?');
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Show me active browser sessions' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockSendSessionMessage).toHaveBeenCalledWith('ops-room', {
        targetAgent: 'controller',
        message: 'Show me active browser sessions',
        namespace: 'kagent-system',
        runConfig: { timeoutSeconds: 300, maxIterations: 8 },
      });
    });
    expect(
      await screen.findByRole('link', { name: 'open created task chat-fixed01' }),
    ).toBeTruthy();
  });

  it('submits through the selected typed profile instead of raw agent names', async () => {
    mockFetchSessionProfiles.mockResolvedValue([
      {
        id: 'agent:kagent-draft/profile-agentcore-research-agent',
        profileName: 'research-browser-code',
        source: 'Agent',
        targetAgent: 'profile-agentcore-research-agent',
        namespace: 'kagent-draft',
        modelClass: 'tool-caller-default',
        toolProfileRef: 'browser-code-researcher',
        tools: ['browser.goto', 'code_interpreter.execute_code'],
        capabilities: ['research'],
        defaults: { runConfig: { timeoutSeconds: 240, maxIterations: 6 } },
        launchability: { state: 'ready', reasons: [] },
      },
    ]);
    mockFetchSessions.mockResolvedValue([
      makeSession({
        id: 'agentcore-validation',
        namespace: 'kagent-draft',
        targetAgent: 'profile-agentcore-research-agent',
      }),
    ]);
    mockFetchSessionDetail.mockResolvedValue({
      ...makeDetail('agentcore-validation'),
      namespace: 'kagent-draft',
      targetAgent: 'profile-agentcore-research-agent',
    });

    render(<SessionsPage initialSessionId="agentcore-validation" />);

    await screen.findByText('Cluster is stable. One profile validation task completed.');
    expect(screen.getByLabelText<HTMLSelectElement>('Profile').value).toBe(
      'agent:kagent-draft/profile-agentcore-research-agent',
    );
    expect(screen.getByText(/tool-caller-default · browser-code-researcher/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Run the profile instructions' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(mockSendSessionMessage).toHaveBeenCalledWith('agentcore-validation', {
        targetAgent: 'profile-agentcore-research-agent',
        message: 'Run the profile instructions',
        namespace: 'kagent-draft',
        runConfig: { timeoutSeconds: 240, maxIterations: 6 },
      });
    });
  });

  it('offers a stop control for active session tasks', async () => {
    mockFetchSessionDetail.mockResolvedValue({
      ...makeSession({ lastPhase: 'Pending' }),
      messages: [
        {
          id: 'turn-running:user',
          role: 'user',
          content: 'Investigate the gateway',
          createdAt: '2026-06-10T10:00:00Z',
          task: {
            namespace: 'kagent-draft',
            name: 'turn-running',
            uid: 'uid-turn-running',
            phase: 'Pending',
            ui: '/#/tasks/kagent-draft/turn-running',
          },
        },
      ],
    } satisfies ChannelSessionDetail);

    render(<SessionsPage initialSessionId="ops-room" />);

    await screen.findByText('Investigate the gateway');
    fireEvent.click(screen.getByRole('button', { name: 'stop task turn-running' }));

    await waitFor(() => {
      expect(mockTerminateTask).toHaveBeenCalledWith('kagent-draft', 'turn-running');
    });
  });

  it('refreshes the selected timeline when task stream events arrive', async () => {
    const stream: {
      onEvent: ((event: { readonly kind: string }) => void) | null;
    } = { onEvent: null };
    mockSubscribeCacheEvents.mockImplementation(
      (next: (event: { readonly kind: string }) => void) => {
        stream.onEvent = next;
        return vi.fn();
      },
    );
    mockFetchSessionDetail
      .mockResolvedValueOnce({
        ...makeSession(),
        messages: [makeDetail().messages[0]!],
      } satisfies ChannelSessionDetail)
      .mockResolvedValueOnce(makeDetail());

    render(<SessionsPage initialSessionId="ops-room" />);

    expect(await screen.findByText('What needs attention?')).toBeTruthy();
    expect(
      screen.queryByText('Cluster is stable. One profile validation task completed.'),
    ).toBeNull();

    const emit = stream.onEvent;
    if (emit === null) throw new Error('stream subscription was not installed');
    emit({ kind: 'task' });

    expect(
      await screen.findByText('Cluster is stable. One profile validation task completed.'),
    ).toBeTruthy();
    expect(mockFetchSessionDetail).toHaveBeenCalledTimes(2);
  });

  it('seeds the composer target from the selected session agent', async () => {
    mockFetchSessionProfiles.mockResolvedValue([
      {
        id: 'agent:kagent-system/orchestrator',
        profileName: 'orchestrator',
        source: 'Agent',
        targetAgent: 'orchestrator',
        namespace: 'kagent-system',
        modelClass: 'tool-caller-default',
        tools: [],
        capabilities: [],
        defaults: { runConfig: { timeoutSeconds: 300, maxIterations: 8 } },
        launchability: { state: 'ready', reasons: [] },
      },
      {
        id: 'agent:kagent-draft/profile-agentcore-research-agent',
        profileName: 'research-browser-code',
        source: 'Agent',
        targetAgent: 'profile-agentcore-research-agent',
        namespace: 'kagent-draft',
        modelClass: 'tool-caller-default',
        toolProfileRef: 'browser-code-researcher',
        tools: ['browser.goto'],
        capabilities: ['research'],
        defaults: { runConfig: { timeoutSeconds: 300, maxIterations: 8 } },
        launchability: { state: 'ready', reasons: [] },
      },
    ]);
    mockFetchAgents.mockResolvedValue([
      { name: 'orchestrator', namespace: 'kagent-system', modelClass: 'tool-caller-default' },
      {
        name: 'profile-agentcore-research-agent',
        namespace: 'kagent-draft',
        modelClass: 'tool-caller-default',
      },
    ] satisfies AgentSummaryRow[]);
    mockFetchSessions.mockResolvedValue([
      makeSession({
        id: 'agentcore-validation',
        namespace: 'kagent-draft',
        targetAgent: 'profile-agentcore-research-agent',
      }),
    ]);
    mockFetchSessionDetail.mockResolvedValue({
      ...makeDetail('agentcore-validation'),
      namespace: 'kagent-draft',
      targetAgent: 'profile-agentcore-research-agent',
    });

    render(<SessionsPage initialSessionId="agentcore-validation" />);

    await screen.findByText('Cluster is stable. One profile validation task completed.');
    expect(screen.getByLabelText<HTMLSelectElement>('Profile').value).toBe(
      'agent:kagent-draft/profile-agentcore-research-agent',
    );
  });
});
