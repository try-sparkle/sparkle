// END-TO-END: a spawned, un-briefed agent driven through the REAL state machine — the actual
// StatusEngine producing the actual status, then the actual overlay correcting it.
//
// This file was written against an EARLIER design in which `statusEngine` escalated a silent agent
// to red `blocked` at the 25s stall timer, and the `calmNewAgent` overlay corrected that red down to
// `new` for never-briefed rows. That engine escalation has since been REMOVED — silence is not
// evidence of anything, so a quiet terminal never produces a red at all now (see statusEngine.ts
// SCREEN_RECHECK_MS: a long `pnpm test`, a `roborev wait`, a CI poll and a finished agent parked at
// its idle prompt are all silent). The join this file exercises is therefore now
// `settle -> idle -> the overlay`, and the invariant it pins is that NOTHING on the silent path
// reaches the red / needs-you tier — briefed or not. A REAL ask (a permission menu on screen) still
// goes red immediately; that is evidence, and the permission-menu case below still asserts it.
//
// FAKE TIMERS HERE ARE THE PTY CLOCK, NOT THE SPAWN CLOCK. statusEngine's stall timers are real
// setTimeouts and the whole suite already drives them with vi.advanceTimersByTime (see
// statusEngine.test.ts). The spawn-age backstop is a DIFFERENT clock and is injected as a plain
// `now` parameter — never faked — so a passing assertion here cannot be an artifact of timer
// mocking. The two are deliberately kept separate.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { calmNewAgent } from "./newAgentAttention";
import { isRedStatus } from "../services/windowStatus";
import { needsAttention } from "./attention";
import { DEFAULT_NOTIFY_STATUSES } from "../stores/settingsStore";
import type { AgentTabStatus } from "../types";

/** Claude's idle input box, as the rendered snapshot looks when it is sitting there with nothing to
 *  do. screenClassifier deliberately does NOT read this as a prompt (its header says so), which is
 *  why settle lands on `idle` rather than `waiting`. */
const IDLE_SCREEN = ["╭───────────────╮", "│ >             │", "╰───────────────╯"].join("\n");

/** A rendered permission menu — a REAL ask, with the ❯ selection cursor. */
const PERMISSION_SCREEN = [
  "│ Do you want to make this edit to foo.ts?           │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No, and tell Claude what to do differently    │",
].join("\n");

function run(screen: string): { statuses: AgentTabStatus[]; last: () => AgentTabStatus } {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({
    agentId: "test",
    onStatus: (s) => statuses.push(s),
    getScreen: () => screen,
  });
  // A freshly spawned Claude prints its banner and then goes quiet — no spinner, because there is no
  // turn to run. That is exactly the shape that drops the engine onto the legacy stall path.
  engine.ingest("Welcome to Claude Code!\n");
  vi.advanceTimersByTime(2500); // IDLE_MS   -> settle
  vi.advanceTimersByTime(25_000); // BLOCKED_MS -> the stall escalation
  engine.dispose();
  return { statuses, last: () => statuses[statuses.length - 1]! };
}

const SPAWN = 1_000_000;
const briefless = { id: "test", lastPrompt: "", promptHistory: [], createdAt: SPAWN };

describe("a spawned, un-briefed agent, driven through the real StatusEngine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the engine leaves a silent agent at `idle` and never reds it — silence is not evidence", () => {
    // This used to assert the engine escalated to red `blocked` after the 25s stall timer, and was
    // pinned so the file would fail loudly if that behaviour ever moved. It did move, deliberately:
    // the escalation was removed at the engine (statusEngine SCREEN_RECHECK_MS). The screen check at
    // settle already said "no question here -> gray", nothing new is observed in the 25s that follow,
    // so the status STAYS idle. The pin now guards the opposite invariant — that a quiet terminal
    // never re-reddens — so a silence-driven red reintroduced at the engine still fails this loudly.
    const { statuses, last } = run(IDLE_SCREEN);
    expect(last()).toBe("idle");
    expect(isRedStatus(last())).toBe(false);
    expect(statuses).not.toContain("blocked");
    expect(statuses.filter(isRedStatus)).toEqual([]);
  });

  it("…and the overlay turns that into a calm `new` the fleet does not report", () => {
    const { last } = run(IDLE_SCREEN);
    const corrected = calmNewAgent(last(), briefless, SPAWN + 26_000)!;

    expect(corrected).toBe("new");
    expect(isRedStatus(corrected)).toBe(false);
    expect(needsAttention(corrected)).toBe(false);
  });

  it("passes through `idle` on the way, which is ALSO corrected", () => {
    // The 22.5s the agent spends at `idle` before the stall timer fires is the state it actually
    // lives in most of the time, and `idle` NOTIFIES BY DEFAULT — that is the whole reason this
    // point on the path matters.
    //
    // This case used to assert `needsAttention`, which proved nothing (roborev 54748): that
    // predicate is the narrow badge/relay set {waiting, approval, errored}, and the path here is
    // `working → idle` (no longer `→ blocked` — the engine stall escalation was removed), so it
    // was already false for every RAW status before any
    // correction. The test passed identically with the overlay replaced by the identity function.
    // Assert the corrected VALUE, and assert the notification claim against the set that actually
    // governs it.
    const { statuses } = run(IDLE_SCREEN);
    expect(statuses).toContain("idle");
    for (const s of statuses) {
      const corrected = calmNewAgent(s, briefless, SPAWN + 26_000)!;
      // `working` is not a red and is not a never-briefed state — it passes through untouched.
      expect(corrected, s).toBe(s === "working" ? "working" : "new");
      // The claim that matters: nothing on this path is left in a status that pings by default.
      // Meaningfully red today for raw `idle`, which IS true in DEFAULT_NOTIFY_STATUSES.
      expect(DEFAULT_NOTIFY_STATUSES[corrected] === true, `${s} → ${corrected}`).toBe(false);
    }
  });

  it("STILL goes red when the same fresh agent draws a real permission menu", () => {
    // The regression that matters. Same agent, same age, same absence of a brief — but this time it
    // put a question on screen, so the engine reports `approval` and the overlay must not touch it.
    const statuses: AgentTabStatus[] = [];
    const engine = new StatusEngine({
      agentId: "test",
      onStatus: (s) => statuses.push(s),
      getScreen: () => PERMISSION_SCREEN,
    });
    engine.ingest("Welcome to Claude Code!\n");
    vi.advanceTimersByTime(2500);
    engine.dispose();

    const settled = statuses[statuses.length - 1]!;
    expect(settled).toBe("waiting");
    // One second old, no brief, and it goes red anyway — evidence beats the grace period.
    const corrected = calmNewAgent(settled, briefless, SPAWN + 1_000)!;
    expect(corrected).toBe("waiting");
    expect(isRedStatus(corrected)).toBe(true);
    expect(needsAttention(corrected)).toBe(true);
  });

  it("a BRIEFED agent that stalls the same way is ALSO not red — silence is not evidence for anyone", () => {
    // Under the earlier design the overlay withheld the grace period from briefed agents, so a
    // briefed agent that went silent stayed red `blocked` — the engine had reddened it and the
    // overlay left briefed rows untouched. With the escalation gone at the engine there is no red to
    // withhold: the briefed agent settles at `idle` (a finished-turn "your turn", NOT a needs-you),
    // and the overlay still leaves briefed rows untouched, so it stays `idle`. A briefed agent that
    // draws a REAL question still goes red immediately — that is the permission-menu case above,
    // which is evidence rather than silence.
    const { last } = run(IDLE_SCREEN);
    const briefed = { ...briefless, lastPrompt: "go build the thing" };
    const corrected = calmNewAgent(last(), briefed, SPAWN + 26_000)!;

    expect(corrected).toBe("idle");
    expect(isRedStatus(corrected)).toBe(false);
    // The same raw `idle`, UN-briefed, IS still corrected to `new` — proving this case is about the
    // brief, not about `idle` being inert, and that the overlay's briefed/un-briefed distinction
    // survives the engine change (a parallel rebase of this branch pinned exactly this contrast).
    expect(calmNewAgent(last(), briefless, SPAWN + 26_000)).toBe("new");
  });
});
