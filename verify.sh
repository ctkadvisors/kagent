#!/usr/bin/env sh
# Proves the scope of the project-stats banner removal on ctkadvisors/kagent#53.
#
# Two independent gates:
#   1) Static: CLAUDE.md no longer carries a stale "verified" stats banner or any
#      of the hard-coded claims it used to assert. Runs BEFORE any test so a broken
#      test suite cannot mask a not-yet-removed banner, and a missing file cannot
#      produce a false PASS.
#   2) Runtime: the full monorepo test suite actually still passes (point 4 of the
#      review feedback) -- a red test run must fail this script, not silently pass.
#
# Uses only POSIX sh so it runs identically under /bin/sh (dash) or bash.
# (pipefail is a bashism that dash rejects with "Illegal option -o pipefail".)

# Fail on an unset variable during expansion and on the last stage of a pipeline.
set -eu

cd /workspace/repo

# Resolve pnpm without depending on it being on PATH: corepack can always bring
# it up, and we prefer an ambient pnpm if one is present.
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  PNPM="corepack pnpm"
fi

# --- Gate 1: the stale banner is gone -------------------------------------

# A missing CLAUDE.md must fail, not PASS: the greps below run against it.
if [ ! -f CLAUDE.md ]; then
  echo "FAIL: CLAUDE.md is missing; cannot verify the banner was removed"
  exit 1
fi

# 1a) The "Status (verified <date>):" banner line itself must not exist -- this
#     catches ANY hard-coded stats banner regardless of its exact wording.
if grep -qi "Status (verified" CLAUDE.md; then
  echo "FAIL: CLAUDE.md still carries a stale 'Status (verified ...)' banner"
  exit 1
fi

# 1b) The specific hard-coded claims the banner used to assert are gone.
#     (grep exits 1 when nothing matches => success)
#   - 29 packages, ~96k lines / 96,126 lines, 253 test files
#   - "all passing" / "Four Agents" quality claims
#   - the pinned RC tag
if grep -Eq "96,126|96k lines|96k source|253 test files|29 packages|v0\.2\.46-loop-guards|Four Agents|all passing" CLAUDE.md; then
  echo "FAIL: CLAUDE.md still carries a stale hard-coded claim (count / tag / quality claim)"
  exit 1
fi

echo "PASS: no stale 'verified' stats banner or hard-coded claim remains in CLAUDE.md."

# --- Gate 2: the test suite still green -----------------------------------

# Fail the whole script if the suite is red. Do not run under set -e: we want the
# exit code to decide the verdict, and we want to print the tail on failure.
if $PNPM -r test > /tmp/pnpm-test.log 2>&1; then
  echo "PASS: pnpm -r test is green (full tail in /tmp/pnpm-test.log)."
else
  echo "FAIL: pnpm -r test is red; last 40 lines:"
  tail -n 40 /tmp/pnpm-test.log || true
  exit 1
fi
