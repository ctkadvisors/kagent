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
    async deleteTaskJobs(namespace, taskUid) {
      await batch.deleteCollectionNamespacedJob({
        namespace,
        labelSelector: `${SANDBOX_TASK_LABEL}=${taskUid}`,
        propagationPolicy: 'Background',
      });
    },
    async runningPodIp(namespace, jobName) {
      const pods = await core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      const pod = pods.items.find((p) => p.status?.phase === 'Running' && p.status.podIP);
      return pod?.status?.podIP;
    },
  };
}
