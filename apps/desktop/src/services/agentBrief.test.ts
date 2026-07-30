// THE BRIEF MUST BE SUBMITTED, NOT MERELY PRESENT.
//
// The bug these tests lock down: `spawn_build_agent` delivered an agent's opening brief into its
// terminal and never submitted it. The text sat at the prompt with the cursor after it, waiting for a
// human to press Enter, while the tool returned `briefed: true` — so nothing downstream knew the
// agent was dead in the water. Five of five concierge spawns in one evening; two agents idle 20+
// minutes; one woke with no objective at all.
//
// Each test here asserts the SIDE EFFECT (the brief rides claude's argv, so claude submits it; and
// `briefed` reflects an observation) rather than the precondition (a prompt was passed in) — the
// latter was already true of the broken code, which is exactly why nothing caught this.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  __heldWaiterCount,
  attachBrief,
  awaitBriefDelivery,
  briefForLaunch,
  clearBrief,
  hasUndeliveredBrief,
  noteBriefFailed,
  noteBriefLaunched,
  resetAgentBriefs,
} from "./agentBrief";
import { assembleBuildSpawn } from "./orchestrationLaunch";

beforeEach(() => {
  resetAgentBriefs();
});

const BRIEF = "Fix the flaky resize test.\nStart by reading Workspace.resize.test.tsx.";

describe("the brief rides the LAUNCH, not a post-spawn PTY write", () => {
  it("is emitted as claude's positional prompt, which auto-submits at startup", () => {
    attachBrief("a1", BRIEF);
    const spawn = assembleBuildSpawn({
      claudePath: "/bin/claude",
      resume: false,
      cwd: "/wt",
      persona: "persona",
      bridge: { socketPath: "/s", token: "t" },
      paths: { nodePath: "/node", serverPath: "/server.js" },
      initialPrompt: briefForLaunch("a1", false),
    });
    const exec = spawn.args.at(-1)!;
    // `--` then the quoted prompt: this is the form claude submits itself on launch. Without it the
    // brief would have to be typed into the TUI afterwards, which is the bug.
    expect(exec).toContain("-- ");
    expect(exec).toContain("Fix the flaky resize test.");
    // The prompt must come AFTER the `--` terminator, or `--add-dir` (variadic) swallows it.
    expect(exec.indexOf("-- ")).toBeLessThan(exec.indexOf("Fix the flaky resize test."));
  });

  it("emits NO positional prompt on resume, so a reopen never re-runs the brief", () => {
    attachBrief("a2", BRIEF);
    expect(briefForLaunch("a2", true)).toBeUndefined();
    const spawn = assembleBuildSpawn({
      claudePath: "/bin/claude",
      resume: true,
      cwd: "/wt",
      persona: "persona",
      bridge: { socketPath: "/s", token: "t" },
      paths: { nodePath: "/node", serverPath: "/server.js" },
      initialPrompt: briefForLaunch("a2", true),
    });
    expect(spawn.args.at(-1)!).not.toContain("Fix the flaky resize test.");
  });

  it("keeps the brief held until delivery settles, so a failed launch can retry with it", () => {
    attachBrief("a3", BRIEF);
    // A first launch that never reached exec must not consume the brief.
    expect(briefForLaunch("a3", false)).toBe(BRIEF);
    expect(briefForLaunch("a3", false)).toBe(BRIEF);
    expect(hasUndeliveredBrief("a3")).toBe(true);
    noteBriefLaunched("a3");
    // Delivered: gone, so a later relaunch does not re-submit it.
    expect(briefForLaunch("a3", false)).toBeUndefined();
    expect(hasUndeliveredBrief("a3")).toBe(false);
  });
});

describe("`briefed` is an OBSERVATION — it may not be inferred from the input", () => {
  it("resolves `submitted` only once the launch carrying the brief has run", async () => {
    attachBrief("b1", BRIEF);
    const pending = awaitBriefDelivery("b1", { timeoutMs: 10_000 });
    let settled = false;
    void pending.then(() => (settled = true));
    // Nothing has launched yet: the promise must NOT be resolved. This is the assertion the old code
    // could never have satisfied — it reported success at this exact point.
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(noteBriefLaunched("b1")).toBe(BRIEF);
    await expect(pending).resolves.toEqual({ state: "submitted" });
  });

  it("reports `launch-failed` with a reason when the pane will never launch it", async () => {
    attachBrief("b2", BRIEF);
    const pending = awaitBriefDelivery("b2", { timeoutMs: 10_000 });
    noteBriefFailed("b2", "claude not found");
    await expect(pending).resolves.toEqual({
      state: "launch-failed",
      reason: "claude not found",
    });
  });

  it("reports `unconfirmed` — never `submitted` — when the wait gives up on silence", async () => {
    attachBrief("b3", BRIEF);
    // Injected timer: the give-up bound is exercised with no real clock, and nothing in the delivery
    // path depends on a duration.
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("b3", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
  });

  it("answers a waiter with a failure when the agent closes, rather than hanging forever", async () => {
    attachBrief("b4", BRIEF);
    const pending = awaitBriefDelivery("b4", { timeoutMs: 10_000 });
    clearBrief("b4", "agent closed");
    await expect(pending).resolves.toEqual({ state: "agent-closed", reason: "agent closed" });
  });

  it("settles exactly once — a relaunch cannot re-report a delivered brief", async () => {
    attachBrief("b5", BRIEF);
    const pending = awaitBriefDelivery("b5", { timeoutMs: 10_000 });
    noteBriefLaunched("b5");
    await expect(pending).resolves.toEqual({ state: "submitted" });
    // Second launch (a resume) finds nothing held and reports nothing.
    expect(noteBriefLaunched("b5")).toBeUndefined();
    noteBriefFailed("b5", "should be ignored");
    expect(hasUndeliveredBrief("b5")).toBe(false);
  });

  // A FAILED launch must not destroy the brief. The pane's remedy is "Start again", and the reply
  // tells the human exactly that — so if the failure consumed the text, the retry would launch claude
  // with NO positional prompt and the agent would come up silently briefless, which is the very
  // failure this whole change exists to end. (The first cut of this module got this wrong: `settle`
  // deleted the entry on every outcome.)
  it("KEEPS the brief after a failed launch, so Start again re-emits it", async () => {
    attachBrief("b6", BRIEF);
    const pending = awaitBriefDelivery("b6", { timeoutMs: 10_000 });
    noteBriefFailed("b6", "claude not found");
    await expect(pending).resolves.toEqual({
      state: "launch-failed",
      reason: "claude not found",
    });
    // Still deliverable — this is the assertion that would fail against a settle() that dropped it.
    expect(hasUndeliveredBrief("b6")).toBe(true);
    expect(briefForLaunch("b6", false)).toBe(BRIEF);
    // …and the retry delivers it for real, reporting submitted.
    expect(noteBriefLaunched("b6")).toBe(BRIEF);
    expect(hasUndeliveredBrief("b6")).toBe(false);
  });

  // Giving up on the ANSWER is not the brief becoming undeliverable — a late launch must still carry
  // it — but the abandoned waiter must not pin the entry for the life of the process.
  it("keeps a brief deliverable after an unconfirmed wait", async () => {
    attachBrief("b7", BRIEF);
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("b7", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
    expect(hasUndeliveredBrief("b7")).toBe(true);
    // A late launch still carries it.
    expect(noteBriefLaunched("b7")).toBe(BRIEF);
  });

  // ASSERTS THE WAITER COUNT, because nothing else can see this.
  //
  // The previous version of this test claimed to cover the cleanup and did not: a retained waiter is
  // still invoked by the later `settle`, sees its own `done` flag and returns silently, so every
  // observable value is identical with the cleanup deleted. It was green against the leak it named —
  // the exact vacuous test this repo's guidance is about (roborev 55850). The count is the only
  // side effect, so the count is what gets asserted.
  it("releases the abandoned waiter when the wait gives up, so nothing pins the entry", async () => {
    attachBrief("b8", BRIEF);
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("b8", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    expect(__heldWaiterCount("b8")).toBe(1);
    fire!();
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
    // Delete the filter line in `awaitBriefDelivery` and this is still 1.
    expect(__heldWaiterCount("b8")).toBe(0);
  });

  // A CLOSE IS NOT A FAILED LAUNCH. They once shared `launch-failed`, which made the caller answer a
  // close-during-wait with the retry copy — "the brief is still attached, Start again will send it" —
  // naming a control on a row that had just been deleted, about a brief that had just been dropped.
  it("reports `agent-closed`, distinctly from a failed launch, when the agent goes away", async () => {
    attachBrief("b9", BRIEF);
    const pending = awaitBriefDelivery("b9", { timeoutMs: 10_000 });
    clearBrief("b9", "agent closed");
    await expect(pending).resolves.toEqual({ state: "agent-closed", reason: "agent closed" });
    // …and unlike launch-failed, the brief really is gone, so no copy may offer to retry it.
    expect(hasUndeliveredBrief("b9")).toBe(false);
    expect(briefForLaunch("b9", false)).toBeUndefined();
  });

  it("resolves immediately when no brief was asked for, so an empty spawn is not slowed", async () => {
    await expect(awaitBriefDelivery("never-briefed", { timeoutMs: 10_000 })).resolves.toEqual({
      state: "submitted",
    });
  });
});
