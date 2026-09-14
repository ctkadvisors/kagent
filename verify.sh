#!/usr/bin/env sh
# Proves the scope of 03-implementation: the stale "Status (verified ...)" banner
# with hard-coded project stats has been removed from CLAUDE.md.
#
# Uses only POSIX sh so it runs identically under /bin/sh (dash) or bash.
# (pipefail is a bashism that dash rejects with "Illegal option -o pipefail".)

# Fail on an unset variable during expansion and a failing pipeline's last stage.
set -eu

cd /workspace/repo

# 1) The candidate's "Done when" gate: no specific line/test counts remain.
#    (exit status 1 from grep => no match => success)
if grep -qi "test files" CLAUDE.md; then
  echo "FAIL: CLAUDE.md still contains a stale 'test files' count"
  exit 1
fi

# Also assert the hard-coded numbers the banner carried are gone.
if grep -Eq "96,126|96k|253 test files|v0\.2\.46-loop-guards" CLAUDE.md; then
  echo "FAIL: CLAUDE.md still carries stale numeric stats / pinned tag"
  exit 1
fi

echo "PASS: CLAUDE.md has no stale hard-coded project-stats banner."
