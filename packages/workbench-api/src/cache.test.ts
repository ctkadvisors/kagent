/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent, AgentTask, Channel, ChannelBinding, ChannelSession } from '@kagent/dto';
import { API_GROUP_VERSION } from '@kagent/dto';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

import { SnapshotCache, cacheKey } from './cache.js';

function makeTask(name: string, namespace = 'default'): AgentTask {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: { name, namespace, uid: `uid-${name}` },
    spec: { payload: {} },
  };
}

function makeAgent(name: string, namespace = 'default'): Agent {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Agent',
    metadata: { name, namespace, uid: `agent-uid-${name}` },
    spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
  };
}

function makeChannel(name: string, namespace = 'default'): Channel {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'Channel',
    metadata: { name, namespace, uid: `channel-uid-${name}` },
    spec: { provider: 'whatsapp', accountId: 'work' },
  };
}

function makeChannelBinding(name: string, channelName = 'whatsapp-work'): ChannelBinding {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelBinding',
    metadata: { name, namespace: 'default', uid: `binding-uid-${name}` },
    spec: {
      channelRef: { name: channelName },
      target: { agentRef: { name: 'operator-investigator' } },
    },
  };
}

function makeChannelSession(name: string, channelName = 'whatsapp-work'): ChannelSession {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'ChannelSession',
    metadata: { name, namespace: 'default', uid: `session-uid-${name}` },
    spec: {
      channelRef: { name: channelName },
      provider: 'whatsapp',
      accountId: 'work',
      peer: { kind: 'dm', id: '+15551234567' },
      sessionKey: `session:${name}`,
      target: { agentRef: { name: 'operator-investigator' } },
    },
  };
}

function makeJob(name: string, taskName: string, namespace = 'default'): V1Job {
  return {
    metadata: {
      name,
      namespace,
      labels: { 'kagent.knuteson.io/task': taskName },
    },
  };
}

function makePod(name: string, taskName: string, namespace = 'default'): V1Pod {
  return {
    metadata: {
      name,
      namespace,
      labels: { 'kagent.knuteson.io/task': taskName },
    },
  };
}

describe('cacheKey', () => {
  it('builds <namespace>/<name>', () => {
    expect(cacheKey('foo', 'bar')).toBe('foo/bar');
  });

  it('defaults namespace to default', () => {
    expect(cacheKey(undefined, 'bar')).toBe('default/bar');
  });

  it('handles missing name', () => {
    expect(cacheKey('foo', undefined)).toBe('foo/');
  });
});

describe('SnapshotCache tasks', () => {
  it('upserts and reads back a task', () => {
    const c = new SnapshotCache();
    const t = makeTask('alpha');
    c.upsertTask(t);
    expect(c.getTask('default', 'alpha')).toBe(t);
    expect(c.listTasks()).toHaveLength(1);
  });

  it('overwrites on second upsert', () => {
    const c = new SnapshotCache();
    c.upsertTask(makeTask('alpha'));
    const t2 = makeTask('alpha');
    c.upsertTask(t2);
    expect(c.getTask('default', 'alpha')).toBe(t2);
    expect(c.listTasks()).toHaveLength(1);
  });

  it('deletes a task', () => {
    const c = new SnapshotCache();
    const t = makeTask('alpha');
    c.upsertTask(t);
    c.deleteTask(t);
    expect(c.getTask('default', 'alpha')).toBeUndefined();
  });

  it('namespace separation', () => {
    const c = new SnapshotCache();
    c.upsertTask(makeTask('alpha', 'ns1'));
    c.upsertTask(makeTask('alpha', 'ns2'));
    expect(c.listTasks()).toHaveLength(2);
    expect(c.getTask('ns1', 'alpha')?.metadata.namespace).toBe('ns1');
  });
});

describe('SnapshotCache agents', () => {
  it('upserts, reads, lists, deletes', () => {
    const c = new SnapshotCache();
    const a = makeAgent('researcher');
    c.upsertAgent(a);
    expect(c.getAgent('default', 'researcher')).toBe(a);
    expect(c.listAgents()).toHaveLength(1);
    c.deleteAgent(a);
    expect(c.getAgent('default', 'researcher')).toBeUndefined();
  });
});

describe('SnapshotCache channels', () => {
  it('upserts, reads, lists, and deletes Channel resources', () => {
    const c = new SnapshotCache();
    const channel = makeChannel('whatsapp-work');
    c.upsertChannel(channel);
    expect(c.getChannel('default', 'whatsapp-work')).toBe(channel);
    expect(c.listChannels()).toEqual([channel]);
    c.deleteChannel(channel);
    expect(c.getChannel('default', 'whatsapp-work')).toBeUndefined();
  });

  it('upserts, lists, and deletes ChannelBinding resources', () => {
    const c = new SnapshotCache();
    const binding = makeChannelBinding('whatsapp-default');
    c.upsertChannelBinding(binding);
    expect(c.listChannelBindings()).toEqual([binding]);
    c.deleteChannelBinding(binding);
    expect(c.listChannelBindings()).toEqual([]);
  });

  it('upserts, lists, and deletes ChannelSession resources', () => {
    const c = new SnapshotCache();
    const session = makeChannelSession('kcs-whatsapp-work-a1b2c3d4');
    c.upsertChannelSession(session);
    expect(c.listChannelSessions()).toEqual([session]);
    c.deleteChannelSession(session);
    expect(c.listChannelSessions()).toEqual([]);
  });
});

describe('SnapshotCache job/pod join by task label', () => {
  it('finds job by kagent.knuteson.io/task label', () => {
    const c = new SnapshotCache();
    c.upsertJob(makeJob('job-alpha-1', 'alpha'));
    c.upsertJob(makeJob('job-beta-1', 'beta'));
    expect(c.findJobForTask('default', 'alpha')?.metadata?.name).toBe('job-alpha-1');
    expect(c.findJobForTask('default', 'beta')?.metadata?.name).toBe('job-beta-1');
    expect(c.findJobForTask('default', 'gamma')).toBeUndefined();
  });

  it('finds pod by kagent.knuteson.io/task label, namespace-scoped', () => {
    const c = new SnapshotCache();
    c.upsertPod(makePod('pod-alpha-1', 'alpha', 'ns1'));
    c.upsertPod(makePod('pod-alpha-2', 'alpha', 'ns2'));
    expect(c.findPodForTask('ns1', 'alpha')?.metadata?.name).toBe('pod-alpha-1');
    expect(c.findPodForTask('ns2', 'alpha')?.metadata?.name).toBe('pod-alpha-2');
  });

  it('returns undefined for unlabeled jobs/pods', () => {
    const c = new SnapshotCache();
    c.upsertJob({ metadata: { name: 'unlabeled', namespace: 'default' } });
    expect(c.findJobForTask('default', 'alpha')).toBeUndefined();
  });
});

describe('SnapshotCache listeners', () => {
  it('fires on task upsert', () => {
    const c = new SnapshotCache();
    const listener = vi.fn();
    c.subscribe(listener);
    c.upsertTask(makeTask('alpha'));
    expect(listener).toHaveBeenCalledWith({
      kind: 'task',
      op: 'upsert',
      key: 'default/alpha',
    });
  });

  it('fires on agent / job / pod / channel upserts', () => {
    const c = new SnapshotCache();
    const listener = vi.fn();
    c.subscribe(listener);
    c.upsertAgent(makeAgent('a'));
    c.upsertJob(makeJob('j', 'alpha'));
    c.upsertPod(makePod('p', 'alpha'));
    c.upsertChannel(makeChannel('whatsapp-work'));
    c.upsertChannelBinding(makeChannelBinding('whatsapp-default'));
    c.upsertChannelSession(makeChannelSession('kcs-whatsapp-work-a1b2c3d4'));
    expect(listener).toHaveBeenCalledTimes(6);
    expect(listener.mock.calls.map((call) => (call[0] as { kind: string }).kind)).toEqual([
      'agent',
      'job',
      'pod',
      'channel',
      'channelBinding',
      'channelSession',
    ]);
  });

  it('only fires delete when key actually existed', () => {
    const c = new SnapshotCache();
    const listener = vi.fn();
    c.subscribe(listener);
    c.deleteTask(makeTask('never-added'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops events', () => {
    const c = new SnapshotCache();
    const listener = vi.fn();
    const off = c.subscribe(listener);
    off();
    c.upsertTask(makeTask('alpha'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener errors are swallowed and do not break fan-out', () => {
    const c = new SnapshotCache();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    c.subscribe(bad);
    c.subscribe(good);
    c.upsertTask(makeTask('alpha'));
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('listenerCount tracks active subscribers', () => {
    const c = new SnapshotCache();
    const off = c.subscribe(() => undefined);
    expect(c.listenerCount()).toBe(1);
    off();
    expect(c.listenerCount()).toBe(0);
  });
});
