import { describe, it, expect } from "vitest";
import { isPermanentSpawnRefusal, resolveTerminalOverlay } from "./terminalOverlay";

describe("resolveTerminalOverlay", () => {
  it("shows the loading hint before any output (Starting / Resuming)", () => {
    expect(resolveTerminalOverlay(null, false, false)).toEqual({ kind: "loading", message: "Starting…" });
    expect(resolveTerminalOverlay(null, false, true)).toEqual({ kind: "loading", message: "Resuming conversation…" });
  });

  it("shows nothing once output has streamed", () => {
    expect(resolveTerminalOverlay(null, true, false)).toEqual({ kind: "none" });
  });

  it("shows a retryable fail state — never a silent blank — when spawn fails or exits empty", () => {
    expect(resolveTerminalOverlay("failed", false, false)).toEqual({
      kind: "fail", canRetry: true, message: "Couldn't start the agent.",
    });
    expect(resolveTerminalOverlay("exited", false, false)).toEqual({
      kind: "fail", canRetry: true, message: "Agent exited.",
    });
  });

  it("lets a failure win over the loading hint regardless of firstOutput", () => {
    expect(resolveTerminalOverlay("exited", true, true).kind).toBe("fail");
  });

  // THE REASON MUST REACH THE USER (sparkle-mahbf). "Couldn't start the agent." on its own is
  // unactionable: the founder's embedded Claude login was being refused by pty_spawn's worktree-scope
  // guard on every attempt, and the only place that said so was a `console.debug` nobody reads. The
  // pane looked identical to a slow start, so a hard, permanent rejection was indistinguishable from
  // a transient one — and "Start again" looked like a dead button rather than a doomed retry.
  it("carries the real spawn error through as a detail line", () => {
    const o = resolveTerminalOverlay(
      "failed",
      false,
      false,
      "pty_spawn: cwd is outside the managed worktrees directory",
    );
    expect(o.kind).toBe("fail");
    expect(o).toMatchObject({
      canRetry: true,
      detail: "pty_spawn: cwd is outside the managed worktrees directory",
    });
  });

  it("omits the detail when there is no reason to show, rather than printing an empty line", () => {
    expect(resolveTerminalOverlay("failed", false, false, "   ")).toEqual({
      kind: "fail", canRetry: true, message: "Couldn't start the agent.",
    });
    expect(resolveTerminalOverlay("exited", false, false, undefined)).toEqual({
      kind: "fail", canRetry: true, message: "Agent exited.",
    });
  });
});

// ---------------------------------------------------------------------------
// A DOOMED retry must not be presented as an ordinary one (the second half of
// sparkle-mahbf / sparkle-bdbd9). Surfacing the reason text made the refusal
// legible; it did not stop the pane from offering "Start again" — a button that,
// for the worktree-scope guard, re-runs the same effect with the same fixed cwd
// and re-derives the identical refusal, forever.
// ---------------------------------------------------------------------------
describe("resolveTerminalOverlay — a permanent refusal says so", () => {
  const CONTAINMENT =
    "pty_spawn: cwd is outside the managed worktrees directory: /a/accounts/x is not under /a/worktrees";

  it("marks the worktree-scope refusal permanent and stops claiming a retry will help", () => {
    const o = resolveTerminalOverlay("failed", false, false, CONTAINMENT);
    expect(o).toEqual({
      kind: "fail",
      canRetry: true,
      permanent: true,
      message: "Couldn't start the agent — starting again won't help.",
      detail: CONTAINMENT,
    });
  });

  // The ESCAPE HATCH, asserted as a capability rather than as a label: whatever we say about the
  // retry, the user is never locked out of taking it. This pane has no other control.
  it("keeps the retry available on a permanent refusal", () => {
    const o = resolveTerminalOverlay("failed", false, false, CONTAINMENT);
    expect(o.kind === "fail" && o.canRetry).toBe(true);
  });

  // NARROW BY CONSTRUCTION. Each of these reaches the same branch and must come back retryable —
  // a permanent verdict on a recoverable failure tells the user to give up for no reason.
  it.each([
    ["the sibling error from the same Rust function, which a later attempt can clear",
     "pty_spawn: worktrees dir unavailable: No such file or directory (os error 2)"],
    ["a missing binary", "No such file or directory (os error 2): claude"],
    ["an unrecognized backend error", "something nobody has classified yet"],
  ])("leaves %s retryable, with no permanent flag", (_why, reason) => {
    const o = resolveTerminalOverlay("failed", false, false, reason);
    expect(o).toEqual({
      kind: "fail",
      canRetry: true,
      message: "Couldn't start the agent.",
      detail: reason,
    });
    expect(o).not.toHaveProperty("permanent");
  });

  // "exited" is a PTY that ran and died, not a refused spawn. It can carry a reason string, but the
  // containment guard cannot be the cause — the spawn it guards already succeeded.
  it("never marks an exited PTY permanent, even if its reason text mentions the guard", () => {
    const o = resolveTerminalOverlay("exited", false, false, CONTAINMENT);
    expect(o).not.toHaveProperty("permanent");
    expect(o.kind === "fail" && o.message).toBe("Agent exited.");
  });

  it("does not mark a blank reason permanent", () => {
    expect(resolveTerminalOverlay("failed", false, false, "   ")).not.toHaveProperty("permanent");
    expect(isPermanentSpawnRefusal(undefined)).toBe(false);
    expect(isPermanentSpawnRefusal("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The STOPPED state (bead sparkle-l2xgf). The founder typed into an agent whose
// PTY had exited and nothing happened; the pane was still painting the dead
// session's last frame, prompt chevron and block cursor included.
// ---------------------------------------------------------------------------
describe("resolveTerminalOverlay — a stopped PTY must never look alive", () => {
  it("REGRESSION: an agent that ran, output, then exited rendered NOTHING", () => {
    // This is the exact founder state: output streamed (firstOutput), no spawnFail
    // (because spawnFail is only set when the PTY died having emitted nothing).
    // The old three-arg call is what shipped — it resolves to "none", i.e. a dead
    // terminal wearing a live terminal's face.
    expect(resolveTerminalOverlay(null, true, false)).toEqual({ kind: "none" });
    // With the PTY's death actually reported, the pane says so and offers a way out.
    // (`ptyStopped` is the FIFTH arg — `reason` sits at 4 and belongs to the fail path.)
    expect(resolveTerminalOverlay(null, true, false, undefined, true)).toEqual({
      kind: "stopped",
      canRetry: true,
      message: "Terminal stopped",
    });
  });

  it("beats the loading hint — 'Starting…' over a dead process is the same lie", () => {
    expect(resolveTerminalOverlay(null, false, false, undefined, true).kind).toBe("stopped");
    expect(resolveTerminalOverlay(null, false, true, undefined, true).kind).toBe("stopped");
  });

  it("yields to a hard failure, which has a better message and a full-pane scrim", () => {
    expect(resolveTerminalOverlay("exited", false, false, undefined, true).kind).toBe("fail");
    expect(resolveTerminalOverlay("failed", false, false, undefined, true).kind).toBe("fail");
    // …and the failure keeps its `detail`, which `stopped` has no field for — so the
    // precedence above must not be "whichever branch is written first" by accident.
    expect(resolveTerminalOverlay("failed", false, false, "scope guard", true)).toEqual({
      kind: "fail",
      canRetry: true,
      message: "Couldn't start the agent.",
      detail: "scope guard",
    });
  });

  it("clears the moment the restarted child speaks", () => {
    // The caller drops ptyStopped on the first output byte; prove the resolver agrees
    // that a live, streaming terminal wears no overlay at all.
    expect(resolveTerminalOverlay(null, true, false, undefined, false)).toEqual({ kind: "none" });
  });

  it("always offers a way out whenever it admits the process is gone", () => {
    // The concierge tells the user to "Start it again" — that copy is only true if every
    // process-is-gone state carries a retry affordance. Pin the pair together.
    for (const o of [
      resolveTerminalOverlay(null, true, false, undefined, true),
      resolveTerminalOverlay("exited", false, false, undefined, false),
      resolveTerminalOverlay("failed", false, false, undefined, false),
    ]) {
      expect(o.kind === "stopped" || o.kind === "fail").toBe(true);
      expect("canRetry" in o && o.canRetry).toBe(true);
    }
  });
});
