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
    env: BASE_SHA, HEAD_SHA (the PR's base and head commits), PR_AUTHOR (who opened it),
         ACTOR (who pushed the commit being judged)

It runs under pull_request_target from the base branch: the workflow, this script and the
policy (read at BASE_SHA) are the base's, and nothing from the pull request executes; its
head is fetched only as data to diff. Both the author and the pusher must be the fleet, so
a human push onto a fleet branch is judged as human. Stdlib only.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request

FLEET = frozenset({"knuteson-fleet[bot]"})
# The commit identity the authority writes fleet patches with (authority/gh.py); a human
# commit pushed before a later fleet push still carries its own identity.
FLEET_COMMITS = frozenset({"authority@fleet.local"})
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


def decide(author, actor, changed, grant, committers=()):
    """(ok, message): the fleet may change its own paths; anyone else may change only the floor.

    `committers` are the author and committer emails of every commit in the pull request."""
    hits = sorted(path for path in changed if owned(path, grant))
    strangers = sorted(set(committers) - FLEET_COMMITS)
    if not hits or (author in FLEET and actor in FLEET and not strangers):
        return True, f"ownership: ok ({len(hits)} fleet-owned path(s), author {author}, pushed by {actor})"
    who = (author if author not in FLEET else f"{actor} (pushing to {author}'s pull request)" if actor not in FLEET
           else "commits by " + ", ".join(strangers))
    return False, ("ownership: these paths are fleet-owned (constitution writable_paths):\n  "
                   + "\n  ".join(hits)
                   + f"\nonly the fleet changes them; {who} is not the fleet. Post a fleet-proposal/v1 on the"
                   " forum, or leave it to fleet-boss. Floor paths (everything else) stay open to humans.")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main(argv=None):
    args = argparse.ArgumentParser()
    args.add_argument("--policy", required=True)
    args.add_argument("--repository")
    args.add_argument("--mirror", help="URL of the kagent mirror to compare with the constitution")
    options = args.parse_args(argv)
    env = {key: os.environ.get(key) for key in ("BASE_SHA", "HEAD_SHA", "PR_AUTHOR", "ACTOR")}
    if not all(env.values()):
        print("ownership: BASE_SHA, HEAD_SHA, PR_AUTHOR and ACTOR must all be set; refusing to pass")
        return 1
    base, head = env["BASE_SHA"], env["HEAD_SHA"]
    try:
        policy = json.loads(git("show", f"{base}:{options.policy}"))
    except (subprocess.CalledProcessError, ValueError) as error:
        print(f"ownership: cannot read {options.policy} at the base {base}: {error}; refusing to pass")
        return 1
    try:
        # -z: exact paths, never quoted or split on whitespace; --no-renames: both sides of a move
        changed = [p for p in git("diff", "-z", "--name-only", "--no-renames", f"{base}...{head}").split("\0") if p]
        identities = git("log", "-z", "--format=%ae%x00%ce", f"{base}..{head}").split("\0")
    except subprocess.CalledProcessError as error:
        print(f"ownership: cannot read {base}..{head}: {error}; refusing to pass")
        return 1
    ok, message = decide(env["PR_AUTHOR"], env["ACTOR"], changed, grant_of(policy, options.repository),
                         [i.strip() for i in identities if i.strip()])
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
