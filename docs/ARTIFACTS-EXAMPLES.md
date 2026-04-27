# Artifact Examples — concrete `status.artifacts` payloads

**Date:** 2026-04-27
**Status:** Companion to [`ARTIFACTS.md`](./ARTIFACTS.md) (the design)
and the v0.1 status-reference-only slice in
[`PLATFORM-PRIORITIES.md`](./PLATFORM-PRIORITIES.md) §P3.

These three examples show real-world `AgentTask.status` payloads as they
will appear once the writer slice lands. Today the substrate carries the
`ArtifactRef` shape end-to-end (CRD schema + TypeScript types + agent-pod
status patcher), but no agent loop populates `artifacts` yet — these
payloads are the contract the next slice (artifact writer + GC sweeper)
will conform to.

URI scheme reminder (from `parseArtifactUri`):

| Scheme    | v0.x | Shape                                    | Meaning                                           |
| --------- | ---- | ---------------------------------------- | ------------------------------------------------- |
| `pvc://`  | v0.1 | `pvc://<pvc-name>/<task-uid>/<name>`     | Shared RWX PVC mounted into every agent-pod      |
| `s3://`   | v0.2 | `s3://<bucket>/<task-uid>/<name>`        | S3-compatible object store (MinIO planned)       |
| `minio://`| v0.2 | `minio://<bucket>/<task-uid>/<name>`     | Alias for MinIO when host distinction matters    |
| `https://`| v0.2 | `https://<host>/<path>`                  | Presigned URL (post-MinIO; consumed as opaque)   |

Inline-vs-reference rule (`inlineSafe`): textual / JSON payloads under
8 KiB inline into `status.result.content`; everything else gets an
`ArtifactRef`. The cap is tunable per-call.

---

## 1. Research report — 50 KB markdown only

The researcher agent produces a digest larger than the inline cap; it
goes to a PVC ref. `status.result.content` is omitted because the
markdown is the artifact, not a chat-style response.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: AgentTask
metadata:
  name: research-kata-containers
  namespace: kagent-workloads
  uid: 9b1a8c4e-1f3a-4d2e-bc73-f0a812340001
status:
  phase: Completed
  startedAt: 2026-04-28T14:21:00Z
  completedAt: 2026-04-28T14:23:11Z
  podName: research-kata-containers-job-abc12
  structuralVerdict:
    suspicious: []
  artifacts:
    - uri: pvc://kagent-artifacts/9b1a8c4e-1f3a-4d2e-bc73-f0a812340001/digest.md
      mediaType: text/markdown
      sizeBytes: 51284
      checksum: sha256:7c4f1aab2c9e5a6d8b031d9e7a64bf02c0f5e91a7db4d2e1f8c3a90bbcde91a4
      name: digest.md
      producedAt: 2026-04-28T14:23:10Z
```

---

## 2. Summary with screenshot — inline text + PVC PNG ref

A 2 KB summary stays inline (under the 8 KiB cap, `text/markdown` is
inline-safe). The PNG is binary — never inlined regardless of size — so
it lands in the PVC.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: AgentTask
metadata:
  name: ui-smoke-summary
  namespace: kagent-workloads
  uid: 7a44e1c0-2c11-4b80-9e44-001122334455
status:
  phase: Completed
  startedAt: 2026-04-28T15:30:00Z
  completedAt: 2026-04-28T15:30:42Z
  podName: ui-smoke-summary-job-de9b1
  structuralVerdict:
    suspicious: []
  result:
    content: |
      # Login flow smoke — PASS

      - `/login` rendered in 412 ms (Lighthouse FCP).
      - Submitted credentials: redirected to `/dashboard`.
      - Dashboard greeted user by name; no console errors.
      - Screenshot attached for visual diff baseline.
  artifacts:
    - uri: pvc://kagent-artifacts/7a44e1c0-2c11-4b80-9e44-001122334455/dashboard.png
      mediaType: image/png
      sizeBytes: 412903
      checksum: sha256:1d2e8f0aab3399c52e6f47a08e1cf73a2b4d15ce0fb71c8d4e9a3b56789fe88a
      name: dashboard.png
      producedAt: 2026-04-28T15:30:41Z
```

---

## 3. Code patch — inline diff + repo-state tarball ref

A 6 KB unified diff is inline-safe (`text/x-diff`, under the cap), so it
travels in `status.result.content` for fast `kubectl get` inspection. A
companion tarball captures the repo state the diff was generated against
— too large for etcd, parked behind a PVC ref.

```yaml
apiVersion: kagent.knuteson.io/v1alpha1
kind: AgentTask
metadata:
  name: codefix-typo-readme
  namespace: kagent-workloads
  uid: 2f8b40c1-7e90-4d3a-87ab-aabbccddeeff
status:
  phase: Completed
  startedAt: 2026-04-28T16:01:00Z
  completedAt: 2026-04-28T16:02:18Z
  podName: codefix-typo-readme-job-f42a8
  structuralVerdict:
    suspicious: []
  result:
    content: |
      diff --git a/README.md b/README.md
      index 8ec15b0..cd1a932 100644
      --- a/README.md
      +++ b/README.md
      @@ -3,7 +3,7 @@
       `kagent` is a K3s-native, OSS, MIT-licensed agent farm operator.

      -Composes Katar Containers + NATS JetStream + Bun + LiteLLM + Langfuse...
      +Composes Kata Containers + NATS JetStream + Bun + LiteLLM + Langfuse...
  artifacts:
    - uri: pvc://kagent-artifacts/2f8b40c1-7e90-4d3a-87ab-aabbccddeeff/repo-state.tar.gz
      mediaType: application/gzip
      sizeBytes: 4823104
      checksum: sha256:af33aa1f0b12bc73d2e4f5601a8c9e0b73a4d2150b6c8d319aef73a210b91234
      name: repo-state.tar.gz
      producedAt: 2026-04-28T16:02:17Z
```

---

## Cross-cutting notes

- **Always present when set:** `uri`. Everything else is optional in the
  CRD schema and the TypeScript type — writers should populate them when
  they can (cheap and high-value for downstream consumers), but the
  substrate doesn't reject sparse refs. This forward-compat lets v0.2
  backends that don't compute checksum server-side still produce valid
  refs.
- **`x-kubernetes-preserve-unknown-fields` per item** lets v0.2 backends
  attach extra metadata (e.g. `etag`, `generation`, `bucket`) without a
  CRD bump.
- **Empty arrays are omitted from the patch** by `buildStatusPatch` —
  consumers should treat `status.artifacts === undefined` and
  `status.artifacts === []` as identical (no artifacts produced).
- **Retention is task-owned** (see `ARTIFACTS.md` §6): when the parent
  `AgentTask` is GC'd, its blobs go with it. Per-artifact TTL is YAGNI
  in v0.1.
