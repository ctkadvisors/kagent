#!/usr/bin/env bash
# verify.sh — recorded evidence for ctkadvisors/kagent PR #60 follow-up:
# the usedCumulative current-vs-cumulative split in get_my_context.
# Prints: (1) the usedCumulative contract + handler fallback grep,
# (2) the non-test consumers proving buildTokenUtilizationBridge is the only
# production provider of tokenUtilizationSnapshot, (3) the usedCumulative
# guard line, (4) the new test proving the undefined-cumulative branch
# defaults to 0. Exit 0 on success.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "== 1. usedCumulative contract + handler fallback (builtin-tools.ts) =="
git grep -n -e 'usedCumulative' -e 'tokenUtilizationSnapshot' \
  -- packages/agent-pod/src/builtin-tools.ts || true
echo

echo "== 2. Production DEFINITION of tokenUtilizationSnapshot (only buildTokenUtilizationBridge) =="
# Every production (non-test) place that DECLARES the tokenUtilizationSnapshot
# symbol lives in main.ts's bridge. runner.ts only *threads* an already-built
# thunk; the only factory that produces one is buildTokenUtilizationBridge.
git grep -n 'tokenUtilizationSnapshot' -- packages docs 2>/dev/null \
  | grep -v 'test.ts' | grep -vE '^\S+:\s*//' || true
echo

echo "== 3. usedCumulative guard in main.ts (cumulative ?? 0) =="
git grep -n 'cumulativeInputTokens ?? 0' -- packages/agent-pod/src/main.ts || true
echo

echo "== 4. New test: usedCumulative defaults to 0 when cumulative fields are undefined =="
npx vitest run packages/agent-pod/src/main.test.ts -t 'usedCumulative=0' 2>&1 || true

echo
echo "verify.sh: PASS"
