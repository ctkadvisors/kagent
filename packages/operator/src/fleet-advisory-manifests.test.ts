/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kubernetesAdvisoryTaskStore } from './fleet-advisory.js';
import { resolveAgentModel } from './model-class-resolver.js';
import type { Agent } from './crds/index.js';

const manifestDir = new URL('../../../deploy/fleet-advisory/', import.meta.url);

function manifest(name: string): Agent {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, manifestDir)), 'utf8')) as Agent;
}

describe('fleet advisory Agent manifests', () => {
  it('pins both agents to the local Spark class with no model escape hatch', () => {
    for (const name of ['researcher.json', 'source-checker.json']) {
      const agent = manifest(name);
      expect(agent.kind).toBe('Agent');
      expect(agent.metadata.namespace).toBe('kagent-system');
      expect(agent.spec.modelClass).toBe('reasoner-default');
      expect(agent.spec.model).toBeUndefined();
      expect(agent.spec.capabilityClaims?.models).toEqual(['flashnext']);
      const resolved = resolveAgentModel({
        agentSpec: agent.spec,
        classMap: { 'reasoner-default': { model: 'flashnext' } },
      });
      expect(resolved).toMatchObject({ kind: 'resolved', model: 'flashnext', source: 'class' });
      expect(agent.spec.capabilityClaims?.egress).toEqual([]);
      expect(agent.spec.tools).not.toContain('shell.exec');
      expect(agent.spec.tools).not.toContain('mcp.add_memory');
      expect(agent.spec.tools).not.toContain('http.github.pr_comment');
      expect(agent.spec.toolProfileRef).toBeUndefined();
    }
  });

  it('rejects a cloud or non-Spark class mapping before creating a Kubernetes store', () => {
    const api = {
      createNamespacedCustomObject: () => Promise.resolve(undefined),
      getNamespacedCustomObject: () => Promise.resolve(undefined),
    };
    const route = {
      classMap: { 'reasoner-default': { model: 'flashnext' } },
      endpoint: {
        model: 'flashnext',
        backendKind: 'localai',
        backendUrl: 'http://spark-llamaswap.ai-services.svc.cluster.local:9090/v1',
      },
    };
    expect(() => kubernetesAdvisoryTaskStore(api, route)).not.toThrow();
    expect(() =>
      kubernetesAdvisoryTaskStore(api, {
        ...route,
        classMap: { 'reasoner-default': { model: 'workers-ai/@cf/example' } },
      }),
    ).toThrow(/Spark/u);
    expect(() =>
      kubernetesAdvisoryTaskStore(api, {
        ...route,
        endpoint: { ...route.endpoint, backendUrl: 'https://api.openai.com/v1' },
      }),
    ).toThrow(/Spark/u);
  });

  it('permits one research child and no onward delegation', () => {
    const parent = manifest('researcher.json');
    const child = manifest('source-checker.json');
    expect(parent.metadata.name).toBe('fleet-question-researcher');
    expect(parent.spec.allowedChildAgents).toEqual(['fleet-source-checker']);
    expect(parent.spec.maxConcurrentChildren).toBe(1);
    expect(parent.spec.capabilityClaims?.spawn).toEqual(['fleet-source-checker']);
    expect(parent.spec.tools).toContain('spawn_child_task');
    expect(child.spec.allowedChildAgents).toEqual([]);
    expect(child.spec.capabilityClaims?.spawn).toEqual([]);
    expect(child.spec.tools).toContain('browser.goto');
    expect(child.spec.tools).toContain('http.web_search');
    expect(
      child.spec.tools?.every((tool) => parent.spec.capabilityClaims?.tools?.includes(tool)),
    ).toBe(true);
  });
});
