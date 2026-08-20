// What the Terminal paints over the still-blank xterm. Extracted as a pure function so the
// (load-bearing) "never a silent blank pane" rule is unit-tested without standing up xterm/WebGL.
//
//   - fail:    the spawn chain threw ("failed") or the PTY exited before any output ("exited").
//              Offers "Start again". This is the fix for the reported blank-pane bug — instead of
//              clearing to nothing, we say what happened and let the user retry.
//   - loading: spawned, no output yet — the unavoidable gap before Claude's first byte / a
//              `--resume` redraw. Reads as loading, not broken.
//   - stopped: the PTY ran, PRODUCED OUTPUT, and then exited. See below — this is the case that
//              used to render nothing at all.
//   - none:    output has streamed and the process is alive; the terminal itself is showing.
export type SpawnFail = null | "failed" | "exited";

/** Flatten an unknown thrown value into something showable. Local by convention — five other modules
 *  (demote.ts, promote.ts, lifecycle.ts, workflow.ts, SetupChecklist.tsx) each carry their own copy
 *  rather than sharing one, and widening that seam is not this fix's job. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export type TerminalOverlay =
  | { kind: "none" }
  | { kind: "loading"; message: string }
  | { kind: "stopped"; message: string; canRetry: true }
  /** `detail` is the underlying error, when we have one — see `reason` on resolveTerminalOverlay.
   *  `permanent` marks a refusal that cannot change on retry — see `isPermanentSpawnRefusal`. */
  | { kind: "fail"; message: string; canRetry: true; detail?: string; permanent?: true };

/** The leading phrase of pty.rs `validate_spawn_inner`'s containment refusal. Rust may only ever
 *  APPEND to that message (its own comment says so, naming this module), so a substring match on
 *  the phrase is stable while the appended paths vary per install. */
const CWD_CONTAINMENT_REFUSAL = "cwd is outside the managed worktrees directory";

/** Is this spawn error a refusal that a retry CANNOT clear?
 *
 *  Only one signature qualifies today, and it qualifies for a specific structural reason: the
 *  worktree-scope guard compares the `cwd` prop against the managed worktrees base, and that prop is
 *  fixed for the Terminal's life. "Start again" re-runs the same effect with the same cwd, so it
 *  re-derives the identical refusal — the retry is doomed before it is clicked, every time.
 *
 *  Deliberately NOT matched: `pty_spawn: worktrees dir unavailable`, the sibling error from the same
 *  function. That one fires when the base directory cannot be canonicalized (it does not exist yet),
 *  which a later attempt genuinely can clear — calling it permanent would tell the user to give up
 *  on a case that fixes itself. Narrow by construction: anything unrecognized stays retryable, so a
 *  new backend error can never be mislabelled as hopeless. */
export function isPermanentSpawnRefusal(reason: string | undefined): boolean {
  return !!reason && reason.includes(CWD_CONTAINMENT_REFUSAL);
}

/**
 * `stopped` closes the hole this whole module was supposed to cover (bead sparkle-l2xgf).
 *
 * The "never a silent blank pane" rule was enforced only for a PTY that died having emitted
 * NOTHING. An agent that ran, printed thousands of lines and then exited took the `none` branch —
 * so the pane kept rendering the last frame of a dead session, INCLUDING the CLI's prompt chevron
 * and its block cursor. That is not a blank pane, it is a worse one: it is indistinguishable from a
 * terminal waiting for input, and every keystroke typed into it was silently swallowed by
 * `pty_write`'s "no such pty" path. The founder typed into one and reasonably concluded the app was
 * broken. The concierge's own copy ("…'s terminal has closed — Start it again and I'll pass it
 * along") pointed at a Start again button that, in exactly this case, was never rendered.
 *
 * `fail` still wins over `stopped`: an agent that exited with no output at all is better described
 * by "Agent exited." over a scrim than by a footer under an empty screen.
 */
export function resolveTerminalOverlay(
  spawnFail: SpawnFail,
  firstOutput: boolean,
  resuming: boolean,
  /** The actual error behind a "failed" spawn, surfaced instead of being swallowed.
   *
   *  "Couldn't start the agent." alone cannot be acted on, and worse, it renders a PERMANENT refusal
   *  identically to a transient hiccup — so "Start again" reads as a dead button when it is really a
   *  retry that is guaranteed to fail again. That is precisely how sparkle-mahbf presented: the
   *  embedded Claude login was refused by pty_spawn's worktree-scope guard every single time, and the
   *  only record of it was a `console.debug`. Blank/whitespace is treated as absent so we never paint
   *  an empty second line. */
  reason?: string,
  ptyStopped = false,
): TerminalOverlay {
  // Failure takes precedence over the loading affordance even if output never set firstOutput.
  if (spawnFail) {
    const detail = reason?.trim();
    // A PERMANENT refusal is still offered a retry — `canRetry` stays true and the button stays
    // rendered. Removing it would take away the only control on a pane that has nothing else, and
    // "this cannot succeed" is a judgement about one signature, not a reason to strip the escape
    // hatch. What `permanent` changes is the CLAIM: the surface stops presenting a doomed retry as
    // an ordinary one, which is the half of sparkle-mahbf that surfacing the reason text left open.
    const permanent = spawnFail === "failed" && isPermanentSpawnRefusal(detail);
    return {
      kind: "fail",
      canRetry: true,
      message: permanent
        ? "Couldn't start the agent — starting again won't help."
        : spawnFail === "failed"
          ? "Couldn't start the agent."
          : "Agent exited.",
      ...(detail ? { detail } : {}),
      ...(permanent ? { permanent: true as const } : {}),
    };
  }
  // Before the loading hint: a PTY that stopped is stopped whether or not its first byte arrived,
  // and "Starting…" over a dead process is the same lie in a different font.
  if (ptyStopped) {
    return { kind: "stopped", canRetry: true, message: "Terminal stopped" };
  }
  if (!firstOutput) {
    return { kind: "loading", message: resuming ? "Resuming conversation…" : "Starting…" };
  }
  return { kind: "none" };
}
