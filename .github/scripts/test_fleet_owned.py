"""python3 .github/scripts/test_fleet_owned.py — the ownership guard's rules, stdlib only."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet_owned  # noqa: E402

GRANT = {"writable_paths": ["packages/agent-loop/src", "k8s/fleet-inventor.yaml"],
         "protected_paths": ["packages/agent-loop/src/kernel"], "protected_suffixes": [".test.ts"]}


def test_owned_matches_the_authority_rule():
    assert fleet_owned.owned("packages/agent-loop/src/executor.ts", GRANT)
    assert fleet_owned.owned("k8s/fleet-inventor.yaml", GRANT)
    assert not fleet_owned.owned("packages/agent-loop/src/executor.test.ts", GRANT)   # the judge stays human
    assert not fleet_owned.owned("packages/agent-loop/src/kernel/x.ts", GRANT)
    assert not fleet_owned.owned("packages/agent-loop/srcx/y.ts", GRANT)              # a prefix, not a substring
    assert not fleet_owned.owned("k8s/fleet-boss.yaml", GRANT)


def test_only_the_fleet_changes_fleet_owned_paths():
    harness = ["packages/agent-loop/src/executor.ts", "docs/x.md"]
    bot = "knuteson-fleet[bot]"
    ok, message = fleet_owned.decide("chrisknu", "chrisknu", harness, GRANT)
    assert not ok and "packages/agent-loop/src/executor.ts" in message and "docs/x.md" not in message
    assert fleet_owned.decide(bot, bot, harness, GRANT)[0]
    # a human pushing onto the fleet's branch is judged as a human
    ok, message = fleet_owned.decide(bot, "chrisknu", harness, GRANT)
    assert not ok and "chrisknu (pushing to" in message
    assert fleet_owned.decide("chrisknu", "chrisknu", ["docs/x.md", "packages/agent-loop/src/a.test.ts"], GRANT)[0]
    # a human commit in a fleet PR (pushed before the fleet's last push) is still a human change
    ok, message = fleet_owned.decide(bot, bot, harness, GRANT, ["authority@fleet.local", "me@x.com"])
    assert not ok and "commits by me@x.com" in message
    assert fleet_owned.decide(bot, bot, harness, GRANT, ["authority@fleet.local"])[0]


def test_grant_of_reads_a_constitution_or_a_mirror():
    constitution = {"repositories": {"o/r": {**GRANT, "readable_paths": ["x"]}}}
    assert fleet_owned.grant_of(constitution, "o/r") == GRANT
    assert fleet_owned.grant_of(GRANT, None) == GRANT


def test_main_reads_the_policy_at_the_base_and_fails_closed():
    with tempfile.TemporaryDirectory() as root:
        def git(*args):
            subprocess.run(["git", "-C", root, *args], check=True, capture_output=True)
        git("init", "-q", "-b", "main")
        git("config", "user.email", "authority@fleet.local")
        git("config", "user.name", "t")
        Path(root, "policy.json").write_text(json.dumps({"repositories": {"o/r": GRANT}}))
        git("add", ".")
        git("commit", "-q", "-m", "base")
        base = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        # the PR widens its own grant and edits a fleet-owned file: the base grant still decides
        Path(root, "packages/agent-loop/src").mkdir(parents=True)
        Path(root, "packages/agent-loop/src/a b.ts").write_text("x")   # whitespace never splits a path
        Path(root, "policy.json").write_text(json.dumps({"repositories": {"o/r": {"writable_paths": []}}}))
        git("add", ".")
        git("commit", "-q", "-m", "head")
        head = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        git("checkout", "-q", base)   # the guard runs from the base checkout; the head is only data
        cwd = os.getcwd()
        os.chdir(root)
        try:
            os.environ.update(BASE_SHA=base, HEAD_SHA=head, PR_AUTHOR="chrisknu", ACTOR="chrisknu")
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
            os.environ.update(PR_AUTHOR="knuteson-fleet[bot]", ACTOR="knuteson-fleet[bot]")
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 0
            os.environ["ACTOR"] = "chrisknu"
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
            # a human commit under the fleet's later push: the commit identity still decides
            git("checkout", "-q", head)
            Path(root, "packages/agent-loop/src/b.ts").write_text("y")
            git("add", ".")
            git("-c", "user.email=me@x.com", "commit", "-q", "-m", "human")
            mixed = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            git("checkout", "-q", base)
            os.environ.update(ACTOR="knuteson-fleet[bot]", HEAD_SHA=mixed)
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
            os.environ["HEAD_SHA"] = "f" * 40
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
            os.environ["HEAD_SHA"] = head
            del os.environ["BASE_SHA"]
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
            os.environ["BASE_SHA"] = "0" * 40
            assert fleet_owned.main(["--policy", "policy.json", "--repository", "o/r"]) == 1
        finally:
            os.chdir(cwd)


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
