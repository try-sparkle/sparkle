// @vitest-environment jsdom
//
// The thinking indicator. The founder asked for more than three dots; the constraint on "more" is
// that every word of it be something the app OBSERVED. These tests are mostly about the cases where
// it must say less: no turn, no activity, or activity that belongs to a different turn.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NO_ANSWER_YET_LABEL,
  THINKING_ACTIVITY_TESTID,
  THINKING_ELAPSED_TESTID,
  THINKING_INDICATOR_TESTID,
  ThinkingIndicator,
} from "./ThinkingIndicator";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
} from "../../services/conciergeActivity";
import {
  ELAPSED_COUNTER_AFTER_MS,
  OFFLINE_AFTER_MS,
} from "../../engine/conciergeLiveness";
import {
  _resetConciergeLivenessForTests,
  noteConciergeSent,
  noteConciergeSettled,
} from "../../services/conciergeLiveness";
import { useProjectStore } from "../../stores/projectStore";
import { AgentPillProvider } from "./AgentPill";
import type { MentionAgent } from "./mentions";

/** A real project + agent in the store, so the recorder's id→name lookup genuinely resolves.
 *
 *  Seeded through the STORE's own `addAgent` rather than hand-built, because the thing under test is
 *  whether a spawn's reply resolves against the live roster — a fixture object would assert the
 *  fixture. */
function seedSpawn(): { projectId: string; agentId: string; storeName: string } {
  const projectId = useProjectStore.getState().addProject("web", "/tmp/web");
  const agentId = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
  // The spawn-time placeholder the store mints ("Build 1"). Read rather than hard-coded: it is the
  // very value this feature exists to stop anyone from quoting as identity, so a test that spelled
  // it out would be asserting the placeholder it is trying to make irrelevant.
  const storeName = useProjectStore
    .getState()
    .projects.find((p) => p.id === projectId)!
    .agents.find((a) => a.id === agentId)!.name;
  return { projectId, agentId, storeName };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  // The row now reads the liveness detector too, and that store is a module singleton that outlives
  // render() — without this, one case's outstanding turn is the next case's elapsed counter.
  _resetConciergeLivenessForTests();
});
afterEach(() => cleanup());

function indicator(): HTMLElement | null {
  return document.querySelector(`[data-testid="${THINKING_INDICATOR_TESTID}"]`);
}
function activityText(): string | null {
  return document.querySelector(`[data-testid="${THINKING_ACTIVITY_TESTID}"]`)?.textContent ?? null;
}

describe("ThinkingIndicator", () => {
  it("renders nothing at all when no turn is in flight", () => {
    render(<ThinkingIndicator typing={false} />);
    expect(indicator()).toBeNull();
  });

  // THE HONEST FALLBACK. A turn that thinks and calls no tools has nothing to report, and the right
  // answer is the pulse it always showed — not an invented status line.
  it("shows the bare pulse when the concierge has done nothing observable", () => {
    render(<ThinkingIndicator typing />);
    expect(indicator()).not.toBeNull();
    expect(activityText()).toBeNull();
    expect(indicator()?.querySelector(".sparkle-pulse")?.textContent).toBe("…");
    // Nothing to announce, so nothing is announced: the bare pulse stays decorative.
    expect(indicator()?.getAttribute("aria-hidden")).toBe("true");
    // The name this row has always carried. Several suites outside this file identify the indicator
    // by it, so the fallback must keep it.
    expect(indicator()?.getAttribute("aria-label")).toBe("Sparkle is typing");
  });

  it("says what the concierge is doing once it calls a tool", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" });
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Reading an agent's terminal");
    // A real sentence IS worth announcing — it changes once per tool call, not per token, so it
    // carries none of the flooding risk that kept the thread itself off a live region.
    expect(indicator()?.getAttribute("aria-live")).toBe("polite");
    expect(indicator()?.getAttribute("aria-hidden")).toBeNull();
    // …and what is announced is the line itself, not the generic "typing" underneath it.
    expect(indicator()?.getAttribute("aria-label")).toBe("Reading an agent's terminal");
  });

  it("keeps the pulse beside the line, so a settled call still reads as ongoing", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    const settle = noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Merging PR #753");

    settle(true);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Merged PR #753");
    expect(indicator()?.querySelector(".sparkle-pulse")).not.toBeNull();
  });

  // A refused call — a policy denial, or an ask-tier tool whose approval card is on screen right
  // now — must read as an attempt. The past tense there would have the column announcing the merge
  // directly above the request asking whether to allow it.
  it("reads a refused call as an attempt, not as something that happened", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    const settle = noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    settle(false);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Tried merging PR #753");
  });

  // THE STALENESS GUARD, and the reason the store hands out a `seq` at all. A proactive push calls
  // tools with no typing indicator of its own, and the previous turn's last call outlives it — so
  // without this the column would present an old action as what it is doing about the message the
  // user just sent.
  it("ignores activity recorded before this turn began", () => {
    const { rerender } = render(<ThinkingIndicator typing={false} />);
    noteConciergeToolCall("terminal", "read_agent_terminal", {});

    rerender(<ThinkingIndicator typing />); // the user sends: a NEW turn starts
    expect(indicator()).not.toBeNull();
    expect(activityText()).toBeNull();

    // A call made during THIS turn does show.
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");
  });

  // The floor is snapshotted on the false→true edge, not on every render — otherwise it would keep
  // moving past calls that had already arrived and the line would never appear.
  it("does not re-snapshot the floor on a re-render mid-turn", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");
  });

  // A second turn must not inherit the first turn's last line.
  it("drops the line again when the next turn starts with nothing to report", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");

    rerender(<ThinkingIndicator typing={false} />); // the turn finishes
    rerender(<ThinkingIndicator typing />); // and the user sends again
    expect(activityText()).toBeNull();
  });

  // A tool the phrase table has no sentence for still shows its own name, but a domain the app does
  // not recognise has nothing truthful to say and falls back to the pulse.
  it("falls back to the pulse for an unrecognised domain", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("filesystem", "rm_rf", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBeNull();
    expect(indicator()?.querySelector(".sparkle-pulse")).not.toBeNull();
  });
});

// ── HOW LONG YOU HAVE BEEN WAITING ──────────────────────────────────────────────────────────────
//
// The pulse alone could not tell "thinking hard" from "this turn died and nothing will ever arrive",
// and on 2026-07-29 the second case happened 149 times without the column changing at all. These
// rows are the timing half; the thresholds themselves are argued and tested in
// engine/conciergeLiveness.
describe("ThinkingIndicator — the wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function elapsedText(): string | null {
    return document.querySelector(`[data-testid="${THINKING_ELAPSED_TESTID}"]`)?.textContent ?? null;
  }

  /** Let the liveness ticker run, which is what advances both the clock and the escalation. */
  function wait(ms: number, rerender: (ui: React.ReactElement) => void) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    rerender(<ThinkingIndicator typing />);
  }

  it("says nothing about time for the first few seconds", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(ELAPSED_COUNTER_AFTER_MS - 1_000, rerender);
    expect(elapsedText()).toBeNull();
  });

  // FACTUAL, NOT A CLAIM. A counter cannot be wrong, so it may appear early — which is what the
  // "show me something within a few seconds" instinct actually wants. Asserting a status that early
  // would be a guess, and the measured median turn is ~54s.
  it("states the elapsed time once there is some", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(ELAPSED_COUNTER_AFTER_MS + 2_000, rerender);
    expect(elapsedText()).toContain("7s");
    // Still just waiting — no alarm, no claim about the brain.
    expect(indicator()?.textContent).not.toContain(NO_ANSWER_YET_LABEL);
    expect(indicator()?.getAttribute("data-liveness")).toBe("waiting");
  });

  it("says plainly that nothing has come back once the silence is long enough", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(OFFLINE_AFTER_MS, rerender);
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);
    expect(indicator()?.getAttribute("data-liveness")).toBe("offline");
    // Announced: it changes at most twice a turn, and it is the only notice a non-sighted user gets
    // that their question has gone nowhere. (The bare counter is NOT — it changes every second.)
    expect(indicator()?.getAttribute("aria-live")).toBe("polite");
    expect(indicator()?.getAttribute("aria-label")).toContain(NO_ANSWER_YET_LABEL);
  });

  // A tool call RESETS the silence clock, so a stale activity line beside "No answer yet" would read
  // as work still in progress — the one thing we have just established we cannot vouch for.
  it("drops the stale activity line once it goes silent", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    // AFTER the first render: the row snapshots an activity floor when a turn starts, so a call
    // recorded before it mounted belongs to the previous turn and is correctly ignored.
    act(() => noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" }));
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Reading an agent's terminal");

    // Measured from the TOOL CALL, which reset the silence clock — that reset is the whole reason a
    // 20s threshold is safe for turns whose median duration is ~54s.
    wait(OFFLINE_AFTER_MS, rerender);
    expect(activityText()).toBeNull();
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);
  });

  // "Recovering must clear the state promptly" — in the same commit, not on the next tick.
  it("goes back to normal the instant the turn answers", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(OFFLINE_AFTER_MS, rerender);
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);

    act(() => noteConciergeSettled());
    rerender(<ThinkingIndicator typing />);
    expect(indicator()?.textContent).not.toContain(NO_ANSWER_YET_LABEL);
    expect(elapsedText()).toBeNull();
  });

  // The name several suites outside this file identify the row by, kept EXACTLY while there is
  // nothing else to say.
  it("keeps its original accessible name when nothing has happened yet", () => {
    render(<ThinkingIndicator typing />);
    expect(indicator()?.getAttribute("aria-label")).toBe("Sparkle is typing");
  });
});

// ── THE SPAWN LINE IS A LIVE REFERENCE, NOT A NAME ─────────────────────────────────────────────
//
// The failure that produced this feature: the concierge said "Build 17" as plain text, and by the
// time the founder read it the agent had renamed itself — so the name pointed at nothing they could
// see, and was not clickable either. *"Build 17 is not the name of the agent right now … When you
// tell me Build 17, that doesn't mean anything to me because I can't see it."*
//
// The fix is structural: the line carries an ID, and the renderer resolves it to the CURRENT name on
// every render. These are about that resolution — above all the rename.
describe("ThinkingIndicator — agent references", () => {
  const rosterAgent = (over: Partial<MentionAgent> = {}): MentionAgent =>
    ({
      id: "a1",
      name: "Build 17",
      band: "running",
      projectId: "p1",
      projectName: "web",
      ...over,
    }) as MentionAgent;

  /** Mount the way ConciergeColumn does — the thread wrapped in the pill roster — and hand back a
   *  re-render that can swap the ROSTER, which is how a rename reaches the pill in production.
   *
   *  MOUNTED BEFORE ANY CALL IS RECORDED, deliberately: the indicator snapshots the activity counter
   *  on the false→true edge and ignores anything at or below it, so a test that records first would
   *  put its own call below the floor and assert on a line the component is right to suppress. */
  // `=> true` — the opener REPORTS whether the reveal landed, and these rows are about the pill's
  // live form. An opener that returns false is read as "that agent is closed", which would take
  // every pill here into the explained state instead of the one being asserted (see AgentPill).
  function harness(agents: MentionAgent[], onOpenAgent: (t: never) => boolean = () => true) {
    const ui = (a: MentionAgent[]) => (
      <AgentPillProvider
        value={{
          agents: a,
          onOpenAgent: onOpenAgent as (t: { agentId: string; projectId: string }) => boolean,
        }}
      >
        <ThinkingIndicator typing />
      </AgentPillProvider>
    );
    const r = render(ui(agents));
    return { rerender: (a: MentionAgent[] = agents) => r.rerender(ui(a)) };
  }

  const pill = () => document.querySelector('[data-testid="concierge-agent-pill"]');
  // `-closed`, not the `-inert` this was written against: an unresolvable pill is now NAMED as
  // closed, and is interactive on any surface that supplies a history route (see AgentPill). This
  // harness supplies none, so the degraded form here is still plain, non-interactive prose — which
  // is exactly what these rows assert.
  const inertPill = () => document.querySelector('[data-testid="concierge-agent-pill-closed"]');

  it("says 'Starting a new agent' with no reference while the id does not exist yet", () => {
    const h = harness([rosterAgent()]);
    noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId: "p1" });
    h.rerender();
    expect(activityText()).toBe("Starting a new agent");
    // Honest: there is genuinely nothing to open yet, so nothing pretends to be openable.
    expect(pill()).toBeNull();
    expect(inertPill()).toBeNull();
  });

  // ══ THE TEST THE WHOLE DESIGN EXISTS FOR ══════════════════════════════════════════════════════
  // Render a reference, RENAME the agent, re-render, confirm the pill followed — in place, with no
  // remount and nothing rewritten. This is what makes a reference written at any time still correct:
  // the id never changes, the name may change freely.
  it("follows a rename IN PLACE — the same pill, new words", () => {
    const { projectId, agentId } = seedSpawn();
    const h = harness([rosterAgent({ id: agentId, projectId, name: "Build 17" })]);
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    settle(true, { agentId, projectId });
    h.rerender();

    expect(activityText()).toBe("Started @Build 17");
    const first = pill();
    expect(first).not.toBeNull();
    expect(first?.getAttribute("data-agent-id")).toBe(agentId);

    // The agent names itself after its work — which is what happens seconds after every spawn.
    h.rerender([rosterAgent({ id: agentId, projectId, name: "Concierge Drag-Drop Fix" })]);

    expect(activityText()).toBe("Started @Concierge Drag-Drop Fix");
    // IN PLACE: the very same DOM node, re-lettered. A pill that unmounted and remounted would read
    // identically to a human and would NOT be the "watch it rename" that was asked for — and it
    // would prove nothing about the id binding, since a fresh node could equally have come from a
    // rewritten line.
    expect(pill()).toBe(first);
    expect(pill()?.getAttribute("data-agent-id")).toBe(agentId);
    // Nothing about the RECORDED line changed — only the roster did. That is the proof the reference
    // is an id resolved at render time rather than a name captured when the call was made.
    expect(first?.getAttribute("data-agent-id")).toBe(agentId);
  });

  it("clicks through to the agent the id names, carrying its project", () => {
    const { projectId, agentId } = seedSpawn();
    const onOpenAgent = vi.fn();
    const h = harness([rosterAgent({ id: agentId, projectId })], onOpenAgent as never);
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    settle(true, { agentId, projectId });
    h.rerender();
    expect(pill()).not.toBeNull();
    fireEvent.click(pill()!);
    expect(onOpenAgent).toHaveBeenCalledWith({ agentId, projectId });
  });

  // *"If the ID does not resolve — agent closed or discarded — render the reference as inert plain
  // text with an indication it is gone. NEVER render a dead link, and never fall back to guessing a
  // different agent."* Here the agent is gone from the STORE, so the line degrades to the indefinite
  // noun before it ever reaches a pill — there is no name to draw one over.
  it("degrades to indefinite words, with no pill at all, when the agent is gone", () => {
    const h = harness([]);
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId: "p1" });
    settle(true, { agentId: "vanished", projectId: "p1" });
    h.rerender();
    expect(activityText()).toBe("Started a new agent");
    expect(pill()).toBeNull();
    expect(inertPill()).toBeNull();
  });

  // The agent existed when the call settled but has since left the ROSTER — closed while the line is
  // still on screen. The pill is the inert form: named, explained, and not a dead link.
  it("goes inert rather than dead when the agent leaves the roster mid-line", () => {
    const { projectId, agentId, storeName } = seedSpawn();
    const h = harness([rosterAgent({ id: agentId, projectId, name: "Build 17" })]);
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    settle(true, { agentId, projectId });
    h.rerender();
    expect(pill()).not.toBeNull();

    h.rerender([]); // the user closes it
    expect(pill()).toBeNull();
    expect(inertPill()).not.toBeNull();
    // TWO NAME SOURCES, and this is where they separate. The LIVE pill showed the roster's name
    // ("Build 17"); with the agent gone from the roster there is nothing live left to read, so the
    // inert form falls back to the name the line was RECORDED with — the store's placeholder. That
    // is the correct fallback: it is what the reader was already looking at a moment ago.
    expect(inertPill()?.textContent).toBe(`@${storeName}`);
  });

  // A line whose subject is not an agent must never render a control: a pill built from a project id
  // would open an agent that does not exist — or, worse, one that does.
  it("renders a project subject as plain words", () => {
    const projectId = useProjectStore.getState().addProject("web", "/tmp/web");
    const h = harness([rosterAgent({ id: projectId })]);
    noteConciergeToolCall("workspace", "select_project", { projectId });
    h.rerender();
    expect(activityText()).toBe("Switching to web");
    expect(pill()).toBeNull();
  });

  // The sighted reader and the announced text must say the same thing — the accessible name is the
  // plain sentence, pill or no pill.
  it("announces the sentence in plain words even when it renders a control", () => {
    const { projectId, agentId, storeName } = seedSpawn();
    const h = harness([rosterAgent({ id: agentId, projectId, name: "Build 17" })]);
    const settle = noteConciergeToolCall("lifecycle", "spawn_build_agent", { projectId });
    settle(true, { agentId, projectId });
    h.rerender();
    // A complete sentence with no markup and no sigil — the announced text is the plain form of the
    // line, which is the whole reason `text` is kept alongside the split pieces.
    expect(indicator()?.getAttribute("aria-label")).toBe(`Started ${storeName}`);
    expect(indicator()?.getAttribute("aria-live")).toBe("polite");
  });
});
