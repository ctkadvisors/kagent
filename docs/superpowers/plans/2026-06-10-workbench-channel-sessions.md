# Workbench Channel Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Workbench channel where the operator can talk to the controller and see all sessions.

**Architecture:** Implement a thin `/api/sessions` projection over channel-labelled AgentTasks, then add a `#/sessions` Workbench route with a WhatsApp-style operational timeline. User turns still create AgentTask CRs; assistant turns derive from task status/result.

**Tech Stack:** TypeScript, Hono, Kubernetes CustomObjects API, React, Vite, Vitest.

---

### Task 1: API Types And Projection

**Files:**
- Create: `packages/workbench-api/src/routes/sessions.ts`
- Test: `packages/workbench-api/src/routes/sessions.test.ts`
- Modify: `packages/workbench-api/src/router.ts`

- [ ] Write failing tests for `GET /api/sessions`, `GET /api/sessions/:sessionId`, and `POST /api/sessions/:sessionId/messages`.
- [ ] Implement session id validation, task grouping, message projection, and task creation through the Kubernetes custom object client.
- [ ] Register the route in the Workbench API router.
- [ ] Run `pnpm -F @kagent/workbench-api test -- src/routes/sessions.test.ts`.

### Task 2: UI Route And API Client

**Files:**
- Create: `packages/workbench-ui/src/SessionsPage.tsx`
- Create: `packages/workbench-ui/src/SessionsPage.module.css`
- Test: `packages/workbench-ui/src/SessionsPage.test.tsx`
- Modify: `packages/workbench-ui/src/api.ts`
- Modify: `packages/workbench-ui/src/types.ts`
- Modify: `packages/workbench-ui/src/App.tsx`
- Modify: `packages/workbench-ui/src/AppShell.tsx`

- [ ] Write failing UI tests for list/detail rendering and composer submission.
- [ ] Add `fetchSessions`, `fetchSessionDetail`, and `sendSessionMessage` client helpers.
- [ ] Add route parsing for `#/sessions` and `#/sessions/:sessionId`.
- [ ] Add a nav item under Operate.
- [ ] Implement the split-pane session UI with target selector and task links.
- [ ] Run `pnpm -F @kagent/workbench-ui test -- src/SessionsPage.test.tsx`.

### Task 3: Verification

**Files:**
- No new production files.

- [ ] Run `pnpm -F @kagent/workbench-api test`.
- [ ] Run `pnpm -F @kagent/workbench-ui test`.
- [ ] Run `pnpm -F @kagent/workbench-api typecheck`.
- [ ] Run `pnpm -F @kagent/workbench-ui typecheck`.
- [ ] Run `pnpm -F @kagent/workbench-api lint`.
- [ ] Run `pnpm -F @kagent/workbench-ui lint`.
- [ ] Start the local Workbench if needed and verify `#/sessions` with Chrome/Playwright.
- [ ] Commit the implementation.
