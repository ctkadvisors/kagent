"""The fleet judging itself: a ledger of what its promoted checks measured.

Every catalog check (an instance of an accepted AgentTemplate check-<slug>, see
authority/catalog.py) posts to the forum under its instance name: a first line "<name> on <what>: exit <status>", the tool's output, and a
versioned JSON block of numbers. This module reads those posts through the same
read-only forum path the observation adapter uses, keeps only what is
measurable — the exit status and the numeric leaves of the JSON — and appends
one row per run to `/artifacts/metrics/<check>.jsonl`. From the rows it keeps a
per-check summary: last run, previous run, and the delta of every number, so a
promotion's effect is visible in the report and the digest instead of buried in
prose. Chris, 2026-09-27: "give it the tools to judge itself".

Prose still dies at this boundary: the body is parsed for numbers and dropped.
"""

import json
import math
import re
import time
from pathlib import Path

from . import forum_source

METRICS_DIR = "metrics"
STATE = "checks.json"
# The disposal side (Chris, 2026-09-27: "flagged results and pitches pile up with
# nowhere to go"): one agent posts, under this name, a fenced JSON block per flagged
# run saying what became of it. Only the block is read; its prose dies here too.
DISPOSER = "fleet-disposer"   # the Agent name: authors are gateway-signed since 2026-09-27
# Both roles told to dispose of flags. Reading only the disposer's blocks dropped every
# auditor disposition: the 2026-09-28 audit re-disposed egressmeter (post 2455) from
# noise to pitch, found the ledger still said noise, and posted that as a finding (2458).
# fleet-boss re-disposes a pitch whose fix is playground code as a repair (adoptions.DECISIONS).
DISPOSERS = (DISPOSER, "fleet-auditor", "fleet-boss")
DISPOSITION_SCHEMA = "fleet-disposition/v1"
DISPOSITIONS = frozenset({"proposal", "pitch", "noise", "repair"})   # repair: a real finding whose fix is playground check code
CONSTITUTION = Path(__file__).resolve().parents[1] / "policy" / "bootstrap.json"
POST_QUERY = "SELECT id, author, body, EXTRACT(EPOCH FROM created_at)::bigint FROM post WHERE id = %s"
QUERY = ("SELECT id, author, body, EXTRACT(EPOCH FROM created_at)::bigint FROM post "
         "WHERE id > %s AND (author = ANY(%s) OR author LIKE ANY(%s)) ORDER BY id ASC LIMIT %s")
MAX_BODY = 64 * 1024
MAX_VALUES = 200


def current_checks(root):
    """Every check the fleet runs: the catalog's accepted templates, by slug."""
    from . import catalog

    return sorted(name[len("check-"):] for name in catalog.registered(root) if name.startswith("check-"))


def check_authors(names):
    """The author patterns the forum query needs: instances post as check-<slug>-<instance>-<hash>."""
    return [f"check-{name}-%" for name in names]


def check_name(author, known=()):
    """The check a post's author belongs to (forum_source.check_slug), else the author."""
    return forum_source.check_slug(author, known) or author


def fetch_check_posts(credentials, authors, after_id, limit=500, connect=None):
    """Bounded, id-ordered, read-only; only module-owned queries reach the forum."""
    if not authors:
        return []
    # exact Agent names, plus prefix patterns (a catalog check's instances post as
    # check-<slug>-<instance>-<hash>)
    exact = [a for a in authors if not a.endswith("-%")]
    patterns = [a for a in authors if a.endswith("-%")]
    rows = forum_source._read_query(credentials, QUERY, (int(after_id), exact, patterns, int(limit)), connect)
    return [(int(post_id), str(author), body if isinstance(body, str) else bytes(body).decode("utf-8", "replace"),
             int(epoch)) for post_id, author, body, epoch in rows]


def _json_block(text):
    """The first balanced {...} that parses, bounded; nothing else from the prose."""
    start = text.find("{")
    while 0 <= start < len(text):
        depth = 0
        for i in range(start, min(len(text), start + MAX_BODY)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(text[start:i + 1])
                    except ValueError:
                        break
                    return parsed if isinstance(parsed, dict) else {}
        start = text.find("{", start + 1)
    return {}


def _numbers(obj, prefix="", out=None):
    """Numeric leaves, flattened as dotted keys; lists count and lists of numbers average."""
    out = {} if out is None else out
    if len(out) >= MAX_VALUES:
        return out
    if isinstance(obj, bool):
        out[prefix or "value"] = 1.0 if obj else 0.0
    elif isinstance(obj, (int, float)):
        try:
            number = float(obj)
        except OverflowError:
            return out
        if math.isfinite(number):
            out[prefix or "value"] = number
    elif isinstance(obj, dict):
        for key, value in obj.items():
            _numbers(value, f"{prefix}.{key}" if prefix else str(key), out)
    elif isinstance(obj, list):
        nums = [x for x in obj if isinstance(x, (int, float)) and not isinstance(x, bool)]
        out[f"{prefix}.count" if prefix else "count"] = float(len(obj))
        if nums:
            out[f"{prefix}.mean" if prefix else "mean"] = sum(nums) / len(nums)
    return out


READING_KEY = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./:\[\]-]{1,79}")
# What a check's reading starts with: a verdict token, a number, or name=value. Prose lines
# ("Both stores fail: ...") are not readings and never reach the ledger.
READING_VALUE = re.compile(r"[A-Z][A-Z0-9_]{1,40}|[-+]?\d[\d.,]*%?|[\w.-]+=\S+")


def readings(body):
    """What a check says per line: `<key>  <reading...>` -> {key: reading}. Checks report
    their verdicts as text (`read/l300  SHORTFALL_UNDECLARED  asked=300 got=200`), which the
    numeric values never held. A key that appears twice in one run is dropped: a release is
    judged on one reading, never on a guess between two."""
    seen, out = set(), {}
    for line in body[:MAX_BODY].splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not READING_KEY.fullmatch(parts[0]) \
                or not READING_VALUE.fullmatch(parts[1].split(None, 1)[0]):
            continue
        key, text = parts[0], parts[1].strip()[:200]
        if key in seen:
            out.pop(key, None)
            continue
        seen.add(key)
        if len(out) < MAX_VALUES:
            out[key] = text
    return out


def parse(author, body, post_id, epoch):
    """One run's measurable content."""
    body = body[:MAX_BODY]
    return {"post_id": post_id, "check": author, "at": epoch,
            "exit": forum_source.exit_status(body),
            "values": _numbers(_json_block(body)), "readings": readings(body)}


def _state(root):
    try:
        state = json.loads((Path(root) / METRICS_DIR / STATE).read_text())
    except (OSError, ValueError):
        state = {"watermark": 0, "checks": {}}
    state.setdefault("dispositions", {})
    state.setdefault("disposer_watermark", 0)
    return state


def parse_disposition(body):
    """The signed schema block of a disposer post, bounded; None when absent.

    Disposer prose may quote tool arguments before its inline or fenced block. Scan
    complete JSON objects for the disposition schema instead of treating the first
    unrelated object as the post's verdict. Check metric parsing deliberately keeps
    `_json_block`'s first-object semantics.
    """
    text, block, decoder = body[:MAX_BODY], {}, json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            candidate, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(candidate, dict) and candidate.get("schema") == DISPOSITION_SCHEMA:
            block = candidate
            break
    if block.get("schema") != DISPOSITION_SCHEMA or block.get("kind") not in DISPOSITIONS:
        return None
    post = block.get("post")
    if not isinstance(post, int) or isinstance(post, bool) or post <= 0:
        return None
    return {"post": post, "kind": block["kind"],
            "ref": str(block.get("ref") or "")[:200], "why": str(block.get("why") or "")[:400]}


def record(store, credentials, *, connect=None, fetch=fetch_check_posts):
    """Read new check posts since the watermark, append rows, refresh the summary."""
    scan_started_at = time.time()
    root = Path(store.root) / METRICS_DIR
    root.mkdir(parents=True, exist_ok=True)
    state = _state(store.root)
    authors = current_checks(store.root)
    posts = fetch(credentials, check_authors(authors), state["watermark"], connect=connect) if authors else []
    recorded = 0
    for post_id, author, body, epoch in posts:
        check = check_name(author, authors)
        # The poster: a catalog instance is check-<slug>-<instance>-<hash>, which no
        # agent can guess from the slug, so readers look the post up by this.
        row = {**parse(check, body, post_id, epoch), "author": author}
        with (root / f"{check}.jsonl").open("a") as handle:
            handle.write(json.dumps(row, sort_keys=True) + "\n")
        previous = state["checks"].get(check, {}).get("last")
        state["checks"][check] = {"last": row, "previous": previous, "runs": state["checks"].get(check, {}).get("runs", 0) + 1}
        state["watermark"] = max(state["watermark"], post_id)
        recorded += 1
    for name in authors:
        state["checks"].setdefault(name, {"last": None, "previous": None, "runs": 0})
    disposed = 0
    for post_id, author, body, epoch in (fetch(credentials, list(DISPOSERS), state["disposer_watermark"], connect=connect) if authors else []):
        state["disposer_watermark"] = max(state["disposer_watermark"], post_id)
        d = parse_disposition(body)
        # the boss only routes to the inventor; it never calls a flag noise or closes it
        if d is None or (author == "fleet-boss" and d["kind"] != "repair"):
            continue
        state["dispositions"][str(d["post"])] = {**d, "at": epoch, "by": post_id}
        disposed += 1
    # A completed remeasure task may be retried only after a full check-post scan
    # started after its completion. A page at the query limit may leave a backlog.
    if authors and len(posts) < 500:
        state["check_scan_started_at"] = scan_started_at
    (root / STATE).write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")
    return {"recorded": recorded, "checks": len(authors), "watermark": state["watermark"], "disposed": disposed}


def reading_in_post(credentials, post_id, key, connect=None):
    """(author, reading) for `key` in one forum post, read from the post itself; every reading for None."""
    found = forum_source._read_query(credentials, POST_QUERY, (int(post_id),), connect)
    if not found:
        return None, None
    _, author, body, _ = found[0]
    body = body if isinstance(body, str) else bytes(body).decode("utf-8", "replace")
    return str(author), readings(body) if key is None else readings(body).get(key)


def meets_target(value, operator, target):
    """Compare one protected numeric check value to its proposal's explicit target."""
    if (type(value) not in (int, float) or isinstance(value, bool)
            or isinstance(value, float) and not math.isfinite(value)
            or isinstance(target, float) and not math.isfinite(target)):
        return False
    return {">": value > target, ">=": value >= target, "<": value < target,
            "<=": value <= target, "==": value == target, "!=": value != target}[operator]


def rows(root, names):
    """The ledger's rows per check (slug -> [{post_id, at, exit, values}]), bounded."""
    out = {}
    for name in names:
        path = Path(root) / METRICS_DIR / f"{name}.jsonl"
        try:
            lines = path.read_text().splitlines()[-200:]
        except OSError:
            continue
        out[name] = [json.loads(line) for line in lines if line.strip()]
    return out


def parked_proposals(root):
    """post id (text) -> why the lab parked that proposal (steer registry), or {}. A contract
    returned for its own red tests carries CI's lines: the reopened flag is where the proposer
    reads what to fix."""
    try:
        registry = json.loads((Path(root) / "proposals.json").read_text())   # steer.REGISTRY
    except (OSError, ValueError):
        return {}
    return {str(entry.get("post_id")): entry["parked"] + (f": CI said {entry['ci_failure']}" if entry.get("ci_failure") else "")
            for entry in (registry.get("proposals") or {}).values() if isinstance(entry, dict) and entry.get("parked")}


def widened_at(constitution=None):
    """When the constitution last widened what the fleet may write (epoch), or 0."""
    from datetime import datetime
    document = constitution if constitution is not None else json.loads(CONSTITUTION.read_text())
    stamps = [repo.get("widened_at") for repo in (document.get("repositories") or {}).values()]
    return max((datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() for s in stamps if s), default=0)


def summary(root, now=None, constitution=None):
    """What the report and the digest read: one entry per check."""
    from . import catalog

    state = _state(root)
    current = set(current_checks(root))
    masked = {name[len("check-"):] for name, entry in catalog.registered(root).items()
              if name.startswith("check-") and catalog.masked(entry.get("run"))}
    parked = parked_proposals(root)
    widened = widened_at(constitution)
    out = []
    # A check that left the catalog keeps its rows on disk but leaves the summary.
    for name, entry in sorted(state["checks"].items()):
        if name not in current:
            continue
        last, previous = entry.get("last"), entry.get("previous")
        item = {"check": name, "runs": entry.get("runs", 0),
                "last_at": last["at"] if last else None,
                "post_id": last["post_id"] if last else None,
                "author": last.get("author") if last else None,
                "exit": last["exit"] if last else None,
                "flagged": bool(last and (last["exit"] not in (0, None) or name in masked))}
        if last and name in masked:
            item["masked_run"] = True   # its exit 0 is the wrapper's: a repair, not a pass
        if item["flagged"]:
            # What became of the flag: a proposal the fleet builds, a pitch for Chris,
            # noise with a reason, or still open (the disposer has not been round).
            item["disposition"] = state["dispositions"].get(str(last["post_id"]), {"kind": "open"})
            # A proposal the lab parked (invalid, green, unrunnable) did not dispose of
            # anything: the flag reopens with the failed approach attached, so the next
            # disposer sees it and must try something different.
            ref = str(item["disposition"].get("ref") or "")
            if item["disposition"].get("kind") == "proposal" and ref in parked:
                item["disposition"] = {"kind": "open", "reopened": {"proposal": ref, "parked": parked[ref]}}
            # A pitch sends a fix outside what the fleet may write. When the constitution
            # widens that, the pitch was decided under rules that no longer hold: it reopens
            # once, and the next disposer decides again with the new writable paths.
            elif item["disposition"].get("kind") == "pitch" and item["disposition"].get("at", 0) < widened:
                item["disposition"] = {"kind": "open", "reopened": {"pitch": ref, "constitution_widened": widened}}
        if last:
            deltas = {}
            for key, value in last["values"].items():
                before = (previous or {}).get("values", {}).get(key)
                deltas[key] = {"now": value, "before": before,
                               "delta": None if before is None else round(value - before, 6)}
            item["values"] = deltas
        out.append(item)
    ran_24h = sum(1 for item in out if item["last_at"] and now and now - item["last_at"] <= 86400)
    kinds = [item["disposition"]["kind"] for item in out if item["flagged"]]
    return {"checks": out, "ran_24h": ran_24h if now else None,
            "flagged": len(kinds),
            "disposed": {k: kinds.count(k) for k in ("open", "proposal", "pitch", "noise", "repair") if kinds.count(k)},
            "never_ran": [item["check"] for item in out if item["runs"] == 0]}


def line(root, now=None):
    s = summary(root, now)
    if not s["checks"]:
        return ""
    flagged = [f"{item['check']} {item['disposition']['kind']}" for item in s["checks"] if item["flagged"]]
    return (f"Checks: {len(s['checks'])} in the catalog, {s['ran_24h'] or 0} ran in 24h, "
            f"{len(flagged)} flagged" + (f" ({', '.join(flagged)})" if flagged else "")
            + (f", {len(s['never_ran'])} never ran" if s["never_ran"] else "") + ". ")
