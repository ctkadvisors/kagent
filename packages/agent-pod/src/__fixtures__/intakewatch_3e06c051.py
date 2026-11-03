#!/usr/bin/env python3
"""intakewatch - read-only check over the conversation-graph memory INTAKE face.

Reads a RECORDED reading of the intake status surface (the json object that
mcp.get_ingestion_status returns) and prints one account per receipt:
  {receipt_id, group_id, status, attempts, last_error, age_seconds}
plus one exit status:
  0  no receipt exceeds the bounded retry budget
  1  at least one receipt breaches it (each is named), or the worker is down
  2  the status surface itself is unavailable/unreliable (a finding, never a pass)

Read-only. No graph write, no network fetch inside the run, no self-test mode.
"""
import argparse
import hashlib
import json
import os
import sys
import time

DEFAULT_MAX_ATTEMPTS = 20
DEFAULT_MAX_AGE_SECONDS = 86400.0
REQUIRED_TOP = ("counts", "receipts", "worker_running", "oldest_pending_seconds")
DEFAULT_MAX_INPUT_AGE_SECONDS = 3600.0
EXPECTED_SOURCE_TOOL = "mcp.get_ingestion_status"
BARE_RECORD_PROVENANCE = "<record-provenance-needs-a-path>"


WINDOW_LIMIT = 20   # the row cap mcp.get_ingestion_status applies when none is recorded
# Observed 2026-10-28 on the live face: `receipts` arrives ordered by receipt_id
# ascending, so a bounded `limit` is an id-PREFIX sample, not a random or
# newest-first one. The long-retrying poisoned receipts (highest ids) are exactly
# the rows a small window drops. `mcp.get_ingestion_status(limit=20)` on the live
# face returned 20 all-completed rows while counts reported retrying=2 and
# oldest_pending_seconds=1,826,927 (21.1 d); the same call at limit=100 carried
# both stuck receipts. VERIFIED_COVERING_LIMIT is the smallest limit observed to
# cover the whole table today, offered as the consumer's next call, never assumed.
VERIFIED_COVERING_LIMIT = 100
FACE_ORDERING = ("receipts arrive ordered by receipt_id ascending (observed on the live "
                 "face 2026-10-28), so a bounded limit is an id-prefix sample")


COVERAGE_BASIS = ("every non-terminal status reported by counts is reconciled against "
                  "the window row-for-row, and the window does not end on a "
                  "non-terminal row")


def size_of(path):
    try:
        with open(path, "rb") as handle:
            return len(handle.read())
    except Exception:
        return None


def sha256_of(path):
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except Exception:
        return None


def _clean_args(args):
    """Normalise tool arguments a capture recorded, so an unset filter is null,
    never the four-character string "null" that a naive str(None) leaves behind."""
    if not isinstance(args, dict):
        return None
    out = {}
    for k, v in args.items():
        if isinstance(v, str) and v.strip().lower() in ("null", "none", ""):
            v = None
        out[str(k)] = v
    return out


def sidecar_candidates(path):
    stem, _ext = os.path.splitext(path)
    return [path + ".provenance.json", stem + ".provenance.json"]


def bind_provenance(path, reading, max_input_age, now, raw=None, record_path=None):
    """Bind the judged bytes to a provenance record, or refuse to certify them.

    A committed file can be re-judged forever without ever touching the surface,
    so the binding is enforced rather than assumed: a sibling provenance record
    must name the tool the reading came from, carry the sha256 of the judged
    bytes, and be fresh enough to still describe the live face. Returns
    (record, None) when bound, else (record_or_None, (code, reason)).
    """
    found = None
    if record_path:
        if not os.path.exists(record_path):
            return None, ("provenance_unbound",
                          "--provenance names " + str(record_path) + ", which does not exist")
        found = record_path
    else:
        for cand in sidecar_candidates(path):
            if os.path.exists(cand):
                found = cand
                break
    if found is None:
        return None, ("provenance_unbound",
                      "no provenance record beside " + str(path)
                      + " (looked for " + " or ".join(sidecar_candidates(path))
                      + "); for a stream input pass --provenance <record.json>)")
    try:
        with open(found, "rb") as handle:
            record = json.loads(handle.read().decode("utf-8"))
    except Exception as exc:
        return None, ("provenance_unreadable",
                      "provenance record " + str(found) + " unreadable: " + str(exc))
    if not isinstance(record, dict):
        return None, ("provenance_unreadable",
                      "provenance record " + str(found) + " is not a json object")
    if isinstance(raw, bytes):
        want = hashlib.sha256(raw).hexdigest()
        bytes_read = len(raw)
    else:
        want = sha256_of(path)
        bytes_read = size_of(path)
    got = record.get("sha256")
    if not isinstance(got, str) or got.lower() != want:
        return None, ("provenance_digest_mismatch",
                      "provenance record " + str(found) + " binds sha256=" + repr(got)
                      + " but the judged bytes are sha256=" + repr(want))
    tool = record.get("source_tool")
    if tool != EXPECTED_SOURCE_TOOL:
        return None, ("provenance_source_mismatch",
                      "provenance record " + str(found) + " names source_tool="
                      + repr(tool) + ", expected " + repr(EXPECTED_SOURCE_TOOL))
    kind = record.get("source_kind")
    if not isinstance(kind, str) or not kind.strip():
        return None, ("provenance_unbound",
                      "provenance record " + str(found) + " names no source_kind")
    stamp = reading.get("observed_at")
    if not isinstance(stamp, (int, float)) or isinstance(stamp, bool):
        stamp = record.get("received_at")
    if not isinstance(stamp, (int, float)) or isinstance(stamp, bool):
        return None, ("provenance_unbound",
                      "neither the reading nor " + str(found)
                      + " carries an observation stamp")
    age = float(now) - float(stamp)
    prov = {
        "record": found,
        "source_tool": tool,
        "source_kind": kind,
        "recorded_by": record.get("recorded_by") or record.get("captured_by"),
        "tool_arguments": _clean_args(record.get("tool_arguments")),
        "url": record.get("url"),
        "url_reason": record.get("url_reason"),
        "verifier_check": record.get("verifier_check"),
        "observed_at": float(stamp),
        "age_seconds_at_judgement": round(age, 1),
        "max_input_age_seconds": max_input_age,
        "judged_bytes_sha256": want,
        "judged_bytes": bytes_read,
        "counts": reading.get("counts"),
        "receipts_seen": len(reading.get("receipts") or []),
        "worker_running": reading.get("worker_running"),
        "status": "bound",
    }
    side_counts = record.get("counts")
    if side_counts is not None and side_counts != reading.get("counts"):
        return prov, ("provenance_counts_mismatch",
                      "provenance record " + str(found) + " recorded counts="
                      + json.dumps(side_counts, sort_keys=True)
                      + " but the judged bytes carry counts="
                      + json.dumps(reading.get("counts"), sort_keys=True))
    if max_input_age and max_input_age > 0:
        if age > max_input_age:
            prov["status"] = "stale"
            return prov, ("reading_stale",
                          "the judged reading is " + format(age, ".0f")
                          + " s old, past the " + format(max_input_age, ".0f")
                          + " s freshness bound, so it may be a frozen capture rather"
                          + " than a reading of the live face")
        if age < -300:
            prov["status"] = "future"
            return prov, ("reading_from_the_future",
                          "the judged reading is stamped " + format(-age, ".0f")
                          + " s ahead of this run")
    return prov, None


def load_reading(path, sink=None):
    """Return (reading, None) or (None, reason). Unavailable is a finding.

    When `sink` is a dict the exact bytes that were judged are recorded under
    "raw", so a judgement made over a stream (stdin) can still be bound to a
    digest of the bytes actually read."""
    if path in ("-", "/dev/stdin"):
        # sys.stdin hands back str; the file branch hands back bytes. The shared
        # decode below expects bytes, so an unnormalised stdin read raised
        # "'str' object has no attribute 'decode'" and the documented `--input -`
        # path could never succeed. Prefer the binary channel, normalise otherwise.
        try:
            buf = getattr(sys.stdin, "buffer", None)
            raw = buf.read() if buf is not None else sys.stdin.read()
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
        except Exception as exc:
            return None, "stdin unreadable: %s" % exc
    else:
        if not os.path.exists(path):
            return None, "reading file absent: %s" % path
        try:
            with open(path, "rb") as handle:
                raw = handle.read()
        except Exception as exc:
            return None, "reading file unreadable: %s (%s)" % (path, exc)
    if isinstance(sink, dict):
        sink["raw"] = raw
    if not raw or not raw.strip():
        return None, "reading carried no bytes: %s" % path
    try:
        reading = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        return None, "reading is not valid json: %s" % exc
    if not isinstance(reading, dict):
        return None, "reading is not a json object"
    missing = [k for k in REQUIRED_TOP if k not in reading]
    if missing:
        return None, "reading lacks required surface fields: %s" % ",".join(missing)
    if not isinstance(reading.get("receipts"), list):
        return None, "receipts is not a list"
    if not isinstance(reading.get("counts"), dict):
        return None, "counts is not an object"
    return reading, None


TERMINAL = ("completed", "forgotten")


def window_fault(reading, max_age, window_limit=WINDOW_LIMIT):
    """The surface returns a bounded window, not the whole receipt table.

    A breach can only come from a non-terminal receipt, so a judgement is
    certifiable exactly when the window provably holds every non-terminal row.
    Reconcile EVERY non-terminal status the counts report -- not only
    `retrying`: the live face also emits `pending` and `processing`, and a
    window that only ever checks `retrying` can exit clean while hiding a
    breach in a status it never reconciled. A truncated tail of already
    completed rows is expected and is not a fault.

    Returns (None, None) when the window provably covers the non-terminal
    region, else (fault_code, reason).
    """
    counts = reading.get("counts") or {}
    try:
        parsed = {k: int(counts.get(k, 0) or 0) for k in counts}
    except Exception:
        return ("counts_not_integral", "counts are not all integral: %r" % (counts,))
    rows = [r for r in reading["receipts"] if isinstance(r, dict)]
    if len(rows) != len(reading["receipts"]):
        return ("row_not_object", "a receipt row is not an object")
    listed = len(rows)
    seen = {}
    for r in rows:
        st = str(r.get("status"))
        seen[st] = seen.get(st, 0) + 1

    nonterminal = {k: v for k, v in parsed.items()
                   if v > 0 and k not in TERMINAL}
    # The surface's own scalar is the one field that survives a truncated window: it is
    # the face's account of its oldest non-terminal receipt. Weigh it, and refuse to let
    # a reading that reports an old pending receipt while counting none certify anything.
    scalar = reading.get("oldest_pending_seconds")
    scalar_breach = (isinstance(scalar, (int, float)) and not isinstance(scalar, bool)
                     and float(scalar) > float(max_age))
    if not nonterminal:
        if scalar_breach:
            return ("scalar_without_nonterminal",
                    "counts reports no non-terminal receipt (%s) while the surface's own "
                    "oldest_pending_seconds=%s exceeds the %s s budget - the reading "
                    "disagrees with itself, so no judgement can be certified"
                    % (json.dumps(parsed, sort_keys=True), format(float(scalar), ".0f"),
                       format(float(max_age), ".0f")))
        if listed == 0:
            return ("no_rows", "counts report no non-terminal receipts but the window "
                    "lists no rows at all, so nothing was observed")
        for st in seen:
            if st not in TERMINAL:
                return ("status_unaccounted",
                        "the window holds %d rows of status %r while counts report none "
                        "of that status - the reading disagrees with itself" % (seen[st], st))
        return (None, None)

    for st, want in sorted(nonterminal.items()):
        got = seen.get(st, 0)
        if got < want:
            return ("coverage_shortfall",
                    "counts.%s=%d but the window lists only %d %s rows - the non-terminal "
                    "region is not fully covered, so no judgement can be certified"
                    % (st, want, got, st))
        if got > want:
            return ("counts_disagreement",
                    "counts.%s=%d but the window lists %d %s rows - the reading disagrees "
                    "with itself" % (st, want, got, st))
    # Truncation is only PLAUSIBLE once the window has actually reached the
    # surface's row limit; below it the surface returned everything it had, so a
    # trailing non-terminal row is not evidence of a cut and must not refuse a
    # reading whose counts already reconcile row for row.
    if listed >= window_limit:
        statuses = [r.get("status") for r in rows]
        last_nonterminal = -1
        for idx, st in enumerate(statuses):
            if st not in TERMINAL:
                last_nonterminal = idx
        if last_nonterminal == listed - 1:
            return ("window_ends_nonterminal",
                    "the window is full at the surface limit of %d rows and ends on a "
                    "non-terminal row, so the surface may have cut further non-terminal "
                    "rows below it" % window_limit)
    return (None, None)


def recorded_window_limit(path, record_path=None):
    """The `limit` the capture's own provenance says the call was given.

    The capture step already records tool_arguments.limit, so the tool knows the
    width of the window it is judging. Before this it never read that number, so
    when the window came up short it could name the shortfall but could not say
    how wide the next call should be."""
    found = record_path
    if found and not os.path.exists(found):
        return None
    if not found:
        for cand in sidecar_candidates(path):
            if os.path.exists(cand):
                found = cand
                break
    if not found:
        return None
    try:
        with open(found, "rb") as handle:
            record = json.loads(handle.read().decode("utf-8"))
    except Exception:
        return None
    args = record.get("tool_arguments") if isinstance(record, dict) else None
    if not isinstance(args, dict):
        return None
    raw = args.get("limit")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        text = str(raw).strip()
        try:
            raw = int(text)
        except Exception:
            return None
    return int(raw)


def build_remedy(reading, fault_code, recorded_limit, max_attempts, max_age):
    """A next call the consumer can make, sized to the gap this reading shows.

    exit 2 was a dead end: it said `no judgement can be certified` and named
    neither the width to ask for nor the call to make, so the consumer's only
    move was to re-run the same un-widened capture and get the same refusal.
    Counts are surface-wide even when the window is not, so the number of
    non-terminal rows the window is missing is knowable and sets the width."""
    counts = reading.get("counts") or {}
    missing = {}
    total_missing = 0
    for key, val in counts.items():
        if key in TERMINAL:
            continue
        try:
            want = int(val or 0)
        except Exception:
            continue
        if want <= 0:
            continue
        have = sum(1 for r in (reading.get("receipts") or [])
                   if isinstance(r, dict) and str(r.get("status")) == key)
        gap = want - have
        if gap > 0:
            missing[key] = {"counts": want, "in_window": have, "missing": gap}
            total_missing += gap
    rows = [r for r in (reading.get("receipts") or []) if isinstance(r, dict)]
    scalar = reading.get("oldest_pending_seconds")
    scalar_ok = isinstance(scalar, (int, float)) and not isinstance(scalar, bool)
    width = VERIFIED_COVERING_LIMIT
    if recorded_limit is not None and recorded_limit >= VERIFIED_COVERING_LIMIT:
        width = recorded_limit
    if total_missing > 0:
        needed = len(rows) + total_missing + 10
        width = max(width, needed)
    remedy = {
        "next_call": "mcp.get_ingestion_status(limit=%d)" % width,
        "suggested_limit": width,
        "rows_in_window": len(rows),
        "non_terminal_missing_from_window": missing,
        "non_terminal_missing_total": total_missing,
        "face_ordering": FACE_ORDERING,
        "why": "counts are surface-wide while receipts is a bounded window, so these "
               "%d non-terminal rows are known to exist yet sit outside the judged "
               "window; widening the call is what makes a judgement certifiable"
               % total_missing,
        "capture_command": "mcp.get_ingestion_status(limit=%d) | python3 "
                           "capture_intake_status.py --out <path> --limit %d "
                           "--captured-at <now-iso>" % (width, width),
    }
    if recorded_limit is not None:
        remedy["recorded_call_limit"] = recorded_limit
    if scalar_ok:
        remedy["surface_oldest_pending_seconds"] = round(float(scalar), 1)
        remedy["oldest_beyond_budget"] = bool(float(scalar) > float(max_age))
    remedy["budget"] = {"max_attempts": max_attempts, "max_age_seconds": max_age}
    remedy["meaning"] = ("exit 2 is a finding about the READING, not a pass and not a "
                         "verdict on the receipts; make the call named in next_call and "
                         "judge those bytes")
    return remedy


def coverage_account(reading, window_limit=None):
    """What the bounded window provably covers. Reported, never assumed.

    window_limit is the width the capture's own provenance says the call was
    given, when that is knowable; the surface default is the fallback, never a
    guess. Before this the field always printed the default 20, so a consumer
    reading a limit=100 capture was told its window was 20 rows wide."""
    counts = reading.get("counts") or {}
    rows = [r for r in reading.get("receipts", []) if isinstance(r, dict)]
    seen = {}
    for r in rows:
        st = str(r.get("status"))
        seen[st] = seen.get(st, 0) + 1
    nonterminal = {}
    for k, v in counts.items():
        try:
            v = int(v or 0)
        except Exception:
            v = None
        if v and v > 0 and k not in TERMINAL:
            nonterminal[k] = {"counts": v, "in_window": seen.get(k, 0)}
    return {
        "status": "covered" if nonterminal else "none_nonterminal",
        "non_terminal": nonterminal,
        "window_rows": len(rows),
        "window_limit": (int(window_limit) if isinstance(window_limit, int)
                          and not isinstance(window_limit, bool)
                          and window_limit > 0 else WINDOW_LIMIT),
        "window_limit_is_recorded": bool(isinstance(window_limit, int)
                                          and not isinstance(window_limit, bool)
                                          and window_limit > 0),
        "terminal_in_window": sum(c for s, c in seen.items() if s in TERMINAL),
        "basis": COVERAGE_BASIS,
    }


def age_seconds(receipt, observed_at):
    accepted = receipt.get("accepted_at")
    if not isinstance(accepted, (int, float)) or isinstance(accepted, bool):
        return None
    return float(observed_at) - float(accepted)


def observe(reading, max_attempts, max_age, observed_at):
    accounts, breaches, findings = [], [], []
    for receipt in reading["receipts"]:
        if not isinstance(receipt, dict):
            findings.append("receipt row is not an object: %r" % (receipt,))
            continue
        rid = receipt.get("receipt_id") or receipt.get("episode_uuid") or "<no-id>"
        status = receipt.get("status")
        attempts = receipt.get("attempts")
        age = age_seconds(receipt, observed_at)
        account = {
            "receipt_id": rid,
            "group_id": receipt.get("group_id"),
            "status": status,
            "attempts": attempts,
            "last_error": receipt.get("last_error"),
            "age_seconds": None if age is None else round(age, 1),
        }
        accounts.append(account)
        if status == "retrying":
            over_a = isinstance(attempts, (int, float)) and not isinstance(attempts, bool)
            over_a = bool(over_a) and attempts > max_attempts
            over_g = age is not None and age > max_age
            if over_a or over_g:
                why = []
                if over_a:
                    why.append("attempts %s > %s" % (attempts, max_attempts))
                if over_g:
                    why.append("age_seconds %.0f > %.0f" % (age, max_age))
                breaches.append({
                    "receipt_id": rid,
                    "group_id": account["group_id"],
                    "attempts": attempts,
                    "age_seconds": account["age_seconds"],
                    "last_error": account["last_error"],
                    "because": " and ".join(why),
                })
    # The face's own scalar is the one breach signal that survives a bounded
    # window: it is computed by the surface, not by the rows we were handed.
    # Weigh it. If it says a non-terminal receipt is older than the budget
    # while the window carries no non-terminal row at all, the reading
    # contradicts itself and cannot certify a clean answer -- that is an
    # unreliable reading (exit 2), never a pass.
    scalar = reading.get("oldest_pending_seconds")
    scalar_usable = (isinstance(scalar, (int, float))
                     and not isinstance(scalar, bool))
    any_over_budget = any(a["age_seconds"] is not None and a["age_seconds"] > max_age
                          for a in accounts) if accounts else False
    nonterminal_rows = any(str(a["status"]) not in TERMINAL for a in accounts)
    # Weigh the scalar whether or not the window happens to hold some other
    # non-terminal row: a fresh pending row must not mask a much older receipt
    # the face says exists outside the window. Only a row that is ITSELF over
    # budget can account for the scalar.
    if scalar_usable and float(scalar) > max_age and not any_over_budget:
        findings.append(
            "oldest_pending_seconds %.0f exceeds budget %.0f but no judged row is "
            "itself over budget: the face reports a non-terminal receipt older than "
            "the retry budget that this window cannot name, so a clean answer cannot "
            "be certified" % (float(scalar), max_age))
    if reading.get("worker_running") is not True:
        findings.append("worker_running is %r, not true" % (reading.get("worker_running"),))
    accounts.sort(key=lambda a: (-(a["attempts"]
                    if isinstance(a["attempts"], (int, float)) and not isinstance(a["attempts"], bool)
                    else -1), str(a["receipt_id"])))
    return accounts, breaches, findings


def emit(status_code, payload, breaches, findings, json_path=None):
    print("intakewatch on the memory intake status face: exit %d" % status_code)
    print("")
    print(json.dumps(payload, sort_keys=True))
    if json_path:
        try:
            parent = os.path.dirname(json_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(json_path, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, sort_keys=True, indent=2) + "\n")
        except Exception as exc:
            print("intakewatch: could not write %s: %s" % (json_path, exc),
                  file=sys.stderr)
    for breach in breaches:
        print("STUCK %s group=%s attempts=%s age_seconds=%s last_error=%s because %s"
              % (breach["receipt_id"], breach["group_id"], breach["attempts"],
                 breach["age_seconds"], breach["last_error"], breach["because"]),
              file=sys.stderr)
    for finding in findings:
        print("FINDING %s" % finding, file=sys.stderr)


def _leaps_before(y):
    """Leap days strictly before 1 Jan of year y (proleptic Gregorian)."""
    return (y - 1) // 4 - (y - 1) // 100 + (y - 1) // 400


_DAYS_BEFORE_MONTH = (0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334)


def _days_from_civil(year, month, day):
    """Days from 1970-01-01 to a civil date, counted without any calendar object."""
    base = 1970 * 365 + _leaps_before(1970) + 1
    leap_extra = 1 if (month > 2 and year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 0
    return (year * 365 + _leaps_before(year) + _DAYS_BEFORE_MONTH[month - 1] + day
            + leap_extra - base)


def _epoch_arg(value):
    """Accept epoch seconds OR an ISO-8601 stamp.

    The fleet's captures are stamped ISO (2026-10-27T14:45:00Z) and that is the
    form an agent already holds, so requiring a bare float made the documented
    consumer path exit 2 on `invalid float value`. Epoch floats keep working
    exactly as before; the ISO branch is purely additive. Validated against
    three independent (capture filename stamp, recorded captured_at) pairs from
    evidence/*.provenance.json, agreeing within the stamp-to-capture lag, and
    against the 1970 and 2000 epoch anchors exactly.
    """
    if value is None:
        return None
    text = str(value).strip()
    try:
        return float(text)
    except ValueError:
        pass
    offset = 0
    fraction = 0.0
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1]
    else:
        for sign_char in ("+", "-"):
            at = text.find(sign_char, 10)
            if at > 0:
                digits = text[at + 1:].replace(":", "")
                offset = ((-1 if sign_char == "-" else 1)
                         * (int(digits[0:2]) * 3600 + int(digits[2:4]) * 60 if len(digits) >= 4
                            else int(digits[0:2]) * 3600))
                text = text[:at]
                break
    dot = text.find(".", 19)
    if dot > 0:
        fraction = float(text[dot:])
        text = text[:dot]
    try:
        year = int(text[0:4]); month = int(text[5:7]); day = int(text[8:10])
        hour = int(text[11:13]); minute = int(text[14:16]); second = int(text[17:19])
    except (ValueError, IndexError):
        raise argparse.ArgumentError(
            "expected epoch seconds or an ISO-8601 stamp, got %r" % (value,))
    if not (1 <= month <= 12 and 1 <= day <= 31 and hour <= 23 and minute <= 59 and second <= 60):
        raise argparse.ArgumentError("stamp %r is out of range" % (value,))
    return (_days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60
            + second - fraction - offset)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="intakewatch")
    ap.add_argument("--input", required=True,
                    help="recorded intake-status reading (json), or - for stdin")
    ap.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    ap.add_argument("--max-age-seconds", type=float, default=DEFAULT_MAX_AGE_SECONDS)
    ap.add_argument("--observed-at", type=_epoch_arg, default=None,
                    help="epoch seconds the reading was taken; defaults to the reading stamp")
    ap.add_argument("--json", default=None, help="optional path for the machine result")
    ap.add_argument("--max-input-age-seconds", type=float,
                    default=DEFAULT_MAX_INPUT_AGE_SECONDS,
                    help="how old the judged reading may be before the run refuses to "
                    "certify it as a reading of the live face (default 3600; 0 disables)")
    ap.add_argument("--provenance", default=None,
                    help="explicit provenance record to bind --input to; required for a "
                    "stream input such as -, where no sibling record can be found")
    ap.add_argument("--allow-frozen-capture", action="store_true",
                    help="audit an archived reading on purpose: report, rather than fail on, "
                    "a missing or stale provenance binding")
    ap.add_argument("--captured-at", type=_epoch_arg, default=None,
                    help="epoch seconds the reading was taken from the surface; set by "
                    "the capturing step, never inferred at judgement time")
    ap.add_argument("--capture-limit", type=int, default=None,
                    help="the limit the capture call was given, recorded into the "
                    "provenance sidecar so a later judgement knows the width of the "
                    "window it is reconciling instead of assuming the surface default")
    ap.add_argument("--record-provenance", default=None, nargs="?",
                    const=BARE_RECORD_PROVENANCE,
                    help="path to write the provenance record for --input into, before "
                    "judging. this is a WRITER that needs a path, not a boolean flag: to bind "
                    "a fresh reading, run capture_intake_status.py right after the tool call. "
                    "passing it bare is refused with a structured remedy, not a usage dump")
    args = ap.parse_args(argv)

    if args.record_provenance is BARE_RECORD_PROVENANCE:
        # Measured consumer trap: this flag is a writer that needs a path, but its
        # help once read "used by capture_intake_status.py", so a caller passed it
        # bare and argparse died on the missing value, printing a usage dump with
        # no status, no reason and no remedy. Refuse it as a finding instead.
        emit(2, {"check": "intakewatch", "schema": "intakewatch/v1",
                  "surface": "conversation-graph memory intake (" + EXPECTED_SOURCE_TOOL + ")",
                  "input": args.input, "status": "usage_defect",
                  "provenance_fault": "record_provenance_needs_a_path",
                  "reason": "--record-provenance is a WRITER: it takes the path to write the "
                  "provenance record to, so it cannot be passed bare. it never binds a "
                  "reading that was captured earlier",
                  "stuck_receipt_count": None,
                  "remedy": {"next_call": "mcp.get_ingestion_status(limit=%d)"
                             % VERIFIED_COVERING_LIMIT,
                             "suggested_limit": VERIFIED_COVERING_LIMIT,
                             "capture_command": "mcp.get_ingestion_status(limit=%d) | "
                             "python3 capture_intake_status.py --out <path> --limit %d "
                             "--captured-at <now-iso>" % (VERIFIED_COVERING_LIMIT,
                                                          VERIFIED_COVERING_LIMIT),
                             "meaning": "to judge a live reading, capture it through "
                             "capture_intake_status.py right after the tool call and judge "
                             "those bytes; to audit an archived reading on purpose, drop "
                             "--record-provenance and pass --allow-frozen-capture, which "
                             "waives freshness only and never a digest or source mismatch"},
                  "note": "a usage defect is reported with a remedy, never as a usage dump"},
             [], [], json_path=args.json)
        return 2

    sink = {}
    reading, err = load_reading(args.input, sink)
    if err is not None:
        emit(2, {"check": "intakewatch", "schema": "intakewatch/v1",
                  "surface": "conversation-graph memory intake (mcp.get_ingestion_status)",
                  "input": args.input, "status": "surface_unavailable", "reason": err,
                  "stuck_receipt_count": None,
                  "remedy": {"next_call": "mcp.get_ingestion_status(limit=%d)"
                             % VERIFIED_COVERING_LIMIT,
                             "suggested_limit": VERIFIED_COVERING_LIMIT,
                             "capture_command": "mcp.get_ingestion_status(limit=%d) | "
                             "python3 capture_intake_status.py --out <path> --limit %d "
                             "--captured-at <now-iso>" % (VERIFIED_COVERING_LIMIT,
                                                           VERIFIED_COVERING_LIMIT),
                             "meaning": "the judged bytes were not a usable reading; "
                             "capture a fresh one at the named width and judge that"},
                  "note": "unavailable is a finding, never a pass"}, [], [], json_path=args.json)
        return 2

    # The capture step records the width it asked the face for; read it once, here,
    # so both the window reconciliation and the coverage account judge the window
    # at the width it actually was rather than at an assumed default.
    recorded_limit = recorded_window_limit(args.input, args.provenance)

    observed_at = args.observed_at
    if observed_at is None:
        observed_at = reading.get("observed_at") or reading.get("observedAt")
    if not isinstance(observed_at, (int, float)) or isinstance(observed_at, bool):
        newest = [r.get("updated_at") for r in reading["receipts"]
                  if isinstance(r, dict) and isinstance(r.get("updated_at"), (int, float))]
        observed_at = max(newest) if newest else None
    if not isinstance(observed_at, (int, float)) or isinstance(observed_at, bool):
        emit(2, {"check": "intakewatch", "schema": "intakewatch/v1",
                  "input": args.input, "status": "surface_unavailable",
                  "reason": "reading carries no observation stamp (observed_at) and no receipt updated_at",
                  "stuck_receipt_count": None,
                  "remedy": build_remedy(reading, "no_observation_stamp", recorded_limit,
                                         args.max_attempts, args.max_age_seconds),
                  "note": "unavailable is a finding, never a pass; re-capture with "
                          "--captured-at so ages are measured from the capture, not guessed"}, [], [], json_path=args.json)
        return 2

    window_limit = recorded_limit if isinstance(recorded_limit, int) \
        and recorded_limit > 0 else WINDOW_LIMIT
    fault_code, fault_reason = window_fault(reading, args.max_age_seconds,
                                             window_limit=window_limit)
    if fault_code is not None:
        emit(2, {"check": "intakewatch", "schema": "intakewatch/v1",
                  "input": args.input, "status": "surface_unavailable",
                  "window_fault": fault_code, "reason": fault_reason,
                  "counts": reading.get("counts"),
                  "coverage": {"status": "unverified", "basis": "the window failed "
                              "reconciliation, so no coverage claim is made"},
                  "stuck_receipt_count": None,
                  "remedy": build_remedy(reading, fault_code, recorded_limit,
                                         args.max_attempts, args.max_age_seconds),
                  "note": "an incomplete reading is reported, never passed over; the "
                          "remedy names the wider call that makes a judgement "
                          "certifiable"}, [], [], json_path=args.json)
        return 2

    now = time.time()
    if args.record_provenance:
        try:
            rec_parent = os.path.dirname(args.record_provenance)
            if rec_parent:
                os.makedirs(rec_parent, exist_ok=True)
            stamp_for_record = args.captured_at
            if not isinstance(stamp_for_record, (int, float)) or isinstance(stamp_for_record, bool):
                stamp_for_record = reading.get("observed_at")
            if not isinstance(stamp_for_record, (int, float)) or isinstance(stamp_for_record, bool):
                stamp_for_record = now
            with open(args.record_provenance, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "schema": "intakewatch-provenance/v1",
                    "captured_by": "fleet-inventor",
                    "captured_at": float(stamp_for_record),
                    "received_at": float(now),
                    "source_tool": EXPECTED_SOURCE_TOOL,
                    "source_kind": "mcp-tool-response",
                    "tool_arguments": {"limit": args.capture_limit
                                       if isinstance(args.capture_limit, int)
                                       else WINDOW_LIMIT},
                    "url": None,
                    "url_reason": "the intake face is an MCP tool surface with no HTTP route; "
                                 "no browser capture url exists for it",
                    "verifier_check": "call " + EXPECTED_SOURCE_TOOL + " and confirm the judged "
                                      "counts and per-receipt attempts match the judged bytes",
                    "sha256": (hashlib.sha256(sink["raw"]).hexdigest()
                              if isinstance(sink.get("raw"), bytes)
                              else sha256_of(args.input)),
                    "input": args.input,
                }, sort_keys=True, indent=2) + chr(10))
        except Exception as exc:
            print("intakewatch: could not write provenance record %s: %s"
                  % (args.record_provenance, exc), file=sys.stderr)

    waived_note = (None, None)
    prov, prov_fault = bind_provenance(args.input, reading,
                                       args.max_input_age_seconds, now,
                                       raw=sink.get("raw"), record_path=args.provenance)
    if args.allow_frozen_capture:
        # The waiver exists so an ARCHIVED reading can be audited on purpose after
        # its freshness window closes. It waives freshness only. A digest or
        # source-binding failure means the bytes are not the bytes the capture
        # claims to be, and waiving that would let the flag that makes a
        # committed capture auditable also disable the anti-forgery check.
        FROZEN_WAIVABLE = ("reading_stale", "reading_from_the_future")
        if prov_fault is not None and prov_fault[0] in FROZEN_WAIVABLE:
            findings_frozen = prov_fault
            prov = prov or {"record": None, "status": "waived"}
            prov["status"] = "waived"
            prov["waived_fault"] = findings_frozen[0]
            prov["waived_reason"] = findings_frozen[1]

            waived_note = (findings_frozen[0], findings_frozen[1])
            prov_fault = None
        elif prov_fault is not None:
            prov = prov or {"record": None, "status": "unbound"}
            prov["status"] = "unbound"
            prov["unwaivable_fault"] = prov_fault[0]

    if prov_fault is not None:
        fault_code, fault_reason = prov_fault
        emit(2, {"check": "intakewatch", "schema": "intakewatch/v1",
                  "surface": "conversation-graph memory intake (" + EXPECTED_SOURCE_TOOL + ")",
                  "input": args.input, "status": "provenance_unverified",
                  "provenance_fault": fault_code, "reason": fault_reason,
                  "provenance": prov,
                  "stuck_receipt_count": None,
                  "remedy": {"next_call": "mcp.get_ingestion_status(limit=%d)"
                             % VERIFIED_COVERING_LIMIT,
                             "suggested_limit": VERIFIED_COVERING_LIMIT,
                             "capture_command": "mcp.get_ingestion_status(limit=%d) | "
                             "python3 capture_intake_status.py --out <path> --limit %d "
                             "--captured-at <now-iso>" % (VERIFIED_COVERING_LIMIT,
                                                           VERIFIED_COVERING_LIMIT),
                             "meaning": "re-capture through capture_intake_status.py so the "
                             "bytes carry a provenance sidecar, or pass --provenance; "
                             "--allow-frozen-capture waives an archived reading's freshness "
                             "on purpose but never waives a digest or source mismatch"},
                  "note": "an unbound reading is reported, never passed over as a judgement "
                         "of the live face"}, [], [], json_path=args.json)
        return 2

    accounts, breaches, findings = observe(reading, args.max_attempts,
                                            args.max_age_seconds, float(observed_at))
    effective_limit = recorded_limit if isinstance(recorded_limit, int) \
        and not isinstance(recorded_limit, bool) and recorded_limit > 0 else None
    if waived_note[0] is not None:
        findings.append("frozen capture audited on purpose: " + waived_note[0]
                        + " - " + waived_note[1])
    scalar = reading.get("oldest_pending_seconds")
    scalar_breach = (isinstance(scalar, (int, float)) and not isinstance(scalar, bool)
                     and float(scalar) > args.max_age_seconds)
    if scalar_breach:
        findings.append(
            "oldest_pending_seconds %.0f exceeds budget %.0f: the face itself reports a "
            "non-terminal receipt older than the retry budget"
            % (float(scalar), args.max_age_seconds))
    if breaches:
        status = "stuck_receipts"
    elif scalar_breach:
        # A breach the bounded window can see but no row can name is still a breach.
        status = "stuck_unwindowed"
    elif reading.get("worker_running") is not True:
        status = "worker_unhealthy"
    elif waived_note[0] is not None:
        # A frozen capture audited on purpose is never a clean bill for the live
        # face, so it stays non-zero -- but it is not a worker fault either.
        status = "frozen_audit"
    else:
        status = "ok"

    payload = {
        "check": "intakewatch", "schema": "intakewatch/v1",
        "surface": "conversation-graph memory intake (mcp.get_ingestion_status)",
        "input": args.input, "observed_at": float(observed_at),
        "budget": {"max_attempts": args.max_attempts, "max_age_seconds": args.max_age_seconds},
        "counts": reading.get("counts"),
        "coverage": coverage_account(reading, effective_limit),
        "worker_running": reading.get("worker_running"),
        "oldest_pending_seconds": reading.get("oldest_pending_seconds"),
        "receipts_seen": len(accounts),
        "stuck_receipt_count": len(breaches),
        "stuck_receipt_ids": [b["receipt_id"] for b in breaches],
        "findings": findings, "status": status, "receipts": accounts,
        "provenance": prov,
        "cause_claim": "none - this check names stuck receipts and reports no root cause",
    }
    code = 1 if status != "ok" else 0
    emit(code, payload, breaches, findings, json_path=args.json)
    return code


if __name__ == "__main__":
    sys.exit(main())
