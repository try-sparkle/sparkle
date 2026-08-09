// What the Terminal paints over the still-blank xterm. Extracted as a pure function so the
// (load-bearing) "never a silent blank pane" rule is unit-tested without standing up xterm/WebGL.
//
//   - fail:    the spawn chain threw ("failed") or the PTY exited before any output ("exited").
//              Offers "Start again". This is the fix for the reported blank-pane bug — instead of
//              clearing to nothing, we say what happened and let the user retry.
//   - loading: spawned, no output yet — the unavoidable gap before Claude's first byte / a
//              `--resume` redraw. Reads as loading, not broken.
//   - none:    output has streamed; the terminal itself is showing — no overlay.
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
  /** `detail` is the underlying error, when we have one — see `reason` on resolveTerminalOverlay. */
  | { kind: "fail"; message: string; canRetry: true; detail?: string };

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
): TerminalOverlay {
  // Failure takes precedence over the loading affordance even if output never set firstOutput.
  if (spawnFail) {
    const detail = reason?.trim();
    return {
      kind: "fail",
      canRetry: true,
      message: spawnFail === "failed" ? "Couldn't start the agent." : "Agent exited.",
      ...(detail ? { detail } : {}),
    };
  }
  if (!firstOutput) {
    return { kind: "loading", message: resuming ? "Resuming conversation…" : "Starting…" };
  }
  return { kind: "none" };
}
