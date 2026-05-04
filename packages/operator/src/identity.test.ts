/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@kagent/audit-events';

import {
  buildIdentityVolumes,
  buildSpiffeId,
  DEFAULT_SPIRE_HOST_SOCKET_DIR,
  DEFAULT_SPIRE_SOCKET_PATH,
  DEFAULT_TRUST_DOMAIN,
  loadSpireCaBundleFromEnv,
  MockIdentityWatcher,
  parseSpiffeId,
} from './identity.js';

describe('buildSpiffeId', () => {
  it('builds the canonical kagent SPIFFE ID with default trust domain', () => {
    const id = buildSpiffeId({
      namespace: 'default',
      serviceAccount: 'kagent-agent-pod',
      agentName: 'researcher',
    });
    expect(id).toBe('spiffe://kagent.knuteson.io/ns/default/sa/kagent-agent-pod/agent/researcher');
  });

  it('honors a custom trust domain', () => {
    const id = buildSpiffeId({
      namespace: 'kagent',
      serviceAccount: 'agent-pod',
      agentName: 'summarizer',
      trustDomain: 'demo.test',
    });
    expect(id).toBe('spiffe://demo.test/ns/kagent/sa/agent-pod/agent/summarizer');
  });

  it('URL-encodes path segments to surface invalid characters', () => {
    const id = buildSpiffeId({
      namespace: 'a/b',
      serviceAccount: 'sa',
      agentName: 'agent name',
    });
    expect(id).toBe('spiffe://kagent.knuteson.io/ns/a%2Fb/sa/sa/agent/agent%20name');
  });

  it('throws on empty namespace / sa / agentName', () => {
    expect(() => buildSpiffeId({ namespace: '', serviceAccount: 'sa', agentName: 'a' })).toThrow(
      /namespace is empty/,
    );
    expect(() => buildSpiffeId({ namespace: 'ns', serviceAccount: '', agentName: 'a' })).toThrow(
      /serviceAccount is empty/,
    );
    expect(() => buildSpiffeId({ namespace: 'ns', serviceAccount: 'sa', agentName: '' })).toThrow(
      /agentName is empty/,
    );
  });

  it('throws on empty trustDomain', () => {
    expect(() =>
      buildSpiffeId({
        namespace: 'ns',
        serviceAccount: 'sa',
        agentName: 'a',
        trustDomain: '   ',
      }),
    ).toThrow(/trustDomain is empty/);
  });
});

describe('parseSpiffeId', () => {
  it('round-trips the canonical kagent SPIFFE ID', () => {
    const built = buildSpiffeId({
      namespace: 'default',
      serviceAccount: 'kagent-agent-pod',
      agentName: 'researcher',
    });
    const parsed = parseSpiffeId(built);
    expect(parsed).toEqual({
      trustDomain: 'kagent.knuteson.io',
      namespace: 'default',
      serviceAccount: 'kagent-agent-pod',
      agentName: 'researcher',
    });
  });

  it('returns null on non-kagent SPIFFE IDs', () => {
    expect(parseSpiffeId('spiffe://example.org/spire/agent/k8s/abc')).toBeNull();
    expect(parseSpiffeId('spiffe://kagent.knuteson.io/just/agent/name')).toBeNull();
    expect(parseSpiffeId('https://kagent.knuteson.io/ns/x/sa/y/agent/z')).toBeNull();
  });

  it('returns null on empty / non-string input', () => {
    expect(parseSpiffeId('')).toBeNull();
    // intentional cast — runtime input may come from JSON
    expect(parseSpiffeId(undefined as unknown as string)).toBeNull();
  });

  it('decodes URI-encoded path segments', () => {
    const parsed = parseSpiffeId('spiffe://td/ns/a%2Fb/sa/x/agent/agent%20name');
    expect(parsed).toEqual({
      trustDomain: 'td',
      namespace: 'a/b',
      serviceAccount: 'x',
      agentName: 'agent name',
    });
  });

  it('returns null on malformed URI percent-encoding', () => {
    expect(parseSpiffeId('spiffe://td/ns/%ZZ/sa/x/agent/y')).toBeNull();
  });
});

describe('buildIdentityVolumes', () => {
  it('returns null when identity is disabled', () => {
    expect(buildIdentityVolumes({ enabled: false })).toBeNull();
  });

  it('returns the canonical volume + mount + env when enabled', () => {
    const v = buildIdentityVolumes({ enabled: true });
    expect(v).not.toBeNull();
    expect(v?.volume.name).toBe('kagent-spire-socket');
    expect(v?.volume.hostPath.path).toBe(DEFAULT_SPIRE_HOST_SOCKET_DIR);
    expect(v?.volume.hostPath.type).toBe('DirectoryOrCreate');
    expect(v?.volumeMount.name).toBe('kagent-spire-socket');
    expect(v?.volumeMount.readOnly).toBe(true);
    // DEFAULT_SPIRE_SOCKET_PATH is `/run/kagent-spire/sockets/agent.sock`;
    // the mount is on the directory above it.
    expect(v?.volumeMount.mountPath).toBe('/run/kagent-spire/sockets');
    const env = v?.env ?? [];
    expect(env).toContainEqual({
      name: 'KAGENT_SPIRE_SOCKET_PATH',
      value: DEFAULT_SPIRE_SOCKET_PATH,
    });
    expect(env).toContainEqual({ name: 'KAGENT_LITELLM_USE_SVID', value: 'true' });
  });

  it('honors hostSocketDir + podSocketPath overrides', () => {
    const v = buildIdentityVolumes({
      enabled: true,
      hostSocketDir: '/custom/host',
      podSocketPath: '/custom/pod/agent.sock',
    });
    expect(v?.volume.hostPath.path).toBe('/custom/host');
    expect(v?.volumeMount.mountPath).toBe('/custom/pod');
    expect(v?.env.find((e) => e.name === 'KAGENT_SPIRE_SOCKET_PATH')?.value).toBe(
      '/custom/pod/agent.sock',
    );
  });
});

describe('MockIdentityWatcher', () => {
  it('emits identity.svid_issued event on recordIssuance', async () => {
    const events: AuditEvent[] = [];
    const watcher = new MockIdentityWatcher({
      publish: (e) => {
        events.push(e);
      },
      now: () => new Date('2026-05-04T00:00:00Z'),
    });
    await watcher.recordIssuance({
      taskUid: 'task-uid-1',
      taskName: 'researcher-1',
      taskNamespace: 'default',
      agentName: 'researcher',
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/researcher',
      notBefore: new Date('2026-05-04T00:00:00Z'),
      notAfter: new Date('2026-05-05T00:00:00Z'),
      source: 'mock',
    });
    expect(events.length).toBe(1);
    const ev = events[0];
    if (ev === undefined) throw new Error('no event captured');
    expect(ev.type).toBe('identity.svid_issued');
    expect(ev.subject).toBe('AgentTask/default/researcher-1');
    expect(ev.source).toBe('kagent.knuteson.io/operator');
    if (ev.type === 'identity.svid_issued') {
      expect(ev.data.taskUid).toBe('task-uid-1');
      expect(ev.data.spiffeId).toBe(
        'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/researcher',
      );
      expect(ev.data.source).toBe('mock');
      expect(ev.data.notBefore).toBe('2026-05-04T00:00:00.000Z');
      expect(ev.data.notAfter).toBe('2026-05-05T00:00:00.000Z');
    }
  });

  it('emits identity.rotation event with gapSeconds when previousNotAfter is set', async () => {
    const events: AuditEvent[] = [];
    const watcher = new MockIdentityWatcher({
      publish: (e) => {
        events.push(e);
      },
    });
    await watcher.recordRotation({
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/x',
      newNotBefore: new Date('2026-05-04T01:00:00Z'),
      newNotAfter: new Date('2026-05-05T01:00:00Z'),
      previousNotAfter: new Date('2026-05-04T00:30:00Z'),
      source: 'mock',
    });
    expect(events.length).toBe(1);
    const ev = events[0];
    if (ev === undefined) throw new Error('no event captured');
    expect(ev.type).toBe('identity.rotation');
    if (ev.type === 'identity.rotation') {
      // 30-min positive gap between old expiry and new start
      expect(ev.data.gapSeconds).toBe(1800);
      expect(ev.data.previousNotAfter).toBe('2026-05-04T00:30:00.000Z');
    }
  });

  it('emits identity.rotation with undefined gapSeconds when previousNotAfter is absent', async () => {
    const events: AuditEvent[] = [];
    const watcher = new MockIdentityWatcher({
      publish: (e) => {
        events.push(e);
      },
    });
    await watcher.recordRotation({
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/x',
      newNotBefore: new Date('2026-05-04T01:00:00Z'),
      newNotAfter: new Date('2026-05-05T01:00:00Z'),
      source: 'spire-agent',
    });
    const ev = events[0];
    if (ev === undefined) throw new Error('no event captured');
    if (ev.type === 'identity.rotation') {
      expect(ev.data.previousNotAfter).toBeUndefined();
      expect(ev.data.gapSeconds).toBeUndefined();
      expect(ev.data.source).toBe('spire-agent');
    }
  });

  it('does not throw when publish throws (best-effort contract)', async () => {
    const watcher = new MockIdentityWatcher({
      publish: (): never => {
        throw new Error('publish disabled');
      },
    });
    await expect(
      watcher.recordIssuance({
        taskUid: 'u',
        taskName: 'n',
        taskNamespace: 'ns',
        agentName: 'a',
        spiffeId: 'spiffe://kagent.knuteson.io/ns/ns/sa/x/agent/a',
        notBefore: new Date(),
        notAfter: new Date(),
        source: 'mock',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('loadSpireCaBundleFromEnv', () => {
  it('returns null when identity disabled', () => {
    expect(
      loadSpireCaBundleFromEnv({ KAGENT_IDENTITY_ENABLED: 'false' }, () => '<bundle>'),
    ).toBeNull();
    expect(loadSpireCaBundleFromEnv({}, () => '<bundle>')).toBeNull();
  });

  it('returns bundle bytes when enabled + file readable', () => {
    expect(
      loadSpireCaBundleFromEnv(
        { KAGENT_IDENTITY_ENABLED: 'true' },
        () => '-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----',
      ),
    ).toBe('-----BEGIN CERTIFICATE-----\nABCD\n-----END CERTIFICATE-----');
  });

  it('returns null when file empty / undefined / mounted-but-blank', () => {
    expect(
      loadSpireCaBundleFromEnv({ KAGENT_IDENTITY_ENABLED: 'true' }, () => undefined),
    ).toBeNull();
    expect(loadSpireCaBundleFromEnv({ KAGENT_IDENTITY_ENABLED: 'true' }, () => '')).toBeNull();
  });

  it('uses default path when KAGENT_SPIRE_CA_BUNDLE_FILE unset', () => {
    let askedPath = '';
    loadSpireCaBundleFromEnv({ KAGENT_IDENTITY_ENABLED: 'true' }, (p) => {
      askedPath = p;
      return undefined;
    });
    expect(askedPath).toBe('/var/kagent/spire-ca/bundle.pem');
  });

  it('uses override path when KAGENT_SPIRE_CA_BUNDLE_FILE set', () => {
    let askedPath = '';
    loadSpireCaBundleFromEnv(
      {
        KAGENT_IDENTITY_ENABLED: 'true',
        KAGENT_SPIRE_CA_BUNDLE_FILE: '/etc/spire/ca-bundle.pem',
      },
      (p) => {
        askedPath = p;
        return undefined;
      },
    );
    expect(askedPath).toBe('/etc/spire/ca-bundle.pem');
  });
});

describe('DEFAULT_TRUST_DOMAIN', () => {
  it('matches the substrate-mandated `kagent.knuteson.io` trust domain', () => {
    expect(DEFAULT_TRUST_DOMAIN).toBe('kagent.knuteson.io');
  });
});

describe('MockIdentityWatcher.maybeRotate (v0.5.4-keyrotation)', () => {
  it('returns kept + emits no events when SVID is fresh', async () => {
    const events: AuditEvent[] = [];
    const watcher = new MockIdentityWatcher({
      publish: (e) => {
        events.push(e);
      },
      now: () => new Date('2026-05-04T01:00:00Z'),
    });
    const policy = resolveSvidRotationPolicyFromTest();
    const outcome = await watcher.maybeRotate({
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/researcher',
      notBefore: new Date('2026-05-04T00:00:00Z'),
      notAfter: new Date('2026-05-05T00:00:00Z'),
      policy,
      source: 'mock',
      now: new Date('2026-05-04T01:00:00Z'),
    });
    expect(outcome.verdict).toBe('kept');
    expect(events).toHaveLength(0);
  });

  it('emits keyrotation.svid_rotated + identity.rotation when interval crossed', async () => {
    const events: AuditEvent[] = [];
    const watcher = new MockIdentityWatcher({
      publish: (e) => {
        events.push(e);
      },
      now: () => new Date('2026-05-05T01:00:00Z'),
    });
    const policy = resolveSvidRotationPolicyFromTest();
    const outcome = await watcher.maybeRotate({
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/researcher',
      notBefore: new Date('2026-05-04T00:00:00Z'),
      notAfter: new Date('2026-05-05T00:00:00Z'),
      policy,
      source: 'mock',
      now: new Date('2026-05-05T01:00:00Z'),
    });
    expect(outcome.verdict).toBe('rotated');
    expect(events.map((e) => e.type)).toEqual(['keyrotation.svid_rotated', 'identity.rotation']);
    const krEvent = events[0];
    if (krEvent === undefined) throw new Error('no keyrotation event captured');
    if (krEvent.type === 'keyrotation.svid_rotated') {
      expect(krEvent.data.intervalSeconds).toBe(86400);
      expect(krEvent.data.ageSeconds).toBeGreaterThanOrEqual(86400);
      expect(krEvent.data.source).toBe('mock');
    }
  });

  it('does not throw when publish throws (best-effort contract)', async () => {
    let calls = 0;
    const watcher = new MockIdentityWatcher({
      publish: () => {
        calls++;
        throw new Error('downstream broken');
      },
    });
    const policy = resolveSvidRotationPolicyFromTest();
    const outcome = await watcher.maybeRotate({
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/sa/agent/researcher',
      notBefore: new Date('2026-05-04T00:00:00Z'),
      notAfter: new Date('2026-05-05T00:00:00Z'),
      policy,
      source: 'mock',
      now: new Date('2026-05-05T01:00:00Z'),
    });
    expect(outcome.verdict).toBe('rotated');
    // Both keyrotation + identity.rotation publish were attempted.
    expect(calls).toBe(2);
  });
});

// Inline import-helper kept local to the test to avoid a cross-package
// import in the import block at the top of the file.
function resolveSvidRotationPolicyFromTest(): { intervalSeconds: number } {
  // 24h default — matches Wave 4 KeyRotation default.
  return { intervalSeconds: 86400 };
}
