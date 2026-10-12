# Sandbox Reattachment Implementation Plan

> Execute directly with the executing-plans workflow; root approved the bounded design.

**Goal:** Preserve live same-task workspace files across gateway restart.

**Architecture:** Discover and authenticate the existing owned worker through
namespace-scoped Kubernetes APIs. Retain active Jobs; target only terminal Jobs
for replacement. Use stable creation identity for rolling-instance races.

**Tech Stack:** TypeScript, Kubernetes client, Vitest, actual sandbox worker/file I/O.

- [x] Reproduce two-factory file loss before implementation.
- [x] Implement owned Job discovery, authenticated reattach and exact pod/delete UID scoping.
- [x] Cover active unavailability, terminal/known-missing notices, identity boundaries and concurrent factories.
- [ ] Run affected tests/lint/typecheck/build and full workspace typecheck.
- [ ] Obtain pinned independent review, push PR, and hand CI/release/real restart acceptance to root.
