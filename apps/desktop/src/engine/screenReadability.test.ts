// AN UNREADABLE SCREEN MUST NOT CLAIM TO BE AN APPROVAL — and must announce itself.
//
// The founder's report, in one line: a red row saying "Needs you" over a pane rendering nothing he
// could act on. Underneath, the app KNEW it was blind — `read_picker_options` answered
// `blind: 'no-menu'` and the send path refused with `alternate-screen` — and rendered that as an
// approval anyway.
//
// Two properties are pinned here, and they pull in opposite directions on purpose:
//   * blindness is REPORTED HONESTLY rather than as a button that does not exist, and
//   * blindness is NOT CALMED — `docs/never-hide-actionable-rows.md` forbids quieting a row the app
//     cannot see, because being unable to see a question is not evidence there isn't one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLIND_STATUS_LABEL,
  blindReasonSentence,
  isScreenBlind,
  noteScreenReadability,
  observeFeedReadability,
  REAL_FLEET_READABILITY,
  resetReadabilityAlarm,
  screenReadability,
  statusClaimsScreenContent,
  type ReadabilityAlarmDeps,
} from "./screenReadability";
import {
  PLAN_MODE_COMPOSER_2_1_237,
  ACCEPT_EDITS_COMPOSER_2_1_237,
} from "./capturedScreens.fixture";
import { agentToNudge, type NudgeReadabilityDeps } from "./conciergeNudges";
import {
  _resetConciergeEventLogForTests,
  drainEvents,
} from "../stores/conciergeEventLog";
import { registerViewport, resetViewportRegistry } from "../services/terminalViewport";
import type { ConciergeAgent } from "../services/conciergeFeed";

// GUARANTEES A CLEAN REGISTRY even if a test throws before its `finally` runs — a leaked provider
// would make the next test read a viewport it never registered. roborev 65893 flagged this import as
// unused (it was, and `no-unused-vars` is an ERROR here, so it would have failed lint); using it is
// the better of the two fixes offered.
afterEach(() => resetViewportRegistry());


/** A minimal feed carrying the given agents. Every readability test drives `observeFeedReadability`
 *  through this, exactly as production does — the list form is module-private on purpose, so there
 *  is no narrow-population entry point for a test to reach past it (roborev 65956). */
function feedOf(...agents: { id: string; topLevel?: boolean; parentRowId?: string | null }[]) {
  const base = {
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "blocked",
    statusColor: "#e0533f",
    statusLabel: "Blocked",
    band: "needs_you" as const,
    inScope: true,
    muted: false,
    representedElsewhere: false,
    redIsInherited: false,
    rolledUpGreen: false,
  };
  const full = agents.map((a) => ({
    ...base,
    name: a.id,
    topLevel: a.topLevel ?? true,
    parentRowId: a.parentRowId ?? null,
    ...a,
  }));
  const counts = { needs_you: full.length, questions: 0, running: 0, done: 0 };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: full },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as Parameters<typeof observeFeedReadability>[0];
}

const view = (text: string, alternateBuffer: boolean) => ({ text, alternateBuffer });

/** A genuine full-screen program: no composer box, no Claude chrome, no tool glyphs. This is the
 *  thing the alternate-screen refusal exists for, and it must STAY unreadable. */
const VIM_SCREEN = [
  '"notes.md" 42L, 1024B',
  "# Some heading",
  "",
  "Ordinary prose that happens to mention plan mode on and a picker.",
  "~",
  "~",
  "-- INSERT --",
].join("\n");

describe("screenReadability", () => {
  it("calls a normal-buffer screen readable, whatever is on it", () => {
    // The alternate buffer flag alone is not blindness and its absence is not either — a plain
    // shell prompt is readable by construction.
    expect(screenReadability(view("$ ls -la", false))).toEqual({ kind: "readable" });
  });

  it("calls a BUSY CLAUDE CODE readable even though it holds the alternate buffer", () => {
    // bead sparkle-v7k3y: Claude Code holds that buffer for its ordinary busy state, so treating
    // the flag as the answer calls the most common state in the app unreadable.
    expect(screenReadability(view(PLAN_MODE_COMPOSER_2_1_237, true))).toEqual({ kind: "readable" });
    expect(screenReadability(view(ACCEPT_EDITS_COMPOSER_2_1_237, true))).toEqual({
      kind: "readable",
    });
  });

  it("calls an unrecognised full-screen program blind", () => {
    expect(screenReadability(view(VIM_SCREEN, true))).toEqual({
      kind: "blind",
      reason: "unrecognized-fullscreen",
    });
  });

  it("calls a missing viewport blind, and distinguishes it from an unrecognised screen", () => {
    // NOT the same fact. An agent whose pane is not open in this window is not broken; only one of
    // these two is a defect, and the alarm below fires on exactly one of them.
    expect(screenReadability(null)).toEqual({ kind: "blind", reason: "no-viewport" });
  });

  it("isScreenBlind agrees with screenReadability on every case", () => {
    expect(isScreenBlind(null)).toBe(true);
    expect(isScreenBlind(view(VIM_SCREEN, true))).toBe(true);
    expect(isScreenBlind(view(PLAN_MODE_COMPOSER_2_1_237, true))).toBe(false);
    expect(isScreenBlind(view("$ ls", false))).toBe(false);
  });
});

describe("what a blind row says", () => {
  it("does not claim a button exists", () => {
    // THE ASSERTION THAT MATTERS. "Needs you" and "Approve?" both promise something to press. The
    // blind label must promise nothing, or it is the same lie in new words.
    expect(BLIND_STATUS_LABEL).not.toMatch(/needs you|approve/i);
  });

  it("names Sparkle as the thing that failed, not the agent", () => {
    const s = blindReasonSentence("Sparkle Off Pane Auto Resume", "sparkle");
    expect(s).toContain("Sparkle can't read");
    // A label blaming the agent would send the founder to debug a process that may be fine.
    expect(s).not.toMatch(/agent (is )?(unresponsive|dead|crashed)/i);
  });

  it("states the remedy, not just the failure", () => {
    // never-hide-actionable-rows asks for an ACTION. A row that says only "I can't read this" is
    // the same dead end wearing more honest words.
    expect(blindReasonSentence("A", "p")).toMatch(/force redraw/i);
  });
});

describe("agentToNudge — the row an unreadable agent actually gets", () => {
  // THE END-TO-END HALF. `screenReadability` answering correctly is worth nothing if the card the
  // founder reads still says "Needs you", which is exactly the shape of the original bug: the app
  // KNEW it was blind (the send path was refusing the same screen) and rendered an approval anyway.
  const agent = (over: Record<string, unknown> = {}) =>
    ({
      id: "a1",
      name: "Sparkle Off Pane Auto Resume",
      projectName: "sparkle",
      projectId: "p1",
      status: "approval",
      statusLabel: "Approve?",
      band: "needs_you",
      ...over,
    }) as unknown as ConciergeAgent;

  const withScreen = (text: string, alternateBuffer: boolean): NudgeReadabilityDeps => ({
    viewportFor: () => ({ text, alternateBuffer }),
  });

  it("stops claiming an approval when the screen cannot be read", () => {
    const n = agentToNudge(agent(), withScreen(VIM_SCREEN, true));
    expect(n.text).toContain(BLIND_STATUS_LABEL);
    // THE LIE ITSELF, asserted absent. This is the founder's complaint in one line.
    expect(n.text).not.toContain("Approve?");
  });

  it("offers Open agent rather than an Approve relay on a blind row", () => {
    // Relaying an approval into a screen the app cannot read presses whatever is there — the exact
    // hazard the alternate-screen refusal exists for.
    const n = agentToNudge(agent(), withScreen(VIM_SCREEN, true));
    expect(n.actions.map((x) => x.id)).toEqual(["open"]);
  });

  it("does NOT calm the row — the band is untouched", () => {
    // never-hide-actionable-rows. Being unable to SEE a question is not evidence there isn't one,
    // so blindness rewrites the words and never the loudness. A version of this change that also
    // downgraded the band would pass every other assertion here while hiding a real blocker.
    const n = agentToNudge(agent(), withScreen(VIM_SCREEN, true));
    expect(n.band).toBe("needs_you");
  });

  it("leaves a READABLE agent's card exactly as it was", () => {
    // THE PAIRED INVERSE. Without it, a builder that rendered "Can't read screen" for EVERYTHING
    // would satisfy all three assertions above while destroying every ordinary card in the app.
    const n = agentToNudge(agent(), withScreen(PLAN_MODE_COMPOSER_2_1_237, true));
    expect(n.text).toBe("Approve? — Sparkle Off Pane Auto Resume in sparkle.");
    expect(n.actions.map((x) => x.id)).toEqual(["approve"]);
  });

  it("leaves an agent whose pane is not mounted here as it was", () => {
    // `no-viewport` is the ordinary state of any agent this window does not host. Treating it as
    // blindness would relabel most of a multi-window fleet as unreadable.
    const n = agentToNudge(agent(), { viewportFor: () => null });
    expect(n.text).toBe("Approve? — Sparkle Off Pane Auto Resume in sparkle.");
  });
});

describe("blindness replaces a SCREEN claim and only annotates anything else", () => {
  // roborev 65876. `errored` ("process crashed/exited with an error") and `blocked` ("went quiet")
  // come from the status engine, not from reading the screen — and a crashed TUI is precisely what
  // leaves an unrecognised alternate buffer behind. Overwriting those would discard the one accurate
  // account of what happened and offer a redraw that cannot revive a dead process.
  const agent = (status: string, statusLabel: string) =>
    ({
      id: "a1",
      name: "Worker",
      projectName: "sparkle",
      projectId: "p1",
      status,
      statusLabel,
      band: "needs_you",
    }) as unknown as ConciergeAgent;

  const blindDeps: NudgeReadabilityDeps = {
    viewportFor: () => ({ text: VIM_SCREEN, alternateBuffer: true }),
  };

  for (const [status, label] of [
    ["approval", "Approve?"],
    ["waiting", "Needs you"],
  ] as const) {
    it(`REPLACES the label for "${status}" — its claim is about the screen`, () => {
      const n = agentToNudge(agent(status, label), blindDeps);
      expect(n.text).toContain(BLIND_STATUS_LABEL);
      expect(n.text).not.toContain(label);
    });
  }

  for (const [status, label] of [
    ["errored", "Errored"],
    ["blocked", "Blocked"],
  ] as const) {
    it(`KEEPS the true "${status}" label and only annotates it`, () => {
      const n = agentToNudge(agent(status, label), blindDeps);
      // THE FACT IS NOT DISCARDED — this is the assertion roborev asked for.
      expect(n.text).toContain(label);
      // ...and the blindness is still disclosed, so the human is not left wondering why the pane
      // looks empty.
      expect(n.text).toContain(BLIND_STATUS_LABEL);
    });
  }

  it("still refuses an Approve relay on an annotated row", () => {
    // The action rule keys on BLINDNESS, not on whether the label was replaced. A screen the app
    // cannot read must not be approved into, whatever the row happens to say above it.
    const n = agentToNudge(agent("errored", "Errored"), blindDeps);
    expect(n.actions.map((x) => x.id)).toEqual(["open"]);
  });

  it("statusClaimsScreenContent names only the screen-derived statuses", () => {
    expect(statusClaimsScreenContent("approval")).toBe(true);
    expect(statusClaimsScreenContent("waiting")).toBe(true);
    expect(statusClaimsScreenContent("errored")).toBe(false);
    expect(statusClaimsScreenContent("blocked")).toBe(false);
  });
});

describe("observeFeedReadability — the alarm sweeps the POPULATION, not just the cards", () => {
  beforeEach(() => resetReadabilityAlarm());

  // roborev 65876, and the reason this function exists at all. `buildDigest` emits a card only for a
  // bucket of ONE, so two agents sharing a project+band collapse into a group line and never reach
  // `agentToNudge`. An alarm raised from inside the card builder therefore fired with ONE blocked
  // agent per project and went SILENT with two — inverted against the saturated fleet that produced
  // the founder's report.
  it("alarms for every blind agent in the population, not only the first", () => {
    const record = vi.fn();
    const raised = observeFeedReadability(feedOf({ id: "a1" }, { id: "a2" }, { id: "a3" }), {
      viewportFor: () => ({ text: VIM_SCREEN, alternateBuffer: true }),
      families: () => 1,
      hasComposerBox: () => true,
      record,
    });
    expect(raised).toBe(3);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("skips readable agents while still reaching the blind ones behind them", () => {
    const record = vi.fn();
    const raised = observeFeedReadability(feedOf({ id: "ok" }, { id: "bad" }), {
      viewportFor: (id: string) =>
        id === "ok"
          ? { text: PLAN_MODE_COMPOSER_2_1_237, alternateBuffer: true }
          : { text: VIM_SCREEN, alternateBuffer: true },
      families: () => 1,
      hasComposerBox: () => true,
      record,
    });
    expect(raised).toBe(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ agentId: "bad" }));
  });

  // ══ THE SEAM THAT REGRESSED THREE TIMES, ASSERTED AT LAST ═══════════════════════════════════
  // roborev 65893 → 65897 → 65920. The bug was never in the sweep; it was in WHICH AGENTS THE
  // CALLER PASSED — first per-card, then `surfacedAgents` (topLevel-filtered, dropping rowless and
  // stranded workers). Two attempts to cover it asserted on the sweep or on a helper's body, both
  // of which stayed green with the caller reverted.
  //
  // `observeFeedReadability` takes the FEED, so the narrow choice no longer exists to be made. This
  // drives it against a feed whose blind agents are precisely the ones `surfacedAgents` excludes —
  // so if it ever narrows again, this goes red.
  it("observeFeedReadability reaches rowless and stranded workers, not just top-level heads", () => {
    const base = {
      projectId: "p1",
      projectName: "sparkle",
      kind: "build" as const,
      status: "blocked",
      statusColor: "#e0533f",
      statusLabel: "Blocked",
      band: "needs_you" as const,
      inScope: true,
      muted: false,
      representedElsewhere: false,
      redIsInherited: false,
      rolledUpGreen: false,
    };
    const agents = [
      { ...base, id: "head", name: "Head", topLevel: true, parentRowId: null },
      { ...base, id: "rowless", name: "Rowless", topLevel: false, parentRowId: "head" },
      { ...base, id: "stranded", name: "Stranded", topLevel: false, parentRowId: null },
    ];
    const counts = { needs_you: 3, questions: 0, running: 0, done: 0 };
    const feed = {
      projects: [{ id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents }],
      counts,
      scopedCounts: counts,
      pinnedProjectId: null,
    } as unknown as Parameters<typeof observeFeedReadability>[0];

    const record = vi.fn();
    const raised = observeFeedReadability(feed, {
      viewportFor: () => ({ text: VIM_SCREEN, alternateBuffer: true }),
      families: () => 1,
      hasComposerBox: () => true,
      record,
    });

    // THE TWO NON-TOP-LEVEL IDS ARE THE ASSERTION. A caller narrowed back to `surfacedAgents` would
    // observe only "head", and both of these would be missing.
    expect(raised).toBe(3);
    expect(record.mock.calls.map((c) => (c[0] as { agentId: string }).agentId).sort()).toEqual([
      "head",
      "rowless",
      "stranded",
    ]);
  });

  // ══ THE PRODUCTION WIRING ITSELF, EXECUTED ══════════════════════════════════════════════════
  // roborev 65876 flagged the previous cut as a DEFAULTED SEAM WITH ZERO COVERAGE — the shape
  // AGENTS.md names as bead sparkle-lgbwf. Every other test here injects fakes, so the single line
  // supplying the real `recordConciergeEvent` was covered by nothing: delete it and the suite stays
  // green while the announced alarm is inert in production, which is the same silent failure the
  // alarm exists to prevent. This drives the REAL deps object against a REALLY registered viewport
  // and asserts the event reaches the REAL log.
  it("REAL_FLEET_READABILITY lands a real event in the real log", () => {
    _resetConciergeEventLogForTests();
    const unregister = registerViewport("live-1", () => ({
      text: VIM_SCREEN,
      alternateBuffer: true,
    }));
    try {
      expect(observeFeedReadability(feedOf({ id: "live-1" }), REAL_FLEET_READABILITY)).toBe(1);
      const drained = drainEvents({ since: 0, kinds: ["screen_unrecognized"] });
      expect(drained.events).toHaveLength(1);
      expect(drained.events[0]).toMatchObject({ kind: "screen_unrecognized", agentId: "live-1" });
    } finally {
      unregister();
    }
  });

  it("REAL_FLEET_READABILITY stays silent on a real Claude Code screen", () => {
    // THE PAIRED INVERSE. Without it, a wiring that alarmed on EVERYTHING would satisfy the test
    // above while burying the log in false positives.
    _resetConciergeEventLogForTests();
    const unregister = registerViewport("live-2", () => ({
      text: PLAN_MODE_COMPOSER_2_1_237,
      alternateBuffer: true,
    }));
    try {
      expect(observeFeedReadability(feedOf({ id: "live-2" }), REAL_FLEET_READABILITY)).toBe(0);
      expect(drainEvents({ since: 0, kinds: ["screen_unrecognized"] }).events).toHaveLength(0);
    } finally {
      unregister();
    }
  });
});

describe("the regression alarm", () => {
  beforeEach(() => resetReadabilityAlarm());

  const deps = (over: Partial<ReadabilityAlarmDeps> = {}) => {
    const record = vi.fn();
    const d: ReadabilityAlarmDeps = {
      families: () => 1,
      hasComposerBox: () => true,
      record,
      ...over,
    };
    return { d, record };
  };

  const blind = { kind: "blind", reason: "unrecognized-fullscreen" } as const;

  it("records an event naming the detector's verdict", () => {
    const { d, record } = deps({ families: () => 1, hasComposerBox: () => true });
    expect(noteScreenReadability("a1", blind, VIM_SCREEN, d)).toBe(true);
    expect(record).toHaveBeenCalledWith({
      kind: "screen_unrecognized",
      agentId: "a1",
      families: 1,
      composerBox: true,
    });
  });

  it("carries NO screen text — the event log forbids user data", () => {
    // Property 4 of stores/conciergeEventLog: these records are handed to a model and may be quoted
    // back. The diagnosis travels as the detector's verdict instead, which is what actually names
    // the rotted family.
    const { d, record } = deps();
    noteScreenReadability("a1", blind, VIM_SCREEN, d);
    const payload = JSON.stringify(record.mock.calls[0]![0]);
    expect(payload).not.toContain("INSERT");
    expect(payload).not.toContain("notes.md");
  });

  it("is EDGE-TRIGGERED — a permanently blind pane does not mint an event per tick", () => {
    // The check runs every feed tick. Without this the alarm evicts the entire ring and destroys
    // the log it writes to.
    const { d, record } = deps();
    expect(noteScreenReadability("a1", blind, VIM_SCREEN, d)).toBe(true);
    expect(noteScreenReadability("a1", blind, VIM_SCREEN, d)).toBe(false);
    expect(noteScreenReadability("a1", blind, VIM_SCREEN, d)).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("re-arms once the agent reads clean again, so a flapping pane stays visible", () => {
    // THE PAIRED CASE. Edge-triggering without a re-arm records a recurring fault exactly once,
    // forever — which is indistinguishable from a fault that was fixed.
    const { d, record } = deps();
    noteScreenReadability("a1", blind, VIM_SCREEN, d);
    noteScreenReadability("a1", { kind: "readable" }, "", d);
    expect(noteScreenReadability("a1", blind, VIM_SCREEN, d)).toBe(true);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("latches PER AGENT — one blind agent does not suppress another's alarm", () => {
    const { d, record } = deps();
    noteScreenReadability("a1", blind, VIM_SCREEN, d);
    expect(noteScreenReadability("a2", blind, VIM_SCREEN, d)).toBe(true);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("does NOT alarm on a missing viewport", () => {
    // The ordinary state of every agent whose pane is not open in this window. Alarming on it would
    // fire constantly, for something that is not a defect, drowning the signal.
    const { d, record } = deps();
    expect(
      noteScreenReadability("a1", { kind: "blind", reason: "no-viewport" }, "", d),
    ).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it("does NOT alarm on a readable screen", () => {
    const { d, record } = deps();
    expect(noteScreenReadability("a1", { kind: "readable" }, "", d)).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});
