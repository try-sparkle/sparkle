#!/usr/bin/env python3
"""PreToolUse[Bash] gate — DENY a Claude-initiated `git push` while the current
branch has outstanding roborev fail-verdict reviews, so findings get fixed or
acknowledged before code leaves the machine instead of accumulating unseen.

This is the deny-surface counterpart to roborev-pre-commit-context.py (the
warn-surface). The split is deliberate:

  - commit is too frequent + too early to block — you commit small and often
    while reviews run async, so the commit hook only WARNS (surfaces findings);
  - push is the export boundary — the right altitude for a hard gate. The deny
    isn't a security boundary (it's trivially bypassable on a box you control);
    it's a forcing function against the *silent-forget* failure mode: pushing
    over a `verdict=F` review you never looked at. It converts "forgot" into
    "consciously fixed it, or `roborev close`'d it."

Both surfaces import the SAME command parser, discovery, and outstanding-finding
definition (`_is_open_fail` / `_list_jobs`) from `_roborev_hooklib`, so they can
never disagree on what counts as an open finding.

ALLOWS (no-op) on anything that isn't a real `git ... push` segment, or when
roborev / git / the repo can't be resolved (best-effort; a broken dev install
must not wedge every push — the commit hook + verify.sh own that loud signal).
It DENIES on (a) a confirmed open fail-verdict review, (b) in-flight reviews
that exceed the wait timeout, or (c) a review still in flight after the wait
(fail-closed — an unreviewed push can't slip through). Before denying on
in-flight work it first waits up to 600s for queued/running reviews to finish,
because commit→push-immediately is the normal flow and the daemon needs a moment
to catch up. (The SEED post-commit hook
enqueues synchronously — the review row is listable before control returns — so
a just-committed HEAD shows up as in-flight, not as an empty list.)

Scope limits (by design, not gaps):
  - Detached HEAD → allow. With no branch there's nothing to scope
    `roborev list --branch` to; denying would block every detached-HEAD push,
    including in repos roborev doesn't track. Branch-scoped gating simply
    doesn't apply.
  - A chained `git commit && git push` in ONE Bash call → not gated for that
    call: PreToolUse fires once, before the string runs, so the new commit (and
    its review) doesn't exist yet. Caught on the next standalone push once the
    review lands. Detecting a trailing push after a commit segment isn't worth
    the parser complexity for a bypass that's trivially available anyway.
  - Claude-Code-only: codex/human pushes aren't gated — this seed's purpose is
    teaching the Claude Code agent the review loop.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

from _roborev_hooklib import (
    _push_cwd_and_branch,
    _find_roborev,
    _inside_git_repo,
    _current_branch,
    _git_toplevel,
    _list_jobs,
    _is_open_fail,
    _in_flight,
    _deny,
    _emit_hook,
    _git_stdout,
    open_fail_backlog,
    format_backlog_summary,
    chained_steps_around_push,
    format_skipped_steps,
    BACKLOG_NOTICE_MAX_ROWS,
    BACKLOG_NOTICE_MAX_IDS,
)

# How long to wait for in-flight reviews. Fixed — under the installer's
# registered 660s hook timeout, so the timeout-deny JSON always emits before
# Claude Code kills the hook. Not configurable: no env read, so no mistyped
# value can crash the hook before _deny() and no >660 value can get the deny
# killed mid-wait.
WAIT_TIMEOUT_SECS = 600


def _list_fail_reason(cmd: str) -> str:
    """The fail-closed deny (review state unreadable), with the chained steps
    that never ran named — same skipped-step surface as `_format_block`, since
    this deny blocks the whole invocation exactly as hard as that one does."""
    lines = [
        "Push blocked: couldn't determine roborev review state — `roborev list` "
        "failed (timed out, errored, or returned unparseable output). The gate is "
        "fail-closed: a wedged daemon must not be mistaken for 'no open findings'. "
        "Check `roborev status`, then re-run the push. Note: this hook denied the "
        "ENTIRE Bash command before it ran, so a chained `git commit && git push` "
        "did NOT commit — run the earlier steps separately first.",
    ]
    skipped = format_skipped_steps(*chained_steps_around_push(cmd))
    if skipped:
        lines += ["", *skipped]
    return "\n".join(lines)


def _allow() -> int:
    return 0  # exit 0, no stdout → normal permission flow proceeds


def _current_roots(cwd: str, repo_root: str) -> set[str]:
    """The repo roots that mean "the checkout being pushed", for marking/sorting
    the backlog notice. Two of them, because a WORKTREE's `--show-toplevel` is
    the worktree path while the daemon registered the repo by its MAIN checkout;
    matching only one would leave every agent worktree unable to recognise its
    own repo's rows. Best-effort — a failed git call just yields fewer keys, and
    the notice degrades to "no repo marked", never to an error."""
    roots = {repo_root} if repo_root else set()
    common = _git_stdout(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common.endswith("/.git"):
        roots.add(common[: -len("/.git")])
    return roots


def _allow_with_backlog(cwd: str = "", repo_root: str = "") -> int:
    """The happy-path allow: this branch is clear (current-branch deny already
    ruled out), so surface the MACHINE-WIDE open-FAIL backlog as non-blocking
    `additionalContext` and nudge the agent to sweep the stale ones.

    NON-BLOCKING by construction: it emits NO `permissionDecision`, so the push
    proceeds regardless of what other branches hold — the hard deny stays
    strictly current-branch-only (other-branch FAILs must never wedge a push).
    A None/empty backlog (read failure or nothing open) is a silent clean allow —
    the informational surface is best-effort and never costs a push."""
    backlog = open_fail_backlog()
    if not backlog:
        return _allow()
    _emit_hook({"additionalContext": format_backlog_summary(
        backlog,
        current_roots=_current_roots(cwd, repo_root),
        max_rows=BACKLOG_NOTICE_MAX_ROWS,
        max_ids=BACKLOG_NOTICE_MAX_IDS,
    )})
    return 0


def _wait_for(roborev: str, repo_root: str, ids: list[int]) -> bool:
    """Block until the given job IDs finish, bounded at WAIT_TIMEOUT_SECS.
    Returns True if the wait completed (regardless of pass/fail — the caller
    re-queries for the authoritative open-fail state), False on timeout.

    Signature `roborev wait --quiet --job <id…>` (batch ids after one --job) is
    verified against the live binary. A nonzero exit (not an exception) returns
    True → the caller's re-query still sees the job in flight → fail-closed deny,
    so a CLI drift over-blocks (safe) rather than letting a push through."""
    try:
        subprocess.run(
            [roborev, "wait", "--quiet", "--job", *[str(i) for i in ids]],
            cwd=repo_root, capture_output=True, text=True,
            timeout=WAIT_TIMEOUT_SECS,
        )
        return True
    except subprocess.TimeoutExpired:
        return False
    except (subprocess.SubprocessError, OSError):
        return True  # best-effort: if wait can't run, fall through to re-query


def _format_block(jobs: list[dict], cmd: str = "") -> str:
    lines = [
        f"Push blocked: {len(jobs)} open roborev fail-verdict review(s) on this "
        "branch must be addressed first.",
        "",
        "The ENTIRE Bash command was blocked, and this hook runs BEFORE the "
        "command executes — so if you chained the push (e.g. `git commit && git "
        "push`, or `... ; git push`, or a piped sequence), NONE of the earlier "
        "steps ran. Your commit was NOT made; HEAD did not move. Do not re-check "
        "`git status` to work out why — run the earlier steps as their own command "
        "first, then push separately once the reviews below are cleared.",
        "",
    ]
    # Name the chained steps rather than only warning that some may exist: the
    # paragraph above tells the agent a chain MIGHT have been skipped, which a
    # long compound command makes hard to act on (bead sparkle-9tl2e).
    skipped = format_skipped_steps(*chained_steps_around_push(cmd))
    if skipped:
        lines += [*skipped, ""]
    # Drifted open-fail rows (null/non-int id) still display usefully — fall back
    # to the short git_ref so the agent can find the review, matching how the
    # warn surface tolerates id-less rows rather than printing "review #None".
    for j in jobs:
        jid = j.get("id")
        ref = f"#{jid}" if isinstance(jid, int) else f"@{str(j.get('git_ref', '') or '?')[:8]}"
        lines.append(f"  - review {ref} (FAIL)")
    lines += [
        "",
        "Resolve each before re-pushing — the goal is to CLEAR every open "
        "fail-verdict review by fixing or declining it, with judgment per "
        "finding, not to push over them:",
        "  1. `roborev show <id>` — read the findings.",
        "  2. VALID finding: fix it in a new commit, then `roborev close <id>` "
        "(the fix is covered by the new commit's own review; the old review "
        "stays open until you close it).",
        "  3. INVALID / YAGNI finding (a guard, edge-case branch, fallback, or "
        "abstraction not warranted at the current operating point): decline it — "
        "`roborev comment <id> -m \"<why declined>\"` to record the reason, then "
        "`roborev close <id>`.",
        "",
        "Do NOT clear these with `roborev refine` or `roborev fix`: they "
        "autonomously apply every finding WITHOUT the valid-vs-YAGNI judgment in "
        "steps 2–3 (so they accrete defensive cruft), and `refine` runs in a git "
        "worktree. Resolve each review by hand.",
        "",
        "Re-run the push once no open fail-verdict reviews remain.",
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
    seg = _push_cwd_and_branch(cmd, fallback_cwd)
    if seg is None:
        return _allow()
    cwd, pushed_branch = seg
    if not _inside_git_repo(cwd):
        return _allow()
    repo_root = _git_toplevel(cwd)
    # Scope to the branch the push EXPLICITLY names (its refspec source), falling
    # back to the current branch of cwd only when it names none (bare push / HEAD).
    # Fixes bead sparkle-0614: `git push origin fresh-branch` from a shell parked
    # on another branch must gate on `fresh-branch`, not the parked branch's stale
    # findings — `_current_branch(cwd)` would read the parked branch.
    branch = pushed_branch or _current_branch(cwd)
    if not branch or not repo_root:
        return _allow()  # detached HEAD / unresolvable repo → nothing to scope
                         # `roborev list --branch` to; allow by design (see the
                         # module docstring's Scope limits).
    roborev = _find_roborev()
    if roborev is None:
        return _allow()

    jobs = _list_jobs(roborev, repo_root, branch)
    if jobs is None:
        return _deny(_list_fail_reason(cmd))

    # Deny IMMEDIATELY on an already-confirmed open fail — a terminal fail can't
    # be cleared by waiting, so never hang up to WAIT_TIMEOUT_SECS on unrelated
    # in-flight reviews first (the common case: an old verdict=F plus a freshly
    # enqueued review for the new commit).
    outstanding = [j for j in jobs if _is_open_fail(j)]
    if outstanding:
        return _deny(_format_block(outstanding, cmd))

    # TRIAGED-TO-LAND (Sparkle policy): do NOT wait-and-block on reviews still in
    # flight for the commit being pushed. The gate blocks ONLY on already-
    # completed, un-closed fail reviews (the `outstanding` check above) — the
    # safety property people actually want is "no COMPLETED finding went unread",
    # which `roborev close`-with-reason already enforces. A fix commit's freshly-
    # enqueued review is in-flight at push time; blocking on it is the non-
    # convergent fix->review->fix loop AGENTS.md documents (every fix is itself
    # reviewable, FAIL plateaus 40-48% through the 14th round). Instead we let it
    # complete AFTER the push and surface via the Sparkle review badge; if it
    # lands a fail it becomes `outstanding` and blocks the NEXT push until
    # triaged. This makes the gate MATCH the documented "fix Medium+, then land"
    # policy instead of contradicting it. `_in_flight`/`_wait_for` are retained
    # for the other gates that import this module.

    # This branch is clear (no un-triaged completed findings). Surface the machine-wide backlog (non-blocking) so
    # the agent can sweep stale FAILs on OTHER branches it's moved off of — the
    # visibility half the current-branch deny structurally can't cover.
    return _allow_with_backlog(cwd, repo_root)


if __name__ == "__main__":
    sys.exit(main())
