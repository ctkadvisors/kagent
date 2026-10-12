/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/** The in-cluster SandboxKube: the gateway's service account creates and removes sandbox Jobs. */

import { BatchV1Api, CoreV1Api, KubeConfig } from '@kubernetes/client-node';

import { SANDBOX_TASK_LABEL, type SandboxKube } from './pod-code-runner.js';

export function inClusterSandboxKube(): SandboxKube {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batch = kc.makeApiClient(BatchV1Api);
  const core = kc.makeApiClient(CoreV1Api);
  return {
    async createJob(namespace, job) {
      await batch.createNamespacedJob({ namespace, body: job });
    },
    async listTaskJobs(namespace, taskUid) {
      const jobs = await batch.listNamespacedJob({
        namespace,
        labelSelector: `${SANDBOX_TASK_LABEL}=${taskUid},app.kubernetes.io/component=code-sandbox,app.kubernetes.io/managed-by=kagent-tool-gateway`,
      });
      return jobs.items;
    },
    async deleteJob(namespace, name, uid) {
      await batch.deleteNamespacedJob({
        namespace,
        name,
        body: {
          propagationPolicy: 'Background',
          preconditions: { uid },
        },
      });
    },
    async runningPodIp(namespace, jobName, jobUid) {
      const pods = await core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      const pod = pods.items.find(
        (p) =>
          p.metadata?.namespace === namespace &&
          !p.metadata.deletionTimestamp &&
          p.status?.phase === 'Running' &&
          p.status.podIP &&
          p.metadata.ownerReferences?.some(
            (owner) =>
              owner.kind === 'Job' &&
              owner.name === jobName &&
              owner.uid === jobUid &&
              owner.controller === true,
          ),
      );
      return pod?.status?.podIP;
    },
  };
}
