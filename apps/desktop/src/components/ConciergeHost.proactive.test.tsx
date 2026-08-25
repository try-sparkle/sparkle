// @vitest-environment jsdom
//
// THE PROACTIVE PUSH CHANNEL, END TO END THROUGH THE HOST (roborev 54166-M5).
//
// The trigger, the transport and the staleness rule all landed with their own unit tests and
// NOTHING MOUNTED THEM: no scheduler was created, nothing set `proactive`/`digest` on a message,
// nothing called `markStaleProactive`. A push triggered by any path would therefore have produced
// an ordinary sparkle bubble with no digest — precisely the append-only "You have 3 P1s" that keeps
// asserting a resolved count forever, with no way to ever retract it (PRD §2a).
//
// So these cases are about WIRING, not arithmetic. The scheduler's own cost controls are pinned in
// services/conciergeProactive.test.ts; what is checked here is that the host observes the feed,
// spends a turn on a real change, renders the reply AS a push, and retracts it when the state it
// described stops holding.
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Prompts the host asked the transport to push. */
  pushes: [] as string[],
  /** The turn id the transport hands back. `null` = it stood down (the user owns the turn). */
  pushId: "9" as string | null,
  proactiveIds: new Set<string>(),
  done: null as ((e: { id: string; sessionId: string; text: string }) => void) | null,
}));

vi.mock("../services/concierge", () => ({
  // The failure handler reads the failed turn's account via turnAccountFor(e.id); a mock that omits
  // it throws 'No turnAccountFor export' the moment an auth/quota failure reaches that branch. null =
  // 'turn not remembered', which the rotation degrades on.
  turnAccountFor: () => null,
  // The LIVE tool channel. A no-op unsubscribe, exactly like its siblings: these suites are about
  // the host's other wiring, and a mock that simply OMITS an export the host calls does not
  // degrade — vitest throws on the missing property and every case in the file dies at mount.
  onConciergeTool: () => () => {},
  onConciergeDelta: () => () => {},
  onConciergeDone: (cb: (e: { id: string; sessionId: string; text: string }) => void) => {
    h.done = cb;
    return () => {
      h.done = null;
    };
  },
  onConciergeError: () => () => {},
  onConciergeTurnsAbandoned: () => () => {},
  startConciergeTurn: vi.fn(() => Promise.resolve("1")),
  startProactiveConciergeTurn: vi.fn((prompt: string) => {
    h.pushes.push(prompt);
    if (h.pushId !== null) h.proactiveIds.add(h.pushId);
    return Promise.resolve(h.pushId);
  }),
  isProactiveTurn: (id: string) => h.proactiveIds.has(id),
  isSupersededDetail: (d: string) => d.includes("superseded") || d.includes("cancelled"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));
// The concierge column now locks its paid half when AI enhancements are off (bead sparkle-4562),
// and something in this tree drives authStore.refresh(), which CLEARS `me` when no auth token is
// present — so seeding the store alone is not enough: the refresh races it back to signed-out and
// the column renders the lock instead of the thread. Stubbing the token/identity source is what
// makes the seeded state survive. This suite is about push RENDERING, not entitlement;
// Concierge/ConciergeColumn.locked.test.tsx owns the locked state's own behaviour.
const SIGNED_IN_ME = { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 };
vi.mock("../services/sparkleApi", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasToken: () => Promise.resolve(true),
  fetchMe: () => Promise.resolve(SIGNED_IN_ME),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { PROACTIVE_COALESCE_MS } from "../services/conciergeProactive";
import { useResearchStore } from "../services/research/store";
import type { ResearchTask } from "../services/research/types";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { StatusBand } from "../engine/buildSections";


// The concierge column now replaces its thread with the AI-enhancements lock when the gate is shut
// (bead sparkle-4562). This suite is about PUSH rendering, not entitlement, so it opens the gate
// explicitly; ConciergeColumn.locked.test.tsx owns the locked state's own behaviour.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({ me: SIGNED_IN_ME, creditFloorCents: 0 } as never);
}

/** One project, one agent, in whatever state the case needs. */
// `band` takes the SHARED StatusBand rather than a hand-written union: the union went stale the
// day `questions` was added, and a re-listed taxonomy is exactly what buildSections warns against.
function feedOf(status: string, band: StatusBand): ConciergeFeed {
  const counts = {
    needs_you: band === "needs_you" ? 1 : 0,
    questions: band === "questions" ? 1 : 0,
    running: band === "running" ? 1 : 0,
    done: band === "done" ? 1 : 0,
  };
  return {
    projects: [
      {
        id: "p1",
        name: "sparkle-desktop",
        inScope: true,
        counts,
        scopedCounts: counts,
        agents: [
          {
            id: "ag0",
            name: "Kraken Auth",
            projectId: "p1",
            projectName: "sparkle-desktop",
            kind: "build",
            status,
            statusColor: "#e0533f",
            statusLabel: band === "needs_you" ? "Blocked" : "Working",
            band,
            inScope: true,
            muted: false,
            topLevel: true,
            parentRowId: null,
            representedElsewhere: false,
            rolledUpGreen: false,
          },
        ],
      },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const calm = () => feedOf("working", "running");
const needing = () => feedOf("blocked", "needs_you");

/** Run the coalescing window down and let the transport's promise settle. */
async function settle(ms = PROACTIVE_COALESCE_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  openConciergeAiGate();
  vi.useFakeTimers();
  h.pushes.length = 0;
  h.pushId = "9";
  h.proactiveIds.clear();
  h.done = null;
  useConciergeThreadStore.getState().clearChat();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the host mounts the push channel", () => {
  it("spends NOTHING on mount — the column is already rendering that state", async () => {
    render(<ConciergeHost feed={needing()} />);
    await settle(PROACTIVE_COALESCE_MS * 4);
    expect(h.pushes).toEqual([]);
  });

  it("pushes once when an agent starts needing the user, with the surfaced count and item", async () => {
    const { rerender } = render(<ConciergeHost feed={calm()} />);
    rerender(<ConciergeHost feed={needing()} />);
    await settle();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toContain("Kraken Auth");
    // Singular — `bandCountLabel` agrees the verb with the count ("1 Needs you", "2 Need you").
    expect(h.pushes[0]).toContain("1 Needs you");
    // The whole point of the channel: the brain is told nobody asked it anything.
    expect(h.pushes[0]!.toLowerCase()).toContain("the user has not asked you anything");
  });

  it("tears the channel down on unmount, so a closed window stops spending", async () => {
    const { rerender, unmount } = render(<ConciergeHost feed={calm()} />);
    rerender(<ConciergeHost feed={needing()} />);
    unmount();
    await settle(PROACTIVE_COALESCE_MS * 4);
    expect(h.pushes).toEqual([]);
  });
});

describe("a push lands in the thread as a push", () => {
  async function pushAndReply(text = "Kraken Auth is blocked on an approval.") {
    const view = render(<ConciergeHost feed={calm()} />);
    view.rerender(<ConciergeHost feed={needing()} />);
    await settle();
    act(() => h.done?.({ id: "9", sessionId: "sess-A", text }));
    return view;
  }

  it("renders it labelled as unprompted, not as a reply to nothing", async () => {
    await pushAndReply();
    const push = screen.getByTestId("concierge-push");
    expect(push.textContent).toContain("Sparkle noticed");
    expect(push.textContent).toContain("Kraken Auth is blocked");
    expect(push.getAttribute("data-stale")).toBe("false");
  });

  it("goes visibly stale once the state it described no longer holds", async () => {
    // The bug §2a names, and the reason a digest rides along with the message at all: the thread is
    // append-only, so a resolved count would keep asserting itself forever.
    const view = await pushAndReply("You have 1 agent needing you.");
    expect(screen.getByTestId("concierge-push").getAttribute("data-stale")).toBe("false");
    view.rerender(<ConciergeHost feed={feedOf("idle", "done")} />);
    const push = screen.getByTestId("concierge-push");
    expect(push.getAttribute("data-stale")).toBe("true");
    expect(push.textContent).toContain("no longer current");
    // The text is NOT removed — the founder may be reading it as it turns.
    expect(push.textContent).toContain("You have 1 agent needing you.");
  });

  it("leaves an ordinary reply alone — only pushes are retractable", async () => {
    h.pushId = null; // nothing pushed; this `done` is a plain reply's
    const view = render(<ConciergeHost feed={calm()} />);
    act(() => h.done?.({ id: "1", sessionId: "sess-A", text: "Sure, here you go." }));
    view.rerender(<ConciergeHost feed={needing()} />);
    expect(screen.queryByTestId("concierge-push")).toBeNull();
    expect(screen.getByTestId("concierge-thread").textContent).toContain("Sure, here you go.");
  });
});

describe("a push that never ran is not treated as delivered", () => {
  it("keeps the change owed to the founder when the transport stands down", async () => {
    // `concierge_proactive_turn` refuses while the user owns the conversation. If the host reported
    // that as a delivery the scheduler would advance its baseline past the change and the founder
    // would never be told about it — the exact failure the channel exists to prevent.
    h.pushId = null;
    const { rerender } = render(<ConciergeHost feed={calm()} />);
    rerender(<ConciergeHost feed={needing()} />);
    await settle();
    expect(h.pushes).toHaveLength(1);
    expect(screen.queryByTestId("concierge-push"), "nothing was said").toBeNull();

    // The user puts their turn down; the same unreported change is still owed.
    h.pushId = "9";
    await settle(3 * 60_000);
    expect(h.pushes.length).toBeGreaterThan(1);
    expect(h.pushes.at(-1)).toContain("Kraken Auth");
  });
});

// ══ RESEARCH COMING BACK REACHES THE SCHEDULER ══════════════════════════════════════════════════
//
// THE WIRING HALF of bead sparkle-wo4c79, and the half that can silently not exist. The scheduler's
// own suite proves that `observeResearch` buys a turn, but it calls that method directly — so it
// would pass unchanged if the host never subscribed the scheduler to the research store at all,
// which is precisely the "defaulted seam" vacuity shape AGENTS.md warns about. What is checked here
// is the edge: a task going terminal in the STORE, with nobody touching the scheduler by hand,
// produces a push.
describe("a finished research run wakes the concierge through the host", () => {
  const task = (over: Partial<ResearchTask> & { id: string }): ResearchTask =>
    ({
      question: "epic vs tasks",
      depth: "quick",
      projectId: "p1",
      projectRoot: "/p1",
      status: "done",
      createdAt: 1,
      startedAt: 2,
      finishedAt: 3,
      findings: "Epics are containers; tasks are the unit of work.",
      error: null,
      readAt: null,
      ...over,
    }) as ResearchTask;

  /** Put tasks into the real store, which is what the host's subscription is listening to. */
  const store = (...tasks: ResearchTask[]) =>
    act(() => {
      useResearchStore.setState({
        byId: Object.fromEntries(tasks.map((t) => [t.id, t])),
        hydrated: true,
      } as never);
    });

  afterEach(() => {
    useResearchStore.setState({ byId: {}, hydrated: false } as never);
  });

  it("pushes the ANSWER on a calm fleet, with nothing else buying the turn", async () => {
    // The founder's exact case: the fleet is quiet, so under the old rule no turn was ever bought
    // and the answer sat until he thought to ask for it.
    render(<ConciergeHost feed={calm()} />);
    await settle(PROACTIVE_COALESCE_MS * 2);
    expect(h.pushes, "nothing before the run finishes").toEqual([]);

    await store(task({ id: "r1" }));
    await settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toContain("Epics are containers");
    expect(h.pushes[0]).toContain("speaking first, unprompted");
    // It is not the fleet's message: no roster line rode in on it.
    expect(h.pushes[0]).not.toContain("Kraken Auth");
  });

  it("pushes for a FAILED run too — the case the founder was never told about", async () => {
    render(<ConciergeHost feed={calm()} />);
    await settle(PROACTIVE_COALESCE_MS * 2);

    await store(
      task({
        id: "r1",
        status: "failed",
        findings: null,
        error: "The research run could not start — the Claude CLI is not signed in.",
      }),
    );
    await settle();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toContain("not signed in");
  });

  it("says nothing for a run the founder CANCELLED himself", async () => {
    render(<ConciergeHost feed={calm()} />);
    await settle(PROACTIVE_COALESCE_MS * 2);

    await store(task({ id: "r1", status: "cancelled", findings: null, error: null }));
    await settle(PROACTIVE_COALESCE_MS * 4);

    expect(h.pushes).toEqual([]);
  });

  it("says nothing for a run that is still going", async () => {
    // The guard against waking on every poll: only a TERMINAL task is news.
    render(<ConciergeHost feed={calm()} />);
    await settle(PROACTIVE_COALESCE_MS * 2);

    await store(task({ id: "r1", status: "running", findings: null, finishedAt: null }));
    await settle(PROACTIVE_COALESCE_MS * 4);

    expect(h.pushes).toEqual([]);
  });

  it("says nothing for a finding already delivered — `readAt` is the authority", async () => {
    render(<ConciergeHost feed={calm()} />);
    await settle(PROACTIVE_COALESCE_MS * 2);

    await store(task({ id: "r1", readAt: 12_345 }));
    await settle(PROACTIVE_COALESCE_MS * 4);

    expect(h.pushes).toEqual([]);
  });
});
