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
# An earlier version RAN claude --print for the first candidate and failed over to the next on a wall.
# That was fatal: the first run consumed STDIN (the review prompt), so the failover `exec` handed
# claude an empty pipe and every review died with "Input must be provided either through stdin or as
# a prompt argument when using --print". A wrapper cannot replay a streamed prompt to a second
# process, so it must never run the REVIEW more than once.
#
# WHY A PRE-EXEC AUTH PROBE IS STILL SAFE. The fatal thing above was consuming the PROMPT, not running
# claude at all. This shim live-probes the selected candidate's OAuth session with
# `claude auth status --json </dev/null` BEFORE it commits to that account. The probe reads /dev/null,
# never the review prompt on our STDIN, so the prompt is still intact byte-for-byte when we finally
# `exec`. A candidate the CLI reports DEFINITELY signed out is skipped for the next ranked one — the
# proactive complement to the reactive bench below. This closes the gap where the reactive path never
# fires: it detects a wall only AFTER a failing job writes a transcript matching a known OAuth-expiry
# phrase, so the FIRST job after a session lapses — or any lapse whose error text is not in that
# phrase list — still routes to the dead login and takes review down until something else benches it.
# Mirrors the spawn-time picker (accounts.rs::claude_auth_status): a live CLI "no" beats a recorded
# "yes", but an unavailable/garbled probe never blocks — only a parsed {"loggedIn":false} skips.
#
# Routing is ALSO handled reactively: Sparkle observes a failure, benches the account (quota wall via
# `exhausted_until`, OAuth-expiry via the auth-dead bench in roborev_account.rs), and republishes this
# candidate list so the NEXT job's shim reads a list the dead login is absent from.
#
# Fails OPEN throughout: a wrong/absent candidate list, or a probe that cannot render a verdict, execs
# the real claude untouched — which is exactly the pre-shim behavior. A broken shim must never be
# worse than no shim.
REAL_CLAUDE='@REAL_CLAUDE@'
CANDIDATES='@CANDIDATES@'

now=`date +%s 2>/dev/null` || now=0
case "$now" in ''|*[!0-9]*) now=0 ;; esac

# ── Live OAuth probe for a candidate account ─────────────────────────────────────────────────────
# Exit 0 == "the CLI reports this account DEFINITELY signed out, SKIP it"; exit 1 == "healthy OR the
# probe was inconclusive, KEEP it" (fail open). Prints nothing. This is the ONLY place the real claude
# is referenced before the exec, and it MUST redirect its stdin from /dev/null: draining the review
# prompt is the exact outage the shim's header warns about, so the probe reads /dev/null and the
# prompt on our STDIN is never touched.
shim_auth_dead() {
  _dir=$1
  # The empty-dir default-account sentinel is never probed: it is the machine-wide login (the same
  # target as "export nothing") and the last-resort fallback, so it is kept as-is.
  [ -n "$_dir" ] || return 1
  # Probe in the candidate's own config dir, with every ANTHROPIC_* / provider override scrubbed so an
  # inherited API key can't report a healthy API-key posture over a dead OAuth session (roborev 57985).
  # The unset+export run in the command-substitution subshell, so the parent environment is untouched.
  _st=`
    unset ANTHROPIC_API_KEY ANTHROPIC_API ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_CUSTOM_HEADERS CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX 2>/dev/null
    CLAUDE_CONFIG_DIR="$_dir" export CLAUDE_CONFIG_DIR
    "$REAL_CLAUDE" auth status --json </dev/null 2>/dev/null
  ` || _st=''
  # Whitespace-normalize (a chatty CLI may print an update banner around the JSON), then match ONLY
  # the definite signed-out shape. jq-free by design, so the shim stays correct with a stripped env.
  # Anything else — {"loggedIn":true}, empty, an error, an older CLI with no `auth status` — is
  # inconclusive and KEEPS the candidate: an unavailable probe is not evidence the account is signed
  # out, and blocking on it would strand reviews the reactive bench never asked to strand.
  _st=`printf '%s' "$_st" | tr -d '[:space:]' 2>/dev/null` || _st=''
  case "$_st" in
    *'"loggedIn":false'*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Select the best usable candidate (the list is ranked best-first) ─────────────────────────────
# NOTHING in this loop reads or consumes the review prompt on STDIN — no `read` from the prompt pipe,
# no `cat`, and the auth probe above redirects its own stdin from /dev/null — so the prompt is still
# intact when we exec. `read` here draws from the CANDIDATES file via the `< "$CANDIDATES"`
# redirection on the loop, not from the process STDIN.
standdown=0
selected=''
have=0
firstdir=''
havefirst=0
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
    # Remember the best-ranked candidate that cleared the wall/exists checks: if the live probe rules
    # EVERY candidate dead, we fall open to this one rather than stranding all reviews — the same
    # all-dead fail-open the Rust ranker applies (a possibly-wrong probe must not hard-stop review).
    if [ "$havefirst" -eq 0 ]; then firstdir=$dir; havefirst=1; fi
    # Live-probe the OAuth session; a definite signed-out account is skipped for the next ranked one.
    if shim_auth_dead "$dir"; then continue; fi
    selected=$dir
    have=1
    break
  done < "$CANDIDATES"
fi

# Every viable candidate probed dead: fall open to the best-ranked one (a live review beats none).
if [ "$standdown" -eq 0 ] && [ "$have" -eq 0 ] && [ "$havefirst" -eq 1 ]; then
  selected=$firstdir
  have=1
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
