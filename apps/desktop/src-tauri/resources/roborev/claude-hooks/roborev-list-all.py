#!/usr/bin/env python3
"""`roborev list --all`, seed-side — the MACHINE-WIDE open fail-verdict backlog
that the real `roborev list` CLI can't produce (it's scoped to one repo+branch).

roborev is a pinned upstream release binary with no source here, so there's no
real `--all` subcommand to add. This standalone helper fills that gap by reading
the daemon's store (`~/.roborev/reviews.db`) directly, read-only, and printing
every job with an UNCLOSED FAIL review across ALL repos and branches (one
deduped row per open-FAIL job) — ephemeral fixture repos (under /tmp etc.)
filtered out as noise.

It reuses `open_fail_backlog()` / `format_backlog_summary()` from the shared
`_roborev_hooklib`, so its definition of "open finding" (`verdict_bool = 0 AND
closed = 0`) can never drift from the pre-commit bridge / pre-push gate, which
gate on the same predicate over the CLI's `verdict == "F" && !closed` rows.

Usage:
  roborev-list-all.py            # human-readable repo  branch  count/ids backlog
  roborev-list-all.py --json     # the raw [{repo, root_path, branch, id}] rows

Every `id` it prints (both surfaces) is a JOB id — pass it straight to
`roborev show/close/comment <id>`.

Exit status: 0 on a clean read (including an empty backlog), 1 if the DB can't
be read (missing/locked/schema-drift) — distinct so a wrapper can tell "all
clear" from "couldn't look." This is an exploration aid for the cross-branch
backlog sweep; it never blocks anything."""
from __future__ import annotations

import json
import sys

from _roborev_hooklib import open_fail_backlog, format_backlog_summary


def main(argv: list[str]) -> int:
    as_json = "--json" in argv[1:]
    backlog = open_fail_backlog()
    if backlog is None:
        print(
            "roborev backlog: could not read ~/.roborev/reviews.db "
            "(missing, locked, or schema drift) — check `roborev status`.",
            file=sys.stderr,
        )
        return 1
    if as_json:
        print(json.dumps(backlog))
        return 0
    if not backlog:
        print("roborev backlog: 0 open FAIL jobs machine-wide. All clear.")
        return 0
    print(format_backlog_summary(backlog))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
