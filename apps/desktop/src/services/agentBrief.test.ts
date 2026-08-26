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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The steering prelude (bead .3) reaches Rust through `./steeringFiles` and finds its
// project through the project store. Both are mocked at the SEAM AGENTBRIEF ACTUALLY USES, so the
// wiring under test — "attachBrief asks for a block and prepends what comes back" — is the code
// that runs, not a hand-built stand-in for it.
const steeringBlockMock = vi.fn<(root: string) => Promise<string>>(async () => "");
vi.mock("./steeringFiles", () => ({
  fetchSteeringPreflightBlock: (root: string) => steeringBlockMock(root),
}));
const projectsMock: Array<{ rootPath: string; agents: Array<{ id: string }> }> = [];
vi.mock("../stores/projectStore", () => ({
  useProjectStore: { getState: () => ({ projects: projectsMock }) },
}));

import {
  __heldWaiterCount,
  attachBrief,
  awaitBriefDelivery,
  BRIEF_DELIVERY_TIMEOUT_MS,
  briefForLaunch,
  clearBrief,
  hasUndeliveredBrief,
  noteBriefFailed,
  noteBriefLaunchAbandoned,
  noteBriefLaunched,
  resetAgentBriefs,
} from "./agentBrief";
import { assembleBuildSpawn } from "./orchestrationLaunch";

beforeEach(() => {
  resetAgentBriefs();
  steeringBlockMock.mockReset();
  steeringBlockMock.mockResolvedValue("");
  projectsMock.length = 0;
});

const STEERING = [
  "<<< SPARKLE STEERING — HARD CONSTRAINTS >>>",
  "── standards.md (project) ──",
  "The test command is `pnpm verify`. A red suite is not done.",
  "<<< END SPARKLE STEERING >>>",
].join("\n");

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

// THE BOUND MUST COVER THE LAUNCH LATENCY THAT ACTUALLY OCCURS.
//
// These use the REAL default bound deliberately — passing `timeoutMs` would test the plumbing and
// leave the constant, which is the thing that was wrong, unpinned.
//
// The incident: three consecutive concierge spawns reported `unconfirmed` for briefs that were
// delivered. Measured from the app's own logs, the time from a pane starting its launch to
// `pty_spawn` returning had a p50 of 7.5s and a p90 of 24.5s across 108 spawns that day — so the 20s
// bound was under the real distribution and 13.9% of spawns raised a false alarm about an agent that
// was briefed and working. The three were 18.5s, 18.7s and 39.8s (and the wait starts before the
// pane's launch does, so even the sub-20s pair ran out of patience).
describe("the delivery bound vs how long a launch really takes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Fails against the 20s bound: the timer fires at 20s and resolves `unconfirmed` before the launch
  // this test then reports. That is exactly the false alarm the incident produced.
  it("still confirms a launch that takes 25s — the p90 of real spawns, which the old bound cut off", async () => {
    attachBrief("slow", BRIEF);
    const pending = awaitBriefDelivery("slow");
    await vi.advanceTimersByTimeAsync(25_000);
    // The pane's launch lands here, later than the old bound but well within a realistic spawn.
    expect(briefForLaunch("slow", false)).toBe(BRIEF);
    expect(noteBriefLaunched("slow")).toBe(BRIEF);
    await expect(pending).resolves.toEqual({ state: "submitted" });
  });

  // The counterweight: the bound must still EXIST. A test that only proved "25s confirms" would pass
  // against an unbounded wait, which would hang the concierge's whole round trip.
  it("still gives up eventually, so the reply cannot hang on a launch that never comes", async () => {
    attachBrief("never", BRIEF);
    const pending = awaitBriefDelivery("never");
    await vi.advanceTimersByTimeAsync(BRIEF_DELIVERY_TIMEOUT_MS + 1_000);
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
  });
});

// WHICH SILENCE WAS IT? — the distinction that stops a duplicate brief.
//
// A timeout used to report `unconfirmed` whether or not a launch was already carrying the brief in
// its argv. Those are different facts with opposite remedies, and the reply's copy acted on the wrong
// one: told to "check that it picked up the task", the concierge re-sent the brief into three agents
// that had already received it.
describe("a timeout says WHICH silence it was", () => {
  it("reports `launching` when a launch is already carrying the brief in its argv", async () => {
    attachBrief("c1", BRIEF);
    // The pane reads the brief into its spawn — delivery is committed to a command line from here.
    expect(briefForLaunch("c1", false)).toBe(BRIEF);
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("c1", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    await expect(pending).resolves.toEqual({ state: "launching" });
  });

  // Guards the test above against vacuity: if `launching` were returned unconditionally, this fails.
  it("still reports `unconfirmed` when NOTHING has read the brief to launch with", async () => {
    attachBrief("c2", BRIEF);
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("c2", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
  });

  // A pane that GAVE UP is not a launch in flight. The brief is retained for its Retry, so the entry
  // survives — but nothing is carrying it, and saying `launching` would tell the human to sit and
  // wait for a launch that is over.
  it("goes back to `unconfirmed` after a failed launch, since nothing is carrying the brief now", async () => {
    attachBrief("c3", BRIEF);
    expect(briefForLaunch("c3", false)).toBe(BRIEF);
    noteBriefFailed("c3", "claude not found");
    // The brief is still deliverable by a Retry…
    expect(hasUndeliveredBrief("c3")).toBe(true);
    // …but a fresh wait must not claim a launch is in flight.
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("c3", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
  });

  // AN ABANDONED LAUNCH MUST NOT KEEP CLAIMING TO BE IN FLIGHT.
  //
  // `inFlight` was set on read and cleared ONLY by `noteBriefFailed`, which the pane calls just for
  // `error`/`no-claude`. A pane that unmounted between reading the brief and `pty_spawn` (tab closed,
  // project switched, run superseded) left the flag stuck true, so a later timeout said `launching` —
  // "give it a moment rather than re-sending" — about a launch that had stopped happening. That is
  // the wrong-remedy shape this module exists to close, relocated into the flag added to close it.
  it("stops reporting `launching` once the launch carrying the brief was abandoned", async () => {
    attachBrief("c5", BRIEF);
    expect(briefForLaunch("c5", false)).toBe(BRIEF);
    // The pane unmounts before the PTY is spawned.
    noteBriefLaunchAbandoned("c5");
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("c5", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    fire!();
    // `unconfirmed`, whose copy correctly says to go and check — not `launching`.
    await expect(pending).resolves.toEqual({ state: "unconfirmed" });
  });

  // …but abandoning is NOT a failure: nothing is reported, and the brief stays deliverable so the
  // next mount still carries it. Guards the fix against being written as a `settle`.
  it("keeps the brief deliverable after an abandoned launch, answering no waiter", async () => {
    attachBrief("c6", BRIEF);
    expect(briefForLaunch("c6", false)).toBe(BRIEF);
    let settled: unknown;
    // Braces, not a bare assignment expression: `(settled = o)` would make this promise RESOLVE to
    // the outcome, so the "nothing was reported" assertion below would read the value it is meant to
    // prove absent.
    const pending = awaitBriefDelivery("c6", { timeoutMs: 10_000 }).then((o) => {
      settled = o;
    });
    noteBriefLaunchAbandoned("c6");
    await Promise.resolve();
    // No outcome was pushed to the waiter — abandoning is not an answer.
    expect(settled).toBeUndefined();
    expect(hasUndeliveredBrief("c6")).toBe(true);
    // The remount re-reads it and really delivers.
    expect(briefForLaunch("c6", false)).toBe(BRIEF);
    expect(noteBriefLaunched("c6")).toBe(BRIEF);
    await expect(pending).resolves.toBeUndefined();
    expect(settled).toEqual({ state: "submitted" });
  });

  // `inFlight` is set by whatever read happens DURING the wait, which is the ordinary case for a slow
  // spawn: the concierge is already waiting when the pane finally gets to its launch. Reading the
  // flag captured at call time instead of the current entry would report `unconfirmed` here.
  it("reports `launching` when the launch reads the brief AFTER the wait began", async () => {
    attachBrief("c4", BRIEF);
    let fire: (() => void) | undefined;
    const pending = awaitBriefDelivery("c4", {
      setTimer: (fn) => {
        fire = fn;
        return 1;
      },
      clearTimer: () => {},
    });
    expect(briefForLaunch("c4", false)).toBe(BRIEF);
    fire!();
    await expect(pending).resolves.toEqual({ state: "launching" });
  });
});

// ── the steering prelude (bead .3) ────────────────────────────────────────────────
//
// A feature that is registered but never REACHED is inert, and that is the failure these guard:
// the block only earns its place if the text an agent is actually launched with contains it.
describe("the steering prelude is part of the brief the agent is LAUNCHED with", () => {
  it("prepends this project's steering block, ahead of the mission", async () => {
    projectsMock.push({ rootPath: "/repo", agents: [{ id: "s1" }] });
    steeringBlockMock.mockResolvedValue(STEERING);

    await attachBrief("s1", BRIEF);

    const launched = briefForLaunch("s1", false);
    // THE SIDE EFFECT: what goes into claude's argv, not merely that the fetch was called.
    expect(launched).toContain("The test command is `pnpm verify`.");
    expect(launched).toContain(BRIEF);
    // Constraints must be in force while the agent reads the mission, so they come FIRST.
    expect(launched!.indexOf("HARD CONSTRAINTS")).toBeLessThan(launched!.indexOf(BRIEF));
    expect(steeringBlockMock).toHaveBeenCalledWith("/repo");
  });

  it("carries it all the way through a real launch assembly", async () => {
    projectsMock.push({ rootPath: "/repo", agents: [{ id: "s2" }] });
    steeringBlockMock.mockResolvedValue(STEERING);
    await attachBrief("s2", BRIEF);

    const spawn = assembleBuildSpawn({
      claudePath: "/bin/claude",
      resume: false,
      cwd: "/wt",
      persona: "persona",
      bridge: { socketPath: "/s", token: "t" },
      paths: { nodePath: "/node", serverPath: "/server.js" },
      initialPrompt: briefForLaunch("s2", false),
    });
    expect(spawn.args.some((a) => a.includes("The test command is `pnpm verify`."))).toBe(true);
  });

  it("leaves the brief EXACTLY as written when steering is disabled", async () => {
    projectsMock.push({ rootPath: "/repo", agents: [{ id: "s3" }] });
    // Rust answers "" for every off / nothing-to-say case — steering off, inject_at_preflight off,
    // or no files anywhere. There is no flag to read: the empty string IS the answer.
    steeringBlockMock.mockResolvedValue("");

    await attachBrief("s3", BRIEF);

    expect(briefForLaunch("s3", false)).toBe(BRIEF);
  });

  it("does not guess a project for an agent no project claims", async () => {
    projectsMock.push({ rootPath: "/other", agents: [{ id: "someone-else" }] });
    steeringBlockMock.mockResolvedValue(STEERING);

    await attachBrief("s4", BRIEF);

    expect(briefForLaunch("s4", false)).toBe(BRIEF);
    expect(steeringBlockMock).not.toHaveBeenCalled();
  });

  it("still delivers the mission when the steering lookup FAILS", async () => {
    projectsMock.push({ rootPath: "/repo", agents: [{ id: "s5" }] });
    steeringBlockMock.mockRejectedValue(new Error("steering_preflight_block: no such command"));

    // Must not reject: a brief that failed to attach costs the agent its whole mission, while
    // steering that could not be read costs it a hint.
    await expect(attachBrief("s5", BRIEF)).resolves.toBeUndefined();
    expect(briefForLaunch("s5", false)).toBe(BRIEF);
  });

  it("a re-spawn's brief is not overwritten by the superseded one's late steering", async () => {
    projectsMock.push({ rootPath: "/repo", agents: [{ id: "s6" }] });
    // Gate the FIRST lookup open so the interleaving under test is the one that runs, rather than
    // whichever way two racing microtask chains happened to fall (an ordering test written from
    // hope, not from the log, is the vacuous shape AGENTS.md names).
    const calls: string[] = [];
    let releaseFirst: (v: string) => void = () => {};
    steeringBlockMock.mockImplementation((root: string) => {
      calls.push(root);
      return calls.length === 1
        ? new Promise<string>((r) => {
            releaseFirst = r;
          })
        : Promise.resolve(STEERING);
    });

    const first = attachBrief("s6", "FIRST MISSION");
    await vi.waitFor(() => expect(calls.length).toBe(1));

    // The re-spawn lands while the first lookup is still in flight.
    await attachBrief("s6", "SECOND MISSION");
    releaseFirst(STEERING);
    await first;

    const launched = briefForLaunch("s6", false);
    expect(launched).toContain("SECOND MISSION");
    expect(launched).not.toContain("FIRST MISSION");
    // …and exactly one prelude, not the stale one stacked on top of the live one.
    expect(launched!.split("HARD CONSTRAINTS").length - 1).toBe(1);
  });
});
