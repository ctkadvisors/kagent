/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import {
  ARTIFACT_VOLUME_NAME,
  buildJobSpec,
  DEFAULT_ARTIFACT_MOUNT_PATH,
  DEFAULT_CONTAINER_SECURITY_CONTEXT,
  DEFAULT_POD_SECURITY_CONTEXT,
  jobNameForTask,
  TMP_VOLUME_NAME,
} from './job-spec.js';

const sampleAgent: Agent = {
  apiVersion: API_GROUP_VERSION,
  kind: 'Agent',
  metadata: { name: 'researcher', namespace: 'default', uid: 'a-uid' },
  spec: {
    model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    systemPrompt: 'You are a research assistant.',
    tools: ['fetch_url', 'web_search'],
    sandboxProfile: 'default',
  },
};

const sampleTask: AgentTask = {
  apiVersion: API_GROUP_VERSION,
  kind: 'AgentTask',
  metadata: { name: 't1', namespace: 'default', uid: 'task-uid-12345' },
  spec: {
    targetAgent: 'researcher',
    payload: { topic: 'k3s' },
    originalUserMessage: 'what is k3s default runtime?',
  },
};

describe('jobNameForTask', () => {
  it('derives kat-<uid> deterministically', () => {
    expect(jobNameForTask(sampleTask)).toBe('kat-task-uid-12345');
  });

  it('throws when metadata.uid is missing', () => {
    const noUid: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: undefined },
    };
    expect(() => jobNameForTask(noUid)).toThrow(/missing metadata.uid/);
  });

  it('throws when metadata.uid is empty string', () => {
    const empty: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: '' },
    };
    expect(() => jobNameForTask(empty)).toThrow(/missing metadata.uid/);
  });

  it('truncates long UIDs to keep total name ≤ 63 chars', () => {
    const longUid = 'x'.repeat(100);
    const longTask: AgentTask = {
      ...sampleTask,
      metadata: { ...sampleTask.metadata, uid: longUid },
    };
    const name = jobNameForTask(longTask);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^kat-/);
  });
});

describe('buildJobSpec', () => {
  it('produces a Job with the expected name + namespace', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.metadata?.name).toBe('kat-task-uid-12345');
    expect(job.metadata?.namespace).toBe('default');
    expect(job.apiVersion).toBe('batch/v1');
    expect(job.kind).toBe('Job');
  });

  it('sets ownerReferences pointing at the AgentTask', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const owner = job.metadata?.ownerReferences?.[0];
    expect(owner?.apiVersion).toBe(API_GROUP_VERSION);
    expect(owner?.kind).toBe('AgentTask');
    expect(owner?.name).toBe('t1');
    expect(owner?.uid).toBe('task-uid-12345');
    expect(owner?.controller).toBe(true);
    expect(owner?.blockOwnerDeletion).toBe(true);
  });

  it('sets all KAGENT_* env vars on the container', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_ID')).toBe('task-uid-12345');
    expect(byName.get('KAGENT_TASK_NAME')).toBe('t1');
    expect(byName.get('KAGENT_TASK_NAMESPACE')).toBe('default');
    expect(byName.get('KAGENT_AGENT_NAME')).toBe('researcher');
    expect(JSON.parse(byName.get('KAGENT_AGENT_SPEC') ?? '{}')).toMatchObject({
      model: sampleAgent.spec.model,
    });
    expect(JSON.parse(byName.get('KAGENT_TASK_SPEC') ?? '{}')).toMatchObject({
      targetAgent: 'researcher',
    });
  });

  it('appends extraEnv after the KAGENT_* defaults', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      extraEnv: [
        { name: 'KAGENT_LITELLM_BASE_URL', value: 'http://192.168.68.60:1234/v1' },
        {
          name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
          value: 'http://langfuse:3000/api/public/otel/v1/traces',
        },
      ],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_LITELLM_BASE_URL')).toBe('http://192.168.68.60:1234/v1');
    expect(byName.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')).toBe(
      'http://langfuse:3000/api/public/otel/v1/traces',
    );
    // KAGENT_* defaults are still present.
    expect(byName.get('KAGENT_TASK_ID')).toBe('task-uid-12345');
  });

  it('uses placeholder image by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const image = job.spec?.template?.spec?.containers?.[0]?.image;
    expect(image).toMatch(/^ghcr\.io\/ctkadvisors\/kagent-agent-pod:/);
  });

  it('honors image override from BuildJobSpecOptions', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { image: 'custom:tag' });
    expect(job.spec?.template?.spec?.containers?.[0]?.image).toBe('custom:tag');
  });

  it('omits runtimeClassName by default; deprecated runtimeClassName field still applies kata when supplied', () => {
    const without = buildJobSpec(sampleAgent, sampleTask);
    expect(without.spec?.template?.spec?.runtimeClassName).toBeUndefined();
    const kata = buildJobSpec(sampleAgent, sampleTask, { runtimeClassName: 'kata' });
    expect(kata.spec?.template?.spec?.runtimeClassName).toBe('kata');
  });

  /* =====================================================================
   * Per-Agent runtimeClass mapping — WS-C / Kata + sandboxProfile wiring.
   *
   * `opts.runtimeClasses` is the canonical path: a profile-keyed map
   * resolved against `Agent.spec.sandboxProfile`. The deprecated
   * `opts.runtimeClassName` global override is still honored for tests
   * but the map wins when both are set.
   * ===================================================================== */

  it('runtimeClasses absent → no runtimeClassName on the pod spec', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {});
    expect(job.spec?.template?.spec?.runtimeClassName).toBeUndefined();
  });

  it('runtimeClasses.strict=kata + Agent.sandboxProfile=strict → runtimeClassName: kata', () => {
    const strictAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: 'strict' },
    };
    const job = buildJobSpec(strictAgent, sampleTask, {
      runtimeClasses: { default: '', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).toBe('kata');
  });

  it('runtimeClasses.default=runc + Agent.sandboxProfile=default → runtimeClassName: runc', () => {
    const defaultAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: 'default' },
    };
    const job = buildJobSpec(defaultAgent, sampleTask, {
      runtimeClasses: { default: 'runc', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).toBe('runc');
  });

  it('runtimeClasses.default=runc + Agent.sandboxProfile absent → defaults to "default" profile (runc)', () => {
    const noProfileAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: undefined },
    };
    const job = buildJobSpec(noProfileAgent, sampleTask, {
      runtimeClasses: { default: 'runc', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).toBe('runc');
  });

  it('runtimeClasses.strict=kata + Agent.sandboxProfile=default → does NOT apply kata (no over-application)', () => {
    const defaultAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: 'default' },
    };
    const job = buildJobSpec(defaultAgent, sampleTask, {
      runtimeClasses: { default: '', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).not.toBe('kata');
    // Empty default means cluster-default → omit field entirely.
    expect(job.spec?.template?.spec?.runtimeClassName).toBeUndefined();
  });

  it('runtimeClasses.strict=kata + Agent.sandboxProfile absent → does NOT apply kata', () => {
    const noProfileAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: undefined },
    };
    const job = buildJobSpec(noProfileAgent, sampleTask, {
      runtimeClasses: { default: '', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).not.toBe('kata');
    expect(job.spec?.template?.spec?.runtimeClassName).toBeUndefined();
  });

  it('runtimeClasses map wins over deprecated runtimeClassName field when both set', () => {
    const strictAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: 'strict' },
    };
    const job = buildJobSpec(strictAgent, sampleTask, {
      runtimeClassName: 'gvisor',
      runtimeClasses: { default: '', strict: 'kata' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).toBe('kata');
  });

  it('deprecated runtimeClassName falls through when runtimeClasses entry is empty', () => {
    const strictAgent: Agent = {
      ...sampleAgent,
      spec: { ...sampleAgent.spec, sandboxProfile: 'strict' },
    };
    // map present but strict is empty → fall back to deprecated override.
    const job = buildJobSpec(strictAgent, sampleTask, {
      runtimeClassName: 'gvisor',
      runtimeClasses: { default: '', strict: '' },
    });
    expect(job.spec?.template?.spec?.runtimeClassName).toBe('gvisor');
  });

  it('omits imagePullSecrets / serviceAccountName by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.template?.spec?.imagePullSecrets).toBeUndefined();
    expect(job.spec?.template?.spec?.serviceAccountName).toBeUndefined();
  });

  it('applies imagePullSecrets + serviceAccountName when supplied', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      imagePullSecret: 'ghcr-pull',
      serviceAccountName: 'kagent-agent-pod',
    });
    expect(job.spec?.template?.spec?.imagePullSecrets?.[0]?.name).toBe('ghcr-pull');
    expect(job.spec?.template?.spec?.serviceAccountName).toBe('kagent-agent-pod');
  });

  it('sets restartPolicy=Never and backoffLimit=0', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.template?.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
  });

  it('labels the Pod with agent + task + managed-by', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const labels = job.spec?.template?.metadata?.labels ?? {};
    expect(labels['kagent.knuteson.io/agent']).toBe('researcher');
    expect(labels['kagent.knuteson.io/task']).toBe('t1');
    expect(labels['kagent.knuteson.io/managed-by']).toBe('kagent-operator');
  });

  it('omits activeDeadlineSeconds when AgentTask.spec.timeoutSeconds is unset', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.activeDeadlineSeconds).toBeUndefined();
  });

  it('sets Job.spec.activeDeadlineSeconds from AgentTask.spec.timeoutSeconds', () => {
    const t = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: 60 } };
    const job = buildJobSpec(sampleAgent, t);
    expect(job.spec?.activeDeadlineSeconds).toBe(60);
  });

  it('omits activeDeadlineSeconds when timeoutSeconds is 0 or negative (defensive)', () => {
    const zero = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: 0 } };
    expect(buildJobSpec(sampleAgent, zero).spec?.activeDeadlineSeconds).toBeUndefined();
    const neg = { ...sampleTask, spec: { ...sampleTask.spec, timeoutSeconds: -5 } };
    expect(buildJobSpec(sampleAgent, neg).spec?.activeDeadlineSeconds).toBeUndefined();
  });

  /* =====================================================================
   * Artifact PVC plumbing — Phase 5 / Platform-Priorities P3
   * ===================================================================== */

  it('omits PVC volume / volumeMount / artifact env vars when artifactPvc is unset', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    // WS-A: a /tmp emptyDir is added under the default
    // readOnlyRootFilesystem=true container security context, so
    // volumes is no longer undefined when artifactPvc is unset. Assert
    // specifically that no PVC-backed volume is present.
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.some((v) => v.name === ARTIFACT_VOLUME_NAME)).toBe(false);
    const container = job.spec?.template?.spec?.containers?.[0];
    const mounts = container?.volumeMounts ?? [];
    expect(mounts.some((m) => m.name === ARTIFACT_VOLUME_NAME)).toBe(false);
    const env = container?.env ?? [];
    const names = env.map((e) => e.name);
    expect(names).not.toContain('KAGENT_ARTIFACTS_DIR');
    expect(names).not.toContain('KAGENT_ARTIFACT_PVC_NAME');
  });

  it('mounts the artifact PVC at the default path when artifactPvc.mountPath is omitted', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts' },
    });
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    const artifactVolume = volumes.find((v) => v.name === ARTIFACT_VOLUME_NAME);
    expect(artifactVolume).toBeDefined();
    expect(artifactVolume?.persistentVolumeClaim?.claimName).toBe('kagent-artifacts');

    const container = job.spec?.template?.spec?.containers?.[0];
    const mounts = container?.volumeMounts ?? [];
    const artifactMount = mounts.find((m) => m.name === ARTIFACT_VOLUME_NAME);
    expect(artifactMount).toBeDefined();
    expect(artifactMount?.mountPath).toBe(DEFAULT_ARTIFACT_MOUNT_PATH);
  });

  it('honors a custom artifactPvc.mountPath override', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts', mountPath: '/mnt/artifacts' },
    });
    const mount = job.spec?.template?.spec?.containers?.[0]?.volumeMounts?.[0];
    expect(mount?.mountPath).toBe('/mnt/artifacts');
  });

  it('injects KAGENT_ARTIFACTS_DIR + KAGENT_ARTIFACT_PVC_NAME env when PVC is set', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts' },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_ARTIFACTS_DIR')).toBe(DEFAULT_ARTIFACT_MOUNT_PATH);
    expect(byName.get('KAGENT_ARTIFACT_PVC_NAME')).toBe('kagent-artifacts');
  });

  it('injects KAGENT_ARTIFACTS_DIR matching the custom mountPath', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts', mountPath: '/mnt/artifacts' },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_ARTIFACTS_DIR')).toBe('/mnt/artifacts');
    expect(byName.get('KAGENT_ARTIFACT_PVC_NAME')).toBe('kagent-artifacts');
  });

  /* =====================================================================
   * Suspended Job creation — WS-F (suspended publish + dispatch ordering)
   * ===================================================================== */

  it('omits spec.suspend by default (back-compat with non-WS-F callers)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.suspend).toBeUndefined();
  });

  it('sets spec.suspend=true when BuildJobSpecOptions.suspend is set', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { suspend: true });
    expect(job.spec?.suspend).toBe(true);
  });

  it('omits spec.suspend when BuildJobSpecOptions.suspend is explicitly false', () => {
    // Defensive: only `=== true` flips the bit; `false` falls through to
    // the K8s default (unsuspended). This avoids surfacing `suspend: false`
    // on the API which is technically equivalent but clutters the diff.
    const job = buildJobSpec(sampleAgent, sampleTask, { suspend: false });
    expect(job.spec?.suspend).toBeUndefined();
  });

  it('artifact env vars come BEFORE extraEnv (so operator-level overrides win)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts' },
      extraEnv: [{ name: 'KAGENT_LITELLM_BASE_URL', value: 'http://litellm:4000/v1' }],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const idxArtifactDir = env.findIndex((e) => e.name === 'KAGENT_ARTIFACTS_DIR');
    const idxExtra = env.findIndex((e) => e.name === 'KAGENT_LITELLM_BASE_URL');
    expect(idxArtifactDir).toBeGreaterThan(-1);
    expect(idxExtra).toBeGreaterThan(idxArtifactDir);
  });

  /* =====================================================================
   * Security context — WS-A baseline
   * ===================================================================== */

  it('applies the WS-A default pod + container security context', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const podSpec = job.spec?.template?.spec;
    expect(podSpec?.securityContext).toEqual(DEFAULT_POD_SECURITY_CONTEXT);
    const container = podSpec?.containers?.[0];
    expect(container?.securityContext).toEqual(DEFAULT_CONTAINER_SECURITY_CONTEXT);
  });

  it('mounts a writable /tmp emptyDir under readOnlyRootFilesystem=true', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    const tmpVolume = volumes.find((v) => v.name === TMP_VOLUME_NAME);
    expect(tmpVolume).toBeDefined();
    expect(tmpVolume?.emptyDir).toBeDefined();

    const container = job.spec?.template?.spec?.containers?.[0];
    const mounts = container?.volumeMounts ?? [];
    const tmpMount = mounts.find((m) => m.name === TMP_VOLUME_NAME);
    expect(tmpMount?.mountPath).toBe('/tmp');
  });

  it('honors a caller-provided podSecurityContext override (not deep-merged)', () => {
    const custom = { runAsUser: 2000, fsGroup: 2000 };
    const job = buildJobSpec(sampleAgent, sampleTask, {
      podSecurityContext: custom,
    });
    expect(job.spec?.template?.spec?.securityContext).toEqual(custom);
  });

  it('omits the pod security context when caller passes null', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { podSecurityContext: null });
    expect(job.spec?.template?.spec?.securityContext).toBeUndefined();
  });

  it('omits the /tmp emptyDir when readOnlyRootFilesystem is overridden to false', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      containerSecurityContext: {
        ...DEFAULT_CONTAINER_SECURITY_CONTEXT,
        readOnlyRootFilesystem: false,
      },
    });
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.some((v) => v.name === TMP_VOLUME_NAME)).toBe(false);
  });

  it('omits the container security context when caller passes null', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { containerSecurityContext: null });
    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.securityContext).toBeUndefined();
    // /tmp emptyDir is also omitted (no readOnlyRootFilesystem flag in
    // the container security context to gate it).
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.some((v) => v.name === TMP_VOLUME_NAME)).toBe(false);
  });

  it('preserves the artifact volume + adds the /tmp emptyDir under default security ctx', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts' },
    });
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    const names = volumes.map((v) => v.name).sort();
    expect(names).toEqual([ARTIFACT_VOLUME_NAME, TMP_VOLUME_NAME].sort());
  });

  /* =====================================================================
   * v0.1.8 — secret-hygiene. Spawned-Job env entries that carry a key
   * or secret MUST be expressed as `valueFrom.secretKeyRef`, never as
   * inline `value:`. Today we accept both shapes in the typed
   * `extraEnv` array; this group of tests pins the rendered Job spec
   * to the secret-ref shape and asserts the failure mode for any
   * regression (a plaintext `value:` for a name matching `KEY|SECRET`
   * would land in etcd, `kubectl describe pod`, and `/proc/<pid>/environ`).
   * ===================================================================== */

  it('accepts an extraEnv entry carrying a valueFrom.secretKeyRef and emits it verbatim', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      extraEnv: [
        {
          name: 'KAGENT_LITELLM_API_KEY',
          valueFrom: {
            secretKeyRef: { name: 'cloudflare-ai-gateway', key: 'api-key' },
          },
        },
      ],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const apiKeyEntry = env.find((e) => e.name === 'KAGENT_LITELLM_API_KEY');
    expect(apiKeyEntry).toBeDefined();
    expect(apiKeyEntry?.value).toBeUndefined();
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe('cloudflare-ai-gateway');
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.key).toBe('api-key');
  });

  it('mixes plaintext and secret-ref extraEnv entries side-by-side', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      extraEnv: [
        { name: 'KAGENT_LITELLM_BASE_URL', value: 'http://gw/v1' },
        {
          name: 'KAGENT_LITELLM_API_KEY',
          valueFrom: { secretKeyRef: { name: 'gw', key: 'token' } },
        },
        {
          name: 'KAGENT_LANGFUSE_SECRET_KEY',
          valueFrom: { secretKeyRef: { name: 'lf', key: 'sk' } },
        },
      ],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    expect(env.find((e) => e.name === 'KAGENT_LITELLM_BASE_URL')?.value).toBe('http://gw/v1');
    expect(
      env.find((e) => e.name === 'KAGENT_LITELLM_API_KEY')?.valueFrom?.secretKeyRef?.name,
    ).toBe('gw');
    expect(
      env.find((e) => e.name === 'KAGENT_LANGFUSE_SECRET_KEY')?.valueFrom?.secretKeyRef?.key,
    ).toBe('sk');
  });

  it('emits ZERO inline `value:` entries for any name matching /KEY|SECRET/i when extraEnv supplies secretRefs', () => {
    // The brief's secret-hygiene contract: rendered Job spec has zero
    // `value:` entries for any name matching /(?i)KEY|SECRET/. This
    // is the regression test the v0.1.8 release is gated on.
    const job = buildJobSpec(sampleAgent, sampleTask, {
      extraEnv: [
        // Sensitive names: secretRef-shaped only.
        {
          name: 'KAGENT_LITELLM_API_KEY',
          valueFrom: { secretKeyRef: { name: 'gw', key: 'token' } },
        },
        {
          name: 'KAGENT_LANGFUSE_SECRET_KEY',
          valueFrom: { secretKeyRef: { name: 'lf', key: 'sk' } },
        },
        {
          name: 'KAGENT_LANGFUSE_PUBLIC_KEY',
          valueFrom: { secretKeyRef: { name: 'lf', key: 'pk' } },
        },
        // Non-sensitive plaintext is fine.
        { name: 'KAGENT_LITELLM_BASE_URL', value: 'http://gw/v1' },
        { name: 'KAGENT_LANGFUSE_HOST', value: 'http://lf' },
      ],
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const sensitive = /(?:KEY|SECRET)/i;
    const offenders = env.filter(
      (e) => sensitive.test(e.name) && typeof e.value === 'string' && e.value.length > 0,
    );
    expect(offenders).toEqual([]);
  });

  /* =====================================================================
   * v0.1.11 — OTEL_TRACEPARENT env threading from runConfig.traceparent
   * ===================================================================== */

  it('omits OTEL_TRACEPARENT env when runConfig.traceparent is unset', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const names = env.map((e) => e.name);
    expect(names).not.toContain('OTEL_TRACEPARENT');
  });

  it('threads runConfig.traceparent into OTEL_TRACEPARENT env on the agent container', () => {
    const tp = '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01';
    const t: AgentTask = {
      ...sampleTask,
      spec: { ...sampleTask.spec, runConfig: { traceparent: tp } },
    };
    const job = buildJobSpec(sampleAgent, t);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('OTEL_TRACEPARENT')).toBe(tp);
  });

  it('omits OTEL_TRACEPARENT env when runConfig is set but traceparent is not', () => {
    const t: AgentTask = {
      ...sampleTask,
      spec: { ...sampleTask.spec, runConfig: { timeoutSeconds: 30 } },
    };
    const job = buildJobSpec(sampleAgent, t);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    expect(env.find((e) => e.name === 'OTEL_TRACEPARENT')).toBeUndefined();
  });
});
