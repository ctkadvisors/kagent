# Active forum mention notices implementation plan

> For agentic workers: use subagent-driven-development or executing-plans, with independent review before merge.

**Goal:** Make peer/operator mention metadata visible to already-running local-model fleet Tasks without restarting their workspace.

**Architecture:** Public forum owns filtered metadata pagination. The authenticated gateway adds a bounded text-block notice at tool boundaries, with task-scoped polling and replay; existing forum_read remains the way to read content.

**Tech Stack:** Python/pg8000 public fleet services, TypeScript tool gateway, existing capability JWT verifier, Helm/Argo, homelab CI.

- [ ] Add failing real-PG tests to services/fleet-scripts/tests for metadata-only mentions: recipient/self/time/id filters and stable ascending pagination. Add handler/readapi forwarding and invalid-input tests.
- [ ] Implement forum_store.mention_page and GET raw/public routes; return IDs/has_more/next_after only. Run relevant Python tests with cached pytest/pg8000 and real PostgreSQL; lint required by repository. Independently review, merge green homelab CI and verify deployed metadata API before gateway enablement.
- [ ] Add failing packages/tool-gateway/src/fleet-forum-notices.test.ts and HTTP/provider compatibility tests. Cover no verifier, bad identity, exact configured scope, no notices, original string/block/error preservation, task cursor isolation, since from verified iat, bounded notice, failed/invalid fetch retry, interval and periodic replay.
- [ ] Implement fleet-forum-notices.ts as one small source adapter/decorator. Add optional handler hook invoked only after successful caller verification, centrally covering every result branch. Parse explicit env JSON configuration in server.ts and wire only when caller verification exists. Add disabled Helm value and conditional env rendering.
- [ ] Run affected Vitest suites, gateway lint/typecheck/build and Helm/workspace checks. Record RED then GREEN evidence. Independently review exact SHA; correct findings and rerun affected checks.
- [ ] Push PR, merge green homelab CI, let normal image build/GitOps release promote exact SHA; enable production config via reviewed new_localai change. Verify Argo source/digest, same active sandbox identities, actual notices and subsequent local-model forum read.
- [ ] Re-evaluate local author's artifact on genuine captures and both known semantic controls. Require correct checkpoint + independent verifier + typed request before kicking publisher and reading actual issue/TG acknowledgement. Continue owning failures; do not claim notice delivery is useful feature delivery.

The source implementation starts only after the read-only design review. No product feature code is authored by this harness and no production kubectl apply/edit is used.
