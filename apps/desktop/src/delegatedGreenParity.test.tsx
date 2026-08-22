// @vitest-environment jsdom
// AN AGENT WITH LIVE SUBAGENTS RENDERS ACTIVE — ON BOTH CHAINS, FOR BOTH ROW KINDS.
//
// ══ THE REPORT THIS PINS (founder, 2026-08-22, with a screenshot) ═══════════════════════════════
// "The improved sparkle's status icon continues to be problematic. You can see it's gray right now,
// but it IS actively working. It has many sub agents working. So it shouldn't be gray."
// and, separately:
// "sometimes I've noticed that it's waiting on the sub agents to finish, and it should again be
// green when that's happening."
//
// TWO STATES, BOTH GREEN. (1) working WITH subagents live; (2) BLOCKED WAITING on them. (2) is the
// one that was missed, because from the parent's own PTY it is indistinguishable from doing nothing
// — no spinner, no output, no tool calls, for minutes. Delegated work IS activity.
//
// ══ THE HARD RULE ══════════════════════════════════════════════════════════════════════════════
// "I do want it to work exactly like the build agents, so that's the hard rule. The colors work the
// same between the two, and don't let any instruction ever override that."
// So every case below runs TWICE — once for a build row, once for the app-owned self row — and the
// self case passes an EMPTY roster, because that is the REAL condition (`services/knownAgents.ts`:
// Improve Sparkle "is DELIBERATELY never a member of any project's `agents` array"). A version of
// this test that put the sparkle id in `agents` would pass against the very bug it exists to catch —
// which is exactly what `backgroundTaskGreen.test.ts` did by standing a build agent in for the self
// row and calling it "the Improve-Sparkle shape".
//
// ══ WHY BOTH CHAINS ════════════════════════════════════════════════════════════════════════════
// `hooks/useOverlaidStatus` (what the sidebar row's COLOUR descends from) and
// `useAttentionNotifications.composeRollup` (the published map, the column disc, the feed) are
// parallel copies of one chain. `publishedRollupAgreement.test.ts` is structurally blind to the
// divergence because both maps it compares come out of the one `composeRollup`. The divergence was
// real and it WAS this bug: `composeRollup` applied the green-while-delegating promotion and
// `useOverlaidStatus` did not, so the rollup and the row's own status both read "running" — nothing
// disagreed, so nothing overrode — and the disc kept painting the `idle` the sidebar chain held.
//
// The screens are driven through the REAL parser and parked through the REAL registry, so this
// asserts the WIRING and not just the arithmetic: `engine/statusEngine.noteBackgroundTasksFromScreen`
// makes exactly these two calls, in this order.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { AGENT_STATUS } from "@sparkle/ui/tokens";

import { useOverlaidStatus } from "./hooks/useOverlaidStatus";
import { publishedStatusFor, rollupViewFor } from "./useAttentionNotifications";
import { bandOfStatus } from "./engine/buildSections";
import { bandOfRollup } from "./engine/workerRollup";
import { parseDelegatedWorkCount } from "./engine/backgroundTaskFooter";
import {
  noteBackgroundTasks,
  _resetBackgroundTaskRegistryForTests,
} from "./services/backgroundTaskRegistry";
import { useRuntimeStore } from "./stores/runtimeStore";
import { SPARKLE_AGENT_ID } from "./services/sparkleAgent";
import type { AgentTab, AgentTabStatus } from "./types";

function mk(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "briefed",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  } as AgentTab;
}

const NO_STAGE = () => undefined as never;
const NO_PANES = new Set<string>();

// ── THE TWO SCREENS, verbatim in the shapes Claude Code actually draws ──────────────────────────
/** STATE 1 — the agent is working AND has delegated. Spinner on screen, backgrounded work counted. */
const WORKING_WITH_SUBAGENTS = [
  "✻ Crunched for 2s",
  "",
  "3 background tasks live [ctrl+b to manage]",
].join("\n");

/** STATE 2 — BLOCKED WAITING on subagents. No spinner, no footer, no output: the roster is the ONLY
 *  sign of life, and it has REPLACED the composer box. Transcribed from the founder's screenshot
 *  (the same rows `engine/claudeCodeScreen.test.ts` carries). */
const WAITING_ON_SUBAGENTS = [
  "⏺ main",
  "◯ general-purpose  Concierge agents as clickable rows  21m 55s",
  "◯ general-purpose  Trustworthy status dot: bg-task si… 10m 29s",
].join("\n");

/** A finished agent: a turn's leftovers, nothing live. The paired case for every assertion below. */
const NOTHING_DELEGATED = ["⏺ Done — all three landed.", "", "────────────", "❯ "].join("\n");

/** The production path, minus the PTY: parse the rendered screen, park what it found.
 *  `engine/statusEngine.noteBackgroundTasksFromScreen` is these two calls in this order. */
function observeScreen(agentId: string, screen: string): number | null {
  const count = parseDelegatedWorkCount(screen);
  if (count !== null) noteBackgroundTasks(agentId, count);
  return count;
}

/** What the SIDEBAR ROW paints — `hooks/useOverlaidStatus`, through the real store. */
function sidebarStatus(agents: AgentTab[], status: Record<string, AgentTabStatus>, id: string) {
  useRuntimeStore.setState({
    status, openAgentIds: [], lastObserved: {}, observedAttention: {},
    branchStatus: {}, workflowStage: {},
  } as never);
  const { result } = renderHook(() => useOverlaidStatus(agents));
  return result.current.status[id];
}

/** What every OTHER surface reads — the published map and the column's rolled-up disc. */
function publishedSurfaces(agents: AgentTab[], status: Record<string, AgentTabStatus>, id: string) {
  return {
    published: publishedStatusFor(agents, status, NO_PANES, {}, NO_STAGE)[id],
    columnBand: bandOfRollup(rollupViewFor(agents, status, NO_PANES, {}, NO_STAGE).dotOf(id)),
  };
}

/** THE TWO ROW KINDS. The self row's roster is EMPTY on purpose — see the header. */
const ROW_KINDS: { kind: string; id: string; agents: AgentTab[] }[] = [
  { kind: "a build row", id: "b1", agents: [mk("b1")] },
  { kind: "the self row", id: SPARKLE_AGENT_ID, agents: [] },
];

const STATES = [
  { name: "working WITH subagents live", screen: WORKING_WITH_SUBAGENTS },
  { name: "BLOCKED WAITING on its subagents", screen: WAITING_ON_SUBAGENTS },
] as const;

describe("delegated work counts as activity", () => {
  beforeEach(() => _resetBackgroundTaskRegistryForTests());
  afterEach(() => {
    _resetBackgroundTaskRegistryForTests();
    useRuntimeStore.setState({ status: {}, openAgentIds: [] } as never);
  });

  for (const { kind, id, agents } of ROW_KINDS) {
    for (const { name, screen } of STATES) {
      it(`${kind} ${name} is ACTIVE on the chain the row's colour reads`, () => {
        expect(observeScreen(id, screen), "the screen carried no delegated work").not.toBeNull();
        const st = sidebarStatus(agents, { [id]: "idle" }, id);
        // THE SIDE EFFECT, not the precondition: the status the disc paints, and its actual colour.
        expect(st).toBe("working");
        expect(bandOfStatus(st!)).toBe("running");
        expect(AGENT_STATUS[st!].color).toBe(AGENT_STATUS.working.color);
      });

      it(`${kind} ${name} is ACTIVE on the published chain too`, () => {
        observeScreen(id, screen);
        const { published, columnBand } = publishedSurfaces(agents, { [id]: "idle" }, id);
        expect(published).toBe("working");
        expect(columnBand).toBe("running");
      });

      it(`${kind} ${name} — the two chains AGREE, which no agreement test can see`, () => {
        observeScreen(id, screen);
        const viaSidebar = sidebarStatus(agents, { [id]: "idle" }, id);
        const { published } = publishedSurfaces(agents, { [id]: "idle" }, id);
        expect(viaSidebar, "the sidebar chain diverged from the published chain").toBe(published);
      });
    }

    // ── NON-VACUITY: the SAME row, with nothing delegated, must still go gray ────────────────────
    // Without this pair every assertion above would also pass for a rule that painted every row
    // green unconditionally.
    it(`${kind} with NOTHING delegated stays GRAY — the paired case`, () => {
      expect(observeScreen(id, NOTHING_DELEGATED)).toBeNull();
      const st = sidebarStatus(agents, { [id]: "idle" }, id);
      expect(st).toBe("idle");
      expect(bandOfStatus(st!)).toBe("done");
      expect(AGENT_STATUS[st!].color).not.toBe(AGENT_STATUS.working.color);
      expect(publishedSurfaces(agents, { [id]: "idle" }, id).published).toBe("idle");
    });

    // ── RED WINS. Motion never repaints an ask: the founder's rule is that red means only he can
    // clear it, and a live subagent does not answer a question the agent is asking.
    it(`${kind} asking a question stays RED even with subagents live`, () => {
      observeScreen(id, WAITING_ON_SUBAGENTS);
      const st = sidebarStatus(agents, { [id]: "waiting" }, id);
      expect(st).toBe("waiting");
      expect(bandOfStatus(st!)).toBe("needs_you");
    });
  }

  // ── THE PARITY ASSERTION THE HARD RULE ACTUALLY NAMES ───────────────────────────────────────────
  // Not "each row kind is green" but "they reach the SAME answer". A future change that greens one
  // and not the other fails here even if both cases above were rewritten to match it.
  for (const { name, screen } of STATES) {
    it(`the self row and a build row reach the same COLOUR while ${name}`, () => {
      observeScreen("b1", screen);
      observeScreen(SPARKLE_AGENT_ID, screen);
      const build = sidebarStatus([mk("b1")], { b1: "idle" }, "b1");
      const self = sidebarStatus([], { [SPARKLE_AGENT_ID]: "idle" }, SPARKLE_AGENT_ID);
      expect(self, "the self row diverged from a build row").toBe(build);
      expect(AGENT_STATUS[self!].color).toBe(AGENT_STATUS[build!].color);
      // …and the comparison is not "gray === gray": the build row genuinely MOVED.
      expect(build).toBe("working");
    });
  }

  // ── THE WIDENING MUST NOT LEAK ──────────────────────────────────────────────────────────────────
  it("does not admit a foreign agent that is in no roster", () => {
    observeScreen("ghost", WAITING_ON_SUBAGENTS);
    expect(sidebarStatus([], { ghost: "idle" }, "ghost")).toBe("idle");
  });
});

// ══ THE SCREEN PARSER, DIRECTLY ═══════════════════════════════════════════════════════════════════
// The status assertions above all run through `parseDelegatedWorkCount`, so if it silently stopped
// recognising a surface every one of them would go red together — but they could not say WHICH
// surface died. These name them one at a time, which is what makes a TUI retune diagnosable.
describe("parseDelegatedWorkCount — the two surfaces Claude Code draws", () => {
  it("counts the backgrounded-task footer", () => {
    expect(parseDelegatedWorkCount(WORKING_WITH_SUBAGENTS)).toBe(3);
  });

  it("counts the live subagent ROSTER, which carries no footer at all", () => {
    // The regression this whole change exists for: before it, this screen parsed as NOTHING.
    expect(WAITING_ON_SUBAGENTS).not.toMatch(/background tasks? live/i);
    expect(parseDelegatedWorkCount(WAITING_ON_SUBAGENTS)).toBe(2);
  });

  it("is null on a finished screen — an ABSENCE, never a zero entry", () => {
    expect(parseDelegatedWorkCount(NOTHING_DELEGATED)).toBeNull();
  });

  // Position is what separates Claude's LIVE roster from a pager QUOTING one. This module's own
  // header notes that the bead describing the feature reproduces a row verbatim, so a doc on screen
  // trips the row pattern — and a quoted list must never park a count that paints a finished agent
  // green forever.
  it("refuses a QUOTED roster that something is displayed BELOW", () => {
    const quoted = [WAITING_ON_SUBAGENTS, "", "(END)", ":"].join("\n");
    expect(parseDelegatedWorkCount(quoted)).toBeNull();
  });

  it("takes the MAX, not the sum, when both surfaces describe the same work", () => {
    const both = [WAITING_ON_SUBAGENTS, "", "2 background tasks live [ctrl+b to manage]"].join("\n");
    expect(parseDelegatedWorkCount(both)).toBe(2);
  });
});
