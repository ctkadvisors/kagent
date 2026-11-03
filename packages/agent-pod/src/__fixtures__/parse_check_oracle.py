# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Chris Knuteson
"""Run the unchanged protected checks.py fixture with only its forum dependency isolated."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import types
sys.dont_write_bytecode = True
package = types.ModuleType("oracle")
package.__path__ = []
sys.modules["oracle"] = package
forum = types.ModuleType("oracle.forum_source")
# Exact authority.forum_source exit predicate; other forum I/O is unused by parse.
forum.EXIT_LINE = re.compile(r": exit (\d+)\b")
def exit_status(body):
    first = body.split("\n", 1)[0] if isinstance(body, str) else ""
    match = forum.EXIT_LINE.search(first)
    return int(match.group(1)) if match else None
forum.exit_status = exit_status
sys.modules["oracle.forum_source"] = forum
spec = importlib.util.spec_from_file_location("oracle.checks", Path(__file__).with_name("authority_checks_20261103.py"))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
print(json.dumps([checks.parse("fixture", body, 0, 0) for body in json.load(sys.stdin)]))
