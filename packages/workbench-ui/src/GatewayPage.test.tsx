/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./api.js', () => ({
  fetchGatewayCapacity: vi.fn(),
  fetchGatewayUsage: vi.fn(),
  fetchGatewayProviderDispatch: vi.fn(),
  patchModelEndpointInFlight: vi.fn(),
  setGatewayProviderDispatchDisabled: vi.fn(),
  GatewayApiError: class GatewayApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import {
  fetchGatewayCapacity,
  fetchGatewayProviderDispatch,
  fetchGatewayUsage,
  setGatewayProviderDispatchDisabled,
} from './api.js';
import { GatewayPage } from './GatewayPage.js';

const mockFetchCapacity = fetchGatewayCapacity as ReturnType<typeof vi.fn>;
const mockFetchUsage = fetchGatewayUsage as ReturnType<typeof vi.fn>;
const mockFetchDispatch = fetchGatewayProviderDispatch as ReturnType<typeof vi.fn>;
const mockSetDispatch = setGatewayProviderDispatchDisabled as ReturnType<typeof vi.fn>;

describe('GatewayPage provider dispatch control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchCapacity.mockResolvedValue({
      rows: [],
      fetchedAt: '2026-06-08T17:00:00.000Z',
    });
    mockFetchUsage.mockResolvedValue({
      rows: [],
      fetchedAt: '2026-06-08T17:00:00.000Z',
    });
    mockFetchDispatch.mockResolvedValue({ providerDispatchDisabled: false });
    mockSetDispatch.mockResolvedValue({ providerDispatchDisabled: true });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders an emergency pause button and calls the runtime kill-switch endpoint', async () => {
    render(<GatewayPage onBack={vi.fn()} />);

    const pause = await screen.findByRole('button', { name: /pause dispatch/i });
    fireEvent.click(pause);

    await waitFor(() => {
      expect(mockSetDispatch).toHaveBeenCalledWith(true);
    });
    await screen.findByRole('button', { name: /resume dispatch/i });
  });

  it('renders resume dispatch when provider calls are already disabled', async () => {
    mockFetchDispatch.mockResolvedValue({ providerDispatchDisabled: true });
    render(<GatewayPage onBack={vi.fn()} />);

    await screen.findByRole('button', { name: /resume dispatch/i });
  });
});
