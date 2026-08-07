// @vitest-environment jsdom
// A RED CARD MUST NAME THE AGENT THAT IS ACTUALLY RED, AND MUST LEAVE WHEN THAT AGENT RESUMES.
//
// THE REPORT (founder, 2026-07-30, with screenshots). The column showed
// "Needs you — Cockpit Column Resize in sparkle-desktop" while that agent was demonstrably
// WORKING: seven commits ahead, mid-rebase, fixing roborev findings. Clicking through found a busy
// terminal. His conclusion is the one that matters: "a stale alert that says BLOCKED about a
// working agent is worse than no alert, because it trains him to ignore the real ones."
//
// THE MECHANISM, read out of engine/workerAttention.withRedWorkerAttention. A worker's ASK
// (waiting/approval/errored) bubbles onto its orchestrator UNCONDITIONALLY — in motion or not —
// and the write is allowed whenever the parent is not itself asking, which includes a parent that
// is `working`. So a WORKING orchestrator is published `waiting`. Then conciergeFeed's
// `representedElsewhere` sees the worker's band matched by its ancestor and suppresses the
// worker's own card, on the reasoning that the ancestor "speaks for it". The net effect is that
// the ONE thing on screen is a red card naming the one agent in the pair that does NOT need you.
//
// Both halves of the bubble are still right for what they were built for — the ask must not be
// hidden by a busy sibling (the 2026-07-26 report), and one piece of work must be counted once.
// What was wrong is WHO the surviving card names. The rule these cases pin: a nudge card is raised
// for, and named after, the agent whose OWN status is the red. An ancestor that merely INHERITED a
// red while it is itself in motion is a routing hop, not the subject of the alert.
//
// The retraction case is the same rule stated over time, and it is the founder's literal ask:
// bound to the agent whose own status is red, a card cannot outlive that status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ dismissAlert: vi.fn() }));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: vi.fn(async () => null),
    // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
    // the host's other wiring, and a mock that simply OMITS an export the host calls does not
    // degrade — vitest throws on the missing property and every case in the file dies at mount.
    onConciergeTool: () => () => {},
    onConciergeDelta: () => () => {},
    onConciergeDone: () => () => {},
    onConciergeError: () => () => {},
    onConciergeTurnsAbandoned: () => () => {},
  };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import { buildConciergeFeed } from "../services/conciergeFeed";
import { accountedNeedsYou } from "../services/conciergeProactive";
import { useProjectStore } from "../stores/projectStore";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { NUDGE_CARD_TESTID, NUDGE_LEAD_TESTID } from "./Concierge/NudgeCard";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);

const tab = (id: string, over: Partial<AgentTab> = {}): AgentTab =>
  ({
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    ...over,
  }) as AgentTab;

const worker = (id: string, parentId: string | null): AgentTab =>
  tab(id, { kind: "worker", parentId });

const projectOf = (id: string, name: string, agents: AgentTab[]): Project =>
  ({
    id,
    name,
    rootPath: `/${id}`,
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  }) as Project;

/** Everything live, so the unstarted-worker overlay (which invents an `approval` for a worker with
 *  NO status entry) cannot manufacture the very reds these cases are about. */
const openIds = (projects: Project[]) => projects.flatMap((p) => p.agents.map((a) => a.id));

const feedFrom = (projects: Project[], status: Record<string, AgentTabStatus>) =>
  buildConciergeFeed({ projects, status, openAgentIds: openIds(projects) });

/** Which agent each nudge card on screen is ABOUT — read off the card's own data attribute rather
 *  than by matching its prose, so these cases keep holding through the card's copy redesign. */
// THE LOUD CARDS ONLY. Since bead `sparkle-9adzg` a card whose agent leaves the red band is not
// removed — it is greyed and relabelled "RESOLVED after <duration>" and kept as history (the
// founder's call). Filtering on `data-resolved` is what preserves the original meaning of every
// `toEqual([])` below: "nothing is being shouted about", not "nothing is on screen".
const cardAgentIds = (): string[] =>
  screen
    .queryAllByTestId(NUDGE_CARD_TESTID)
    .filter((el) => el.getAttribute("data-resolved") === null)
    .map((el) => el.getAttribute("data-agent-id")!);

/** The GREY cards — a block that is over, kept in the thread as history. */
const resolvedCardAgentIds = (): string[] =>
  screen
    .queryAllByTestId(NUDGE_CARD_TESTID)
    .filter((el) => el.getAttribute("data-resolved") === "true")
    .map((el) => el.getAttribute("data-agent-id")!);

/** The same question asked of a feed WITHOUT rendering — for stating a case's premise before the
 *  gesture under test, where a second mounted column would just be noise. */
const cardSubjects = (feed: ReturnType<typeof buildConciergeFeed>): string[] =>
  accountedNeedsYou(feed).map((a) => a.id);

/** Every `dismissAlert` the host wrote, in order. Read off the real store: this is the record the
 *  status chain (`withDismissedAlerts`) later reads, so asserting it is asserting the side effect
 *  rather than the click. */
const dismissed = (): Array<{ projectId: string; agentId: string; status: string }> =>
  h.dismissAlert.mock.calls.map(([projectId, agentId, status]) => ({
    projectId,
    agentId,
    status,
  }));

beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  useUiStore.setState({ collapsedOrchestrators: {} });
  // The REAL store with one action swapped, rather than a module mock: everything else in the host
  // still reads the genuine projectStore, and `dismissAlert` is the one write these cases are about.
  h.dismissAlert.mockClear();
  useProjectStore.setState({ dismissAlert: h.dismissAlert });
  // A mute is `scope: "forever"` and this store is a module singleton, so one case's mute would
  // silence an agent named `solo` in every case after it — a leak that presents as a card simply
  // failing to appear, with nothing on screen to say why.
  useSparklePrefsStore.setState({ rules: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a red card names the agent that is actually red", () => {
  // THE FOUNDER'S CASE. `w1` asked a question; `orch` is working. Today the ask bubbles onto the
  // working orchestrator and the orchestrator's card is the only one drawn — so the column says
  // the busy agent is the one that needs him, and the agent that does is silent.
  it("names the asking WORKER, not the working orchestrator that inherited its red", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "working", w1: "waiting" });

    // The premise, asserted rather than assumed: the orchestrator's OWN status is `working`, and
    // the only reason it is not calm is the bubble. If this ever stops being true the case below is
    // testing something else.
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["w1"]!.status).toBe("waiting");

    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["w1"]);
  });

  // The same shape one level deeper, so the fix cannot be a parent-only special case: an ask under
  // a working orchestrator nested under a working orchestrator still names the asker.
  it("names the asker when the inherited red has travelled more than one hop", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("top"),
      worker("mid", "top"),
      worker("leaf", "mid"),
    ]);
    const feed = feedFrom([p], { top: "working", mid: "working", leaf: "approval" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["leaf"]);
  });

  // THE OTHER DIRECTION, and the reason this is a rule about OWN status rather than about workers.
  // An orchestrator that is itself asking still gets its own card: the bubble is not what put it
  // there, so nothing about it is a routing hop.
  it("still names the orchestrator when the orchestrator is the one asking", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "waiting", w1: "working" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["orch"]);
  });

  // THE TRADE-OFF, CHOSEN RATHER THAN DISCOVERED. A hop's red descendants surface under the
  // ORDINARY gates, so a hop whose only red descendant is MUTED relays nothing and the column goes
  // quiet. Pinned because it is the one behaviour this fix gives up, and the alternative is worse:
  // telling the founder that a working agent needs him, on behalf of a worker he explicitly asked
  // not to be interrupted about. See `ConciergeAgent.redIsInherited`.
  it("goes quiet rather than relaying, when the only red under a working head is muted", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = buildConciergeFeed({
      projects: [p],
      status: { orch: "working", w1: "waiting" },
      openAgentIds: openIds([p]),
      shouldInterrupt: (topic) => !topic.includes("w1"),
    });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual([]);
    // And the count agrees with the silence — the vitals line does not promise an item the thread
    // has no row for, which is the invariant the scoped-count gate exists to keep.
    expect(feed.scopedCounts.needs_you).toBe(0);
  });

  // A calm (not working) orchestrator is NOT a routing hop in the sense above — it is doing
  // nothing, so it is a fair place to knock. This case exists so the fix stays narrow: it must not
  // silence the ordinary "your build finished and a worker is asking" rollup, which is what the
  // orchestrator's row is for.
  it("leaves the rollup intact when the orchestrator is idle rather than working", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "idle", w1: "waiting" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["orch"]);
  });
});

describe("[x] acknowledges the alarm, not just the agent named on the card", () => {
  // THE WHACK-A-MOLE (roborev 55986, Medium). On the rollup shape this design deliberately keeps —
  // an IDLE orchestrator carrying a red worker's band — the card names the orchestrator. Dismissing
  // only that de-escalates its red, which makes the worker un-represented, so the NEXT tick raises a
  // new, near-identical card naming the worker. The reader who reflexively acknowledged one alarm
  // gets it straight back under a different name, once per red descendant.
  //
  // Asserted through the STORE, because the defect is about which records get written — the visible
  // symptom (a second card) is a consequence of the feed being rebuilt from them.
  it("dismisses the descendants a rollup card was standing in for, not only the head", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("orch"),
      worker("w1", "orch"),
      worker("w2", "orch"),
    ]);
    const feed = feedFrom([p], { orch: "idle", w1: "waiting", w2: "waiting" });
    // The premise: ONE card, naming the head, standing in for both workers.
    expect(cardSubjects(feed)).toEqual(["orch"]);

    render(<ConciergeHost feed={feed} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));

    // Every agent the card spoke for is acknowledged, so nothing is left to re-raise under a new
    // name. Each with its OWN published status, which is what ties the record to this episode.
    expect(dismissed()).toEqual([
      { projectId: "p1", agentId: "orch", status: "waiting" },
      { projectId: "p1", agentId: "w1", status: "waiting" },
      { projectId: "p1", agentId: "w2", status: "waiting" },
    ]);
  });

  // THE SAME BUG ONE LEVEL DOWN (roborev 56000). `representedBy` names the NEAREST ancestor that
  // speaks for an agent, so on a three-deep chain the leaf points at `mid`, not at the head the card
  // names. Dismissing only the DIRECT representees left the leaf red with both its ancestors' alarms
  // now suppressed — nothing spoke for it, so the next tick raised a fresh card naming it. The first
  // two cases here could not see that: one is depth 1 and the other depth 0.
  it("dismisses a rollup's whole subtree, not just the agents pointing straight at the head", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("orch"),
      worker("mid", "orch"),
      worker("leaf", "mid"),
    ]);
    const feed = feedFrom([p], { orch: "idle", mid: "waiting", leaf: "waiting" });
    // The premise: ONE card, naming the head, and the leaf pointing at `mid` rather than at it.
    expect(cardSubjects(feed)).toEqual(["orch"]);
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["leaf"]!.representedBy).toBe("mid");
    expect(byId["mid"]!.representedBy).toBe("orch");

    render(<ConciergeHost feed={feed} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));

    expect(dismissed().map((d) => d.agentId).sort()).toEqual(["leaf", "mid", "orch"]);
  });

  // AN ACKNOWLEDGED RED IS NOT A RESOLVED ONE (roborev, 2026-08-07). `dismissAlert` de-escalates the
  // PUBLISHED status while the agent goes on waiting — that is the feature's whole design, "[x]
  // acknowledges the red WITHOUT resolving it" — and the resolved-card ledger reads exactly that
  // published band. So the acknowledgement looked identical to an unblock, and left a grey
  // "RESOLVED after 0s:" card asserting a finished episode for an agent still stopped dead waiting
  // for the reader. The de-escalation is rendered here as the rerender it really is: the same feed,
  // rebuilt from the same statuses, with the dismissed agent's published status calmed.
  it("leaves no RESOLVED receipt when [x] acknowledges a red that is still standing", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    expect(cardAgentIds()).toEqual(["solo"]);

    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    // What `withDismissedAlerts` does to the next tick: the red is calmed, the agent is still there.
    rerender(<ConciergeHost feed={feedFrom([p], { solo: "idle" })} />);

    expect(cardAgentIds()).toEqual([]);
    // THE ASSERTION. Not a grey twin the reader has to dismiss a second time, and — the part that
    // matters — not a card claiming a block finished when nothing about it did.
    expect(resolvedCardAgentIds()).toEqual([]);
  });

  // THE OPPOSITE DIRECTION, without which the case above would pass against a host that had simply
  // stopped producing receipts at all. Same agent, same de-escalated end state, no [x] — the only
  // difference is who caused the calm, and that difference is exactly what decides whether a receipt
  // is honest.
  it("still leaves a receipt when the same agent calms WITHOUT being dismissed", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    expect(cardAgentIds()).toEqual(["solo"]);

    rerender(<ConciergeHost feed={feedFrom([p], { solo: "idle" })} />);
    expect(cardAgentIds()).toEqual([]);
    expect(resolvedCardAgentIds()).toEqual(["solo"]);
  });

  it("dismisses only the named agent when the card speaks for nobody else", () => {
    // The narrow case, so the fix cannot quietly become "dismiss the whole subtree": a leaf card
    // must not acknowledge alarms the reader never saw.
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(dismissed()).toEqual([{ projectId: "p1", agentId: "solo", status: "waiting" }]);
  });
});

describe("a red card retracts when its agent goes back to working", () => {
  // THE FOUNDER'S LITERAL ASK: "make the toast retract itself the moment the agent goes back to
  // working". Asserted as a TRANSITION on one mounted column — a card that is drawn, then gone —
  // rather than as two independent renders, because the failure being guarded against is a card
  // that OUTLIVES its state, and only a rerender can catch that.
  it("drops the card on the next feed tick after the agent resumes", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    expect(cardAgentIds()).toEqual(["solo"]);

    rerender(<ConciergeHost feed={feedFrom([p], { solo: "working" })} />);
    expect(cardAgentIds()).toEqual([]);
    // AND IT DID NOT SIMPLY VANISH (bead `sparkle-9adzg`). The founder's ask was "go away OR show as
    // resolved and be grayed out", and he chose the second: the card stays as history, quiet. This
    // is the assertion that makes the pair above meaningful — without it, a host that deleted the
    // card outright and one that greys it are indistinguishable here.
    expect(resolvedCardAgentIds()).toEqual(["solo"]);
  });

  // MUTE MUST NOT BE ANSWERED WITH A RECEIPT (roborev, 2026-08-07). Mute is one of the three gates
  // `accountedNeedsYou` applies, so it withdraws the LIVE card while the agent is still red — which
  // reads to the ledger exactly like the digest case, except that here the reader has positively
  // asked not to hear about this agent. Resolving it anyway puts the silenced agent straight back in
  // the thread as a grey card, through the very control the card offers to silence it with.
  it("gives a MUTED agent no grey card when it later unblocks", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    // The premise: it was loud first, so there IS an open episode to mishandle.
    expect(cardAgentIds()).toEqual(["solo"]);

    useSparklePrefsStore.getState().setInterruptPreference("solo", "mute");
    // `shouldInterrupt` is an INPUT to the feed (it defaults to allow-everything), so the mute has
    // to be handed to the builder the way the app hands it over — setting the store alone would
    // leave the feed unmuted and the case would prove nothing.
    const muted = (status: Record<string, AgentTabStatus>) =>
      buildConciergeFeed({
        projects: [p],
        status,
        openAgentIds: openIds([p]),
        shouldInterrupt: useSparklePrefsStore.getState().shouldInterrupt,
      });
    rerender(<ConciergeHost feed={muted({ solo: "waiting" })} />);
    expect(cardAgentIds()).toEqual([]);

    rerender(<ConciergeHost feed={muted({ solo: "working" })} />);
    expect(cardAgentIds()).toEqual([]);
    expect(resolvedCardAgentIds()).toEqual([]);

    // AND UNMUTING BRINGS IT BACK, WITH THE REAL DURATION. This half is what makes the gate a HIDE
    // rather than a DELETE (roborev 59945-M2). The first implementation destroyed the ledger record,
    // which is unrecoverable: a mute can carry an `expiresAt`, and `muted` is re-derived every tick
    // from the agent's CURRENT status, so a permanent deletion keyed on a momentary fact throws away
    // history the reader never asked to lose.
    useSparklePrefsStore.getState().clearPreference("solo");
    rerender(<ConciergeHost feed={feedFrom([p], { solo: "working" })} />);
    expect(resolvedCardAgentIds()).toEqual(["solo"]);
  });

  // THE PIN — the same gate's other half, and the one with no coverage at all until now (roborev
  // 59945-M3). `inScope` is nothing but "is this project the pinned one right now", so it is the
  // most transient fact either branch reads. Deleting `|| !a.inScope` left the whole suite green.
  it("hides an out-of-scope receipt while a pin is held, and restores it on unpin", () => {
    const here = projectOf("p1", "sparkle-desktop", [tab("mine")]);
    const there = projectOf("p2", "drodio-website", [tab("theirs")]);
    const feedWith = (status: Record<string, AgentTabStatus>, pinnedProjectId?: string) =>
      buildConciergeFeed({
        projects: [here, there],
        status,
        openAgentIds: openIds([here, there]),
        pinnedProjectId,
      });

    // `theirs` blocks and clears while nothing is pinned, so it has an honestly-earned receipt.
    const { rerender } = render(
      <ConciergeHost feed={feedWith({ mine: "working", theirs: "waiting" })} />,
    );
    expect(cardAgentIds()).toEqual(["theirs"]);
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "working" })} />);
    expect(resolvedCardAgentIds()).toEqual(["theirs"]);

    // Pin project one. "Disregard other projects' alerts" covers their receipts too.
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "working" }, "p1")} />);
    expect(resolvedCardAgentIds()).toEqual([]);

    // Unpin. THE RECEIPT IS STILL THERE — a pin hid it, it did not spend it.
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "working" })} />);
    expect(resolvedCardAgentIds()).toEqual(["theirs"]);
  });

  // THE HALF THE PAIR ABOVE CANNOT REACH, and the one the original finding was actually about
  // (roborev 60007-M1). Both cases above resolve the episode BEFORE the pin/mute goes on, so there
  // is no OPEN episode for a destructive gate to damage — re-inserting `openedAt.delete(a.id)` for
  // an out-of-scope agent leaves them both green. The damage that regression does is to the
  // DURATION: `raisedAt` is the only record of when a block started, so losing it across a pin
  // turns a three-minute block into "RESOLVED after 0s:" (or into no receipt at all). The duration
  // is the entire reason the founder chose "keep it, greyed" over "delete it", and until now no
  // host case asserted the text of one.
  it("reports the FULL duration when the block spans a pin held while it was still red", () => {
    const here = projectOf("p1", "sparkle-desktop", [tab("mine")]);
    const there = projectOf("p2", "drodio-website", [tab("theirs")]);
    const feedWith = (status: Record<string, AgentTabStatus>, pinnedProjectId?: string) =>
      buildConciergeFeed({
        projects: [here, there],
        status,
        openAgentIds: openIds([here, there]),
        pinnedProjectId,
      });
    // The ledger stamps from `Date.now`, so the clock is the fixture. Spied rather than faked:
    // `vi.useFakeTimers` would also take React's scheduler, and the thing under test is one call.
    const T0 = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(T0);

    // The block is raised with nothing pinned.
    const { rerender } = render(
      <ConciergeHost feed={feedWith({ mine: "working", theirs: "waiting" })} />,
    );
    expect(cardAgentIds()).toEqual(["theirs"]);

    // A minute in, the reader pins the OTHER project — while `theirs` is STILL BLOCKED. This is the
    // moment a destructive gate would drop the open episode.
    clock.mockReturnValue(T0 + 60_000);
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "waiting" }, "p1")} />);
    expect(cardAgentIds()).toEqual([]);
    expect(resolvedCardAgentIds()).toEqual([]);

    // It clears at T+3m, still out of scope, so the receipt is minted but not shown.
    clock.mockReturnValue(T0 + 180_000);
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "working" }, "p1")} />);
    expect(resolvedCardAgentIds()).toEqual([]);

    // Unpin much later. The card is back AND it says three minutes — not "0s", and not a duration
    // measured from the unpin.
    clock.mockReturnValue(T0 + 900_000);
    rerender(<ConciergeHost feed={feedWith({ mine: "working", theirs: "working" })} />);
    expect(resolvedCardAgentIds()).toEqual(["theirs"]);
    const grey = screen
      .queryAllByTestId(NUDGE_CARD_TESTID)
      .find((el) => el.getAttribute("data-resolved") === "true")!;
    expect(within(grey).getByTestId(NUDGE_LEAD_TESTID).textContent).toBe("RESOLVED after 3m:");

    clock.mockRestore();
  });

  // THE REPAINT (roborev 60007-M2). `[x]` on a RESOLVED card writes to module state, so nothing
  // React can see changes; a bump counter is what repaints, and its own lint rule's suggested fix
  // is to DELETE it. Without this case that dep is defended only by a comment, and dropping it
  // regresses the feature to "the card you just dismissed sits there until something unrelated
  // ticks" with the whole suite green. NO RERENDER below, deliberately — that is the assertion.
  it("takes a dismissed grey card off screen immediately, with no feed tick", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    rerender(<ConciergeHost feed={feedFrom([p], { solo: "working" })} />);
    expect(resolvedCardAgentIds()).toEqual(["solo"]);

    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(resolvedCardAgentIds()).toEqual([]);
    // AND IT ACKNOWLEDGED NOTHING. [x] on a finished episode is a plain removal; routing it into
    // `dismissAlert` would write against an episode that has already closed, seeding the NEXT red
    // as pre-dismissed — a genuinely new blocker coming up already silenced.
    expect(dismissed()).toEqual([]);
  });

  // The founder's case again, as a transition. The worker answers and resumes; the orchestrator
  // never stopped working. Nothing red is left, so nothing red may be on screen — the state the
  // screenshot showed and the app did not reach.
  it("drops the inherited-red card when the asking worker resumes", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const { rerender } = render(
      <ConciergeHost feed={feedFrom([p], { orch: "working", w1: "waiting" })} />,
    );
    expect(cardAgentIds()).toEqual(["w1"]);

    rerender(<ConciergeHost feed={feedFrom([p], { orch: "working", w1: "working" })} />);
    expect(cardAgentIds()).toEqual([]);
    // The resolved card names the WORKER — the agent the loud card named — not the orchestrator
    // whose red was only inherited. A rollup that resolved to the parent would put a grey card
    // against an agent that was never blocked.
    expect(resolvedCardAgentIds()).toEqual(["w1"]);
  });
});
