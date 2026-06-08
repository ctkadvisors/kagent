/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('./api.js', () => ({
  architectDraft: vi.fn(),
  architectTry: vi.fn(),
}));

import { architectDraft, architectTry } from './api.js';
import { ArchitectPage } from './ArchitectPage.js';

const mockDraft = architectDraft as ReturnType<typeof vi.fn>;
const mockTry = architectTry as ReturnType<typeof vi.fn>;

function renderPage(): void {
  render(<ArchitectPage onBack={vi.fn()} />);
}

async function draft(goal = 'build a careful summarizer'): Promise<void> {
  renderPage();
  fireEvent.change(screen.getByPlaceholderText(/Describe an agent/i), {
    target: { value: goal },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
  await waitFor(() => {
    expect(mockDraft).toHaveBeenCalledWith(goal);
  });
}

describe('ArchitectPage candidate validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('disables Try live and shows YAML parse guidance when candidate YAML is malformed', async () => {
    mockDraft.mockResolvedValue({
      ok: true,
      candidateYaml: 'agentSpec:\n  model: [\n',
      preview: {},
    });

    await draft();

    const tryButton = await screen.findByRole('button', { name: 'Try it live' });
    expect((tryButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('candidateYaml')).toBeTruthy();
    expect(screen.getByText(/YAML parse error/i)).toBeTruthy();

    fireEvent.click(tryButton);
    expect(mockTry).not.toHaveBeenCalled();
  });

  it('disables Try live and shows required agentSpec field validation', async () => {
    mockDraft.mockResolvedValue({
      ok: true,
      candidateYaml: 'agentSpec:\n  systemPrompt: triage incoming issues\n',
      preview: {},
    });

    await draft();

    const tryButton = await screen.findByRole('button', { name: 'Try it live' });
    expect((tryButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('agentSpec.model / agentSpec.modelClass')).toBeTruthy();
    expect(screen.getByText(/choose a model class or explicit model/i)).toBeTruthy();

    fireEvent.click(tryButton);
    expect(mockTry).not.toHaveBeenCalled();
  });

  it('disables Try live and shows missing systemPrompt validation', async () => {
    mockDraft.mockResolvedValue({
      ok: true,
      candidateYaml: 'agentSpec:\n  modelClass: tool-caller-default\n',
      preview: { agentSpec: { modelClass: 'tool-caller-default' } },
    });

    await draft();

    const tryButton = await screen.findByRole('button', { name: 'Try it live' });
    expect((tryButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('agentSpec.systemPrompt')).toBeTruthy();
    expect(screen.getByText(/describe the agent behavior/i)).toBeTruthy();

    fireEvent.click(tryButton);
    expect(mockTry).not.toHaveBeenCalled();
  });

  it('disables Try live when a required parameter has no default value', async () => {
    mockDraft.mockResolvedValue({
      ok: true,
      candidateYaml: [
        'parameters:',
        '  - name: topic',
        '    type: string',
        '    required: true',
        'agentSpec:',
        '  modelClass: tool-caller-default',
        '  systemPrompt: "summarize ${param.topic}"',
        '',
      ].join('\n'),
      preview: {},
    });

    await draft();

    const tryButton = await screen.findByRole('button', { name: 'Try it live' });
    expect((tryButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('parameters.topic.default')).toBeTruthy();
    expect(screen.getByText(/need a default/i)).toBeTruthy();

    fireEvent.click(tryButton);
    expect(mockTry).not.toHaveBeenCalled();
  });

  it('enables Try live for valid candidates and submits the candidate YAML', async () => {
    const candidateYaml = [
      'agentSpec:',
      '  modelClass: tool-caller-default',
      '  systemPrompt: triage incoming issues',
      '',
    ].join('\n');
    mockDraft.mockResolvedValue({
      ok: true,
      candidateYaml,
      preview: { agentSpec: { modelClass: 'tool-caller-default', systemPrompt: 'triage' } },
    });
    mockTry.mockResolvedValue({
      namespace: 'kagent-draft',
      templateName: 'draft-abc',
      agentName: 'draft-abc-agent',
      taskName: 'draft-abc-run',
    });

    await draft('triage issues');

    const tryButton = await screen.findByRole('button', { name: 'Try it live' });
    expect((tryButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tryButton);

    await waitFor(() => {
      expect(mockTry).toHaveBeenCalledWith(candidateYaml, 'triage issues');
    });
  });
});
