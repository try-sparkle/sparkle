#!/usr/bin/env python3
"""Shared helpers for the seed's three Claude-Code PreToolUse[Bash] hooks:

  - roborev-pre-commit-context.py  — WARNS (injects open fail-verdict reviews
    into context before `git commit`); never blocks.
  - roborev-pre-push-gate.py       — DENIES a `git push` while the CURRENT branch
    has open fail-verdict reviews (after waiting for in-flight ones).
  - roborev-pre-checkout-gate.py   — DENIES a `git checkout`/`git switch` to
    ANOTHER branch while the branch you're LEAVING has open fail-verdict reviews
    (so findings can't be stranded by switching away). File restores
    (`git checkout -- f`, `git restore …`) are NOT gated — see
    `_is_branch_switch_args`.

All surfaces must agree on three things, so they live here in exactly one place:
  1. the command parser (is this a real `git <subcommand>` and which cwd?),
  2. roborev/git discovery,
  3. the DEFINITION of an "outstanding finding" (`_is_open_fail` + `_list_jobs`).

Underscore module name = importable from a sibling hook (the hyphenated hook
filenames are not valid Python module names). A hook runs with `sys.path[0]` set
to its own directory, so `from _roborev_hooklib import ...` resolves with no
sys.path hacks — the installer drops this file next to both hooks.

This is NOT a security boundary. The command parser is a best-effort convenience
on operator-controlled machines; a few wrapped invocations (`ENV=x git commit`,
`cd d && git commit` from a non-repo cwd) intentionally no-op rather than growing
a shell emulator (settled across the #2 review's parser-probe rounds). roborev's
own git hooks fire regardless of what this hook recognizes.
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import sqlite3
import subprocess
from pathlib import Path


# The seed installs roborev here (ref/install.sh). Trust that path first; fall
# back to PATH for a dev who keeps it elsewhere.
SEEDED_ROBOREV = Path.home() / ".local" / "bin" / "roborev"

# The daemon's machine-wide review store (one DB per machine). The cross-branch
# backlog view reads it directly — the `roborev list` CLI has no all-repos /
# all-branches mode, so there's no public seam to delegate to for the backlog.
ROBOREV_DB = Path.home() / ".roborev" / "reviews.db"


def _emit_hook(extra: dict) -> None:
    """Print a PreToolUse hook result — `extra` merged into the
    `hookSpecificOutput` envelope all three hooks share (so a future envelope
    tweak has ONE writer). The bridge passes `additionalContext`; the gates pass
    `permissionDecision` + `permissionDecisionReason` via `_deny`."""
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", **extra}}))


def _deny(reason: str) -> int:
    """Emit a PreToolUse permission DENY with `reason`, returning 0 so callers can
    `return _deny(...)` straight out of `main()`. Shared by both gates — the
    pre-push and pre-checkout gates' deny envelope is byte-identical."""
    _emit_hook({"permissionDecision": "deny", "permissionDecisionReason": reason})
    return 0

_OPERATOR_TOKENS = {"&&", "||", "|", ";", "&"}
# git's global options that take a separate argument token (`-X val`). Long
# `--opt=val` forms carry their value in the same token; the startswith("-")
# clause in _find_subcommand_idx handles them.
_GIT_GLOBAL_OPTS_WITH_ARG = {"-C", "-c"}


def _split_into_segments(cmd: str) -> list[list[str]]:
    """Tokenize `cmd` once (quote-aware) and split the token stream on shell
    operator tokens (`&&`, `||`, `|`, `;`, `&`) into per-segment token lists.

    Uses `shlex(..., punctuation_chars=True)`, which groups runs of `&|;` into
    standalone tokens while leaving quoted argument strings (`-m "x && y"`)
    intact — so an operator *inside* a quoted commit message is preserved as
    part of the argument and never splits a segment. Returns `[]` on a tokenizer
    error (unbalanced quote), which fails closed to "no git segment"."""
    try:
        lexer = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []
    segments: list[list[str]] = []
    current: list[str] = []
    for tok in tokens:
        if tok in _OPERATOR_TOKENS:
            segments.append(current)
            current = []
        else:
            current.append(tok)
    segments.append(current)
    return segments


def _find_subcommand_idx(tokens: list[str]) -> int | None:
    """Index of git's subcommand token (first non-option after `git`). Skips
    global options and option+arg pairs (-C <dir>, -c <kv>). None if absent."""
    i = 1
    while i < len(tokens):
        tok = tokens[i]
        if tok in _GIT_GLOBAL_OPTS_WITH_ARG:
            i += 2  # skip the option AND its arg
            continue
        if tok.startswith("-"):
            i += 1  # short flag w/o arg, --long, or --long=val
            continue
        return i
    return None


def _resolve_dash_c(tokens: list[str], sub_idx: int, fallback_cwd: str) -> str:
    """The cwd a `git` segment operates on: the value of the last `-C` BEFORE the
    subcommand ($VAR / ~ expanded), else `fallback_cwd`. `-C` after the
    subcommand or in another segment is git-irrelevant and ignored. Last `-C`
    wins, relative `-C` composes onto the prior one (git's own semantics)."""
    resolved = None
    for i in range(sub_idx):
        if tokens[i] == "-C" and i + 1 < sub_idx:
            path = tokens[i + 1]
            expanded = os.path.expanduser(os.path.expandvars(path))
            if "$" in expanded:
                continue  # unresolvable env var
            if not os.path.isabs(expanded):
                base = resolved if resolved else fallback_cwd
                expanded = os.path.normpath(os.path.join(base, expanded))
            resolved = expanded
    return resolved if resolved else fallback_cwd


def _resolve_repo_cwd(cmd: str, fallback_cwd: str, subcommand: str) -> str | None:
    """Validate that `cmd` contains a real `git ... <subcommand> ...` invocation
    and return the cwd it operates on, else None (`echo git ... <subcommand>` is
    a no-match — the first shlex token must be exactly `git`). `subcommand` is
    "commit" for the context hook, "push" for the gate.

    If found, returns the value of `-C` ($VAR / ~ expanded), else `fallback_cwd`."""
    for tokens in _split_into_segments(cmd):
        if not tokens or tokens[0] != "git":
            continue
        sub_idx = _find_subcommand_idx(tokens)
        if sub_idx is None or tokens[sub_idx] != subcommand:
            continue
        return _resolve_dash_c(tokens, sub_idx, fallback_cwd)
    return None


# Push options that consume the FOLLOWING token as their value, so the token
# after them is an option-argument, NOT an operand. Long `--opt=val` spellings
# carry the value inline and never land here. Kept deliberately small — only the
# value-taking options a branch push realistically carries; an unknown
# value-taking option at worst makes us misread an operand and fall back to the
# current-branch scoping (safe, never a regression).
_PUSH_OPTS_WITH_ARG = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}


def _push_source_branch(args: list[str]) -> str | None:
    """The LOCAL branch a `git push` segment exports, parsed from its refspec, or
    None when it can't be POSITIVELY identified — in which case the caller keeps
    the current-branch-of-cwd behavior, so this is a strict superset of the old
    scoping and can never block a push the old code allowed.

    `args` is the token list AFTER the `push` subcommand. git's push grammar is
    `git push [<options>] [<repository> [<refspec>...]]`: the FIRST operand is the
    remote, the SECOND is the first refspec. We read `<src>` from `<src>[:<dst>]`
    (a leading `+` force marker stripped) because roborev scopes findings by the
    LOCAL branch the commits sit on — the `<dst>` (remote-side) name is irrelevant.

    This is the fix for bead sparkle-0614: an agent pushing `origin fresh-branch`
    from a shell whose cwd is parked on ANOTHER branch (the normal multi-worktree
    case) must be gated on `fresh-branch`, not on the parked branch's unrelated
    stale findings. `_current_branch(cwd)` reads the parked branch; the refspec
    names the branch actually leaving the machine.

    Returns None (→ fall back to current branch) for every form where the source
    isn't one explicit branch name:
      - no refspec (`git push`, `git push origin`) — pushes the current branch;
      - `HEAD` / `HEAD:<dst>` — the current branch under another name;
      - a delete (`--delete`/`-d`, or an empty src `:<dst>`) — exports no commits;
      - `--all`/`--mirror`/`--tags`/`--follow-tags` — multi-ref, no single branch;
      - a tag or other non-`heads` ref (`refs/tags/…`, `refs/…`) — not branch-scoped.
    Only a concrete branch source — `foo`, `foo:bar`, `+foo`, `refs/heads/foo` —
    yields a name to scope to."""
    if any(a in ("--delete", "-d", "--all", "--mirror", "--tags", "--follow-tags")
           for a in args):
        return None
    operands: list[str] = []
    seen_dashdash = False
    i = 0
    while i < len(args):
        a = args[i]
        if seen_dashdash:
            operands.append(a)
            i += 1
            continue
        if a == "--":
            seen_dashdash = True
            i += 1
            continue
        if a in _PUSH_OPTS_WITH_ARG:
            i += 2  # skip the option AND its value token
            continue
        if a.startswith("-"):
            i += 1  # valueless short flag, --long, or --long=val
            continue
        operands.append(a)
        i += 1
    # operands[0] = remote, operands[1] = first refspec. Fewer than two operands
    # means no explicit refspec → the push targets the current branch.
    if len(operands) < 2:
        return None
    src = operands[1].split(":", 1)[0]
    if src.startswith("+"):
        src = src[1:]
    if not src or src == "HEAD":
        return None
    if src.startswith("refs/heads/"):
        src = src[len("refs/heads/"):]
    elif src.startswith("refs/"):
        return None  # tag or other ref namespace — not a plain branch
    return src or None


def _push_cwd_and_branch(cmd: str, fallback_cwd: str) -> tuple[str, str | None] | None:
    """For the first real `git ... push ...` segment in `cmd`, return
    `(cwd, explicit_source_branch)` — the cwd it operates on (last `-C` before the
    subcommand, else `fallback_cwd`, exactly like `_resolve_repo_cwd`) and the
    branch its refspec names (`None` when it names none). Returns None when there
    is no push segment at all, mirroring `_resolve_repo_cwd`'s no-match contract.

    Kept separate from `_resolve_repo_cwd` (which the commit-context hook also
    uses) so that hook's cwd resolution is untouched — this only ADDS the refspec
    read the push gate needs."""
    for tokens in _split_into_segments(cmd):
        if not tokens or tokens[0] != "git":
            continue
        sub_idx = _find_subcommand_idx(tokens)
        if sub_idx is None or tokens[sub_idx] != "push":
            continue
        cwd = _resolve_dash_c(tokens, sub_idx, fallback_cwd)
        return cwd, _push_source_branch(tokens[sub_idx + 1:])
    return None


# Display bounds for the skipped-step list. A chained command can be long; the
# point is to let the agent RECOGNIZE its own steps, not to reproduce them
# verbatim, so a truncated step is still a useful answer while an unbounded dump
# would bury the review list the deny message exists to show.
_MAX_STEP_CHARS = 120
_MAX_STEPS_LISTED = 8


def _render_steps(segments: list[list[str]]) -> list[str]:
    """Token lists -> displayable one-line step strings, empties dropped.

    Rebuilt from the tokenizer's output rather than sliced out of the raw
    command, so quoting is already normalized and no partial quote can leak into
    the message."""
    out: list[str] = []
    for tokens in segments:
        if not tokens:
            continue  # a trailing `;` / `&` yields an empty tail segment
        step = " ".join(tokens)
        if len(step) > _MAX_STEP_CHARS:
            step = step[: _MAX_STEP_CHARS - 1] + "…"
        out.append(step)
    return out


def chained_steps_around_push(cmd: str) -> tuple[list[str], list[str]]:
    """The other top-level steps chained around the first `git push` segment of
    `cmd`, as `(before, after)` display strings.

    Both gates deny the WHOLE Bash invocation before any of it runs, so every one
    of these steps silently did not execute — `before` never ran despite reading
    as already-done (`git commit && git push` leaves HEAD where it was), and
    `after` never ran either. Naming them is the fix for bead sparkle-9tl2e: the
    deny message could say a chain *might* have been skipped, but not which
    steps, and a long compound command makes that non-obvious enough that agents
    re-derived it from `git status`.

    `([], [])` when the command is a standalone push, when there is no push
    segment, or when the tokenizer fails — the caller then omits the list rather
    than asserting anything about steps it could not read."""
    segments = _split_into_segments(cmd)
    push_idx = None
    for i, tokens in enumerate(segments):
        if not tokens or tokens[0] != "git":
            continue
        sub_idx = _find_subcommand_idx(tokens)
        if sub_idx is None or tokens[sub_idx] != "push":
            continue
        push_idx = i
        break
    if push_idx is None:
        return [], []
    return _render_steps(segments[:push_idx]), _render_steps(segments[push_idx + 1:])


def format_skipped_steps(before: list[str], after: list[str]) -> list[str]:
    """Message lines naming the chained steps that did not run, or `[]` when the
    push stood alone (nothing to report, so the caller prints nothing)."""
    if not before and not after:
        return []
    total = len(before) + len(after)
    lines = [
        f"{total} other step(s) chained into that same command therefore did NOT "
        "run:",
    ]
    for step, when in [(s, "before") for s in before] + [(s, "after") for s in after]:
        if len(lines) - 1 >= _MAX_STEPS_LISTED:
            lines.append(f"  … and {total - _MAX_STEPS_LISTED} more")
            break
        lines.append(f"  - [{when} the push] {step}")
    return lines


def _is_create_switch(args: list[str]) -> bool:
    """True when a `git checkout`/`git switch` CREATES (or force-resets) its target
    branch — `-b`/`-B`/`-c`/`-C`. The destination is then a brand-new (or reset)
    branch that by construction carries no prior roborev findings.

    The checkout gate does NOT block these (bead sparkle-0614): blocking
    fresh-branch creation on the LEAVING branch's findings is the P0 — a parked
    checkout's stale findings wedged every `git switch -c <new>` / `git checkout
    -b <new>` an agent ran to start work. The leaving branch's findings are not
    lost: the commit-context hook still surfaces them, the push gate still blocks
    the eventual push of that branch, and the machine-wide backlog still lists
    them. The export boundary (push) stays fully gated. A switch to an EXISTING
    branch is unaffected and still blocks on the leaving branch — the "abandoning
    unreviewed work" case the gate exists for is preserved."""
    return any(a in ("-b", "-B", "-c", "-C") for a in args)


def _is_branch_switch_args(subcommand: str, args: list[str]) -> bool:
    """Decide whether a `git <subcommand> <args…>` invocation LEAVES the current
    branch for another (the thing the checkout gate cares about), vs. restoring
    files / inspecting — which must NOT be gated.

    `args` is the token list AFTER the subcommand (options + operands, in order).

    A branch switch is:
      - `git switch <name>` / `git switch -c|-C <new>` / `git switch --detach
        <ref>` — `switch` is *always* a branch operation (it can't restore
        files), so any `switch` that isn't a pure no-op gates;
      - `git checkout <branch>` / `git checkout -b|-B <new>` / `git checkout -`
        (previous branch) / `git checkout --detach [<ref>]` (detach HEAD) — a
        checkout that leaves the branch rather than restoring a pathspec.

    NOT a branch switch (do NOT gate):
      - `git checkout -- <path>` (explicit pathspec after `--`),
      - `git checkout <ref> -- <path>` / `git checkout . ` / `git checkout <path>`
        where the operand is a pathspec (restore-from-tree), and
      - `git restore …` (never a branch op — not handled here; the caller only
        routes checkout/switch in).

    The hard case is bare `git checkout <arg>` with no `--`: `<arg>` could be a
    branch OR a path. We resolve it the way git's own ambiguity rule biases —
    and the way that's SAFE for this gate — as follows:
      - `-b`/`-B`/`-c`/`-C` (create-and-switch) or `-` (previous branch) present
        → unambiguously a branch switch → gate.
      - an explicit `--` (or `--pathspec-from-file`) → file op → do NOT gate.
      - exactly one non-option operand and NO `--` → treat as a BRANCH ref and
        gate. This is the deliberate call: `git checkout <oneword>` reads as "go
        to branch <oneword>" in agent usage; the rare `git checkout <file>` to
        discard one file's changes is virtually always written with the explicit
        `git checkout -- <file>` / `git restore <file>` (or `git checkout .`)
        forms, which we DON'T gate. We accept that a literal bare
        `git checkout somefile.py` MIGHT be over-gated (denied) when the branch
        has open fails — a safe failure (the agent restores via `git restore` /
        `git checkout --`), never an under-gate that lets a real switch slip.
      - two-or-more non-option operands, OR a single operand of `.`  → pathspec
        restore (`git checkout <ref> -- <paths>` collapses to ≥2 operands once
        `--` is stripped; `git checkout .` is the whole-tree restore) → do NOT
        gate.

    Pure-inspection / no-operand forms (`git checkout` alone, `git switch`
    alone) carry no destination branch → not a switch → do NOT gate."""
    create_flags = {"-b", "-B", "-c", "-C"}
    has_create = any(a in create_flags for a in args)
    # `--detach` LEAVES the current branch for a detached HEAD (`git switch
    # --detach <ref>` / `git checkout --detach [<ref>]`). The ref form already
    # gates via its operand, but the no-ref form doesn't — treat detach itself as
    # a branch-leaving signal. `-d` is git's short alias for `--detach` on
    # `git switch` ONLY (`git checkout` has no `-d`), so accept it for switch.
    has_detach = "--detach" in args or (subcommand == "switch" and "-d" in args)
    has_dashdash = "--" in args
    has_pathspec_from_file = any(
        a == "--pathspec-from-file" or a.startswith("--pathspec-from-file=")
        for a in args
    )
    # Operands = non-option tokens. For `checkout`, everything after `--` is a
    # pathspec by definition, so collection STOPS at `--`. For `switch`, `--` is
    # only an options terminator (switch has no pathspec mode), so the operand
    # after it is still the branch target (`git switch -- other` switches to
    # `other`) — don't stop at `--` for switch. Create-flag VALUES (`-b <new>`)
    # are operands of the flag, not the switch target, but their presence already
    # forces a gate via has_create, so we don't special-case them out.
    operands = []
    for a in args:
        if a == "--" and subcommand == "checkout":
            break
        if a != "--" and not a.startswith("-"):
            operands.append(a)

    if subcommand == "switch":
        # `switch` is exclusively a branch operation. Gate unless it's the bare
        # no-op (`git switch` with no branch and no -c/-C/--detach target).
        # `git switch -` (previous branch) reads `-` as an option token, so it's
        # filtered out of `operands` — handle it (and `--detach`) explicitly,
        # mirroring the checkout path below.
        return has_create or has_detach or "-" in args or bool(operands)

    # subcommand == "checkout"
    if has_dashdash or has_pathspec_from_file:
        return False                       # explicit file-restore form
    if has_create or has_detach:
        return True                        # -b/-B create-and-switch, or --detach
    if "-" in args:
        return True                        # `git checkout -` → previous branch
    if len(operands) == 1 and operands[0] != ".":
        return True                        # bare single ref → treat as branch
    return False                           # 0 operands, `.`, or ≥2 → not a switch


def _branch_switch_cwd(cmd: str, fallback_cwd: str) -> tuple[str, bool] | None:
    """Return `(cwd, is_create)` for a real branch-switching `git checkout`/`git
    switch` segment in `cmd`, else None. `cwd` mirrors `_resolve_repo_cwd` (first
    shlex token must be exactly `git`; `-C` before the subcommand sets the cwd);
    the match requires `_is_branch_switch_args` to classify it as a branch switch,
    so file restores (`git checkout -- f`, `git restore …`) and pure-inspection
    forms no-op. `is_create` is `_is_create_switch(args)` — True for `-b`/`-B`/
    `-c`/`-C` create-and-switch, which the checkout gate uses to skip gating a
    brand-new target branch (bead sparkle-0614)."""
    for tokens in _split_into_segments(cmd):
        if not tokens or tokens[0] != "git":
            continue
        sub_idx = _find_subcommand_idx(tokens)
        if sub_idx is None or tokens[sub_idx] not in ("checkout", "switch"):
            continue
        args = tokens[sub_idx + 1:]
        if not _is_branch_switch_args(tokens[sub_idx], args):
            continue
        return _resolve_dash_c(tokens, sub_idx, fallback_cwd), _is_create_switch(args)
    return None


def _find_roborev() -> str | None:
    """Resolve roborev: the seed-installed path (`~/.local/bin/roborev`) first,
    then PATH for a dev who keeps it elsewhere. None if none is reachable —
    a broken install, which the commit hook surfaces as a warning and the push
    gate treats as allow (don't hard-block a push on a broken dev install)."""
    if SEEDED_ROBOREV.is_file() and os.access(SEEDED_ROBOREV, os.X_OK):
        return str(SEEDED_ROBOREV)
    found = shutil.which("roborev")
    return found if found and os.path.isabs(found) else None


def _find_git() -> str | None:
    return shutil.which("git")


def _git_stdout(cwd: str, *args: str) -> str:
    """Run `git <args>` in `cwd`; trimmed stdout on success, "" else. Swallows
    all subprocess/OS errors so the hook stays best-effort."""
    git = _find_git()
    if git is None:
        return ""
    try:
        r = subprocess.run(
            [git, *args],
            cwd=cwd, capture_output=True, text=True, timeout=2,
        )
    except (subprocess.SubprocessError, OSError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def _inside_git_repo(cwd: str) -> bool:
    return _git_stdout(cwd, "rev-parse", "--is-inside-work-tree") == "true"


def _current_branch(cwd: str) -> str:
    return _git_stdout(cwd, "branch", "--show-current")


def _git_toplevel(cwd: str) -> str:
    """Canonical repo root the daemon stored as `repos.root_path`."""
    return _git_stdout(cwd, "rev-parse", "--show-toplevel")


# roborev's TERMINAL review statuses (a review that has finished running). The
# pre-push gate denylists these to decide "in flight" — anything NOT terminal
# (queued, running, or any transient/future status) is treated as still-running
# so the gate waits on it and stays fail-closed. Keep in sync with the terminal
# set in `verify.sh` / `SEED.md`.
TERMINAL_STATUSES = ("done", "passed", "failed")


def _in_flight(jobs: list[dict]) -> list[dict]:
    """Reviews the daemon hasn't finished. Denylists TERMINAL_STATUSES rather
    than allowlisting {queued,running}, so ANY unrecognized non-terminal status
    (an enqueue/`pending`/`starting` state, or a future one) counts as in-flight
    — keeping both gates fail-CLOSED on an unknown status. A row with no/null
    status is also treated as in-flight. Drifted non-dict rows are ignored
    (best-effort, like `_is_open_fail`).

    A `closed` row is NOT in flight even mid-run: a `roborev close`'d review can
    never become an outstanding finding (`_is_open_fail` requires `not closed`),
    so neither gate should wait on / block over it."""
    return [j for j in jobs
            if isinstance(j, dict) and not j.get("closed", False)
            and j.get("status") not in TERMINAL_STATUSES]


def _is_open_fail(job: object) -> bool:
    """THE shared definition of an "outstanding finding" both surfaces gate on:
    a fail-verdict review that hasn't been acknowledged. `roborev list --open`
    means "unresolved, ANY verdict" and includes PASS rows, so `verdict == "F"`
    is load-bearing; `not closed` drops reviews acknowledged via `roborev close`.
    Tolerates a drifted/non-dict row (returns False) so callers fail soft."""
    return (
        isinstance(job, dict)
        and job.get("verdict") == "F"
        and not job.get("closed", False)
    )


def _list_jobs(roborev: str, repo_root: str, branch: str) -> list[dict] | None:
    """Full job list for this repo+branch via the public `roborev list` CLI.
    Repo+branch scoping is delegated to `--repo`/`--branch` (verified to filter
    server-side) — the same trust we place in the `--json`/`verdict` contract,
    rather than re-implementing branch comparison client-side.

    Returns `None` on ANY failure (subprocess/OS error, nonzero exit, JSON error,
    unexpected non-list shape) — DISTINCT from `[]`, a cleanly-parsed empty
    result. The distinction is load-bearing for the fail-closed push gate: it
    DENIES on `None` (couldn't determine review state) instead of mistaking a
    wedged daemon or timed-out `list` for "no findings" and waving an unreviewed
    push through. The warn-only commit bridge maps `None`→`[]` (under-reporting a
    non-blocking warning is benign). Mirrors the empty-vs-broken handling the git
    hooks use.

    A cleanly-parsed JSON `null` (rc 0) means "no jobs for this repo+branch" — it
    is what `roborev list` prints for a repo/branch it has never reviewed (a fresh
    or freshly-cloned repo, a brand-new branch). That is empty, NOT a read
    failure, so it maps to `[]` — otherwise the gate would deny every push in any
    repo roborev hasn't reviewed yet (the daemon is fine; there's simply nothing
    to find)."""
    try:
        r = subprocess.run(
            [roborev, "list", "--json", "--repo", repo_root, "--branch", branch],
            cwd=repo_root, capture_output=True, text=True, timeout=5,
        )
    except (subprocess.SubprocessError, OSError):
        return None
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    if data is None:        # roborev prints JSON `null`, not `[]`, for a never-
        return []           # reviewed repo+branch — a clean "no jobs", not a fault.
    return data if isinstance(data, list) else None


# A repo path is an EPHEMERAL test fixture (not real work to drain) when it lives
# under a system temp dir. roborev's own pytest suite, the seed's verify.sh
# throwaway repo, and ad-hoc smoke clones all land here and would otherwise
# dominate the backlog count with noise that vanishes on its own.
_EPHEMERAL_ROOT_PREFIXES = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")


def _is_ephemeral_repo(root_path: object) -> bool:
    return isinstance(root_path, str) and root_path.startswith(_EPHEMERAL_ROOT_PREFIXES)


def open_fail_backlog(db_path: Path = ROBOREV_DB) -> list[dict] | None:
    """The MACHINE-WIDE open fail-verdict backlog: every job with an unclosed
    FAIL review across ALL repos and branches in the daemon's store, ephemeral
    fixture repos filtered out. Read-only — a single SELECT, opened read-only so
    a concurrent daemon write is never at risk.

    Returns a list of `{repo, root_path, branch, id}` dicts (one per open-FAIL job),
    where `id` is the JOB id (`review_jobs.id`) — the namespace every CLI verb
    (`roborev show --job <id>`, `roborev close/comment <id>`) resolves. Note the
    `--job`: `show` resolves its argument as a git ref FIRST, so a bare numeric
    job id is read as a commit SHA prefix. Surfacing `reviews.id` here
    instead handed agents ids the CLI answers "no review found" for, killing
    the backlog sweep. SELECT DISTINCT because the emitted id is no longer the
    row's primary key: should a job ever carry two open FAIL reviews, one
    `close` clears both, so one listed id is the honest surface.

    Returns `None` if the DB can't be read (missing file, locked, schema
    drift) — the same None-vs-[] distinction `_list_jobs` draws, so callers can
    tell "nothing open" from "couldn't look." This is INFORMATIONAL ONLY (the
    pre-push gate surfaces it non-blocking); a None just means "no backlog
    summary this time," never a denied push.

    `reviews.verdict_bool = 0` is the DB-level spelling of `_is_open_fail`'s
    `verdict == "F"` (FAIL): the CLI maps the same column to the "F"/"P" letter.
    `reviews.closed = 0` is the same `not closed` both surfaces require. Kept here
    next to `_is_open_fail` so the two definitions of "outstanding finding" can't
    drift — one over the CLI rows, one over the DB rows, same predicate."""
    if not db_path.is_file():
        return None
    try:
        # Read-only (immutable) connection: never creates/locks/migrates the DB,
        # and won't block on the daemon's write lock.
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
        try:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT DISTINCT
                       repos.name        AS repo,
                       repos.root_path   AS root_path,
                       review_jobs.branch AS branch,
                       reviews.job_id    AS id
                FROM reviews
                JOIN review_jobs ON reviews.job_id = review_jobs.id
                JOIN repos       ON review_jobs.repo_id = repos.id
                WHERE reviews.verdict_bool = 0
                  AND reviews.closed = 0
                ORDER BY repos.name, review_jobs.branch, reviews.job_id
                """
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return [dict(r) for r in rows if not _is_ephemeral_repo(r["root_path"])]


# How much of the machine-wide backlog the PUSH-TIME notice is allowed to print.
# The full list belongs to `roborev-list-all.py`, which is what an agent runs when
# it has decided to sweep; the push-time surface only has to make the backlog's
# SIZE visible and point at the rows this repo can actually act on. Unbounded, it
# grew to 340+ findings over 140+ branches — a wall of text that buries the one
# line that matters (the pushed branch is clean), so nobody read any of it.
BACKLOG_NOTICE_MAX_ROWS = 8
BACKLOG_NOTICE_MAX_IDS = 6


def format_backlog_summary(
    backlog: list[dict],
    *,
    current_roots: set[str] | None = None,
    max_rows: int | None = None,
    max_ids: int | None = None,
) -> str:
    """Render `open_fail_backlog()` output as a compact `repo  branch  count/ids`
    block for the pre-push gate's non-blocking surface, plus the active-vs-stale
    cleanup nudge. Groups by (root_path, branch) — keyed on ROOT, not repo name,
    so same-basename sibling clones (the `~/Hacking/<repo>` vs `~/services/<repo>`
    pattern) stay distinct rather than collapsing into one row. The pushed branch
    is deliberately NOT marked: this only runs once the gate has confirmed the
    pushed (repo, branch) has zero open FAILs (it denies otherwise), so the pushed
    branch can never appear in this backlog — there's nothing to mark.

    `max_rows` / `max_ids` bound the printed body (the HEADER always reports the
    true machine-wide totals, so truncation can never understate the backlog).
    `current_roots` are the repo roots of the checkout being pushed — its rows
    sort FIRST, because those are the branches this session can actually sweep;
    everything else is someone else's clone. Rows beyond the cap collapse into a
    single tail line naming what was withheld and where to read it in full.

    All three default to None = unbounded, which is the exact pre-cap output —
    `roborev-list-all.py` is the deliberate "show me everything" surface and must
    keep printing every row."""
    groups: dict[tuple[str, str], list[int]] = {}
    display_name: dict[tuple[str, str], str] = {}
    for row in backlog:
        key = (row["root_path"], row["branch"] or "(detached)")
        groups.setdefault(key, []).append(row["id"])
        display_name.setdefault(key, row["repo"])
    lines = [
        f"roborev backlog: {len(backlog)} open FAIL job(s) across "
        f"{len(groups)} branch(es) machine-wide (this is INFORMATIONAL — your "
        "push is NOT blocked by other branches):",
        "",
    ]

    shown = list(groups.items())
    if max_rows is not None and len(shown) > max_rows:
        roots = current_roots or set()
        # This repo first, then the heaviest branches; (repo, branch) breaks ties
        # so the notice is stable across pushes rather than reshuffling.
        shown.sort(key=lambda kv: (kv[0][0] not in roots, -len(kv[1]), kv[0]))
        hidden = shown[max_rows:]
        shown = shown[:max_rows]
        hidden_ids = sum(len(ids) for _, ids in hidden)
    else:
        hidden, hidden_ids = [], 0

    for (root_path, branch), ids in shown:
        listed = ids if max_ids is None else ids[:max_ids]
        id_list = ", ".join(f"#{i}" for i in listed)
        if len(listed) < len(ids):
            id_list += f", +{len(ids) - len(listed)} more"
        here = "  <- this repo" if current_roots and root_path in current_roots else ""
        lines.append(
            f"  {display_name[(root_path, branch)]}  {branch}  ({len(ids)}) {id_list}{here}"
        )
    if hidden:
        lines.append(
            f"  … and {len(hidden)} more branch(es) holding {hidden_ids} finding(s) "
            "— `~/.config/roborev/claude-hooks/roborev-list-all.py` prints them all."
        )
    lines += [
        "",
        "Sweep the STALE ones while you're here: open them with "
        "`roborev show --job <id>`, and for any that are days-old, caused by code you "
        "authored, or invalid / valid-but-YAGNI, resolve + `roborev close <id>` "
        "(fix-then-close, or `roborev comment <id> -m \"<why declined>\"` "
        "then close). But NEVER close a finding a parallel session is actively "
        "working — recently-created, on a branch checked out in another clone, or "
        "under a PR being iterated. When unsure whether a finding is active, "
        "LEAVE IT. This is the active-vs-stale test, not branch ownership.",
    ]
    return "\n".join(lines)
