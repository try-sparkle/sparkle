// END-TO-END: the reported bug, driven through the REAL state machine.
//
// Every other test in this change tests one layer. This one wires the two together — the actual
// StatusEngine producing the actual status, then the actual overlay correcting it — because the bug
// only exists at the join. Read on its own, `statusEngine` escalating a silent agent to `blocked` is
// correct behaviour, and so is `blocked` being red; what was wrong is that a never-briefed agent
// went down that path at all.
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

  it("the engine really does escalate it to red `blocked` — the bug is real", () => {
    // Pinned so this file fails loudly if the underlying behaviour is ever changed at the engine
    // instead, rather than silently testing nothing.
    const { last } = run(IDLE_SCREEN);
    expect(last()).toBe("blocked");
    expect(isRedStatus(last())).toBe(true);
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
    // `working → idle → blocked`, so it was already false for every RAW status before any
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

  it("STILL goes red for a BRIEFED agent that stalls the same way", () => {
    const { last } = run(IDLE_SCREEN);
    const briefed = { ...briefless, lastPrompt: "go build the thing" };
    const corrected = calmNewAgent(last(), briefed, SPAWN + 26_000)!;

    expect(corrected).toBe("blocked");
    expect(isRedStatus(corrected)).toBe(true);
  });
});
