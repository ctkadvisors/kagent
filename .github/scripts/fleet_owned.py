# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
"""The ownership guard: fleet-owned paths change only through the fleet.

Chris, 2026-10-13: "we've mucked around in the harnesses too much; ensure this is the
LAST time." The fleet-owned paths are exactly what the constitution lets the fleet write
(services/fleet-authority/policy/bootstrap.json `writable_paths`, minus protected paths
and suffixes; the same rule as authority.policy.writable). A pull request that changes one
must come from the fleet's own identity. Anyone else gets a red check saying where the change
belongs instead: a fleet-proposal/v1 on the forum, or a fleet-boss decision. Floor paths
(everything else) stay human. The same file runs in ctkadvisors/kagent against its public
mirror, .github/fleet-owned.json, which this repository's run checks against the constitution.

    python3 fleet_owned.py --policy <file> [--repository <owner/repo>] [--mirror <url>]
    env: BASE_SHA (the PR base), PR_AUTHOR (the PR author's login)

The policy is read at BASE_SHA, so a pull request cannot widen its own grant to pass.
Stdlib only: the runner has no PyYAML.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

FLEET = frozenset({"knuteson-fleet[bot]"})
MIRROR_REPOSITORY = "ctkadvisors/kagent"
GRANT_KEYS = ("writable_paths", "protected_paths", "protected_suffixes")


def within(path, roots):
    return any(path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


def owned(path, grant):
    """authority.policy.writable without its spelling check: what the fleet may write."""
    return (within(path, grant.get("writable_paths", ())) and not within(path, grant.get("protected_paths", ()))
            and not any(path.endswith(suffix) for suffix in grant.get("protected_suffixes", ())))


def grant_of(policy, repository):
    """A constitution's grant for one repository, or a mirror file's top-level grant."""
    grant = policy["repositories"][repository] if repository else policy
    return {key: list(grant.get(key, [])) for key in GRANT_KEYS}


def decide(author, changed, grant):
    """(ok, message): the fleet may change its own paths; anyone else may change only the floor."""
    hits = sorted(path for path in changed if owned(path, grant))
    if not hits or author in FLEET:
        return True, f"ownership: ok ({len(hits)} fleet-owned path(s), author {author})"
    return False, ("ownership: these paths are fleet-owned (constitution writable_paths):\n  "
                   + "\n  ".join(hits)
                   + f"\nonly the fleet changes them; {author} is not the fleet. Post a fleet-proposal/v1 on the"
                   " forum, or leave it to fleet-boss. Floor paths (everything else) stay open to humans.")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main(argv=None):
    args = argparse.ArgumentParser()
    args.add_argument("--policy", required=True)
    args.add_argument("--repository")
    args.add_argument("--mirror", help="URL of the kagent mirror to compare with the constitution")
    options = args.parse_args(argv)
    base, author = os.environ.get("BASE_SHA"), os.environ.get("PR_AUTHOR")
    if not base or not author:
        print("ownership: BASE_SHA and PR_AUTHOR must be set (a pull_request event); refusing to pass")
        return 1
    try:
        policy = json.loads(git("show", f"{base}:{options.policy}"))
    except (subprocess.CalledProcessError, ValueError) as error:
        print(f"ownership: cannot read {options.policy} at the base {base}: {error}; refusing to pass")
        return 1
    changed = git("diff", "--name-only", "--no-renames", f"{base}...HEAD").split()
    ok, message = decide(author, changed, grant_of(policy, options.repository))
    print(message)
    if options.mirror:
        with urllib.request.urlopen(options.mirror, timeout=30) as response:
            mirror = grant_of(json.loads(response.read()), None)
        expected = grant_of(policy, MIRROR_REPOSITORY)
        if mirror != expected:
            print(f"ownership: {options.mirror} differs from the constitution's {MIRROR_REPOSITORY} grant;"
                  f" update the mirror to:\n{json.dumps(expected, indent=2)}")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
