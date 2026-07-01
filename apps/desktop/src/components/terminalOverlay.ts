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

export type TerminalOverlay =
  | { kind: "none" }
  | { kind: "loading"; message: string }
  | { kind: "fail"; message: string; canRetry: true };

export function resolveTerminalOverlay(
  spawnFail: SpawnFail,
  firstOutput: boolean,
  resuming: boolean,
): TerminalOverlay {
  // Failure takes precedence over the loading affordance even if output never set firstOutput.
  if (spawnFail) {
    return {
      kind: "fail",
      canRetry: true,
      message: spawnFail === "failed" ? "Couldn't start the agent." : "Agent exited.",
    };
  }
  if (!firstOutput) {
    return { kind: "loading", message: resuming ? "Resuming conversation…" : "Starting…" };
  }
  return { kind: "none" };
}
