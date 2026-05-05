# Artifact Store — Phase 5 Design

**Date:** 2026-04-26
**Status:** Draft, pre-implementation
**Phase:** 5 (substrate primitive — proposed)

> Read [`DESIGN-V0.1.md`](./DESIGN-V0.1.md) and [`ROADMAP.md`](./ROADMAP.md) first. This doc proposes the artifact-handling primitive that lets agent pods produce/consume payloads larger than fits in `AgentTask.status` without expanding the substrate's surface area.

---

## 1. Motivation

`AgentTask.status` lives in etcd. The K3s default object size cap is ~1.5 MB and Kubernetes etcd best-practice is sub-256 KB per object. Real agent workloads already exceed that:

- The `homelab-orchestrator` researcher writes `digests/<slug>.md` (~30–80 KB) plus a JSONL trace per run.
- Future browser tools (Playwright in agent-pod) will produce screenshots (PNGs, hundreds of KB each), HAR files (single-digit MB), and DOM snapshots.
- Code-acting agents will produce diffs and small datasets.

Stuffing any of that into `status.result` is wrong: it bloats etcd, breaks `kubectl` paging, and leaks bytes through every operator watch event. The substrate needs an **artifact** primitive: opaque bytes live elsewhere, etcd holds only addressable references.

This is a substrate primitive, not an application feature — the substrate provides the storage backend, the addressing convention, the `ArtifactRef` type, the GC policy. *What* an agent puts in an artifact is application-layer (per CLAUDE.md §"What this repo does NOT do").

---

## 2. CRD vs object-store-only metadata — the comparison

| Dimension | Full `Artifact` CRD | Object-store URL in `status` |
|---|---|---|
| etcd cost | metadata-only entry per artifact (~1 KB) | zero (refs are inline strings) |
| Listability | `kubectl get artifacts -A` works | requires backend tool (`mc ls`, `kubectl exec` into PVC) |
| Watch/event semantics | Artifact creation is a watchable event; controllers can react | none — artifacts are mute |
| GC | needs its own controller / finalizer | parent `AgentTask` finalizer can sweep blobs |
| Schema enforcement | OpenAPI validation at apply-time | convention-only; agents can write malformed refs |
| Operator surface | +1 CRD, +1 reconciler, +RBAC | zero new K8s objects |
| Cross-task addressing | first-class (`Artifact` is a named resource) | requires opaque URI literacy |
| Failure mode | etcd entry without backend blob = orphan | backend blob without ref = orphan |

**Decision: object-store-URL refs in `AgentTask.status.artifacts`, no `Artifact` CRD in v0.1.**

Justification rooted in homelab K3s reality:

1. **The v0.1 thesis is "shortest path to a deployed substrate" (per Phase 4 retro).** A new CRD + reconciler is a multi-day commitment and a +1 to the operator surface that v0.1 has not yet earned. Refs as fields stay in the AgentTask blast radius.
2. **`AgentTask` is already the lifecycle owner.** Artifacts are produced *during* a task and meaningful *because of* a task; making them a child resource of AgentTask via owner references and finalizer-driven cleanup is structurally simpler than a parallel CRD.
3. **Cross-task addressing is YAGNI.** The first cross-task use case (researcher → summarizer delegation chain) passes the artifact reference inline through the A2A envelope's `payload` — no resource lookup needed. When a workload demands artifact-as-first-class-resource semantics (provenance graph, audit catalog), that is a Phase 8+ revisit.
4. **Listability is not load-bearing yet.** The smoke-test loop reads `AgentTask.status` directly; the Langfuse trace will carry the same refs as event attributes.

The CRD path remains open as a v0.2/v0.3 addition if cross-task discovery becomes a real need. Refs-in-status is forward-compatible: the same `ArtifactRef` shape becomes a CRD `spec` later.

---

## 3. Backend: which storage, given what's running

What's already in the homelab cluster (`new_localai/k8s-kustomized/base/storage/`):

- **SMB-backed `ai-models-storage` StorageClass** (RWX, Retain, hostPath fronted by an SMB DaemonSet mounting `valhalla.local/ai_models` on every node). PVC `ai-models-pvc` already in `ai-services` namespace, 100 Gi / 500 Gi PV.
- **No MinIO, no Ceph, no S3-compatible object store deployed.**
- Postgres is up (`base/database/postgresql.yaml`) — usable for metadata only, not bytes.

**Decision: PVC-backed shared filesystem for v0.1 (Phase 5). Plan to add a MinIO option in v0.2.**

The smallest delta from today is to provision a dedicated PVC (`kagent-artifacts`, RWX, e.g. 50 Gi from the SMB class) and mount it at `/var/kagent/artifacts/` in every agent-pod. Agents write under `/<task-uid>/<artifact-name>`; the URI becomes `pvc://kagent-artifacts/<task-uid>/<artifact-name>`. A small library inside `@kagent/agent-loop` (`writeArtifact`, `readArtifact`) hides the filesystem path.

Why not MinIO in v0.1:
- Adds a Helm install + Postgres dep + bucket bootstrap + secret distribution. Same deferral logic that pushed LiteLLM and Langfuse to v0.2 applies.
- The `pvc://` scheme is a substrate detail; agent code calls `artifacts.write(name, bytes, mediaType)` and gets back an `ArtifactRef` regardless of backend. Swapping the implementation to `s3://` in v0.2 changes the writer, not consumer code.

**v0.2 path:** add a `kagent-artifacts` MinIO Helm deploy when (a) RWX PVC contention shows up under load, (b) a non-K8s consumer needs HTTP-presigned access, or (c) cross-cluster artifact sharing becomes real. The `ArtifactRef.uri` scheme is the swap point.

---

## 4. `ArtifactRef` — TypeScript shape

Proposed addition to `packages/operator/src/crds/types.ts` (do **not** edit yet — design only):

```ts
export interface ArtifactRef {
  /**
   * Backend-addressable URI. Substrate-defined schemes:
   *   pvc://<pvc-name>/<task-uid>/<artifact-name>     (v0.1 — shared PVC, persisted)
   *   inline://sha256:<hex>                           (v0.1 — content-addressed,
   *                                                   NOT persisted; bytes live in
   *                                                   status.result.content)
   *   s3://<bucket>/<task-uid>/<artifact-name>        (v0.2 — MinIO/S3)
   * Persistence contract: any scheme EXCEPT `inline://` is followable to
   * durable bytes; `inline://` refs are dropped from
   * `RunResult.artifacts` so durable consumers never see a URI they
   * can't follow. Agents MUST treat the URI as opaque and round-trip
   * via the @kagent/agent-loop artifact helpers; never parse the path.
   */
  readonly uri: string;

  /** Human/agent-friendly stable name unique within the task. */
  readonly name: string;

  /** RFC 6838 media type, e.g. 'text/markdown', 'image/png', 'application/json'. */
  readonly mediaType: string;

  /** Byte count at write time. Sanity check; re-read may differ if backend mutated. */
  readonly sizeBytes: number;

  /** 'sha256:' + lowercase hex. Set by the writer; read path verifies. */
  readonly checksum: string;

  /** RFC 3339 timestamp set by the writer. */
  readonly producedAt: string;

  /**
   * UID of the AgentTask that produced this artifact. Lets a consumer
   * confirm provenance without an extra status lookup.
   */
  readonly producedBy: string;

  /**
   * Optional free-form tags the agent attaches at write time (e.g.
   * { kind: 'screenshot', step: '3' }). Substrate ignores these.
   */
  readonly labels?: Readonly<Record<string, string>>;
}
```

Design notes:
- **No URL** beyond the substrate-defined scheme. Presigned HTTP URLs are a v0.2 affordance once MinIO lands; until then, all consumers run inside K8s and mount the PVC.
- **Checksum is mandatory** so a re-read can detect storage corruption or a partial write. SHA-256 — matches existing OCI/registry conventions.
- **No retention field per artifact** in v0.1 — retention is owned at the `AgentTask` level (see §6).

---

## 5. AgentTask.status integration

Add `artifacts?: readonly ArtifactRef[]` to `AgentTaskStatus`:

```ts
export interface AgentTaskStatus {
  readonly phase?: AgentTaskPhase;
  readonly result?: unknown;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly podName?: string;
  readonly structuralVerdict?: { readonly suspicious: readonly string[] };

  /** Artifacts produced by this task. Empty/undefined = none. */
  readonly artifacts?: readonly ArtifactRef[];
}
```

Flat array, no nesting. Reasoning:
- The agent-pod patches status once at end-of-run today (Phase 4 model). A flat array is the smallest payload that carries everything a downstream consumer needs.
- Per-artifact status (in-progress, failed-write) is **out of scope for v0.1.** Artifacts are write-once, end-of-run; partial failures fail the whole task.
- Refs are the only thing in etcd; bytes live in the PVC. A typical research run with 4 artifacts adds ~1.6 KB to the status object — well inside etcd budgets.

The CRD YAML schema (`agenttask.yaml`) gains an `artifacts` array under `status` with the same field set. The OpenAPI v3 schema enforces required fields (`uri`, `name`, `mediaType`, `sizeBytes`, `checksum`, `producedAt`, `producedBy`).

---

## 6. Retention / GC

**Owned-by-AgentTask via finalizer + TTL on the parent.** Two layers:

1. **Finalizer-driven cleanup on delete.** The operator adds finalizer `kagent.knuteson.io/artifacts` to every AgentTask that successfully writes at least one artifact. On AgentTask deletion the operator reads `status.artifacts`, deletes blobs at `pvc://.../<uid>/`, removes the finalizer. Strict ownership: deleting the AgentTask deletes its artifacts. Mirrors how K8s already handles owned Pods/Jobs.

2. **TTL via existing AgentTask TTL.** AgentTasks already need a TTL (otherwise terminal tasks pile up forever). v0.1 piggy-backs on `Job.spec.ttlSecondsAfterFinished` (set by the operator at job-spawn time); when the Job is GC'd, its owner-ref deletion cascades to the AgentTask, which fires the finalizer above. Default TTL = 7 days; overridable per-Agent via `Agent.spec.artifactRetentionSeconds`.

Explicitly **not** doing in v0.1:
- Argo-style sweeper Job that scans the PVC for orphans. Adds operational surface; revisit if leak rate is non-zero in practice.
- Per-artifact TTL. Retention is a task-level concern; an artifact outlives or dies with its task.
- Cross-task artifact reuse with refcount. YAGNI; if it appears, that is the trigger to promote to a real CRD.

The operator gains a small artifact-cleanup module under `packages/operator/src/artifacts/cleanup.ts`. The agent-pod side gains `packages/agent-loop/src/artifacts/` with `write`/`read`/`list` against an injectable backend (filesystem v0.1, S3 v0.2).

---

## 7. Example payloads

### 7a. Research report (~50 KB markdown + 3 PNG screenshots)

```yaml
status:
  phase: Completed
  artifacts:
    - uri: pvc://kagent-artifacts/9b1a8c4e-research/digest.md
      name: digest.md
      mediaType: text/markdown
      sizeBytes: 51284
      checksum: sha256:7c4f...e91a
      producedAt: 2026-04-28T14:23:11Z
      producedBy: 9b1a8c4e-research
      labels: { kind: report, topic: kata-containers }
    - uri: pvc://kagent-artifacts/9b1a8c4e-research/screenshot-01.png
      name: screenshot-01.png
      mediaType: image/png
      sizeBytes: 412903
      checksum: sha256:1d2e...88af
      producedAt: 2026-04-28T14:21:02Z
      producedBy: 9b1a8c4e-research
      labels: { kind: screenshot, source: github.com/kata-containers }
    # ...screenshot-02.png, screenshot-03.png
```

### 7b. Code patch (~20 KB diff)

```yaml
status:
  phase: Completed
  artifacts:
    - uri: pvc://kagent-artifacts/2f8b40c1-codefix/fix.patch
      name: fix.patch
      mediaType: text/x-diff
      sizeBytes: 19842
      checksum: sha256:af33...0b12
      producedAt: 2026-04-28T15:10:44Z
      producedBy: 2f8b40c1-codefix
      labels: { kind: patch, repo: homelab-orchestrator, base: main@866b277 }
```

### 7c. Browser session trace (~5 MB HAR)

```yaml
status:
  phase: Completed
  artifacts:
    - uri: pvc://kagent-artifacts/5dc91200-browse/session.har
      name: session.har
      mediaType: application/json
      sizeBytes: 5238721
      checksum: sha256:0cf4...91be
      producedAt: 2026-04-28T16:02:55Z
      producedBy: 5dc91200-browse
      labels: { kind: har, browser: chromium-128 }
```

5 MB HAR is exactly the case the substrate exists to serve — etcd-hostile, but trivial on a PVC.

---

## 8. Open questions

1. **PVC contention under parallel writes.** SMB-backed RWX PVCs handle concurrent writers but throughput is the bottleneck. If Phase 5's 5-topic comparison rig produces visible artifact-write contention, the answer is to fast-track MinIO (Phase 6 sub-task) rather than tune SMB.
2. **Should `JsonlSink` traces become first-class artifacts?** Today the JSONL trace is a debug-only sink. Promoting it to an artifact would unify "things this run produced" and let Langfuse + the artifact list be the only two surfaces a developer reads. Decide after Phase 5 dogfooding.
3. **Compression at write time?** PNG/HAR compress poorly; markdown gzips ~4x. Tradeoff is CPU on the agent-pod vs. PVC bytes. Defer until storage pressure is real.
4. **Read-side ergonomics for downstream consumers.** A second AgentTask that wants to consume an upstream artifact gets the URI in its `payload`; v0.1 mounts the same PVC and reads through the helper. Cross-cluster or non-K8s consumers (a chat UI fetching a digest) need HTTP. That is the first concrete trigger for MinIO + presigned URLs.
5. **Quota.** Without per-Agent or per-namespace quota, a runaway agent could fill the PVC. Watch via existing K8s PVC monitoring; revisit a hard quota when the first incident happens.

---

## 9. v0.1 PVC writer (Phase 5 P3 wire-up)

**Status:** shipped. Implementation lives in `packages/agent-pod/src/artifacts.ts` (writer + registry) and `packages/agent-pod/src/builtin-tools.ts` (`write_artifact` tool). Operator-side mount + env wiring lives in `packages/operator/src/job-spec.ts` and `packages/operator/src/main.ts`.

### 9.1 Helm values (operator chart)

```yaml
agentPod:
  artifactStorage:
    enabled: true                     # default-OFF when unset; tool returns `disabled` error
    pvcName: kagent-artifacts         # PVC claim name in the AgentTask namespace
    mountPath: /var/kagent/artifacts  # container path; forwarded as KAGENT_ARTIFACTS_DIR
    maxBytes: 26214400                # per-write byte cap (25 MiB default); 0/-1/unset → use agent-pod compiled-in default
    size: 10Gi
    storageClassName: ai-models-storage
    accessMode: ReadWriteMany
```

When `enabled: false` (or the keys are absent because an operator runs without the chart), the operator does NOT stamp the env vars onto spawned Jobs. The agent-pod's `write_artifact` tool then refuses every call with `tool_error: write_artifact: artifact storage is disabled (...)` — the LLM sees a clean failure rather than writes silently landing on an unmounted FS.

### 9.2 Agent-pod env contract

| Env var | Source | Default | Semantics |
|---|---|---|---|
| `KAGENT_ARTIFACTS_DIR` | operator → Helm `agentPod.artifactStorage.mountPath` | unset → tool disabled | Container path the PVC mounts at. |
| `KAGENT_ARTIFACT_PVC_NAME` | operator → Helm `agentPod.artifactStorage.pvcName` | unset → tool disabled | PVC claim name; embedded in the returned `pvc://<pvcName>/...` URI. |
| `KAGENT_ARTIFACT_MAX_BYTES` | operator → Helm `agentPod.artifactStorage.maxBytes` | 25 MiB (`26214400`) | Per-write byte cap on the decoded payload (UTF-8 length for string content, raw byte length for base64). |
| `KAGENT_TASK_ID` | operator (always set) | required | Per-task UID; the writer uses it as the per-pod isolation prefix (`<KAGENT_ARTIFACTS_DIR>/<KAGENT_TASK_ID>/<name>`). |

### 9.3 `write_artifact` built-in tool — input contract

```ts
{
  name: string,                                    // relative path; no `..`, leading `/`, or control chars
  content: string | { base64: string },            // UTF-8 string OR strict-base64 binary
  mediaType?: string,                              // optional; default 'application/octet-stream'
  inline?: boolean                                 // when true + content fits inline-safe rules, returns inline:// ref
}
```

Returns:

```ts
{
  uri: 'pvc://kagent-artifacts/<task-uid>/<name>', // or 'inline://sha256:<hex>' on the inline path
  name: string,
  mediaType: string,
  sizeBytes: number,
  checksum: 'sha256:<hex>',
  contentHash: '<hex>',                            // bare sha256 hex; v0.2.2-cas forward-compat
  producedAt: '<RFC 3339 timestamp>'
}
```

### 9.4 Error taxonomy

The tool maps every refusal into `tool_error: write_artifact: <reason>` so a single grep over Langfuse traces surfaces them:

| Error message fragment | Cause |
|---|---|
| `artifact storage is disabled (...)` | One of the operator-injected env vars is missing — Helm chart not enabled. |
| `"name" must not begin with "/"` | Name is an absolute path. |
| `"name" must not contain ".." segments` | Path-traversal attempt. |
| `"name" must not contain non-printable characters` | Control character (NUL, newline, etc.) in the name. |
| `artifact too large (<actual> > <cap> bytes)` | Decoded content exceeded `KAGENT_ARTIFACT_MAX_BYTES`. |
| `"content.base64" is not valid base64` | Strict base64 decode failed. |
| `"content.base64" decode round-trip mismatch` | Truncated / corrupted base64 input. |

### 9.5 In-pod ArtifactRegistry → status flush

The `write_artifact` handler pushes every successful ref into a per-run in-pod `ArtifactRegistry` (`createArtifactRegistry()` in `artifacts.ts`). The runner reads `registry.snapshot()` AND merges with `collectArtifactsFromTraces()` to build `RunResult.artifacts`.

`buildStatusPatch` flushes the resulting refs into `AgentTask.status.artifacts` on EVERY status patch — Completed AND Failed (cancelled / timeout / budget_exceeded). A partial run that landed two artifacts before timing out surfaces both refs in etcd.

### 9.6 Forward-compat with v0.2.2-cas

The URI shape is identical: `pvc://<pvc>/<task-uid>/<name>` parses cleanly through both `parseArtifactUri` (legacy) and `parseUri` (CAS-aware) in `packages/operator/src/crds/artifact-ref.ts`. The `contentHash` field on every emitted ref carries the bare sha256 hex of the bytes, so an in-flight migration to `cas://sha256:<hex>/<name>` URIs is metadata-only — no agent-pod code changes, no consumer schema updates.

CAS-backed dedupe (v0.2.2) reads the same field. The PVC writer is the substrate's first source of `contentHash` values; the CAS sub-team's hashed-shard layout (`cas/sha256/<first-2-hex>/<remaining-62-hex>`) reuses the same hash space so a v0.1 artifact promoted into CAS keeps its identity.

### 9.7 Design choices resolved by judgment call (no spec ambiguity)

- **`mediaType` is optional in the tool args** even though the original `ArtifactRef` design proposed it as required. Falling back to `application/octet-stream` is RFC 6838-correct and keeps the LLM-facing surface minimal — most binary payloads (screenshots via `{base64:...}`) don't need an explicit type.
- **The legacy `resolveWriterEnv` (back-compat) keeps falling back to defaults**; the new `resolveWriterEnvOrDisabled` is the strict gate the tool consults. The legacy entry point is kept callable so existing direct-disk-writer tests stay green during the v0.1 → v0.1.x transition.
- **Inline path is admissible even when storage is disabled** for text-only payloads. The substrate contract for `inline://sha256:<hex>` is "bytes live in `status.result.content`, not on disk", so the inline shortcut doesn't need PVC plumbing. This lets an Agent fall back to inlining small text outputs even on a cluster where the artifact PVC isn't enabled.
- **Registry de-dupes on `uri` (last-write-wins)** so an Agent that overwrites a file in place during the run produces ONE entry in `status.artifacts` with the most recent metadata rather than a confusing per-write log.
