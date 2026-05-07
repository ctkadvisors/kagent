/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { API_GROUP_VERSION, type Agent, type AgentTask } from './crds/index.js';
import {
  ARTIFACT_VOLUME_NAME,
  buildAgentTaskConfigMap,
  buildArtifactMounts,
  buildCacheMounts,
  buildJobSpec,
  CAP_JWT_SECRET_KEY,
  CAP_JWT_VOLUME_NAME,
  CAS_VOLUME_NAME,
  CONFIG_AGENT_SPEC_KEY,
  CONFIG_MOUNT_PATH,
  CONFIG_TASK_SPEC_KEY,
  CONFIG_VOLUME_NAME,
  configMapNameForTask,
  DEFAULT_CAP_JWT_FILE,
  DEFAULT_ARTIFACT_MOUNT_PATH,
  DEFAULT_BACKOFF_LIMIT,
  DEFAULT_CAS_MOUNT_PATH,
  DEFAULT_CONTAINER_SECURITY_CONTEXT,
  DEFAULT_POD_SECURITY_CONTEXT,
  DEFAULT_TTL_SECONDS_AFTER_FINISHED,
  jobNameForTask,
  parseTaskDepthLabel,
  TASK_DEPTH_LABEL,
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

  it('sets the KAGENT_* env vars on the container (v0.2.0 ConfigMap path drops AGENT_SPEC + TASK_SPEC env)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_ID')).toBe('task-uid-12345');
    expect(byName.get('KAGENT_TASK_NAME')).toBe('t1');
    expect(byName.get('KAGENT_TASK_NAMESPACE')).toBe('default');
    expect(byName.get('KAGENT_AGENT_NAME')).toBe('researcher');
    // v0.2.0-typed-io — model surfaces as a tiny dedicated env var
    // (admission reads this without a ConfigMap round-trip); the
    // big JSON blobs move to the per-Job ConfigMap mounted at
    // /var/kagent/config/.
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe(sampleAgent.spec.model);
    expect(byName.has('KAGENT_AGENT_SPEC')).toBe(false);
    expect(byName.has('KAGENT_TASK_SPEC')).toBe(false);
  });

  it('useConfigMap: false keeps the legacy KAGENT_AGENT_SPEC + KAGENT_TASK_SPEC env (back-compat)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { useConfigMap: false });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(JSON.parse(byName.get('KAGENT_AGENT_SPEC') ?? '{}')).toMatchObject({
      model: sampleAgent.spec.model,
    });
    expect(JSON.parse(byName.get('KAGENT_TASK_SPEC') ?? '{}')).toMatchObject({
      targetAgent: 'researcher',
    });
    // Model env still emitted (admission's hot path).
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe(sampleAgent.spec.model);
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

  it('mounts a per-task capability JWT Secret when capabilityJwt is supplied', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      capabilityJwt: {
        secretName: 'kagent-cap-task-uid-12345',
        jwksUrl: 'http://operator-templates.default.svc.cluster.local:8081/.well-known/jwks.json',
        issuer: 'kagent.knuteson.io/operator',
      },
    });
    const pod = job.spec?.template?.spec;
    const container = pod?.containers?.[0];
    const env = new Map((container?.env ?? []).map((e) => [e.name, e.value]));
    expect(env.get('KAGENT_CAP_JWT_FILE')).toBe(DEFAULT_CAP_JWT_FILE);
    expect(env.get('KAGENT_CAP_JWKS_URL')).toBe(
      'http://operator-templates.default.svc.cluster.local:8081/.well-known/jwks.json',
    );
    expect(env.get('KAGENT_CAP_ISSUER')).toBe('kagent.knuteson.io/operator');

    expect(pod?.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: CAP_JWT_VOLUME_NAME,
          secret: {
            secretName: 'kagent-cap-task-uid-12345',
            items: [{ key: CAP_JWT_SECRET_KEY, path: 'cap.jwt' }],
          },
        }),
      ]),
    );
    expect(container?.volumeMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: CAP_JWT_VOLUME_NAME,
          mountPath: '/var/kagent/cap',
          readOnly: true,
        }),
      ]),
    );
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

  // v0.1.9 — pin DEFAULT_BACKOFF_LIMIT=0 against accidental bumps. The
  // Job-controller default is 6, which would silently re-spawn a fresh
  // agent-pod with the same task UID after any first failure (LLM
  // hiccup, K8s API timeout) and re-issue every side effect the run
  // already produced.
  it('exports DEFAULT_BACKOFF_LIMIT=0 (no retry double-spawn)', () => {
    expect(DEFAULT_BACKOFF_LIMIT).toBe(0);
  });

  // v0.1.9 — TTL reduction from 3600s → 300s. Helm-overridable via
  // BuildJobSpecOptions if a deployment legitimately wants longer
  // post-mortem retention.
  it('exports DEFAULT_TTL_SECONDS_AFTER_FINISHED=300 (was 3600)', () => {
    expect(DEFAULT_TTL_SECONDS_AFTER_FINISHED).toBe(300);
  });

  it('stamps Job.spec.ttlSecondsAfterFinished=300 by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
  });

  /* =====================================================================
   * v0.1.9 — task-depth threading. The operator stamps KAGENT_TASK_DEPTH
   * on every spawned Job env so the agent-pod can return it from
   * `get_my_context()` and the in-pod spawn tool can refuse children
   * at the cluster cap. Per-task depth lives in the
   * `kagent.knuteson.io/task-depth` label, set by the agent-pod's
   * K8sTaskCreator on child create. Root tasks have no such label →
   * depth = 0.
   * ===================================================================== */

  it('exports TASK_DEPTH_LABEL constant for cross-package referencing', () => {
    expect(TASK_DEPTH_LABEL).toBe('kagent.knuteson.io/task-depth');
  });

  it('stamps KAGENT_TASK_DEPTH=0 on root tasks (no parent-depth label)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_DEPTH')).toBe('0');
  });

  it('reads task depth from kagent.knuteson.io/task-depth label and stamps it verbatim', () => {
    const child: AgentTask = {
      ...sampleTask,
      metadata: {
        ...sampleTask.metadata,
        labels: { [TASK_DEPTH_LABEL]: '2' },
      },
    };
    const job = buildJobSpec(sampleAgent, child);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_DEPTH')).toBe('2');
  });

  it('parseTaskDepthLabel: returns 0 for undefined / empty / non-numeric / negative', () => {
    expect(parseTaskDepthLabel(undefined)).toBe(0);
    expect(parseTaskDepthLabel('')).toBe(0);
    expect(parseTaskDepthLabel('not-a-number')).toBe(0);
    expect(parseTaskDepthLabel('-1')).toBe(0);
    expect(parseTaskDepthLabel('1.5')).toBe(0);
    expect(parseTaskDepthLabel('NaN')).toBe(0);
  });

  it('parseTaskDepthLabel: parses non-negative integer strings', () => {
    expect(parseTaskDepthLabel('0')).toBe(0);
    expect(parseTaskDepthLabel('1')).toBe(1);
    expect(parseTaskDepthLabel('4')).toBe(4);
    expect(parseTaskDepthLabel('99')).toBe(99);
  });

  it('treats non-numeric task-depth label as 0 (defensive end-to-end)', () => {
    const garbage: AgentTask = {
      ...sampleTask,
      metadata: {
        ...sampleTask.metadata,
        labels: { [TASK_DEPTH_LABEL]: 'not-a-number' },
      },
    };
    const job = buildJobSpec(sampleAgent, garbage);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_TASK_DEPTH')).toBe('0');
  });

  /* v0.4.1-blackboard — Wave 3 / Blackboard sub-team. */
  it('stamps KAGENT_BLACKBOARD_BUCKET=kagent-kv-<own-uid> on root tasks (no label)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_BLACKBOARD_BUCKET')).toBe(
      `kagent-kv-${sampleTask.metadata.uid ?? ''}`,
    );
  });

  it('stamps KAGENT_BLACKBOARD_BUCKET=kagent-kv-<root-uid-label> on child tasks', () => {
    const child: AgentTask = {
      ...sampleTask,
      metadata: {
        ...sampleTask.metadata,
        uid: 'uid-grandchild',
        labels: { 'kagent.knuteson.io/root-task-uid': 'uid-root-tree' },
      },
    };
    const job = buildJobSpec(sampleAgent, child);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_BLACKBOARD_BUCKET')).toBe('kagent-kv-uid-root-tree');
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

  it('omits KAGENT_ARTIFACT_MAX_BYTES when artifactPvc.maxBytes is unset', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts' },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const names = env.map((e) => e.name);
    expect(names).not.toContain('KAGENT_ARTIFACT_MAX_BYTES');
  });

  it('injects KAGENT_ARTIFACT_MAX_BYTES when artifactPvc.maxBytes is set', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, {
      artifactPvc: { claimName: 'kagent-artifacts', maxBytes: 26214400 },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_ARTIFACT_MAX_BYTES')).toBe('26214400');
  });

  it('drops malformed maxBytes (negative / zero / non-finite) silently', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const job = buildJobSpec(sampleAgent, sampleTask, {
        artifactPvc: { claimName: 'kagent-artifacts', maxBytes: bad },
      });
      const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const names = env.map((e) => e.name);
      expect(names).not.toContain('KAGENT_ARTIFACT_MAX_BYTES');
    }
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
    // v0.2.0-typed-io — `kagent-config` ConfigMap volume joins the
    // artifact PVC + /tmp emptyDir under the default security ctx.
    expect(names).toEqual([ARTIFACT_VOLUME_NAME, CONFIG_VOLUME_NAME, TMP_VOLUME_NAME].sort());
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

  /* =====================================================================
   * Phase-2 modelClass — operator-side resolver injection.
   *
   * `buildJobSpec` accepts a `modelClassMap` opt that the in-function
   * resolver consults BEFORE emitting `KAGENT_AGENT_MODEL`. Behavior:
   *   - Agent.spec.model set → unchanged (resolver returns 'override').
   *   - Agent.spec.modelClass set + key in map → emit mapped physical
   *     model id; log the resolution.
   *   - Agent.spec.modelClass set + key absent → throw (operator's
   *     reconcile-error path surfaces this onto AgentTask.status.error).
   * See docs/MODEL-ROUTING.md §3 + model-class-resolver.test.ts.
   * ===================================================================== */

  it('Phase-2 modelClass: resolves Agent.spec.modelClass through modelClassMap into KAGENT_AGENT_MODEL', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        // model omitted — modelClass is the only source.
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(classedAgent, sampleTask, {
      modelClassMap: {
        'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe(
      'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    );
  });

  it('Phase-2 modelClass: spec.model wins over spec.modelClass (escape-hatch precedence)', () => {
    const overrideAgent: Agent = {
      ...sampleAgent,
      spec: {
        ...sampleAgent.spec,
        model: 'anthropic/claude-3-7-sonnet-20250219',
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(overrideAgent, sampleTask, {
      modelClassMap: {
        'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe('anthropic/claude-3-7-sonnet-20250219');
  });

  it('Phase-2 modelClass: throws when modelClass is set but absent from the map', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-strict',
      },
    };
    expect(() =>
      buildJobSpec(classedAgent, sampleTask, {
        modelClassMap: {
          'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
        },
      }),
    ).toThrow(/tool-caller-strict/);
  });

  it('Phase-2 modelClass: legacy Agent.spec.model still works without a modelClassMap (back-compat)', () => {
    // Existing v0.1 manifest fleet — every Agent has spec.model set.
    // Operator boot may not have a class map at all; build must succeed.
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_AGENT_MODEL')).toBe(sampleAgent.spec.model);
  });

  /* =====================================================================
   * v0.1.9 context-awareness Piece 1 — `KAGENT_AGENT_MODEL_CONTEXT_WINDOW`
   * env emission on the spawned pod.
   *
   * When the resolved class entry declares `contextWindowTokens`, the
   * job-spec emits the value as an integer-string env var on the
   * spawned pod. When the class omits the field — or the Agent took
   * the literal `spec.model` escape hatch — the env var is omitted
   * entirely so Pieces 2/3/4 in @kagent/agent-pod + @kagent/agent-loop
   * degrade to no-op (preserves v0.1.8 behavior). Per
   * docs/CONTEXT-AWARENESS.md §4.1 + §7.
   * ===================================================================== */

  it('v0.1.9 context-awareness: emits KAGENT_AGENT_MODEL_CONTEXT_WINDOW when class declares contextWindowTokens', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(classedAgent, sampleTask, {
      modelClassMap: {
        'tool-caller-default': {
          model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
          contextWindowTokens: 131072,
        },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.get('KAGENT_AGENT_MODEL_CONTEXT_WINDOW')).toBe('131072');
  });

  it('v0.1.9 context-awareness: omits KAGENT_AGENT_MODEL_CONTEXT_WINDOW when class entry has no window', () => {
    // Back-compat path — entry has only `model`. The env var MUST be
    // omitted entirely so the in-pod pieces 2/3/4 see `undefined` and
    // run as no-ops, exactly mirroring v0.1.8 behavior.
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(classedAgent, sampleTask, {
      modelClassMap: {
        'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.has('KAGENT_AGENT_MODEL_CONTEXT_WINDOW')).toBe(false);
  });

  it('v0.1.9 context-awareness: omits KAGENT_AGENT_MODEL_CONTEXT_WINDOW for the literal spec.model escape-hatch', () => {
    // Per CONTEXT-AWARENESS §9 Q5 — the chart map is the single source
    // of truth for context windows. Agents using the literal `spec.model`
    // escape-hatch never get the env var (even if the class key with a
    // window happens to exist in the map; `source: 'override'` skips it).
    const overrideAgent: Agent = {
      ...sampleAgent,
      spec: {
        ...sampleAgent.spec,
        model: 'anthropic/claude-3-7-sonnet-20250219',
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(overrideAgent, sampleTask, {
      modelClassMap: {
        'tool-caller-default': {
          model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
          contextWindowTokens: 131072,
        },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.has('KAGENT_AGENT_MODEL_CONTEXT_WINDOW')).toBe(false);
  });

  it('v0.1.9 context-awareness: legacy Agent.spec.model with no modelClassMap omits KAGENT_AGENT_MODEL_CONTEXT_WINDOW', () => {
    // Pre-context-awareness manifest fleet — every Agent has spec.model
    // set; no class map present. The new env var must NOT appear so
    // already-running tasks keep the v0.1.8 (no safety-net, no detector)
    // semantics until the chart values are migrated.
    const job = buildJobSpec(sampleAgent, sampleTask);
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const byName = new Map(env.map((e) => [e.name, e.value]));
    expect(byName.has('KAGENT_AGENT_MODEL_CONTEXT_WINDOW')).toBe(false);
  });
});

/* =====================================================================
 * v0.2.0-typed-io — ConfigMap projection
 * ===================================================================== */

describe('configMapNameForTask', () => {
  it('derives a kac- prefixed deterministic name from the task uid', () => {
    expect(configMapNameForTask(sampleTask)).toBe('kac-task-uid-12345');
  });

  it('truncates uid to fit a 63-char DNS-1123 name', () => {
    const longUid = 'x'.repeat(80);
    const t: AgentTask = { ...sampleTask, metadata: { ...sampleTask.metadata, uid: longUid } };
    const name = configMapNameForTask(t);
    expect(name.length).toBeLessThanOrEqual(54); // 'kac-' + 50 chars
    expect(name.startsWith('kac-')).toBe(true);
  });

  it('throws when uid is missing', () => {
    const t: AgentTask = { ...sampleTask, metadata: { name: 't' } };
    expect(() => configMapNameForTask(t)).toThrow(/missing metadata\.uid/);
  });
});

describe('buildAgentTaskConfigMap', () => {
  it('produces a ConfigMap with agent.spec.json + task.spec.json data', () => {
    const cm = buildAgentTaskConfigMap(sampleAgent, sampleTask);
    expect(cm.kind).toBe('ConfigMap');
    expect(cm.metadata?.name).toBe('kac-task-uid-12345');
    expect(cm.metadata?.namespace).toBe('default');
    expect(cm.data?.[CONFIG_AGENT_SPEC_KEY]).toBeDefined();
    expect(cm.data?.[CONFIG_TASK_SPEC_KEY]).toBeDefined();
    expect(JSON.parse(cm.data?.[CONFIG_AGENT_SPEC_KEY] ?? '{}')).toMatchObject({
      model: sampleAgent.spec.model,
    });
    expect(JSON.parse(cm.data?.[CONFIG_TASK_SPEC_KEY] ?? '{}')).toMatchObject({
      targetAgent: 'researcher',
    });
  });

  it('stamps managed-by + agent + task labels (parallel to the Job)', () => {
    const cm = buildAgentTaskConfigMap(sampleAgent, sampleTask);
    expect(cm.metadata?.labels).toMatchObject({
      'kagent.knuteson.io/agent': 'researcher',
      'kagent.knuteson.io/task': 't1',
      'kagent.knuteson.io/managed-by': 'kagent-operator',
    });
  });

  it('owns the ConfigMap by the AgentTask via ownerReferences (cascading delete)', () => {
    const cm = buildAgentTaskConfigMap(sampleAgent, sampleTask);
    const owner = cm.metadata?.ownerReferences?.[0];
    expect(owner?.kind).toBe('AgentTask');
    expect(owner?.uid).toBe('task-uid-12345');
    expect(owner?.controller).toBe(true);
    expect(owner?.blockOwnerDeletion).toBe(true);
  });

  /* =====================================================================
   * Phase-2 modelClass — ConfigMap projection (v0.1.8-modelclass.1 fix).
   *
   * The pod's `parseEnv` reads `agent.spec.json` from the ConfigMap and
   * REQUIRES `agentSpec.model` to be a non-empty string. The operator
   * MUST resolve modelClass → physical model id and rewrite spec.model
   * BEFORE serializing the JSON, otherwise pods spawned for migrated
   * (modelClass-only) agents fatal-exit on boot.
   *
   * The `modelClass` field is preserved in the serialized spec for
   * traceability — the pod stays naive about it.
   * ===================================================================== */

  it('Phase-2 modelClass: writes resolved physical model id onto agent.spec.json when only modelClass is set', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        // model omitted — modelClass is the only source.
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const cm = buildAgentTaskConfigMap(classedAgent, sampleTask, {
      'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
    });
    expect(JSON.parse(cm.data?.[CONFIG_AGENT_SPEC_KEY] ?? '{}')).toMatchObject({
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
    });
  });

  it('Phase-2 modelClass: spec.model wins over modelClass in the serialized agent.spec.json (escape-hatch precedence)', () => {
    const overrideAgent: Agent = {
      ...sampleAgent,
      spec: {
        ...sampleAgent.spec,
        model: 'anthropic/claude-3-7-sonnet-20250219',
        modelClass: 'tool-caller-default',
      },
    };
    const cm = buildAgentTaskConfigMap(overrideAgent, sampleTask, {
      'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
    });
    expect(JSON.parse(cm.data?.[CONFIG_AGENT_SPEC_KEY] ?? '{}')).toMatchObject({
      model: 'anthropic/claude-3-7-sonnet-20250219',
    });
  });

  it('Phase-2 modelClass: preserves modelClass field on the serialized agent.spec.json (informational, not stripped)', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const cm = buildAgentTaskConfigMap(classedAgent, sampleTask, {
      'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
    });
    expect(JSON.parse(cm.data?.[CONFIG_AGENT_SPEC_KEY] ?? '{}')).toMatchObject({
      modelClass: 'tool-caller-default',
    });
  });

  it('Phase-2 modelClass: legacy Agent.spec.model still works without a classMap argument (back-compat)', () => {
    // Existing v0.1 callers (tests, pre-Phase-2 fleets) — agent has
    // spec.model set; classMap omitted entirely. ConfigMap must
    // serialize the literal model unchanged.
    const cm = buildAgentTaskConfigMap(sampleAgent, sampleTask);
    expect(JSON.parse(cm.data?.[CONFIG_AGENT_SPEC_KEY] ?? '{}')).toMatchObject({
      model: sampleAgent.spec.model,
    });
  });

  it('Phase-2 modelClass: throws when modelClass is set but absent from the classMap', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-strict',
      },
    };
    expect(() =>
      buildAgentTaskConfigMap(classedAgent, sampleTask, {
        'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      }),
    ).toThrow(/tool-caller-strict/);
  });
});

describe('buildJobSpec — env-JSON fallback path (useConfigMap: false) modelClass resolution', () => {
  it('Phase-2 modelClass: KAGENT_AGENT_SPEC env JSON has resolved spec.model when only modelClass is set', () => {
    const classedAgent: Agent = {
      ...sampleAgent,
      spec: {
        systemPrompt: sampleAgent.spec.systemPrompt,
        modelClass: 'tool-caller-default',
      },
    };
    const job = buildJobSpec(classedAgent, sampleTask, {
      useConfigMap: false,
      modelClassMap: {
        'tool-caller-default': { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
      },
    });
    const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const specEntry = env.find((e) => e.name === 'KAGENT_AGENT_SPEC');
    expect(specEntry?.value).toBeDefined();
    expect(JSON.parse(specEntry?.value ?? '{}')).toMatchObject({
      model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      modelClass: 'tool-caller-default',
    });
  });
});

describe('buildJobSpec — ConfigMap mount (v0.2.0 default)', () => {
  it('mounts /var/kagent/config from the per-Job ConfigMap by default', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    const configVol = volumes.find((v) => v.name === CONFIG_VOLUME_NAME);
    expect(configVol).toBeDefined();
    expect(configVol?.configMap?.name).toBe('kac-task-uid-12345');
    // mode 0o444 — read-only, world-readable. Defense in depth.
    expect(configVol?.configMap?.defaultMode).toBe(0o444);

    const mounts = job.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    const configMount = mounts.find((m) => m.name === CONFIG_VOLUME_NAME);
    expect(configMount?.mountPath).toBe(CONFIG_MOUNT_PATH);
    expect(configMount?.readOnly).toBe(true);
  });

  it('useConfigMap: false drops the ConfigMap volume + mount (back-compat)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { useConfigMap: false });
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    expect(volumes.some((v) => v.name === CONFIG_VOLUME_NAME)).toBe(false);
    const mounts = job.spec?.template?.spec?.containers?.[0]?.volumeMounts ?? [];
    expect(mounts.some((m) => m.name === CONFIG_VOLUME_NAME)).toBe(false);
  });

  it('exposes both agent.spec.json + task.spec.json keys as `items` (default ConfigMap mount)', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const volumes = job.spec?.template?.spec?.volumes ?? [];
    const configVol = volumes.find((v) => v.name === CONFIG_VOLUME_NAME);
    const items = configVol?.configMap?.items ?? [];
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual([CONFIG_AGENT_SPEC_KEY, CONFIG_TASK_SPEC_KEY].sort());
  });
});

/* =====================================================================
 * Audit-rev2 M11 follow-up — Pod template `kagent.knuteson.io/spec-source`
 * annotation.
 *
 * The agent-pod's `parseEnv` recognizes `'configmap' | 'env-json' | 'mixed'`
 * (per packages/agent-pod/src/env.ts:305) and stamps the choice on
 * process.env.KAGENT_SPEC_SOURCE / OTel attribute / boot log. The
 * operator-side annotation closes the observability loop so on-call can
 * read the path off `kubectl describe pod` without exec'ing into the pod.
 *
 * The annotation is stamped at Job-create time on the Pod template
 * metadata, NOT the Job metadata, because what we care about is the
 * pod's spec-mount path. The 'mixed' case (one ConfigMap + one env-JSON
 * resolution at parse time) is intentionally not stampable here — the
 * operator commits to one path per Job. Mixed is a partial-mount edge
 * case the agent-pod surfaces with a runtime WARN.
 * ===================================================================== */
describe('buildJobSpec — kagent.knuteson.io/spec-source annotation (audit-rev2 M11 follow-up)', () => {
  it('default (useConfigMap implicit) stamps spec-source=configmap on the Pod template', () => {
    const job = buildJobSpec(sampleAgent, sampleTask);
    const annotations = job.spec?.template?.metadata?.annotations ?? {};
    expect(annotations['kagent.knuteson.io/spec-source']).toBe('configmap');
  });

  it('explicit useConfigMap: true stamps spec-source=configmap', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { useConfigMap: true });
    const annotations = job.spec?.template?.metadata?.annotations ?? {};
    expect(annotations['kagent.knuteson.io/spec-source']).toBe('configmap');
  });

  it('useConfigMap: false (env-JSON fallback) stamps spec-source=env-json', () => {
    const job = buildJobSpec(sampleAgent, sampleTask, { useConfigMap: false });
    const annotations = job.spec?.template?.metadata?.annotations ?? {};
    expect(annotations['kagent.knuteson.io/spec-source']).toBe('env-json');
  });

  it('annotation lives on the POD template, not the Job-level metadata', () => {
    // The Pod is the substrate the agent-pod runs in; its annotations
    // are what `kubectl describe pod` shows. Job-level annotations are
    // a different surface (admission-policy, GitOps reconcilers).
    const job = buildJobSpec(sampleAgent, sampleTask);
    expect(job.metadata?.annotations?.['kagent.knuteson.io/spec-source']).toBeUndefined();
    expect(job.spec?.template?.metadata?.annotations?.['kagent.knuteson.io/spec-source']).toBe(
      'configmap',
    );
  });
});

describe('buildArtifactMounts (Wave 1 / CAS)', () => {
  function agentWith(inputs?: Agent['spec']['inputs'], outputs?: Agent['spec']['outputs']): Agent {
    return {
      ...sampleAgent,
      spec: {
        ...sampleAgent.spec,
        ...(inputs !== undefined && { inputs }),
        ...(outputs !== undefined && { outputs }),
      },
    };
  }

  it('returns empty arrays when Agent has no inputs / outputs', () => {
    const result = buildArtifactMounts({ pvcName: 'kagent-cas', agent: sampleAgent });
    expect(result.volumes).toEqual([]);
    expect(result.volumeMounts).toEqual([]);
  });

  it('returns empty arrays when only scalar / workspace inputs', () => {
    const agent = agentWith([
      { name: 'k', kind: 'scalar' },
      { name: 'corpus', kind: 'workspace', mountPath: '/mnt/corpus' },
    ]);
    const result = buildArtifactMounts({ pvcName: 'kagent-cas', agent });
    expect(result.volumes).toEqual([]);
    expect(result.volumeMounts).toEqual([]);
  });

  it('emits one volume + one read-only mount when an artifact INPUT is declared', () => {
    const agent = agentWith([{ name: 'brief', kind: 'artifact', mountPath: '/var/kagent/cas' }]);
    const result = buildArtifactMounts({ pvcName: 'kagent-cas', agent });
    expect(result.volumes).toEqual([
      { name: CAS_VOLUME_NAME, persistentVolumeClaim: { claimName: 'kagent-cas' } },
    ]);
    expect(result.volumeMounts).toEqual([
      { name: CAS_VOLUME_NAME, mountPath: DEFAULT_CAS_MOUNT_PATH, readOnly: true },
    ]);
  });

  it('emits one volume + mount when only artifact OUTPUTS are declared', () => {
    const agent = agentWith(undefined, [{ name: 'digest', kind: 'artifact' }]);
    const result = buildArtifactMounts({ pvcName: 'kagent-cas', agent });
    expect(result.volumes).toHaveLength(1);
    expect(result.volumeMounts).toHaveLength(1);
  });

  it('honors a custom mountPath', () => {
    const agent = agentWith([{ name: 'brief', kind: 'artifact' }]);
    const result = buildArtifactMounts({
      pvcName: 'kagent-cas',
      mountPath: '/custom/cas',
      agent,
    });
    expect(result.volumeMounts[0]?.mountPath).toBe('/custom/cas');
  });

  it('returns empty arrays when pvcName is empty (CAS disabled)', () => {
    const agent = agentWith([{ name: 'brief', kind: 'artifact' }]);
    const result = buildArtifactMounts({ pvcName: '', agent });
    expect(result.volumes).toEqual([]);
    expect(result.volumeMounts).toEqual([]);
  });

  it('mount is read-only (writers go through the in-pod CAS backend, not the mount)', () => {
    const agent = agentWith([{ name: 'brief', kind: 'artifact' }]);
    const result = buildArtifactMounts({ pvcName: 'kagent-cas', agent });
    expect(result.volumeMounts[0]?.readOnly).toBe(true);
  });

  it('volume name is stable (CAS_VOLUME_NAME) for status patching', () => {
    expect(CAS_VOLUME_NAME).toBe('kagent-cas');
    expect(DEFAULT_CAS_MOUNT_PATH).toBe('/var/kagent/cas');
  });
});

describe('buildCacheMounts (Wave 3 / Cache)', () => {
  function agentWithCaches(caches?: Agent['spec']['caches']): Agent {
    return {
      ...sampleAgent,
      spec: {
        ...sampleAgent.spec,
        ...(caches !== undefined && { caches }),
      },
    };
  }

  it('returns empty everything when Agent declares no caches', () => {
    const result = buildCacheMounts({
      agent: sampleAgent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: [],
    });
    expect(result.initContainers).toEqual([]);
    expect(result.volumes).toEqual([]);
    expect(result.volumeMounts).toEqual([]);
    expect(result.perSlot).toEqual([]);
    expect(result.hitCount).toBe(0);
    expect(result.missCount).toBe(0);
  });

  it('returns empty everything when pvcName is empty (cache disabled)', () => {
    const agent = agentWithCaches([{ name: 'npm', key: 'default', mountPath: '/c/npm' }]);
    const result = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: '',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => true,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: [],
    });
    expect(result.initContainers).toEqual([]);
    expect(result.volumes).toEqual([]);
    expect(result.perSlot).toEqual([]);
  });

  it('produces per-slot emptyDir mounts even on cache miss', () => {
    const agent = agentWithCaches([{ name: 'npm', key: 'default', mountPath: '/c/npm' }]);
    const result = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: [],
    });
    expect(result.initContainers).toEqual([]);
    // Per-slot emptyDir IS emitted so the agent's mountPath is writable.
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]?.emptyDir).toBeDefined();
    expect(result.volumeMounts[0]?.mountPath).toBe('/c/npm');
    expect(result.perSlot[0]?.outcome).toBe('miss');
    expect(result.hitCount).toBe(0);
    expect(result.missCount).toBe(1);
  });

  it('emits init-container + cache PVC mount when at least one slot hits', () => {
    const agent = agentWithCaches([
      { name: 'npm', key: 'default', mountPath: '/c/npm' },
      { name: 'pip', key: 'default', mountPath: '/c/pip' },
    ]);
    let probeCount = 0;
    const result = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      // Hit only the first probe.
      existsOnDisk: () => probeCount++ === 0,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: [],
    });
    expect(result.initContainers).toHaveLength(1);
    expect(result.initContainers[0]?.name).toBe('kagent-cache-restore');
    expect(result.hitCount).toBe(1);
    expect(result.missCount).toBe(1);
    // Volume layout: 1 read-only PVC + 2 per-slot emptyDirs.
    expect(result.volumes).toHaveLength(3);
    const pvcVolume = result.volumes.find((v) => v.name === 'kagent-cache');
    expect(pvcVolume?.persistentVolumeClaim?.readOnly).toBe(true);
    expect(result.perSlot.map((s) => s.outcome)).toEqual(['hit', 'miss']);
  });

  it('every perSlot entry has a 64-char sha256 hex key', () => {
    const agent = agentWithCaches([{ name: 'a', key: 'default', mountPath: '/c/a' }]);
    const result = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: ['hashA'],
    });
    expect(result.perSlot[0]?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('input-artifact-hash order does NOT change the derived keys', () => {
    const agent = agentWithCaches([{ name: 'npm', key: 'default', mountPath: '/c/npm' }]);
    const a = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: ['x', 'y'],
    });
    const b = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:abc',
      inputArtifactHashes: ['y', 'x'],
    });
    expect(a.perSlot[0]?.key).toBe(b.perSlot[0]?.key);
  });

  it('changing image digest changes the derived key', () => {
    const agent = agentWithCaches([{ name: 'npm', key: 'default', mountPath: '/c/npm' }]);
    const a = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:v1',
      inputArtifactHashes: [],
    });
    const b = buildCacheMounts({
      agent,
      task: sampleTask,
      pvcName: 'kagent-cache',
      cachePvcMountOnOperator: '/mnt/cache',
      existsOnDisk: () => false,
      imageDigest: 'sha256:v2',
      inputArtifactHashes: [],
    });
    expect(a.perSlot[0]?.key).not.toBe(b.perSlot[0]?.key);
  });
});
