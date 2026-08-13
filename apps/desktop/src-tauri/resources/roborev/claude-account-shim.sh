#!/bin/sh
# Sparkle roborev claude shim — selects a healthy Claude ACCOUNT per review job, and FAILS OVER to
# the next account when the one it picked turns out to be walled.
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
# WHY IT RETRIES RATHER THAN JUST PICKING. The candidate list is built from Sparkle's recorded
# `exhaustedUntil`, which is a LAGGING indicator: Sparkle learns an account is walled by scanning
# its transcripts afterwards, so an account walled sixty seconds ago still reads as healthy.
# Measured live while building this — the shim correctly routed away from a walled account and the
# very next account was walled too, unrecorded. Selecting alone is therefore not enough to keep
# reviews running; the shim has to notice the wall itself and move on.
#
# That is why this does NOT exec until the final attempt: it must stay alive to observe the exit.
# Output is captured per attempt and replayed verbatim, so roborev's --output-format stream-json
# parser sees exactly what claude wrote.
#
# Fails OPEN: if anything about the candidate list is wrong, run the real claude untouched — which
# is exactly the pre-shim behavior. A broken shim must never be worse than no shim.
REAL_CLAUDE='@REAL_CLAUDE@'
CANDIDATES='@CANDIDATES@'

now=`date +%s 2>/dev/null` || now=0
case "$now" in ''|*[!0-9]*) now=0 ;; esac

# Does this output show a Claude ACCOUNT wall (as opposed to a real error)? Kept deliberately
# narrow: these are the exact families recorded in ~/.roborev/reviews.db. A non-wall failure must
# NOT burn through every account — it is the same failure everywhere, so retrying only multiplies it.
is_wall() { # file
  # `.*` rather than `[^\n]*`: grep matches line by line, so `.` can never cross a newline anyway,
  # and a backslash before an ordinary character is undefined in a POSIX ERE (caught by
  # scripts/tests/grep-ere-portability.test.sh — it failed CI on Linux while passing on macOS).
  grep -qiE "hit your (session|weekly|monthly|usage).*limit|hit your monthly spend limit|credit balance is too low|not logged in" "$1" 2>/dev/null
}

TMPD=`mktemp -d 2>/dev/null` || TMPD="${TMPDIR:-/tmp}/roborev-shim.$$"
mkdir -p "$TMPD" 2>/dev/null
OUT="$TMPD/out"; ERR="$TMPD/err"
cleanup() { rm -rf "$TMPD" 2>/dev/null; }
trap cleanup EXIT INT TERM

# ── Collect the usable candidates, in order ──────────────────────────────────────────────────────
standdown=0
n=0
if [ -r "$CANDIDATES" ]; then
  while IFS='	' read -r until dir; do
    case "$until" in
      STANDDOWN) standdown=1; break ;;
      ''|'#'*) continue ;;
      *[!0-9]*) continue ;;
    esac
    [ "$until" -le "$now" ] || continue
    # An EMPTY dir is the default-account sentinel: a real value meaning "export nothing".
    if [ -n "$dir" ] && [ ! -d "$dir" ]; then continue; fi
    n=$((n + 1))
    eval "cand_$n=\$dir"
  done < "$CANDIDATES"
fi

if [ "$standdown" -eq 1 ]; then
  echo "sparkle roborev shim: standing down — fewer than two healthy Claude accounts, leaving the last one for interactive work" >&2
  exit 78
fi

# Fail open: nothing usable in the list -> behave exactly as if the shim were not installed.
if [ "$n" -eq 0 ]; then
  cleanup
  exec "$REAL_CLAUDE" "$@"
fi

# ── Try each candidate; move on ONLY when the failure is an account wall ─────────────────────────
i=1
while [ "$i" -le "$n" ]; do
  eval "dir=\$cand_$i"
  if [ -n "$dir" ]; then
    CLAUDE_CONFIG_DIR="$dir" export CLAUDE_CONFIG_DIR
  else
    unset CLAUDE_CONFIG_DIR
  fi

  # The LAST candidate execs: nothing is left to fail over to, so hand the process to claude and let
  # it own the terminal, the signals and the exit status directly.
  if [ "$i" -eq "$n" ]; then
    cleanup
    exec "$REAL_CLAUDE" "$@"
  fi

  "$REAL_CLAUDE" "$@" >"$OUT" 2>"$ERR"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    cat "$OUT"; cat "$ERR" >&2
    exit 0
  fi

  if is_wall "$ERR" || is_wall "$OUT"; then
    echo "sparkle roborev shim: account walled, failing over to the next account" >&2
    i=$((i + 1))
    continue
  fi

  # A genuine error (bad flags, crash, network): identical on every account. Report it as-is.
  cat "$OUT"; cat "$ERR" >&2
  exit "$rc"
done
