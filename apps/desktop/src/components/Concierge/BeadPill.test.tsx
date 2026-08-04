// @vitest-environment jsdom
//
// A bead id the concierge wrote, as a control the founder can act on (bead sparkle-t6wje).
//
// ══ WHAT THESE TESTS ARE GUARDING AGAINST, SPECIFICALLY ═════════════════════════════════════════
// Most of this file renders through `<Markdown>` or through `ConciergeThread` rather than mounting
// `BeadPill` directly, and that is the point rather than thoroughness for its own sake. The whole
// feature rests on a chain — remark plugin → `urlTransform` → the link override → the pill — and a
// test that mounted the pill with a `beadId` prop would keep passing with every link in that chain
// cut. It would also keep passing if the linkifier were wired to the SENT USER BUBBLE instead of to
// concierge output, which is the specific miss this feature is most likely to ship with: the
// founder's example is something the CONCIERGE wrote, and a user bubble renders through an entirely
// different path (`MentionedText`) that never touches markdown.
//
// So: the `ConciergeThread` describe below is load-bearing. If it is ever deleted as redundant, the
// feature can regress to firing on nothing a reader will ever see.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../Markdown";
import { ConciergeThread } from "./ConciergeThread";
import { BeadPillHost, BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import { useBeadsStore } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import type { Bead } from "../../services/beads";
import type { ConciergeMessage } from "./types";
import type { Project } from "../../types";

afterEach(() => cleanup());

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Bead ids in the concierge are clickable",
    description: "The concierge writes bead ids constantly and every one is dead text.",
    status: "open",
    type: "feature",
    priority: 0,
    labels: [],
    parent: null,
    ...over,
  };
}

const T6 = bead({ id: "sparkle-t6wje" });

/** A context whose board holds `beads`, wired with a board opener that reports success. */
function ctx(beads: Bead[], over: Partial<BeadPillContextValue> = {}): BeadPillContextValue {
  return {
    beads: new Map(beads.map((b) => [b.id, { bead: b, projectId: "p1" }])),
    onViewOnBoard: vi.fn(() => true),
    ...over,
  };
}

function mountMarkdown(value: BeadPillContextValue, text: string) {
  return render(
    <BeadPillProvider value={value}>
      <Markdown text={text} />
    </BeadPillProvider>,
  );
}

const pills = () => screen.queryAllByTestId("concierge-bead-pill");
const card = () => screen.queryByTestId("concierge-bead-card");

// ── 1. EXISTENCE DECIDES LINKIFICATION ──────────────────────────────────────────────────────────

describe("BeadPill — an id that does not resolve is prose", () => {
  // The bead's own requirement: "it must not linkify an id that does not exist, since a link that
  // opens nothing is worse than plain text."
  it("renders an unknown id as plain text, with no pill and no button", () => {
    const { container } = mountMarkdown(ctx([]), "settled and recorded on sparkle-17hm1 today");
    expect(pills()).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    // The sentence still reads as the sentence it was.
    expect(container.textContent).toContain("settled and recorded on sparkle-17hm1 today");
  });

  // The candidate the loose pattern deliberately produces. It must come out as the two words it is.
  it("leaves ordinary hyphenated English completely alone", () => {
    const { container } = mountMarkdown(ctx([]), "the auto-heal path is one-shot");
    expect(pills()).toHaveLength(0);
    expect(container.textContent).toBe("the auto-heal path is one-shot");
  });

  // A surface with no provider at all (SupportModal, an agent's own reply) gets the empty default,
  // so every id degrades to prose rather than becoming a button wired to nothing.
  it("degrades to prose with no provider", () => {
    const { container } = render(<Markdown text="recorded on sparkle-t6wje" />);
    expect(pills()).toHaveLength(0);
    expect(container.textContent).toContain("recorded on sparkle-t6wje");
  });
});

describe("BeadPill — an id that resolves is a control", () => {
  it("renders a pill carrying the bead's id and CURRENT status", () => {
    mountMarkdown(ctx([T6]), "settled and recorded on sparkle-t6wje so no agent re-litigates it");
    expect(pills()).toHaveLength(1);
    const pill = pills()[0]!;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("data-bead-id")).toBe("sparkle-t6wje");
    expect(pill.getAttribute("data-bead-status")).toBe("open");
    expect(pill.textContent).toContain("sparkle-t6wje");
  });

  it("keeps the words around it", () => {
    const { container } = mountMarkdown(ctx([T6]), "settled and recorded on sparkle-t6wje today");
    expect(container.textContent).toContain("settled and recorded on");
    expect(container.textContent).toContain("today");
  });

  it("finds an id whose suffix length differs from the last one", () => {
    const ids = ["sparkle-76h9", "sparkle-1sp7r", "sparkle-vyghy", "sparkle-hiju.4"];
    mountMarkdown(ctx(ids.map((id) => bead({ id }))), ids.join(" then "));
    expect(pills().map((p) => p.getAttribute("data-bead-id"))).toEqual(ids);
  });
});

// ── 2. IT FIRES ON CONCIERGE OUTPUT, NOT ONLY ON A USER BUBBLE ──────────────────────────────────

describe("BeadPill — inside a real concierge reply", () => {
  function thread(messages: ConciergeMessage[], value: BeadPillContextValue) {
    render(
      <BeadPillProvider value={value}>
        <ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />
      </BeadPillProvider>,
    );
  }

  // THE TEST THAT CATCHES THE MOST LIKELY MISS. A `kind: "sparkle"` message is what the concierge
  // writes, and it renders through `<Markdown>`; a `kind: "you"` message renders through
  // `MentionedText` and never touches markdown at all. Wiring the linkifier to the latter would look
  // correct in a screenshot of the composer and fire on NOTHING the concierge ever says.
  it("draws the pill in a sparkle reply — the founder's own sentence", () => {
    thread(
      [
        {
          id: "s1",
          kind: "sparkle",
          text: "settled and recorded on sparkle-t6wje so no agent re-litigates it",
        },
      ],
      ctx([T6]),
    );
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.getAttribute("data-bead-id")).toBe("sparkle-t6wje");
  });

  it("draws it in a proactive push too, which renders through the same markdown", () => {
    thread([{ id: "s1", kind: "sparkle", text: "filed sparkle-t6wje", proactive: true }], ctx([T6]));
    expect(pills()).toHaveLength(1);
  });
});

// ── 3. THE CARD ─────────────────────────────────────────────────────────────────────────────────

describe("BeadPill — the card opens in place", () => {
  it("paints the bead's title, status, priority and type on click", () => {
    mountMarkdown(
      ctx([bead({ id: "sparkle-t6wje", title: "Clickable bead ids", status: "in_progress", priority: 1, type: "feature" })]),
      "see sparkle-t6wje",
    );
    expect(card()).toBeNull();
    fireEvent.click(pills()[0]!);
    const c = card();
    expect(c).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe("Clickable bead ids");
    const meta = screen.getByTestId("concierge-bead-card-meta").textContent ?? "";
    // "in progress", never the wire value.
    expect(meta).toContain("in progress");
    expect(meta).not.toContain("in_progress");
    expect(meta).toContain("P1");
    expect(meta).toContain("feature");
  });

  it("shows the description", () => {
    mountMarkdown(ctx([bead({ id: "sparkle-t6wje", description: "the long why" })]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-description").textContent).toBe("the long why");
  });

  // The bead is explicit that a long description must not swallow the thread. The card CAPS its
  // height and scrolls rather than growing — asserted on the style, since jsdom has no layout.
  it("caps a long description instead of growing to fit it", () => {
    mountMarkdown(
      ctx([bead({ id: "sparkle-t6wje", description: "line\n".repeat(500) })]),
      "see sparkle-t6wje",
    );
    fireEvent.click(pills()[0]!);
    const desc = screen.getByTestId("concierge-bead-card-description");
    expect(desc.style.maxHeight).not.toBe("");
    expect(desc.style.overflowY).toBe("auto");
  });

  it("toggles shut on a second click", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
    fireEvent.click(pills()[0]!);
    expect(card()).toBeNull();
  });

  it("advertises itself as a disclosure", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    const pill = pills()[0]!;
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(pill.getAttribute("aria-controls")).toBe(card()!.getAttribute("id"));
  });

  // INLINE ELEMENTS ONLY: this renders inside `<Markdown>`'s `<p>`, and a `<div>` there is invalid
  // nesting the browser silently reparents — moving the card out of the paragraph it explains.
  it("renders no block-level element inside the paragraph", () => {
    const { container } = mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    const p = container.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.contains(card())).toBe(true);
    expect(p!.querySelectorAll("div")).toHaveLength(0);
  });
});

// ── 4. LIVE STATE — THE BEAD'S FOURTH REQUIREMENT ───────────────────────────────────────────────

describe("BeadPill — re-reads CURRENT state, never a snapshot", () => {
  const PROJECT: Project = {
    id: "p1",
    name: "sparkle",
    rootPath: "/tmp/sparkle",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    selectedAgentId: null,
  };

  function seed(beads: Bead[]) {
    act(() => {
      useBeadsStore.setState({ byProject: { p1: { beads, board: {} as never, loadedAt: 1 } } });
    });
  }

  beforeEach(() => {
    // The poller is not what these rows are about, and leaving it armed would shell out to `bd`
    // through a Tauri bridge jsdom does not have. Off means `startPolling` returns immediately, so
    // `byProject` is exactly what the test puts there. Refcounting is covered in the store's suite.
    act(() => {
      useSettingsStore.setState({ beadsEnabled: false });
      useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
      useUiStore.setState({ boardFocusBeadId: null, pairAssignment: {} });
    });
    seed([bead({ id: "sparkle-t6wje", status: "open" })]);
  });

  function mountHosted(text: string) {
    return render(
      <BeadPillHost>
        <Markdown text={text} />
      </BeadPillHost>,
    );
  }

  // THE WIRING FOR THE WATCHER RULE. What a `"passive"` claim DOES is covered in
  // beadsStore.refcount.test.ts (the decompose watcher — which writes beads and reaches the AI gate
  // — does not run for one); this asserts the host actually makes that claim rather than the
  // default `"board"`. Without it the store-side rule is correct and unreached, since this host is
  // the only passive viewer in the app.
  it("claims the poller as PASSIVE, and releases it the same way", () => {
    const startPolling = vi.spyOn(useBeadsStore.getState(), "startPolling").mockImplementation(() => {});
    const stopPolling = vi.spyOn(useBeadsStore.getState(), "stopPolling").mockImplementation(() => {});
    const { unmount } = mountHosted("recorded on sparkle-t6wje");
    expect(startPolling).toHaveBeenCalledWith("p1", "/tmp/sparkle", undefined, "passive");
    unmount();
    // Released with the SAME kind it claimed with, or the board tally drifts and the watcher either
    // never runs again or runs forever.
    expect(stopPolling).toHaveBeenCalledWith("p1", "passive");
    startPolling.mockRestore();
    stopPolling.mockRestore();
  });

  // `startPolling` refuses to arm a timer while beads are off, and it is the SETTING that changes,
  // not this component's props. Without `beadsEnabled` in the effect's deps the host would never
  // re-arm when the user switched beads on, and every id would stay unresolved until some OTHER
  // viewer happened to start polling (roborev 57672).
  it("re-arms when beads are switched on after it mounted", () => {
    act(() => useSettingsStore.setState({ beadsEnabled: false }));
    const startPolling = vi.spyOn(useBeadsStore.getState(), "startPolling").mockImplementation(() => {});
    mountHosted("recorded on sparkle-t6wje");
    startPolling.mockClear();
    act(() => useSettingsStore.setState({ beadsEnabled: true }));
    expect(startPolling).toHaveBeenCalledWith("p1", "/tmp/sparkle", undefined, "passive");
    startPolling.mockRestore();
  });

  it("resolves against the live store, not a prop", () => {
    mountHosted("recorded on sparkle-t6wje");
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.getAttribute("data-bead-status")).toBe("open");
  });

  // THE REQUIREMENT, VERBATIM: "A bead the concierge cited as open an hour ago and has since closed
  // must show closed — never a snapshot frozen at write time."
  //
  // An implementation that captured the bead into state would pass every row above and fail here.
  it("an ALREADY-RENDERED pill repaints when the bead closes underneath it", () => {
    mountHosted("recorded on sparkle-t6wje");
    expect(pills()[0]!.getAttribute("data-bead-status")).toBe("open");
    seed([bead({ id: "sparkle-t6wje", status: "closed" })]);
    expect(pills()[0]!.getAttribute("data-bead-status")).toBe("closed");
  });

  // The stronger half: a card that is ALREADY OPEN must follow too. This is where a "read the bead
  // once, on click" implementation breaks even if the pill itself subscribes.
  it("an ALREADY-OPEN card repaints when the bead closes underneath it", () => {
    mountHosted("recorded on sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-meta").textContent).toContain("open");
    seed([bead({ id: "sparkle-t6wje", status: "closed", title: "renamed since" })]);
    const meta = screen.getByTestId("concierge-bead-card-meta").textContent ?? "";
    expect(meta).toContain("closed");
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe("renamed since");
  });

  // The other direction, which a parse-time existence check could never do: a bead filed AFTER the
  // message was rendered starts resolving without the text being re-parsed.
  it("a bead filed after the message was written starts linkifying", () => {
    seed([]);
    mountHosted("recorded on sparkle-t6wje");
    expect(pills()).toHaveLength(0);
    seed([bead({ id: "sparkle-t6wje" })]);
    expect(pills()).toHaveLength(1);
  });
});

// ── 5. VIEW ON BOARD ────────────────────────────────────────────────────────────────────────────

describe("BeadPill — view on board", () => {
  it("is absent when the surface has no board to open, and the card still opens", () => {
    mountMarkdown(ctx([T6], { onViewOnBoard: undefined }), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    // NOT a dead end: the click already produced the card. Only the second step is missing.
    expect(card()).not.toBeNull();
    expect(screen.queryByTestId("concierge-bead-card-view-on-board")).toBeNull();
  });

  it("hands the board the bead AND its project", () => {
    const onViewOnBoard = vi.fn(() => true);
    mountMarkdown(ctx([T6], { onViewOnBoard }), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-view-on-board"));
    expect(onViewOnBoard).toHaveBeenCalledWith({ beadId: "sparkle-t6wje", projectId: "p1" });
  });

  it("says so when the board could not be opened", () => {
    mountMarkdown(ctx([T6], { onViewOnBoard: vi.fn(() => false) }), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.queryByTestId("concierge-bead-card-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("concierge-bead-card-view-on-board"));
    expect(screen.getByTestId("concierge-bead-card-notice").textContent).toContain(
      "not on an open board",
    );
  });

  // THE ORDER IS THE ASSERTION. `boardFocusBeadId` is a ONE-SHOT that `BoardView` consumes on
  // render; set against a board the Sparkle pane is still covering, the handoff is spent on a
  // surface that never renders and the overlay simply never opens (roborev 55887).
  it("opens the board BEFORE handing it the focus id", () => {
    const calls: string[] = [];
    const project: Project = {
      id: "p1",
      name: "sparkle",
      rootPath: "/tmp/sparkle",
      defaultBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      agents: [],
      selectedAgentId: null,
    };
    act(() => {
      useSettingsStore.setState({ beadsEnabled: false });
      useProjectStore.setState({ projects: [project], selectedProjectId: "p1" });
      useBeadsStore.setState({
        byProject: { p1: { beads: [T6], board: {} as never, loadedAt: 1 } },
      });
    });
    const openPlanBoard = vi
      .spyOn(useUiStore.getState(), "openPlanBoard")
      .mockImplementation(() => calls.push("openPlanBoard"));
    const setBoardFocusBeadId = vi
      .spyOn(useUiStore.getState(), "setBoardFocusBeadId")
      .mockImplementation(() => calls.push("setBoardFocusBeadId"));

    render(
      <BeadPillHost>
        <Markdown text="see sparkle-t6wje" />
      </BeadPillHost>,
    );
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-view-on-board"));

    expect(calls).toEqual(["openPlanBoard", "setBoardFocusBeadId"]);
    openPlanBoard.mockRestore();
    setBoardFocusBeadId.mockRestore();
  });

  // THE NAVIGATION MUST NOT LIVE IN A STATE UPDATER. React re-invokes updaters when it discards and
  // replays a render, and StrictMode double-invokes them on purpose — so a jump written inside one
  // fires twice per click, re-arming a one-shot `BoardView` has already consumed. This shipped that
  // way once and was caught in review; the row exists so it cannot ship that way again.
  it("navigates exactly ONCE per click, even under StrictMode", () => {
    const onViewOnBoard = vi.fn(() => true);
    render(
      <StrictMode>
        <BeadPillProvider value={ctx([T6], { onViewOnBoard })}>
          <Markdown text="see sparkle-t6wje" />
        </BeadPillProvider>
      </StrictMode>,
    );
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-view-on-board"));
    expect(onViewOnBoard).toHaveBeenCalledTimes(1);
  });
});

// ── 6. THE LINKIFIER MUST NOT REWRITE CODE OR NEST A LINK ───────────────────────────────────────

describe("BeadPill — what the linkifier leaves alone", () => {
  it("does not linkify inside an inline code span", () => {
    const { container } = mountMarkdown(ctx([T6]), "run `bd show sparkle-t6wje` first");
    expect(pills()).toHaveLength(0);
    expect(container.querySelector("code")!.textContent).toBe("bd show sparkle-t6wje");
  });

  it("does not linkify inside a fenced block", () => {
    mountMarkdown(ctx([T6]), "```\nbd show sparkle-t6wje\n```");
    expect(pills()).toHaveLength(0);
  });

  // A pill inside an anchor would be a button inside a link — invalid nesting the browser reparents.
  it("does not linkify inside an existing link's label", () => {
    const { container } = mountMarkdown(ctx([T6]), "[sparkle-t6wje](https://example.com)");
    expect(pills()).toHaveLength(0);
    expect(container.querySelector("a")!.textContent).toBe("sparkle-t6wje");
  });

  it("still renders an EXPLICIT reference as a pill", () => {
    mountMarkdown(ctx([T6]), "see [sparkle-t6wje](sparkle-bead:sparkle-t6wje)");
    expect(pills()).toHaveLength(1);
  });

  // The pill shows the ID, never the author's label — so a misleading label buys nothing.
  it("shows the id rather than a label the text supplied", () => {
    mountMarkdown(ctx([T6]), "see [something reassuring](sparkle-bead:sparkle-t6wje)");
    expect(pills()[0]!.textContent).toContain("sparkle-t6wje");
    expect(pills()[0]!.textContent).not.toContain("reassuring");
  });

  // The sanitizer stays on for everything else — widening it for our scheme must not widen it here.
  it("leaves a dangerous scheme inert", () => {
    const { container } = mountMarkdown(ctx([T6]), "[x](javascript:alert(1))");
    expect(container.querySelector("a")!.hasAttribute("href")).toBe(false);
  });
});
