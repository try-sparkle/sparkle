// @vitest-environment jsdom
//
// COLLAPSED BY DEFAULT — AND EXPANDED IS THE FULL, WRITABLE CARD.
//
// The founder, 2026-08-22 (beads sparkle-lm78sq / sparkle-h9wgyf): *"they're just taking up too much
// real estate, and I love them, but I want them to be click to expandable… maybe half the height
// when it's closed."* And, about the other half of the gesture: *"When I click to expand the card in
// the chat, I should see the full card. I should be able to make a comment. I should be able to do
// everything in the card when it's expanded in the chat view."*
//
// ══ THE REVERSAL THIS FILE RECORDS, AND THE TRAP INSIDE IT ══════════════════════════════════════
// This file used to guard the OPPOSITE rule — every named bead's card rendered already-open, over a
// per-message budget (`[ui].bead_cards_expanded`, `bead_cards_expanded_max`). That instruction is
// superseded. But the thing it was reacting to is NOT coming back: the old default was a BARE PILL,
// a card collapsed so far it showed nothing. The new default is a HALF-HEIGHT CARD. So the
// assertions below are written to fail on EITHER end of the spectrum — a card that opens itself, and
// a bead that renders as a pill with no card at all.
//
// ══ WHAT THESE ROWS ARE GUARDING, SPECIFICALLY ═════════════════════════════════════════════════
// Nothing here asserts "a pill exists": that was true before any of this and would stay true with
// the whole feature deleted. Every row below is on a SIDE EFFECT — a card in the DOM, a
// `beads_detail` read that did or did not happen, a `beads_comment` write that reached the wire, a
// thread that re-read afterwards, a jump that carried the right bead's id.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const beadsDetail = vi.fn();
const beadsComment = vi.fn();
vi.mock("../../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beadsCommands")>();
  return {
    ...actual,
    beadsDetail: (...a: unknown[]) => beadsDetail(...a),
    beadsComment: (...a: unknown[]) => beadsComment(...a),
  };
});

const openProjectTab = vi.fn();
vi.mock("../../services/openProjectTab", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/openProjectTab")>();
  return { ...actual, openProjectTab: (...a: unknown[]) => openProjectTab(...a) };
});

import { Markdown } from "../Markdown";
// THE REAL THREAD, not a stand-in. Two rows below mount this instead of `mountReply` precisely
// because it is the only thing that can answer "does `ConciergeMessageRow` still wrap its markdown?"
import { ConciergeThread } from "./ConciergeThread";
import {
  BeadChatSurfaceProvider,
  BeadPillProvider,
  type BeadPillContextValue,
} from "./BeadPill";
import type { ConciergeMessage } from "./types";
import { useBeadsStore } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Bead } from "../../services/beads";
import type { AgentTab, Project } from "../../types";

afterEach(() => cleanup());

// The poller would shell out to `bd` through a Tauri bridge jsdom does not have. Stubbed for the
// whole file, exactly as `BeadPill.test.tsx` does, so beads stay ON and the real resolution path
// runs.
const realPoller = {
  startPolling: useBeadsStore.getState().startPolling,
  stopPolling: useBeadsStore.getState().stopPolling,
};
const settingsBefore = {
  beadCardsExpanded: useSettingsStore.getState().beadCardsExpanded,
  beadCardsExpandedMax: useSettingsStore.getState().beadCardsExpandedMax,
};
const projectsBefore = useProjectStore.getState().projects;

beforeEach(() => {
  beadsDetail.mockReset();
  beadsComment.mockReset();
  openProjectTab.mockReset();
  beadsDetail.mockResolvedValue({ comments: [] });
  beadsComment.mockResolvedValue(undefined);
  useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} });
});
afterEach(() => {
  useBeadsStore.setState(realPoller);
  useSettingsStore.setState(settingsBefore);
  act(() => {
    useProjectStore.setState({ projects: projectsBefore, selectedProjectId: null });
  });
});

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Never hide a row that needs action",
    description: "FOUNDER'S RULE, verbatim: \"We should never hide a row that needs action from me.\"",
    status: "open",
    type: "bug",
    priority: 0,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const QOGAH = bead({ id: "sparkle-qogah" });

function worker(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: "worker-one",
    kind: "worker",
    beadId: null,
    ...over,
  } as AgentTab;
}

function project(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "sparkle",
    rootPath: "/repo",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents,
    selectedAgentId: null,
  } as Project;
}

/** Put a project's backlog and roster where `ConciergeBeadCard` reads them. The card resolves its
 *  own lineage from the LIVE stores (never from the pill's fixture), so a lineage row that is not
 *  seeded here cannot appear — which is exactly what the leaf-card row below asserts. */
function seedStores(beads: Bead[], agents: AgentTab[] = []) {
  act(() => {
    useSettingsStore.setState({ beadsEnabled: true });
    useProjectStore.setState({ projects: [project(agents)], selectedProjectId: "p1" });
    useBeadsStore.setState({ byProject: { p1: { beads, board: {} as never, loadedAt: 1 } } });
  });
}

/** A board holding `beads`. `rootPath` is supplied on purpose — WITHOUT it the card renders
 *  read-only, and every write assertion below would be unsatisfiable for a reason that has nothing
 *  to do with expansion. */
function ctx(beads: Bead[], over: Partial<BeadPillContextValue> = {}): BeadPillContextValue {
  return {
    beads: new Map(beads.map((b) => [b.id, { bead: b, projectId: "p1", rootPath: "/repo" }])),
    onViewOnBoard: vi.fn(() => true),
    // SUPPLIED BY DEFAULT, because it is now what makes a `Tasks:` pill a LINK at all
    // (`sparkle-huw924.12` moved that path off the board and onto the Epics column). Callback-is-
    // the-switch: without it the pills render as static text, and a row asserting "clicking a pill
    // does not collapse the card" would be asserting it about something that is not clickable.
    onViewInColumn: vi.fn(() => true),
    onOpenAgent: vi.fn(),
    ...over,
  };
}

/** THE CHAT PATH — the marker `ConciergeMessageRow` wraps every answer's markdown in. It is what
 *  makes a resolved bead draw a collapsed card at all, so every row below that expects a card
 *  mounts through here. `mountBare` is its other half. */
function mountReply(value: BeadPillContextValue, text: string) {
  return render(
    <BeadPillProvider value={value}>
      <BeadChatSurfaceProvider text={text}>
        <Markdown text={text} />
      </BeadChatSurfaceProvider>
    </BeadPillProvider>,
  );
}

/** ══ THE PRODUCTION WIRING, WITH NOTHING MOUNTED BY HAND ═══════════════════════════════════════
 *  `mountReply` above supplies `BeadChatSurfaceProvider` ITSELF, which makes every row built on it
 *  blind to the one production line that actually supplies it — the wrap around each `<Markdown>`
 *  call site in `ConciergeMessageRow`. Delete that wrap and all of them stay green while the feature
 *  is dead for everyone; this helper is the defaulted-seam antidote, so it must NEVER grow a
 *  provider of its own. It renders the real thread and lets `ConciergeMessageRow` do the wrapping. */
function mountThread(value: BeadPillContextValue, messages: ConciergeMessage[]) {
  return render(
    <BeadPillProvider value={value}>
      <ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />
    </BeadPillProvider>,
  );
}

/** EVERY OTHER `<Markdown>` IN THE APP — a support modal, an agent's own scrollback, a user's own
 *  bubble. No marker, so the pill behaves exactly as it did before this change. */
function mountBare(value: BeadPillContextValue, text: string) {
  return render(
    <BeadPillProvider value={value}>
      <Markdown text={text} />
    </BeadPillProvider>,
  );
}

const pills = () => screen.queryAllByTestId("concierge-bead-pill");
const cards = () => screen.queryAllByTestId("concierge-bead-card");
const card = () => screen.queryByTestId("concierge-bead-card");
const thread = () => screen.queryByTestId("concierge-bead-card-comments");
const composer = () => screen.queryByTestId("concierge-bead-card-comments-input");
const submit = () => screen.getByTestId("concierge-bead-card-comments-submit");
const description = () => screen.queryByTestId("concierge-bead-card-description");
const closers = () => screen.queryAllByTestId("concierge-bead-card-close");

// ── 1. THE DEFAULT ──────────────────────────────────────────────────────────────────────────────

describe("collapsed by default — a CARD, not a pill, and not an open one", () => {
  // THE HALF THE OLD RULE GOT RIGHT. A bead the concierge names is worth a card without a click;
  // what changed is how much of the card. This row fails if anyone "reverts" to the bare pill.
  it("draws a card with no click at all", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(cards()).toHaveLength(1);
    expect(pills()).toHaveLength(1);
  });

  // THE HALF THAT IS NEW. `collapsed` is not directly observable from outside `BeadCard`, so this
  // asserts the two things the concierge itself withholds while collapsed — and both are things the
  // founder explicitly assigned to the expanded state.
  it("withholds the comment thread and the composer while collapsed", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(thread()).toBeNull();
    expect(composer()).toBeNull();
  });

  // *"When it's collapsed, it would not scroll — would just have less of the actual text."* A
  // scrollable region nested inside a scrolling thread captures the wheel and stops the thread.
  it("renders NO description at all when collapsed, so nothing can nest a scroller in the thread", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    // STRONGER THAN "no clamp", and it is what actually shipped. This assertion used to read
    // `description()?.style.maxHeight === ""`, which was written before the collapsed card existed
    // — and optional chaining made it pass on a NULL element by accident of syntax. The founder's
    // rule is "less of the actual text", not the same text in a smaller window, so the honest check
    // is that the element is absent: with no description there is no `descMaxHeight` to apply and
    // no inner scroller to steal the thread's wheel.
    expect(description()).toBeNull();
    // …and it comes back on expand, so the absence above is the collapse, not a card that lost it.
    fireEvent.click(pills()[0]!);
    expect(description()).not.toBeNull();
  });

  // THE READ THAT MUST NOT HAPPEN. This card is now mounted for EVERY bead the concierge ever named,
  // so a fetch-on-mount would be one `beads_detail` per bead per thread against a single-writer bd
  // store. Asserting the call count is the only way to see it: the DOM looks identical either way.
  it("reads no comments on mount — the fetch is the reader's gesture, not the render", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(beadsDetail).not.toHaveBeenCalled();
  });

  // ── THE SURFACE BOUNDARY, AND WHY IT IS NOT A HEDGE ────────────────────────────────────────
  // `BeadPill` draws inside EVERY `<Markdown>` in the app, and the founder's ruling is about the
  // chat thread. Rendering a card unconditionally puts one inside a mounted agent's terminal, whose
  // contract is that it declares no face but the terminal's — a straight regression, and the reason
  // this gate exists rather than a blanket "always draw the card".
  it("draws NO card outside a chat message, where the pill is still click-to-open", () => {
    seedStores([QOGAH]);
    mountBare(ctx([QOGAH]), "see sparkle-qogah");
    expect(cards()).toHaveLength(0);
    expect(pills()).toHaveLength(1);
    fireEvent.click(pills()[0]!);
    expect(cards()).toHaveLength(1);
  });

  it("advertises itself as collapsed to a screen reader", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("false");
  });
});

// ── 2. THE BUDGET IS RETIRED ────────────────────────────────────────────────────────────────────

describe("no exceptions — the auto-expand budget decides nothing any more", () => {
  const MANY = ["sparkle-aaaa1", "sparkle-bbbb2", "sparkle-cccc3"].map((id) => bead({ id }));

  // ONE RULE, NO SURPRISES. Under the retired budget a cap of 1 left the tail as bare pills with no
  // card; this row fails if any of that machinery is still wired to anything.
  it("draws a card for every named bead even with the old cap set to 1", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    seedStores(MANY);
    mountReply(ctx(MANY), "see sparkle-aaaa1 and sparkle-bbbb2 and sparkle-cccc3");
    expect(cards()).toHaveLength(3);
  });

  // …and every one of them starts COLLAPSED, which the cap used to be the only thing producing.
  it("starts every one of them collapsed", () => {
    useSettingsStore.setState({ beadCardsExpandedMax: 1 });
    seedStores(MANY);
    mountReply(ctx(MANY), "see sparkle-aaaa1 and sparkle-bbbb2 and sparkle-cccc3");
    expect(screen.queryAllByTestId("concierge-bead-card-comments")).toHaveLength(0);
  });

  // The old revert switch. It used to restore click-to-expand; there is nothing left for it to
  // switch, and a card must still appear.
  it("still draws the card with [ui].bead_cards_expanded = false", () => {
    useSettingsStore.setState({ beadCardsExpanded: false });
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(cards()).toHaveLength(1);
  });
});

// ── 3. THE GESTURE ──────────────────────────────────────────────────────────────────────────────

describe("click to expand, click to collapse", () => {
  it("expands on the pill and reads the thread exactly once", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    expect(beadsDetail).toHaveBeenCalledTimes(1);
    expect(beadsDetail).toHaveBeenCalledWith("/repo", "sparkle-qogah");
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("true");
  });

  it("restores the description clamp when expanded", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(description()?.style.maxHeight).toBe("180px"));
  });

  // COLLAPSE TAKES BACK THE HEIGHT, IT DOES NOT DISMISS THE CARD. The card survives every exit —
  // that is the difference between this and the popover the old code closed.
  it("collapses on a second press and leaves the card standing", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    fireEvent.click(pills()[0]!);
    expect(thread()).toBeNull();
    expect(cards()).toHaveLength(1);
  });

  it("collapses on Escape, and consumes the press", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(thread()).toBeNull();
    expect(cards()).toHaveLength(1);
  });

  it("collapses on a press outside it", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(thread()).toBeNull();
  });

  // ── THE STOP-PROPAGATION REQUIREMENT, FROM THIS SURFACE'S SIDE ─────────────────────────────
  // The whole card body is the expand target, so a press on anything INSIDE it must not reach the
  // collapse paths this component owns. Mutating away the `closest(CARD_TESTID)` guard in
  // `BeadPill`'s click-outside listener turns this row red.
  it("stays expanded when the press lands INSIDE the card — including on its composer", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(composer()).not.toBeNull());
    act(() => {
      composer()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    // THE INVARIANT THIS TEST IS ACTUALLY ABOUT: a press inside the composer left the card open.
    // Without `stopPropagation` on the comment thread this collapses the card mid-sentence.
    expect(thread()).not.toBeNull();
    expect(composer()).not.toBeNull();
  });

  it("collapses when the press lands on the card BODY — the body is the toggle, both ways", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(composer()).not.toBeNull());
    // The PAIRED case, and the reason the one above is not vacuous: the same gesture on the body
    // DOES toggle, so "the composer press did nothing" is a statement about the composer rather
    // than about a card that never collapses at all.
    fireEvent.click(card()!);
    expect(composer()).toBeNull();
  });
});

// ── 4. EXPANDED MEANS WRITABLE ──────────────────────────────────────────────────────────────────

describe("the expanded card in chat is the full, writable card", () => {
  it("renders the comments it read", async () => {
    beadsDetail.mockResolvedValue({
      comments: [{ id: "c1", author: "DROdio", text: "ship it", createdAt: null }],
    });
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() =>
      expect(screen.getByTestId("concierge-bead-card-comments-item-text").textContent).toBe("ship it"),
    );
  });

  // THE WRITE, END TO END, THROUGH THE REAL COMPOSER. Deliberately not "a textarea exists": the
  // concierge chrome shipped for months WITH a card and WITHOUT this path, so the presence of the
  // card proves nothing about the write. What is asserted is that the text reached `beads_comment`
  // with this project's path and this bead's id, AND that the thread re-read afterwards.
  it("posts a comment through beadsComment and re-reads the thread", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(beadsDetail).toHaveBeenCalledTimes(1);

    beadsDetail.mockResolvedValue({
      comments: [{ id: "c9", author: "DROdio", text: "half height, click to expand", createdAt: null }],
    });
    fireEvent.change(composer()!, { target: { value: "half height, click to expand" } });
    fireEvent.click(submit());

    await waitFor(() =>
      expect(beadsComment).toHaveBeenCalledWith("/repo", "sparkle-qogah", "half height, click to expand"),
    );
    // THE REFRESH IS THE SECOND HALF AND IS EASY TO OMIT: without the reload bump the write lands in
    // `bd` and the reader stares at a thread that never shows it.
    await waitFor(() => expect(beadsDetail).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("concierge-bead-card-comments-item-text").textContent).toBe(
        "half height, click to expand",
      ),
    );
  });

  // CALLBACK-IS-THE-SWITCH. A surface with no project path cannot address `bd`, so it gets a
  // read-only thread rather than a composer whose send can only fail.
  it("offers no composer on a card with no project path, and reads nothing", async () => {
    seedStores([QOGAH]);
    const value: BeadPillContextValue = {
      beads: new Map([["sparkle-qogah", { bead: QOGAH, projectId: "p1" }]]),
      onViewOnBoard: vi.fn(() => true),
    };
    mountReply(value, "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(composer()).toBeNull();
    expect(beadsDetail).not.toHaveBeenCalled();
  });

  it("survives StrictMode's double-invoke without double-posting", async () => {
    seedStores([QOGAH]);
    render(
      <StrictMode>
        <BeadPillProvider value={ctx([QOGAH])}>
          <Markdown text="see sparkle-qogah" />
        </BeadPillProvider>
      </StrictMode>,
    );
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(composer()).not.toBeNull());
    fireEvent.change(composer()!, { target: { value: "once" } });
    fireEvent.click(submit());
    await waitFor(() => expect(beadsComment).toHaveBeenCalledTimes(1));
  });
});

// ── 5. LINEAGE ──────────────────────────────────────────────────────────────────────────────────

describe("the two lineage rows, resolved from the live stores", () => {
  const EPIC = bead({ id: "sparkle-epic1", title: "The epic", type: "epic" });
  const KID_A = bead({ id: "sparkle-kida1", title: "Kid A", parent: "sparkle-epic1" });
  const KID_B = bead({ id: "sparkle-kidb2", title: "Kid B", parent: "sparkle-epic1" });
  const AGENT = worker({ id: "agent-7", name: "Kid A builder", beadId: "sparkle-kida1" });

  it("draws the children as pills, collapsed, with no click", () => {
    seedStores([EPIC, KID_A, KID_B]);
    mountReply(ctx([EPIC, KID_A, KID_B]), "see sparkle-epic1");
    const taskPills = screen.getAllByTestId("concierge-bead-card-tasks-pill");
    expect(taskPills.map((p) => p.textContent)).toEqual(["Kid A", "Kid B"]);
  });

  // ══ A TASK PILL OPENS THE EPICS COLUMN, NOT THE BOARD (bead `sparkle-huw924.12`) ═════════════
  // The founder: *"when I click on a task from the concierge window, I want it to by default open
  // up in the epic column. I want it to open the epic that is its parent. And then I want it to
  // open up the build agents that are assigned to that task."*
  //
  // THIS ROW USED TO ASSERT `onViewOnBoard`, and that was the bug rather than the contract: the
  // Plan board is an `inset: 0` sibling that COVERS the Epics column, so the gesture meant to
  // reveal the column was the one that hid it.
  //
  // REAL LINKS, not decoration — and the id it carries is the CHILD's, which is the thing a
  // hard-coded `bead.id` would get wrong while still looking like it worked. `KID_B` (index 1) on
  // purpose, for exactly that reason.
  it("opens the CHILD's bead in the epics column when its pill is clicked", () => {
    const onViewInColumn = vi.fn(() => true);
    const onViewOnBoard = vi.fn(() => true);
    seedStores([EPIC, KID_A, KID_B]);
    mountReply(ctx([EPIC, KID_A, KID_B], { onViewInColumn, onViewOnBoard }), "see sparkle-epic1");
    fireEvent.click(screen.getAllByTestId("concierge-bead-card-tasks-pill")[1]!);
    expect(onViewInColumn).toHaveBeenCalledWith({
      beadId: "sparkle-kidb2",
      projectId: "p1",
      // The SETTER, not a claim about the target's rung: `openBeadFocus` is the one that stamps a
      // reveal, and `revealFor` then resolves the target to its parent epic. See the call site.
      isEpic: false,
    });
    // BOTH HALVES, or this passes for a card that opens the column AND the board — which would put
    // the board overlay straight back on top of the column it just revealed.
    expect(onViewOnBoard).not.toHaveBeenCalled();
  });

  // ══ AND THE CARD'S OWN `Board view` LINK STILL GOES TO THE BOARD ══════════════════════════════
  // The pair that makes the row above safe. Asked whether the concierge should keep any route from
  // a task to its board card, the founder chose to let the pill always open the Epics column
  // BECAUSE this link still exists — so "the pill went to the column" is only half the contract,
  // and a rewiring that took both would have satisfied the row above while removing the escape
  // hatch his answer depends on. They are separate handlers now precisely so this can be asserted.
  it("keeps this card's own Board view link on the board", () => {
    const onViewInColumn = vi.fn(() => true);
    const onViewOnBoard = vi.fn(() => true);
    seedStores([EPIC, KID_A, KID_B]);
    mountReply(ctx([EPIC, KID_A, KID_B], { onViewInColumn, onViewOnBoard }), "see sparkle-epic1");
    fireEvent.click(screen.getByTestId("concierge-bead-card-open-on-board"));
    expect(onViewOnBoard).toHaveBeenCalledWith({ beadId: "sparkle-epic1", projectId: "p1" });
    // It is THIS card's own bead, and it did NOT leak into the column path.
    expect(onViewInColumn).not.toHaveBeenCalled();
  });

  it("draws the build agents on the children, and jumps to one on a click", () => {
    const onOpenAgent = vi.fn();
    seedStores([EPIC, KID_A, KID_B], [AGENT]);
    mountReply(ctx([EPIC, KID_A, KID_B], { onOpenAgent }), "see sparkle-epic1");
    const agentPills = screen.getAllByTestId("concierge-bead-card-build-agents-pill");
    expect(agentPills.map((p) => p.textContent)).toEqual(["Kid A builder"]);
    fireEvent.click(agentPills[0]!);
    expect(onOpenAgent).toHaveBeenCalledWith({ agentId: "agent-7", projectId: "p1" });
  });

  // A LEAF COSTS NO HEIGHT. Rendering an empty lineage region on every leaf card is the exact height
  // this whole change is reclaiming.
  it("draws no lineage rows at all for a bead with no parent and no children", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(screen.queryByTestId("concierge-bead-card-tasks")).toBeNull();
    expect(screen.queryByTestId("concierge-bead-card-build-agents")).toBeNull();
  });

  // A lineage pill is inside the card body, which is the expand target. Clicking one must open the
  // task and NOT also toggle the card it was opened from.
  it("does not collapse the card when a lineage pill is clicked", async () => {
    seedStores([EPIC, KID_A, KID_B]);
    mountReply(ctx([EPIC, KID_A, KID_B]), "see sparkle-epic1");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    fireEvent.click(screen.getAllByTestId("concierge-bead-card-tasks-pill")[0]!);
    expect(thread()).not.toBeNull();
  });
});

// ── 6. THE WIRING ITSELF — NO PROVIDER MOUNTED BY HAND ──────────────────────────────────────────
//
// Every row above this point reaches `BeadChatSurfaceProvider` through `mountReply`, which supplies
// it. That makes all of them blind to the ONE production line that supplies it for real: the wrap
// around each `<Markdown>` call site in `ConciergeMessageRow`. The classic defaulted-seam trap —
// delete the wrap and the whole suite above stays green while the feature is dead for everyone, and
// it is a live risk because this file's own header names the rename of those call sites (and the
// retirement of the `BeadAutoExpandProvider` alias) as the follow-up.
//
// There are TWO call sites and they are on different branches of `ConciergeMessageRow`, so one row
// each. The neighbours do not cover this: `BeadPill.test.tsx`'s `ConciergeThread` describe asserts
// only that a PILL is drawn (true before any of this, and true with the wrap gone), and
// `ConciergeThread.mentions.test.tsx` drives a `kind: "you"` bubble, which is deliberately unwrapped.
describe("the collapsed card appears through ConciergeMessageRow's OWN wiring", () => {
  // CALL SITE ONE — an ordinary answer. Asserting a CARD, not a pill, and with NO click: those two
  // words are the whole test. Verified to go red by removing the provider wrap at this call site.
  it("draws a card in a real sparkle reply, with nothing mounted by hand", () => {
    seedStores([QOGAH]);
    mountThread(ctx([QOGAH]), [
      { id: "s1", kind: "sparkle", text: "settled and recorded on sparkle-qogah" },
    ]);
    expect(cards()).toHaveLength(1);
    // …and it arrived COLLAPSED, so this row also fails on the other end of the spectrum — a thread
    // that wires the surface up but opens every card it draws.
    expect(thread()).toBeNull();
  });

  // CALL SITE TWO — the proactive push, a different `return` in `ConciergeMessageRow` with its own
  // separate wrap. Wiring only the reply branch leaves every unprompted line a bare pill, which no
  // row driving the reply branch can see.
  it("draws a card in a proactive push too — the second Markdown call site", () => {
    seedStores([QOGAH]);
    mountThread(ctx([QOGAH]), [
      { id: "s1", kind: "sparkle", text: "filed sparkle-qogah", proactive: true },
    ]);
    expect(cards()).toHaveLength(1);
    expect(thread()).toBeNull();
  });

  // THE PAIRED NEGATIVE, and the reason the two rows above are not vacuous: the SAME thread, the
  // SAME bead, on the branch that is deliberately NOT wrapped. A `kind: "you"` bubble renders
  // through `MentionedText` and never touches markdown, so "a card appeared" above is a statement
  // about the wrap rather than about anything that mounts a card unconditionally.
  it("draws no card in the user's own bubble, which is deliberately unwrapped", () => {
    seedStores([QOGAH]);
    mountThread(ctx([QOGAH]), [{ id: "u1", kind: "you", text: "what about sparkle-qogah" }]);
    expect(cards()).toHaveLength(0);
  });
});

// ── 7. NO DEAD CONTROL ON THE MOST COMMON STATE IN THE APP ──────────────────────────────────────
//
// `BeadCard` draws its `×` on the PRESENCE of an `onClose` callback and nowhere else, so a surface
// with nothing for it to do must pass none — this codebase's callback-is-the-switch convention.
//
// The regression this guards (roborev job 68044): the concierge kept passing
// `() => setExpanded(false)` in both states. On the collapsed card that writes `false` onto a state
// already `false`, React bails out on the identical value, and the button's own handler calls
// `stopPropagation` so the card body's expand toggle never sees the press either. One click, no
// repaint, no state change, nothing announced — on every bead the concierge has ever named, in its
// default state. The old suite would have passed with that button wired to a no-op forever.
describe("the × on a collapsed chat card", () => {
  it("is absent while collapsed — there is nothing for it to close", () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    expect(cards()).toHaveLength(1);
    expect(closers()).toHaveLength(0);
  });

  // THE PAIRED POSITIVE. Absence alone is satisfied by a card that never draws a `×` at all, or by
  // a `BeadCard` whose chrome row stopped rendering — neither of which is the rule. Expanded, the
  // control is back AND it changes observable state.
  it("returns on expand and COLLAPSES the card — an observable change, not a no-op", async () => {
    seedStores([QOGAH]);
    mountReply(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    await waitFor(() => expect(thread()).not.toBeNull());
    expect(closers()).toHaveLength(1);

    fireEvent.click(closers()[0]!);
    // COLLAPSED, NOT DISMISSED — the card survives every exit, and the `×` is no exception. The
    // thread and the composer are the two things the concierge withholds while collapsed, so their
    // disappearance IS the state change.
    expect(thread()).toBeNull();
    expect(composer()).toBeNull();
    expect(cards()).toHaveLength(1);
    // …and the affordance goes with it, so a second press cannot be the dead one.
    expect(closers()).toHaveLength(0);
    expect(pills()[0]!.getAttribute("aria-expanded")).toBe("false");
  });

  // OUTSIDE A CHAT MESSAGE the card exists only while open, so the `×` is unconditional there and
  // must not have been swept up by the gate above.
  it("keeps the × on a bare-Markdown card, which is only ever open", () => {
    seedStores([QOGAH]);
    mountBare(ctx([QOGAH]), "see sparkle-qogah");
    fireEvent.click(pills()[0]!);
    expect(cards()).toHaveLength(1);
    expect(closers()).toHaveLength(1);
  });
});
