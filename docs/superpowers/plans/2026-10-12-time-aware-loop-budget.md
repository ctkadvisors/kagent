# Time-aware loop budget implementation plan

> Execute inline with test-driven development; root owns merge and rollout.

**Goal:** Give the model accurate guidance before the tighter of its existing time and turn budgets expires.

**Architecture:** Runner passes the timeout origin and duration at the existing AbortSignal.timeout call. A pure loopTurnNote helper accepts elapsed time; the executor samples time on each appended tool response. No enforcement changes.

**Tech Stack:** TypeScript, Vitest, Node 22, pnpm.

1. Add failing helper and executor integration tests in packages/agent-loop/src/executor-guards.test.ts for time-first save/finish, turn-first finish, no-timeout compatibility, and delayed tool results. Run pnpm --filter @kagent/agent-loop test -- src/executor-guards.test.ts and confirm missing time guidance.
2. Extend RunInput with advisory timeBudget {startedAtMs, timeoutMs}; validate finite origin and positive finite duration. Add optional elapsed-time input to loopTurnNote. Sample time at tool message append on success, catch, guard and missing provider paths.
3. Add failing runner wiring tests in packages/agent-pod/src/runner.test.ts. Pass the resolved timeout budget from its existing arming point; preserve declared/default precedence and hard timeout.
4. Run agent-loop and agent-pod tests, lint, build and workspace typecheck on Node22. Inspect diff for unchanged hard caps and task isolation.
5. Commit and push an isolated branch, request review of exact SHA from review_growth, create a PR with RED/GREEN evidence, and hand parent the green reviewed result for merge and release.
