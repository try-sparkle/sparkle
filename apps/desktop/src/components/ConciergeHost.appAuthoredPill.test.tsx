// @vitest-environment jsdom
//
// AN APP-AUTHORED LINE NAMES ITS AGENT AS A PILL — and clicking that pill lands the row at the
// reader's cursor.
//
// The bug, as reported: names the FOUNDER writes render as pills, and names the concierge's BRAIN
// writes render as pills, but the app's own relay receipt — "<Name> is up — I sent your message
// (…)" — was bare text. Same agent, same sentence position, not clickable. The cause was not the
// pill component (which worked): app-authored strings never went through it, because `postSparkle`
// took a `string` and every call site interpolated `${a.name}`.
//
// WHY THIS SUITE GOES THROUGH THE HOST rather than unit-testing the line builder: the builder has its
// own tests (Concierge/conciergeLine.test.ts), and they cannot see the seam that actually broke. The
// claim here is about what the TRANSCRIPT contains after a real outcome arrives, and the two halves
// that could each silently undo it — the sentence the host composes, and whether the column wires a
// resolver into the pill context at all — sit on opposite sides of that seam. A row asserting
// "postSparkle was called with a Line" would pass with the pill rendering as inert prose.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConciergeDispatchResult } from "../services/conciergeDispatch";
import type { RevealOutcome } from "../services/agentReveal";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(() => true),
  // The gate the host asks BEFORE it acts is `revealOutcomeFor` now, not `agentExists`: the
  // question widened from "is that agent there" to "would revealing it CHANGE anything", which is
  // the distinction the pill needs and a boolean could not carry (bead sparkle-ixsb3).
  revealOutcomeFor: vi.fn((): RevealOutcome => "revealed"),
  deferred: undefined as ((r: ConciergeDispatchResult) => void) | undefined,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/agentReveal", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, revealOutcomeFor: h.revealOutcomeFor };
});
vi.mock("../services/conciergeDispatch", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    onDeferredSendOutcome: (cb: (r: ConciergeDispatchResult) => void) => {
      h.deferred = cb;
      return () => {};
    },
  };
});

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { useUiStore } from "../stores/uiStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

function feed(): ConciergeFeed {
  const counts = { needs_you: 0, questions: 0, running: 1, done: 0 };
  const agent = {
    id: "ag1",
    name: "Composer Polish Esc Thumbs",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "working",
    statusColor: "#3f7fe0",
    statusLabel: "Working",
    // `running`, deliberately: a `needs_you` agent also draws a NUDGE CARD, which contains a pill of
    // its own — so a thread-wide pill query would pass on the card and prove nothing about the
    // receipt sentence. This feed puts exactly one pill on screen, and it is the one under test.
    band: "running" as const,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const thread = () => screen.getByTestId("concierge-thread");
const receiptPill = () => within(thread()).getByTestId("concierge-agent-pill");

/** Emit the deferred-send outcome that produces the receipt the founder screenshotted. */
function relayLands() {
  act(() => h.deferred!({ ok: true, path: "free-text", agentId: "ag1", sent: "start on the docs" }));
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  useConciergeThreadStore.getState().clearChat();
  useUiStore.setState({ revealAgentId: null, revealAnchorY: null });
  h.deferred = undefined;
  h.openProjectTab.mockClear();
  h.openProjectTab.mockReturnValue(true);
  h.revealOutcomeFor.mockClear();
  h.revealOutcomeFor.mockReturnValue("revealed");
});
afterEach(() => cleanup());

describe("the app's own relay receipt names the agent as a pill", () => {
  it("renders the name as a CLICKABLE control, not as bare text", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();

    // Against the old code this is the failure: the sentence rendered, but the name was a text node
    // inside it and there was no pill in the thread at all.
    const pill = receiptPill();
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.textContent).toBe("@Composer Polish Esc Thumbs");
    // The id travels WITH the name — that is the whole point, and it is what a bare string cannot do.
    expect(pill.getAttribute("data-agent-id")).toBe("ag1");
  });

  it("still reads as the same sentence around the pill", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    // The copy is unchanged apart from the pill's own `@`; this is a pill, not a rewrite.
    expect(thread().textContent).toContain(
      "@Composer Polish Esc Thumbs is up — I sent your message (\"start on the docs\").",
    );
  });

  it("speaks the sentence to the live region WITHOUT the markdown or the id", () => {
    // The announcer is the "third consumer" agentRefs.ts warns about. A live region handed
    // `[@Name](sparkle-agent:ag1)` reads the uuid aloud and cannot be scrolled past.
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    const spoken = screen.getByTestId("concierge-announcer").textContent ?? "";
    expect(spoken).toContain("Composer Polish Esc Thumbs is up — I sent your message");
    expect(spoken).not.toContain("sparkle-agent:");
    expect(spoken).not.toContain("](");
  });

  it("opens the agent the receipt named when the pill is clicked", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    fireEvent.click(receiptPill(), { detail: 1, clientY: 400 });
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
  });
});

describe("clicking an app-authored pill lands the row at the cursor", () => {
  it("asks for a reveal ANCHORED at the click's viewport Y", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    fireEvent.click(receiptPill(), { detail: 1, clientY: 517 });

    // Against the old code BOTH of these fail: the pill click selected the agent and never asked for
    // a reveal at all, which is why a row below the fold had to be hunted for.
    expect(useUiStore.getState().revealAgentId).toBe("ag1");
    expect(useUiStore.getState().revealAnchorY).toBe(517);
  });

  it("carries the Y of THIS click, so two clicks at different heights differ", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();

    fireEvent.click(receiptPill(), { detail: 1, clientY: 120 });
    expect(useUiStore.getState().revealAnchorY).toBe(120);

    // The reveal is one-shot: the consuming row clears it. Nothing consumes it in this suite, so
    // re-arm explicitly rather than relying on the previous request's leftovers.
    act(() => useUiStore.setState({ revealAgentId: null, revealAnchorY: null }));
    fireEvent.click(receiptPill(), { detail: 1, clientY: 640 });
    expect(useUiStore.getState().revealAnchorY).toBe(640);
  });

  it("sends NO anchor for a keyboard activation", () => {
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    // Enter/Space on a focused button synthesise a click with `detail: 0` and `clientY: 0`.
    // Anchoring to that would yank the column to the top of the viewport — wrong, and unrequested.
    fireEvent.click(receiptPill(), { detail: 0, clientY: 0 });
    expect(useUiStore.getState().revealAgentId).toBe("ag1");
    expect(useUiStore.getState().revealAnchorY).toBeNull();
  });

  it("does NOT ask for a reveal when the agent could not be opened", () => {
    // A reveal for an agent that did not open would scroll the column toward a row that is not
    // going to be there.
    h.revealOutcomeFor.mockReturnValue("gone");
    render(<ConciergeHost feed={feed()} />);
    relayLands();
    fireEvent.click(receiptPill(), { detail: 1, clientY: 300 });
    expect(h.openProjectTab).not.toHaveBeenCalled();
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });
});

// ── THE HOST'S OWN REVEAL BODY ─────────────────────────────────────────────────────────────────
// Cards route their pills through `ConciergeHost.revealAgentById` so they get `revealAgent`'s gates
// — `showAllStatusBands()` / `expandOrchestrators()`, which exist because a WORKER's row is
// otherwise not drawn at all. And because supplying `onOpen` SUPPRESSES the pill's own live notice,
// a miss on that path is silent unless the host says something: `revealAgent` used to drop
// `openProjectTab`'s boolean, so a card whose agent closed under it swallowed the click entirely
// (roborev 56068).
//
// DRIVEN THROUGH THE NUDGE CARD, not the receipt pill. The receipt pill is on the CONTEXT path and
// reports its own miss with its own notice — so a "did the thread change" assertion against it
// passes for the wrong reason whatever the host does. A first version of this row did exactly that
// and survived both mutations.
describe("the host reveals what a CARD's pill names, and says so when it cannot", () => {
  /** A `needs_you` agent, which is what draws a nudge card and its caller-owned pill. */
  function redFeed(): ConciergeFeed {
    const f = feed() as unknown as {
      projects: { agents: { band: string; status: string; statusLabel: string }[] }[];
      counts: Record<string, number>;
      scopedCounts: Record<string, number>;
    };
    const a = f.projects[0]!.agents[0]!;
    a.band = "needs_you";
    a.status = "approval";
    a.statusLabel = "Approve?";
    f.counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
    f.scopedCounts = f.counts;
    return f as unknown as ConciergeFeed;
  }

  const nudgePill = () =>
    within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill");

  it("says so in the thread when the reveal does not land", () => {
    render(<ConciergeHost feed={redFeed()} />);
    // The agent closed between the render that drew the card and the click that hit it — the race
    // the context path covers with its retry notice, and which this path must cover itself.
    h.openProjectTab.mockReturnValue(false);

    const before = thread().textContent ?? "";
    fireEvent.click(nudgePill());
    const after = thread().textContent ?? "";
    expect(after).not.toBe(before);
    expect(after).toContain("isn't open any more");
  });

  it("stays quiet when the reveal DOES land — a success is not an error message", () => {
    render(<ConciergeHost feed={redFeed()} />);
    h.openProjectTab.mockReturnValue(true);
    const before = thread().textContent ?? "";
    fireEvent.click(nudgePill());
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "ag1");
    expect(thread().textContent).toBe(before);
  });
});
