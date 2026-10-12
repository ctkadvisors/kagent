# Browser Capture Page Implementation Plan

**Goal:** Save primary browser evidence directly in the calling task workspace.

**Architecture:** Extend the existing driver, adapter and runtime dispatch;
consumer profile grants stay in GitOps.

**Tech stack:** TypeScript, Playwright CDP, existing code runner, Vitest.

- [x] Add failing driver tests in packages/tool-gateway/src/playwright-driver.test.ts
  evaluating the capture expression against relative and unsafe anchors.
- [x] Add failing HTTP tests in packages/tool-gateway/src/http-server.test.ts for
  exact UTF-8, provenance/hash, unique paths, task isolation, caller path refusal
  and failed writes; add explicit agent-pod descriptor coverage.
- [x] Run vitest on those files and observe missing capture behavior.
- [x] Add types, adapter method, DOM snapshot, automatic UUID directory writes,
  concise receipt, DTO registration and gateway/pod descriptors. Preserve extract.
- [x] Run focused tests, affected-package lint/typecheck/build, workspace
  typecheck, format, and real Chromium capture smoke.
- [x] Add explicit workspace-to-playground commit with strict complete reads,
  existing size bounds and exact signed body; RED then GREEN tests.
- [x] Add actual HTTP navigation status and 404/503 error handling; observe RED
  failures then GREEN, retaining nullable response compatibility.
- [x] Exercise real Chromium → saved UTF-8 → existing signed playground HTTP
  service → Git commit; text and provenance bytes match exactly.
- [ ] Obtain independent security/code review, push PR, merge green homelab CI,
  coordinate normal release/GitOps with its current owner, observe live capture
  and byte/hash verification.
