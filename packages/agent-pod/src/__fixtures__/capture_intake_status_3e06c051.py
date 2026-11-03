#!/usr/bin/env python3
"""capture_intake_status - record a live reading of the memory intake face, with provenance.

intakewatch judges a RECORDED reading, so the recording step is where provenance is
earned. The agent calls mcp.get_ingestion_status and pipes the tool response here,
byte for byte, right after the call; this tool never fabricates a reading and never
reaches the surface itself. It writes the judged bytes plus a sibling provenance
record binding them by sha256 and by the time the capture was received.

  mcp.get_ingestion_status(limit=20)  ->  stdout | python3 capture_intake_status.py \
        --out evidence/intake-status-<utc>.json --group fleet-audit
"""
import argparse
import hashlib
import json
import os
import sys
import time

SOURCE_TOOL = "mcp.get_ingestion_status"


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
    ap = argparse.ArgumentParser(prog="capture-intake-status")
    ap.add_argument("--out", required=True, help="path for the judged reading")
    ap.add_argument("--group", default=None, help="group the call was scoped to")
    ap.add_argument("--limit", type=int, default=20, help="limit the call was given")
    ap.add_argument("--captured-by", default="fleet-inventor")
    ap.add_argument("--raw", default=None,
                    help="read the recorded tool response from this file instead of stdin; "
                    "lets a run judge a staged capture in one command (the bytes must be the "
                    "verbatim response the caller received)")
    ap.add_argument("--captured-at", type=_epoch_arg, default=None,
                    help="epoch seconds the response was received; set it at the moment of the "
                    "tool call, not later, so the freshness bound stays honest")
    args = ap.parse_args(argv)

    if args.raw is not None:
        try:
            with open(args.raw, "rb") as handle:
                raw = handle.read()
        except Exception as exc:
            print("capture-intake-status: cannot read --raw %s: %s" % (args.raw, exc),
                  file=sys.stderr)
            return 2
    else:
        raw = sys.stdin.buffer.read()
    if not raw or not raw.strip():
        print("capture-intake-status: stdin carried no bytes; refusing to write a reading",
              file=sys.stderr)
        return 2
    try:
        reading = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        print("capture-intake-status: stdin is not the json tool response (%s); refusing" % exc,
              file=sys.stderr)
        return 2
    if not isinstance(reading, dict) or not isinstance(reading.get("receipts"), list):
        print("capture-intake-status: response carries no receipts list; refusing", file=sys.stderr)
        return 2

    captured_at = args.captured_at if isinstance(args.captured_at, float) else time.time()
    parent = os.path.dirname(args.out)
    if parent:
        os.makedirs(parent, exist_ok=True)
    payload = raw.decode("utf-8")
    if not payload.endswith(chr(10)):
        payload += chr(10)
    written = payload.encode("utf-8")
    with open(args.out, "wb") as handle:
        handle.write(written)
    # digest the bytes actually on disk: hashing pre-normalisation stdin made a
    # capture that needed a trailing newline self-inflict provenance_digest_mismatch
    digest = hashlib.sha256(written).hexdigest()

    record = {
        "schema": "intakewatch-provenance/v1",
        "captured_by": args.captured_by,
        "captured_at": captured_at,
        "received_at": captured_at,
        "source_tool": SOURCE_TOOL,
        "source_kind": "mcp-tool-response",
        "tool_arguments": {"limit": args.limit, "group_id": args.group},
        "url": None,
        "url_reason": "the intake face is an MCP tool surface with no HTTP route; no browser "
                      "capture url exists for it, so the verifier re-measures the surface",
        "verifier_check": "call " + SOURCE_TOOL + " with the same tool_arguments and confirm the "
                         "judged counts and per-receipt attempts match these bytes",
        "sha256": digest,
        "input": args.out,
        "counts": reading.get("counts"),
        "worker_running": reading.get("worker_running"),
    }
    rec_path = args.out + ".provenance.json"
    with open(rec_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, indent=2) + chr(10))
    print(json.dumps({"captured": args.out, "provenance": rec_path, "sha256": digest,
                      "counts": reading.get("counts"), "bytes": len(written)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
