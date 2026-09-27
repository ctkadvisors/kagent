/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import {
  maybeAnnotateTemplateCandidate,
  ANNOTATION_TEMPLATE_CANDIDATE,
  TEMPLATE_CANDIDATE_MEDIA_TYPE,
} from './main.js';
import type { AgentTask } from './crds/index.js';

function task(
  over: Partial<AgentTask['status']> = {},
  annotations?: Record<string, string>,
): AgentTask {
  return {
    apiVersion: 'kagent.knuteson.io/v1alpha1',
    kind: 'AgentTask',
    metadata: { name: 'inv-1', namespace: 'kagent-system', ...(annotations && { annotations }) },
    spec: { targetAgent: 'fleet-inventor', payload: {} },
    status: { phase: 'Completed', ...over },
  } as unknown as AgentTask;
}

describe('maybeAnnotateTemplateCandidate', () => {
  it('annotates a Completed task that produced a template candidate, once', async () => {
    const patches: unknown[] = [];
    const customApi = {
      patchNamespacedCustomObject: (req: unknown) => {
        patches.push(req);
        return Promise.resolve({});
      },
    };
    const t = task({
      artifacts: [{ uri: 'inline://sha256:ab', mediaType: TEMPLATE_CANDIDATE_MEDIA_TYPE }],
    });
    expect(await maybeAnnotateTemplateCandidate(t, { customApi } as never)).toBe('annotated');
    expect(patches).toHaveLength(1);
    const req = patches[0] as {
      plural: string;
      name: string;
      body: { metadata: { annotations: Record<string, string> } };
    };
    expect(req.plural).toBe('agenttasks');
    expect(req.body.metadata.annotations[ANNOTATION_TEMPLATE_CANDIDATE]).toBe('true');
    // already annotated, other media type, not Completed: no-op
    expect(
      await maybeAnnotateTemplateCandidate(
        task(
          { artifacts: [{ uri: 'x', mediaType: TEMPLATE_CANDIDATE_MEDIA_TYPE }] },
          { [ANNOTATION_TEMPLATE_CANDIDATE]: 'true' },
        ),
        { customApi } as never,
      ),
    ).toBe('no-op');
    expect(
      await maybeAnnotateTemplateCandidate(
        task({ artifacts: [{ uri: 'x', mediaType: 'text/plain' }] }),
        { customApi } as never,
      ),
    ).toBe('no-op');
    expect(
      await maybeAnnotateTemplateCandidate(
        task({
          phase: 'Failed',
          artifacts: [{ uri: 'x', mediaType: TEMPLATE_CANDIDATE_MEDIA_TYPE }],
        }),
        { customApi } as never,
      ),
    ).toBe('no-op');
    expect(patches).toHaveLength(1);
  });
});
