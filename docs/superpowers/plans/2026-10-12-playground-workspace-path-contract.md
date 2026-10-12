# Playground Workspace Path Contract Implementation Plan

> Execute directly with the executing-plans workflow; root approved this bounded design.

**Goal:** Make the existing destination/source path scopes unambiguous.

**Architecture:** Correct the tool descriptor and schema, with one advertised
request example. Preserve handler and Python service semantics.

**Tech Stack:** TypeScript, Vitest, Python playground service, local Git.

- [x] Add a RED executable example regression in `packages/tool-gateway/src/http-server.test.ts`.
- [x] Correct descriptions and add the complete schema example in `fleet-playground-commit-files.ts`; correct the inherited capture design terminology.
- [x] Run the example through the real Python service and inspect actual Git paths/bytes.
- [ ] Run affected tests, lint, build and typecheck, then request pinned independent review and open a PR for root-owned CI/merge/release.
