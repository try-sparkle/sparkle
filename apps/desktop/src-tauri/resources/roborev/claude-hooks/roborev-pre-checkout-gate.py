#!/usr/bin/env python3
"""PreToolUse[Bash] gate — DENY a Claude-initiated branch SWITCH
(`git checkout <branch>` / `git switch <branch>`, incl. `-b`/`-B`/`-c`/`-C`
create-and-switch and `git checkout -`) while the branch you're LEAVING has open
roborev `verdict=F` reviews. It closes the enforcement gap the pre-push gate
leaves: the push gate is per-push-per-current-branch, so a `verdict=F` strands
the moment you move off the branch — invisible until you check it back out
(SEED.md ## Open, "Branch-scoping orphans open findings"). This turns the prose
"drain before switching" rule into a forcing function.

Counterpart to roborev-pre-push-gate.py, anchored to the branch you're ON NOW
(the one the switch LEAVES) instead of the push target. Shares the SAME command
discovery, list, and outstanding-finding definition (`_is_open_fail` /
`_list_jobs`) via `_roborev_hooklib`, so the three surfaces can never disagree on
what counts as an open finding.

What gets gated vs. not (full rationale in `_is_branch_switch_args`):
  - GATED   — `git switch <b>`, `git switch -c|-C <new>`, `git checkout <b>`,
              `git checkout -b|-B <new>`, `git checkout -` (previous branch),
              and a bare `git checkout <oneword>` (read as a branch ref).
  - ALLOWED — `git checkout -- <path>`, `git checkout <ref> -- <path>`,
              `git checkout .`, `git checkout <a> <b>` (≥2 operands = pathspec),
              `git restore …` (never a branch op), and the bare no-operand
              `git checkout` / `git switch` (no destination → not a switch).
  When a bare single arg is ambiguous (branch vs. file) we GATE — a safe
  over-block (the agent restores via `git restore` / `git checkout -- f`, which
  aren't gated), never an under-gate that lets a real switch strand findings.

Unlike the push gate, this gate does NOT wait on in-flight reviews — but it does
DENY while any remain (fail-safe), rather than waiting them out. A checkout
exports nothing, so blocking-then-retry is cheaper than stalling the switch on
the daemon for up to the wait timeout; and an in-flight review that lands
`verdict=F` AFTER the agent switched away would strand exactly as this gate
exists to prevent. So the gate denies on EITHER a confirmed terminal `verdict=F`
OR an unfinished (non-terminal, unclosed) review on the leaving branch, telling
the agent to `roborev wait` for the in-flight ones and re-try the switch once the
branch is drained. Reviews that finished clean (PASS) or were `roborev close`d
never block. The push gate waits-then-rechecks because a push must not be
deferred indefinitely; a branch switch can simply be retried, so the simpler
no-wait deny suffices here.

ALLOWS (no-op) on anything that isn't a real branch-switching segment, on a
detached HEAD (no leaving-branch to scope to), and when roborev / git / the repo
can't be resolved (best-effort fail-OPEN — a broken dev install must not wedge
every branch switch; the commit bridge + verify.sh own that loud signal). It
also fails OPEN on an unreadable `roborev list` — DISTINCT from the push gate,
which fails CLOSED there: a push is the export boundary (an unreadable state must
not let unreviewed code leave), but a blocked checkout strands no code and a
wedged daemon blocking every branch switch is worse than letting one switch
through (the findings are still on the branch, surfaced again on the next
commit/push). Claude-Code-only, same scope as the push gate.

Scope limit (shared with the push gate, by design): a chained
`git commit && git switch other` in ONE Bash call is NOT gated for that call.
PreToolUse fires once, before the string runs, so the new commit's review isn't
enqueued yet — there's nothing for `_list_jobs` to see. The strand is
self-healing: the post-commit review lands on the (now-left) branch and is
caught on the NEXT switch attempt off it, the commit bridge surfaces it on the
next commit, and the push gate blocks the eventual push. Detecting a trailing
switch after a commit segment isn't worth the segment-ordering parser
complexity for a bypass that's trivially available anyway (just run the two
commands separately) — the push gate declined the identical
`git commit && git push` case for the same reason; keeping the two gates'
command-parsing stance identical is the point of the shared `_roborev_hooklib`.
"""
from __future__ import annotations

import json
import os
import sys

from _roborev_hooklib import (
    _branch_switch_cwd,
    _find_roborev,
    _inside_git_repo,
    _current_branch,
    _git_toplevel,
    _list_jobs,
    _is_open_fail,
    _in_flight,
    _deny,
)


def _allow() -> int:
    return 0  # exit 0, no stdout → normal permission flow proceeds


def _format_block(branch: str, jobs: list[dict]) -> str:
    lines = [
        f"Branch switch blocked: {len(jobs)} open roborev fail-verdict "
        f"review(s) on the branch you're LEAVING ({branch!r}) must be addressed "
        "first — switching away would strand them (they go invisible until you "
        "check this branch back out).",
        "",
    ]
    # Drifted open-fail rows (null/non-int id) still display usefully — fall back
    # to the short git_ref, matching the push gate's _format_block.
    for j in jobs:
        jid = j.get("id")
        ref = f"#{jid}" if isinstance(jid, int) else f"@{str(j.get('git_ref', '') or '?')[:8]}"
        lines.append(f"  - review {ref} (FAIL)")
    lines += [
        "",
        "Drain this branch BEFORE switching — `roborev list --open` on it, then "
        "resolve every open fail-verdict review with judgment per finding (do "
        "NOT clear them with `roborev refine`/`roborev fix`, which auto-apply "
        "findings without the valid-vs-YAGNI judgment):",
        "  1. `roborev show --job <id>` — read the findings.",
        "  2. VALID finding: fix it in a new commit on THIS branch, then "
        "`roborev close <id>`.",
        "  3. INVALID / YAGNI finding: `roborev comment <id> -m \"<why declined>\"` "
        "then `roborev close <id>`.",
        "",
        "Re-run the switch once no open fail-verdict reviews remain on this branch.",
    ]
    return "\n".join(lines)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return _allow()
    if payload.get("tool_name") != "Bash":
        return _allow()
    cmd = (payload.get("tool_input") or {}).get("command", "")
    fallback_cwd = payload.get("cwd") or os.getcwd()
    sw = _branch_switch_cwd(cmd, fallback_cwd)
    if sw is None:
        return _allow()  # not a real branch switch
    cwd, is_create = sw
    if is_create:
        # Create-and-switch (`-b`/`-B`/`-c`/`-C`): the target is a brand-new (or
        # force-reset) branch with no findings of its own, and blocking it on the
        # LEAVING branch's findings is bead sparkle-0614's P0 (a parked checkout's
        # stale findings wedged every fresh-branch creation). Allow — the leaving
        # branch's findings still surface via the commit-context hook, the push
        # gate, and the machine-wide backlog; the export boundary stays gated.
        return _allow()
    if not _inside_git_repo(cwd):
        return _allow()  # not in a repo
    branch = _current_branch(cwd)
    repo_root = _git_toplevel(cwd)
    if not branch or not repo_root:
        return _allow()  # detached HEAD / unresolvable repo → no leaving-branch
                         # to scope to; nothing to strand (see module docstring).
    roborev = _find_roborev()
    if roborev is None:
        return _allow()  # broken dev install → don't wedge every branch switch.

    jobs = _list_jobs(roborev, repo_root, branch)
    if jobs is None:
        return _allow()  # unreadable list → fail OPEN (see module docstring;
                         # the push gate fails CLOSED here, the checkout gate does
                         # NOT — a blocked switch strands no code).
    # Confirmed terminal fails first — they can't be cleared by waiting, so name
    # them directly rather than rolling them into the in-flight message.
    outstanding = [j for j in jobs if _is_open_fail(j)]
    if outstanding:
        return _deny(_format_block(branch, outstanding))
    # Then in-flight (non-terminal, unclosed) reviews: one that lands `verdict=F`
    # AFTER the switch would strand exactly as this gate prevents. We don't wait
    # (a switch is cheap to retry, unlike a push) — deny and tell the agent to
    # `roborev wait` and re-try once the branch is drained.
    flight = _in_flight(jobs)
    if flight:
        n = len(flight)
        return _deny(
            f"Branch switch blocked: {n} roborev review(s) on the branch you're "
            f"LEAVING ({branch!r}) are still in flight — one could land "
            "verdict=F after you've switched away and strand the finding. "
            "`roborev wait` for them to finish, resolve any fail-verdict ones "
            "(`roborev list --open` → fix-then-close or comment-then-close), then "
            "re-run the switch."
        )
    return _allow()


if __name__ == "__main__":
    sys.exit(main())
