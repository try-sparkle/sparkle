// THE ON-SCREEN RESUME BANNER FAST-TRACKS A CLEANLY-STOPPED PANE (sparkle-tab3nm).
//
// The founder's P0: a worker's claude PROCESS exits, the row shows "Terminal stopped" over
// `Resume this session with: claude --resume <id>`, and — before this change — nothing restarted it
// for up to 30 minutes, because a watched PTY exit classifies `unknown` and `armsOnSlowestRung`
// holds `unknown` on the 30-minute ceiling. The graceful-exit banner is positive evidence of a CLEAN
// resumable stop (a segfault/kill prints no such line), so the sweep fast-tracks it onto the normal
// ladder. This drives the REAL sweep and asserts the SIDE EFFECT — the mount/restart CALL fires — for
// a banner-confirmed stop, and does NOT for the same stop without the banner, nor for a live agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RESURRECT_LADDER_MS } from "../engine/resurrection";
import {
  _resetResurrectionRunnerForTests,
  type DueAgent,
  type ResurrectionSweepOptions,
  sweepResurrections,
} from "./resurrectionRunner";
import { resetAdmittedAgents } from "./resurrectionAdmission";
import { StatusEngine } from "../engine/statusEngine";
import {
  registerStatusEngine,
  resumeBannerForAgent,
  unregisterStatusEngine,
} from "../engine/engineRegistry";

const NOW = 1_754_534_400_000;
const FIRST_RUNG = RESURRECT_LADDER_MS[0]!; // 60s

/** A single watched PTY exit — the founder's lone-death shape (`unknown` cause, no wall, no error). */
function stopped(over: Partial<DueAgent> = {}): DueAgent {
  return {
    agentId: "a1",
    projectId: "proj-1",
    worktree: "/wt/a1",
    cause: "unknown",
    epoch: "epoch-still-alive",
    diedAt: NOW,
    notBeforeMs: NOW,
    message: null,
    attemptsAt: [],
    ...over,
  };
}

/** Everything permissive, `mount` recorded, evaluated ONE first-rung after death. `resumeBannerShown`
 *  and `liveSessions` are what each case varies. */
function opts(
  due: DueAgent[],
  over: Partial<ResurrectionSweepOptions>,
  mounted: string[],
): ResurrectionSweepOptions {
  return {
    now: NOW + FIRST_RUNG,
    ownsProject: () => true,
    projectTornOut: () => false,
    hasAgentRow: () => true,
    due: () => Promise.resolve(due),
    liveSessions: () => Promise.resolve([]),
    claim: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    suppress: () => {},
    mount: (id) => {
      mounted.push(id);
      return "restarted";
    },
    resumeBannerShown: () => false,
    ...over,
  };
}

beforeEach(() => {
  _resetResurrectionRunnerForTests();
  resetAdmittedAgents();
});

describe("a cleanly-stopped pane showing the resume banner auto-resumes promptly", () => {
  it("THE TEST: banner present → the sweep RESTARTS it at the first rung (auto-resume is invoked)", async () => {
    const mounted: string[] = [];
    const outcomes = await sweepResurrections(
      opts([stopped()], { resumeBannerShown: () => true }, mounted),
    );
    // The mount lever actually ran for this agent — the "give the watcher a RESTART verb" the bead asks
    // for, fired without waiting out the 30-minute slow rung.
    expect(mounted).toEqual(["a1"]);
    expect(outcomes).toEqual([
      { agentId: "a1", action: "respawn", detail: "attempt 1 (restarted)" },
    ]);
  });

  it("PAIRED NEGATIVE — same stop, NO banner → still on the 30-min rung, nothing is restarted", async () => {
    const mounted: string[] = [];
    const outcomes = await sweepResurrections(
      opts([stopped()], { resumeBannerShown: () => false }, mounted),
    );
    // Without the positive clean-stop evidence, an `unknown` death waits — a possible silent crash must
    // not be fork-bombed. This is the exact assertion that pins the banner as the load-bearing input:
    // flip it to true above and the mount fires; false and it does not.
    expect(mounted).toEqual([]);
    expect(outcomes).toEqual([
      { agentId: "a1", action: "none", detail: "waiting-for-next-rung" },
    ]);
  });

  it("a LIVE agent is never resumed, banner or not (a running row stays green)", async () => {
    const mounted: string[] = [];
    const outcomes = await sweepResurrections(
      opts(
        [stopped()],
        { resumeBannerShown: () => true, liveSessions: () => Promise.resolve(["a1"]) },
        mounted,
      ),
    );
    // Its PTY is still in the live-session map, so `decideResurrection` refuses it as `already-live`
    // and the restart verb never fires — resurrection acts only on a process that is explicitly dead.
    expect(mounted).toEqual([]);
    expect(outcomes).toEqual([{ agentId: "a1", action: "none", detail: "already-live" }]);
  });
});


// ── THE PRODUCTION SEAM, DRIVEN END-TO-END (roborev 68218) ────────────────────────────────────────
// The three cases above INJECT `resumeBannerShown`, which is right for testing the sweep's decision
// but leaves the one line wiring it to production — `resumeBannerShown ?? resumeBannerForAgent`, and
// `resumeBannerForAgent` reading a registered StatusEngine — asserted by nothing (the defaulted-seam
// trap AGENTS.md names). These drive the REAL default: a StatusEngine registered in the registry, its
// banner read back through `resumeBannerForAgent`, and a sweep that OMITS `resumeBannerShown` so the
// production path runs. Modelled on `accountSwitch.quotaRelease.test.ts`'s treatment of the sibling
// seams in the same registry.
const RESUME_SCREEN = [
  "work done.",
  "",
  "Resume this session with:",
  "  claude --resume 4c1f6312-e927-47c2-aa8b-4a08cbdb3df9",
  "",
].join("\n");

describe("the registry seam that wires the banner to production", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    unregisterStatusEngine("seam-1", REGISTERED);
  });

  let REGISTERED: StatusEngine;

  it("resumeBannerForAgent reads a registered engine: false before exit, true after, false when unregistered", () => {
    // Unregistered → false (the SAFE default: no engine, no fast-track).
    expect(resumeBannerForAgent("seam-1")).toBe(false);
    REGISTERED = new StatusEngine({
      agentId: "seam-1",
      onStatus: () => {},
      getScreen: () => RESUME_SCREEN,
    });
    registerStatusEngine("seam-1", REGISTERED);
    // Registered but ALIVE → still false (the liveness gate).
    expect(resumeBannerForAgent("seam-1")).toBe(false);
    REGISTERED.exit();
    // Registered AND exited AND banner on screen → true.
    expect(resumeBannerForAgent("seam-1")).toBe(true);
  });

  it("THE PRODUCTION DEFAULT: a sweep that OMITS resumeBannerShown reads the live engine and restarts", async () => {
    REGISTERED = new StatusEngine({
      agentId: "seam-1",
      onStatus: () => {},
      getScreen: () => RESUME_SCREEN,
    });
    registerStatusEngine("seam-1", REGISTERED);
    REGISTERED.exit();

    const mounted: string[] = [];
    // NOTE: no `resumeBannerShown` key — the sweep falls back to `resumeBannerForAgent`, the real
    // production wiring. Remove the `?? resumeBannerForAgent` default and this reds while the injected
    // cases above stay green — which is the exact gap this test closes.
    const outcomes = await sweepResurrections({
      now: NOW + FIRST_RUNG,
      ownsProject: () => true,
      projectTornOut: () => false,
      hasAgentRow: () => true,
      due: () => Promise.resolve([stopped({ agentId: "seam-1" })]),
      liveSessions: () => Promise.resolve([]),
      claim: () => Promise.resolve(true),
      release: () => Promise.resolve(),
      suppress: () => {},
      mount: (id) => {
        mounted.push(id);
        return "restarted";
      },
    });

    expect(mounted).toEqual(["seam-1"]);
    expect(outcomes).toEqual([
      { agentId: "seam-1", action: "respawn", detail: "attempt 1 (restarted)" },
    ]);
  });
});
