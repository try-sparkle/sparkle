// @vitest-environment jsdom
//
// THE LOUDEST CHANNEL HAS TO RESPECT THE HOLD TOO.
//
// Keeping a routine permission dialog out of the concierge column is worth nothing if the same
// prompt still lights a macOS banner and pushes to the founder's phone: he gets interrupted, on a
// second device, about a question he has no row for. So this suite renders the REAL hook against the
// REAL stores and asserts on the three boundaries the founder actually experiences — `notifyAttention`
// (the banner), `emitAttention` (the phone), and `reportAttentionCount` (the dock badge).
//
// The two properties that matter are opposites, and both are here:
//
//   • HELD → silent. Nothing fires, and the paired control (identical fleet, identical prompt, no
//     episode in the ledger) fires exactly once — without which the silence would prove nothing.
//   • RELEASED → the notification is DEFERRED, NOT DROPPED. This is the failure a naive `continue`
//     in the dispatch loop produces: the edge is consumed while held, so when the ceiling lapses
//     there is nothing left to detect and the founder is never told. That would be strictly worse
//     than not holding at all, so it gets two cases — one released by the answerer reporting
//     `unreachable`, one released by the 30-second ceiling running out on its own.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: () => Promise.resolve(),
    show: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
  }),
}));

const summarizeAttention = vi.fn<(screen: string, project?: string) => Promise<string | null>>();
const notifyAttention = vi.fn();
const reportAttentionCount = vi.fn();
// importOriginal + spread, NOT a hand-listed factory: Vitest throws on access to an export the
// factory forgot (the sibling suite learned this the hard way with `onSelectProject`).
vi.mock("./services/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/attention")>()),
  reportAttentionCount: (...a: unknown[]) => reportAttentionCount(...a),
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
  summarizeAttention: (s: string, project?: string) => summarizeAttention(s, project),
  onFocusAgent: () => Promise.resolve(() => {}),
  onSelectProject: () => Promise.resolve(() => {}),
  onFocusTier: () => Promise.resolve(() => {}),
}));

const emitAttention = vi.fn();
vi.mock("./services/relayClient", () => ({
  emitAttention: (...a: unknown[]) => emitAttention(...a),
  emitResolved: vi.fn(),
}));

import {
  baselineWithHeldPrompts,
  heldPromptIds,
  useAttentionNotifications,
} from "./useAttentionNotifications";
import { AppBoot } from "./windowContext";
import {
  BLOCKED_PROMPT_GRACE_MS,
  notePromptAnswerOutcome,
  notePromptEpisodes,
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
} from "./engine/blockedPromptGrace";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import type { AgentTab, AgentTabStatus, Project } from "./types";

const AGENT_ID = "agent-1";
/** The routine permission dialog this whole feature exists for. */
const ASK = "Allow `git status`?\n  1. Yes\n  2. No";

const agent = (): AgentTab =>
  ({
    id: AGENT_ID,
    kind: "build",
    name: "Builder",
    parentId: null,
    autoNameVariants: null,
    namePinned: false,
    shellCommand: null,
    baseBranch: null,
  }) as AgentTab;

const project = (agents: AgentTab[]): Project => ({
  id: "p1",
  name: "Sparkle",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null, // not the notified agent → the banner is never suppressed
  agents,
});

function Harness() {
  useAttentionNotifications();
  return null;
}

/** Seed one working agent and mount the hook (its baseline pass). */
function mount() {
  useProjectStore.setState({ projects: [project([agent()])], selectedProjectId: "p1" });
  useRuntimeStore.setState({ status: { [AGENT_ID]: "working" }, attentionScreen: {} });
  return render(
    <AppBoot>
      <Harness />
    </AppBoot>,
  );
}

/** Drive the agent into `waiting` with its ask screen captured — a drawn prompt. */
async function goWaiting() {
  await act(async () => {
    useRuntimeStore.setState((s) => ({
      status: { ...s.status, [AGENT_ID]: "waiting" },
      attentionScreen: { ...s.attentionScreen, [AGENT_ID]: ASK },
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Open the grace episode for the prompt, exactly as `buildConciergeFeed` does on each rebuild.
 *  `capturedAt` is what the 30s ceiling is measured from. */
function holdPrompt(capturedAt: number) {
  notePromptEpisodes(
    windowPromptGraceLedger(),
    { [AGENT_ID]: "waiting" },
    () => ({ text: ASK, at: capturedAt }),
    capturedAt,
    [AGENT_ID],
  );
}

/** Select a DIFFERENT project, exactly as clicking another tab does. The hook's `agents` becomes
 *  that project's (empty here) while `status` and the baseline stay fleet-wide. */
async function switchToOtherProject(otherAgents: AgentTab[] = []) {
  await act(async () => {
    useProjectStore.setState((st) => ({
      projects: [
        ...st.projects,
        { ...project(otherAgents), id: "p2", name: "Other", rootPath: "/tmp/p2" },
      ],
      selectedProjectId: "p2",
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** …and back. */
async function switchBack() {
  await act(async () => {
    useProjectStore.setState({ selectedProjectId: "p1" });
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Force a re-render of the owned agent list, so the notification effect re-runs without the clock
 *  moving — the ordinary way an app tick reaches this hook. */
async function nudgeRender() {
  await act(async () => {
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => ({ ...p, agents: p.agents.map((ag) => ({ ...ag })) })),
    }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  summarizeAttention.mockReset();
  summarizeAttention.mockResolvedValue("Approve running git status?");
  notifyAttention.mockReset();
  emitAttention.mockReset();
  reportAttentionCount.mockReset();
  resetPromptGraceLedgerForTests();
  useSettingsStore.setState({
    notifyStatuses: { ...useSettingsStore.getState().notifyStatuses, waiting: true },
  });
});

afterEach(() => {
  cleanup();
  resetPromptGraceLedgerForTests();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ status: {}, attentionScreen: {} });
});

describe("a held prompt reaches NEITHER channel", () => {
  it("fires the banner and the phone push when nothing is held (the control)", async () => {
    // No episode in the ledger → no hold → today's behaviour, unchanged. If this half ever went
    // quiet, every assertion in the next test would be vacuous.
    mount();
    await goWaiting();
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(reportAttentionCount).toHaveBeenLastCalledWith(expect.anything(), 1);
  });

  it("stays silent — no banner, no push, and the dock badge reads 0", async () => {
    holdPrompt(Date.now());
    mount();
    await goWaiting();
    expect(notifyAttention).not.toHaveBeenCalled();
    expect(emitAttention).not.toHaveBeenCalled();
    // The badge is the quietest channel and still counts the level, so it follows the hold too.
    expect(reportAttentionCount).toHaveBeenLastCalledWith(expect.anything(), 0);
  });

  it("does not even pay for the Haiku ask-summary while held", async () => {
    // Free consequence of skipping the dispatch, worth pinning: the credit-metered scrape is what
    // the banner body would have needed, and a held prompt must not buy one.
    holdPrompt(Date.now());
    mount();
    await goWaiting();
    expect(summarizeAttention).not.toHaveBeenCalled();
  });
});

describe("a hold in a project the founder is NOT looking at owes him nothing", () => {
  it("opening that project does not burst a banner for every agent held while away", async () => {
    // The anti-vacuity pair to the project-switch case below, and the defect that case's fix first
    // introduced (roborev 62869). Episodes are opened FLEET-WIDE, so an agent in an unselected
    // project gets held — but the dispatch loop is scoped to the selected project, so no banner was
    // ever suppressed for it and nothing is owed. Taking on a debt anyway froze its baseline at the
    // pre-hold value until the founder opened that project, and the first tick then read every red
    // agent there as a fresh entry: a simultaneous banner AND phone push for each. That is exactly
    // the burst the `sameProject` gate exists to prevent.
    const other = { ...agent(), id: "agent-2", name: "Other builder" } as AgentTab;
    mount();
    await switchToOtherProject([other]);
    // The founder is now looking at p2, so the HELD prompt belongs to p1's agent — a project he is
    // not looking at, whose banner was therefore never suppressed by anything.
    //
    // THE HOLD IS OPENED FIRST, and the order is the whole test. Draw the prompt first and the
    // effect baselines `waiting` before any episode exists, so there is no edge left to burst and
    // the case passes against the defect too — which is exactly how the first version of this test
    // was vacuous. Opening the episode first is what leaves the baseline frozen at `working`.
    holdPrompt(Date.now() - (BLOCKED_PROMPT_GRACE_MS - 200));
    await act(async () => {
      useRuntimeStore.setState((st) => ({
        status: { ...st.status, [AGENT_ID]: "waiting" },
        attentionScreen: { ...st.attentionScreen, [AGENT_ID]: ASK },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(notifyAttention).not.toHaveBeenCalled();

    // The ceiling lapses while he is still on p2 …
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    // … and he opens p1. Nothing was deferred for him, so nothing may fire.
    await act(async () => {
      useProjectStore.setState({ selectedProjectId: "p1" });
      await Promise.resolve();
      await Promise.resolve();
    });
    await nudgeRender();
    expect(notifyAttention).not.toHaveBeenCalled();
    expect(emitAttention).not.toHaveBeenCalled();
  });

  it("arriving mid-hold is the same experience as arriving at any other red — no burst", () => {
    // THE MISSING HALF, and the one that pins which shape is intended (roborev 62893). Everything
    // above waits the hold OUT before switching back, which is the one ordering where the freeze has
    // already been released — so the fleet-wide freeze was unguarded and a future edit could flip it
    // silently. Here the founder returns WHILE THE HOLD IS STILL LIVE.
    //
    // Nothing may fire. Opening a project with N non-held reds delivers zero banners, because the
    // `sameProject` gate re-baselines silently; a held prompt must not be the one case that behaves
    // differently, least of all in the loud direction.
    return (async () => {
      const other = { ...agent(), id: "agent-2", name: "Other builder" } as AgentTab;
      mount();
      await switchToOtherProject([other]);
      holdPrompt(Date.now());
      await act(async () => {
        useRuntimeStore.setState((st) => ({
          status: { ...st.status, [AGENT_ID]: "waiting" },
          attentionScreen: { ...st.attentionScreen, [AGENT_ID]: ASK },
        }));
        await Promise.resolve();
        await Promise.resolve();
      });
      // Back to p1 while the 30s window is still open …
      await switchBack();
      await nudgeRender();
      // PIN THE PREMISE. Every other assertion here is negative, so without this the case passes
      // identically whether the prompt is held, was never held, or the engine stopped de-escalating
      // unowned agents entirely — and the one test guarding the freeze shape would guard nothing.
      // The badge counts the DE-ESCALATED map, so 0 proves the hold is still live on arrival; an
      // unheld red reads 1.
      expect(reportAttentionCount).toHaveBeenLastCalledWith(expect.anything(), 0);
      // … and let the hold end there. Still nothing: he arrived after the fact, exactly as he would
      // have for a red that was never held.
      notePromptAnswerOutcome(AGENT_ID, "unreachable", Date.now(), windowPromptGraceLedger());
      await nudgeRender();
      expect(notifyAttention).not.toHaveBeenCalled();
      expect(emitAttention).not.toHaveBeenCalled();
      // …and the hold really did end in-project: the badge counts it again. The row is there for
      // him; he just was not interrupted about it.
      expect(reportAttentionCount).toHaveBeenLastCalledWith(expect.anything(), 1);
    })();
  });
});

describe("the notification is DEFERRED, not dropped", () => {
  it("fires when the answerer reports `unreachable` — nobody but the founder will answer it", async () => {
    holdPrompt(Date.now());
    mount();
    await goWaiting();
    expect(notifyAttention).not.toHaveBeenCalled();

    // The write path could not reach the pane. The hold ends at once.
    notePromptAnswerOutcome(AGENT_ID, "unreachable", Date.now(), windowPromptGraceLedger());
    await nudgeRender();

    // THE WHOLE POINT: the transition into `waiting` happened while we were silent, and the edge
    // survived it. A `continue` that also baselined the red would leave this at 0 forever.
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention).toHaveBeenCalledTimes(1);
    expect(reportAttentionCount).toHaveBeenLastCalledWith(expect.anything(), 1);
  });

  it("delivers the deferred banner ONCE, not on every render after it", async () => {
    // The other half of "deferred, not dropped", and the half a missing baseline write hides. A
    // deferred edge is only correct if delivering it also CONSUMES it: the released tick has to
    // record the red it just acted on, or every subsequent render re-detects the same transition
    // and the founder is pinged again and again for one prompt. That is the mirror of the dropped
    // notification, produced by the opposite mistake, and neither is visible from a single tick.
    holdPrompt(Date.now());
    mount();
    await goWaiting();
    notePromptAnswerOutcome(AGENT_ID, "unreachable", Date.now(), windowPromptGraceLedger());
    await nudgeRender();
    expect(notifyAttention).toHaveBeenCalledTimes(1);

    await nudgeRender();
    await nudgeRender();
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention).toHaveBeenCalledTimes(1);
  });

  it("survives a PROJECT SWITCH inside the window — the edge is not consumed while away", async () => {
    // The deferral is only as wide as the key set it protects. `prevStatus` is FLEET-WIDE (status is
    // every agent in every project and the effect writes the whole map back), so a held set scoped to
    // the SELECTED project silently let this through: switch tabs mid-hold and the held agent's red
    // was baselined by an effect run that never considered it, consuming the edge for good. The
    // ceiling then lapsed with no transition left to detect and the banner never fired — strictly
    // worse than not holding at all (roborev 62857).
    holdPrompt(Date.now() - (BLOCKED_PROMPT_GRACE_MS - 400));
    mount();
    await goWaiting();
    expect(notifyAttention).not.toHaveBeenCalled();

    // Away from the project that owns the held prompt while its window is still open …
    await switchToOtherProject();
    expect(notifyAttention).not.toHaveBeenCalled();

    // … the ceiling lapses while away, and the founder comes back.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    await switchBack();
    // The switch-back tick itself cannot fire — `sameProject` is false on the run that re-selects a
    // project, by design, so tab-switching never bursts banners. The debt has to survive THAT too,
    // and be paid by the next ordinary tick.
    await nudgeRender();

    // The question still reaches him, exactly once.
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the answerer reports `handled` (the anti-vacuity pair)", async () => {
    // Same shape, same re-render, only the outcome differs. Without this the test above would pass
    // against a build that simply released everything on the next tick.
    holdPrompt(Date.now());
    mount();
    await goWaiting();
    notePromptAnswerOutcome(AGENT_ID, "handled", Date.now(), windowPromptGraceLedger());
    await nudgeRender();
    expect(notifyAttention).not.toHaveBeenCalled();
  });

  it("fires when the 30s CEILING lapses, with nothing else in the app changing", async () => {
    // This is the case the hook's own timer exists for, and the only one no other input can produce:
    // a wedged answerer emits no outcome, and the agent emits no further status write. The prompt is
    // seeded 400ms short of its ceiling so the real wake-up is short enough to wait on.
    holdPrompt(Date.now() - (BLOCKED_PROMPT_GRACE_MS - 400));
    mount();
    await goWaiting();
    expect(notifyAttention).not.toHaveBeenCalled();

    // No store write, no re-render, no outcome — only the clock. If `promptTick` were missing from
    // the effect's dependency list this stays at 0 and the question is silenced forever.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(emitAttention).toHaveBeenCalledTimes(1);
  });
});

describe("baselineWithHeldPrompts", () => {
  const status: Record<string, AgentTabStatus> = { a: "waiting", b: "working" };

  it("returns the SAME reference when nothing is held", () => {
    expect(baselineWithHeldPrompts(status, {}, new Set())).toBe(status);
  });

  it("restores a held agent's PREVIOUS value, leaving everyone else at the new one", () => {
    const out = baselineWithHeldPrompts(status, { a: "working", b: "idle" }, new Set(["a"]));
    // `a` is held: as far as the edge detector is concerned this tick did not happen for it.
    expect(out.a).toBe("working");
    // …and `b` is untouched, so an unrelated agent's own edges keep working normally.
    expect(out.b).toBe("working");
  });

  it("REMOVES the key when the held agent had no previous entry", () => {
    // `undefined` is what "never observed" means to newlyEntered. Writing the red in here would
    // consume the edge — the dropped-notification bug — for an agent seen for the first time while
    // already at a prompt.
    const out = baselineWithHeldPrompts(status, {}, new Set(["a"]));
    expect("a" in out).toBe(false);
    expect(out.b).toBe("working");
  });

  it("does not mutate its inputs", () => {
    const prev = { a: "working" as AgentTabStatus };
    baselineWithHeldPrompts(status, prev, new Set(["a"]));
    expect(status.a).toBe("waiting");
    expect(prev.a).toBe("working");
  });
});

describe("heldPromptIds", () => {
  const agents = [{ id: "a" }, { id: "b" }];
  const status: Record<string, AgentTabStatus> = { a: "waiting", b: "waiting" };

  it("is empty when the overlay returned its input unchanged", () => {
    expect(heldPromptIds(agents, status, status).size).toBe(0);
  });

  it("names exactly the agents the overlay de-escalated", () => {
    const graced: Record<string, AgentTabStatus> = { ...status, a: "idle" };
    const held = heldPromptIds(agents, status, graced);
    expect([...held]).toEqual(["a"]);
  });
});
