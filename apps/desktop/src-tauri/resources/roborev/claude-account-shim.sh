#!/bin/sh
# Sparkle roborev claude shim — selects a healthy Claude ACCOUNT per review job, then EXECS the real
# claude, handing it the process untouched.
#
# THIS FILE IS THE SHIM. Rust (`roborev_account.rs`) reads it with include_str! and substitutes the
# two @PLACEHOLDER@ tokens at install time; the shell suite
# (`scripts/tests/roborev-claude-shim.test.sh`) executes this same file with its own substitutions.
# One artifact, two test suites — so a change cannot pass on one side and break the other.
#
# It sets CLAUDE_CONFIG_DIR and nothing else. It must NEVER inject ANTHROPIC_API_KEY or
# CLAUDE_CODE_SIMPLE: that was the retired ~/.roborev-shim mechanism, which forced strict API-key
# auth against an unfunded key and made every review die on "Credit balance is too low".
#
# WHY IT EXECS RATHER THAN RUNS-AND-RETRIES. roborev pipes the review prompt to `claude --print` on
# STDIN. `exec` replaces this shell with claude, so claude inherits STDIN, STDOUT, STDERR, the
# signals and the exit status directly — the prompt reaches it byte-for-byte and its
# --output-format stream-json is written straight to roborev with nothing in the middle.
#
# An earlier version RAN claude for the first candidate and failed over to the next on a wall. That
# was fatal: the first run consumed STDIN, so the failover `exec` handed claude an empty pipe and
# every review died with "Input must be provided either through stdin or as a prompt argument when
# using --print". A wrapper cannot replay a streamed prompt to a second process, so it must not run
# claude more than once. Routing away from a dead account is handled REACTIVELY instead: Sparkle
# observes the failure, benches the account (quota wall via `exhausted_until`, OAuth-expiry via the
# auth-dead bench in roborev_account.rs), and republishes this candidate list so the NEXT job's shim
# picks a different account — the same model the interactive fleet and the concierge use.
#
# Fails OPEN: if anything about the candidate list is wrong, exec the real claude untouched — which
# is exactly the pre-shim behavior. A broken shim must never be worse than no shim.
REAL_CLAUDE='@REAL_CLAUDE@'
CANDIDATES='@CANDIDATES@'

now=`date +%s 2>/dev/null` || now=0
case "$now" in ''|*[!0-9]*) now=0 ;; esac

# ── Select the best usable candidate (the list is ranked best-first) ─────────────────────────────
# NOTHING in this loop reads or consumes STDIN — no `read` from the prompt pipe, no `cat`, no
# `$(...)` that inherits STDIN — so the prompt is still intact when we exec. `read` here draws from
# the CANDIDATES file via the `< "$CANDIDATES"` redirection on the loop, not from the process STDIN.
standdown=0
selected=''
have=0
if [ -r "$CANDIDATES" ]; then
  while IFS='	' read -r until dir; do
    case "$until" in
      STANDDOWN) standdown=1; break ;;
      ''|'#'*) continue ;;
      *[!0-9]*) continue ;;
    esac
    # A future exhaustion means this account is walled: skip it.
    [ "$until" -le "$now" ] || continue
    # An EMPTY dir is the default-account sentinel: a real value meaning "export nothing". A
    # non-empty dir that no longer exists (a removed account) is skipped for the next candidate.
    if [ -n "$dir" ] && [ ! -d "$dir" ]; then continue; fi
    selected=$dir
    have=1
    break
  done < "$CANDIDATES"
fi

if [ "$standdown" -eq 1 ]; then
  echo "sparkle roborev shim: standing down — fewer than two healthy Claude accounts, leaving the last one for interactive work" >&2
  exit 78
fi

# ── Hand off to the real claude, STDIN and all ───────────────────────────────────────────────────
if [ "$have" -eq 1 ] && [ -n "$selected" ]; then
  CLAUDE_CONFIG_DIR="$selected" export CLAUDE_CONFIG_DIR
else
  # Fail open (nothing usable) OR the default-account sentinel (empty dir): export nothing.
  unset CLAUDE_CONFIG_DIR
fi

exec "$REAL_CLAUDE" "$@"
