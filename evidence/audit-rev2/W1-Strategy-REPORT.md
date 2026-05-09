# W1-Strategy — Report

**Workstream:** W1-Strategy (audit R2 §3 — A2A spec version + governance citation)
**Date:** 2026-05-07
**Owner:** Claude Opus 4.7 (1M context) under user `cknuteson@gmail.com`
**Scope:** doc-only fix to `docs/PROTOCOLS.md`. No code, no other docs touched.

---

## Outcome

Single atomic commit landed and pushed to `main`.

- **Commit SHA:** `167e056cf383d4051fbfae280a842a38720fc9b4`
- **Subject:** `docs(protocols): correct A2A spec reference v1.2 → v1.0 with governance citation`
- **Push target:** `origin/main` (`73deac1..167e056`)
- **Files changed:** 1 (`docs/PROTOCOLS.md`)
- **Lines:** +7 / −7

---

## Diff scope (verified single-file)

Pre-commit `git diff --staged docs/PROTOCOLS.md` showed only `docs/PROTOCOLS.md` modifications. `git commit --only -F <msg> docs/PROTOCOLS.md` was used to lock the commit to this single path so concurrent W1-Pod / W1-Operator agents could not pull in unrelated code changes.

Touched sections of `docs/PROTOCOLS.md`:

1. **§1 — The thesis: compat is a feature** (line 22) — replaced "A2A v1.2" in the marketing-line example with "A2A v1.0".
2. **§5.1 — Wire-format protocols for agent-to-agent task exchange** (line 130) — the load-bearing edit. Replaced the A2A v1.2 row with a v1.0 row that adds:
   - GA date (March 12 2026) with link to the official announcement.
   - 150-org production count cited to the LF anniversary press release (April 9 2026).
   - Version-sequence clarification: v0.3 → v1.0; no v1.1 / v1.2 has shipped.
   - Governance note: hosted by the Linux Foundation under the Agentic AI Foundation (AAIF), formed Dec 9 2025, with the AAIF formation press release linked inline.
3. **§5.3 — The handoff envelope** (line 146) — "A2A v1.2 has task lifecycle…" → "A2A v1.0 has task lifecycle…".
4. **§7 — Slate 1 — A2A wire format** (lines 252-257) — heading and slate body updated v1.2 → v1.0; "150+ production deployments" now linked to the LF anniversary press release.
5. **§10 — What this doc explicitly does NOT commit to** (line 317) — "A2A v1.2 is the bet." → "A2A v1.0 is the bet."

Note: a single textual occurrence of "v1.2" remains in the file, intentionally — inside the §5.1 row, the phrase "no v1.1 / v1.2 has shipped" is a deliberate historical-correction marker per the task brief.

§5.3 (the "what's missing for kagent to speak A2A on the wire" subsection) was left untouched per task brief — that is W4-Strategy-A2A territory; only the v1.2→v1.0 token was swapped.

---

## Citations verified

All four URLs requested by the task brief are present in the doc:

| Citation | URL | Where used |
|---|---|---|
| A2A v1.0 announcement | https://a2a-protocol.org/latest/announcing-1.0/ | §5.1 row, §7 Slate 1 body |
| LF 150-org anniversary | https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations | §5.1 row, §7 Slate 1 "Why first" |
| AAIF formation (Dec 9 2025) | https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation | §5.1 row governance note |
| (audit source) R2 §3 | `evidence/audit-rev2/R2.md` §3 | source-of-truth for the version + governance facts |

The 150-org figure is cited consistently as a snapshot from the LF anniversary post (April 9 2026), not as a current real-time count, matching the audit's framing.

---

## Hooks / pre-commit

The repo's `.husky/pre-commit` runs `pnpm lint-staged && pnpm -r typecheck`, which requires Node 22 (the engines pin in `package.json` is `>=22.0.0 <23.0.0`). The shell defaulted to Node 23.11.1, so the first commit attempt failed. Resolved by sourcing nvm and switching to `22.22.0` before re-issuing `git commit --only`. lint-staged ran prettier on the file (no semantic changes), and the full workspace `pnpm -r typecheck` passed. The commit then landed.

No hook bypass (`--no-verify`) was used.

---

## Verification

- `git diff --stat HEAD~1 HEAD` → `docs/PROTOCOLS.md | 14 +++++++-------` (one file, balanced 7/7).
- `grep -n "v1\.2" docs/PROTOCOLS.md` → exactly one match, the deliberate "no v1.1 / v1.2 has shipped" historical-correction phrase in §5.1.
- `git log --oneline origin/main -1` → `167e056 docs(protocols): correct A2A spec reference v1.2 → v1.0 with governance citation`.

---

## Status

Done. Audit R2 §3 finding ("PROTOCOLS.md §5.1 cites A2A v1.2; should be corrected to v1.0 before the slate-1 PR lands") is closed in `main`.
