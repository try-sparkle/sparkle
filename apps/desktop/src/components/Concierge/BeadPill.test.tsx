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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the `bd` shell-outs so the CROSS-PROJECT describe below can drive real store loads without a
// Tauri bridge. Everything else in this file switches `[tools].beads` OFF instead, so these mocks
// are never reached by those rows — `refresh` returns before touching the service.
const listBeads = vi.fn();
const blockedBeadIdsOrNull = vi.fn();
const ensureBeadsDb = vi.fn();
vi.mock("../../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIdsOrNull: (...a: unknown[]) => blockedBeadIdsOrNull(...a),
    ensureBeadsDb: (...a: unknown[]) => ensureBeadsDb(...a),
  };
});
// The card's priority control performs a REAL write through `beads_update`, which reaches Tauri.
// Mocked at the command seam rather than at `invoke`, so the assertion can be on the patch the
// command receives — the thing that has to be right for `bd` to accept it.
const beadsUpdate = vi.fn();
vi.mock("../../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beadsCommands")>();
  return { ...actual, beadsUpdate: (...a: unknown[]) => beadsUpdate(...a) };
});
import { Markdown } from "../Markdown";
import { ConciergeThread } from "./ConciergeThread";
import { BeadPillHost, BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import { useBeadsStore, __resetBeadsRefreshInFlightForTest } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { useComposeHandoffStore } from "../../stores/composeHandoffStore";
import { bucketBeads, type Bead } from "../../services/beads";
import type { ConciergeMessage } from "./types";
import type { Project } from "../../types";

afterEach(() => cleanup());

// ── THE POLLER IS STUBBED FOR THE WHOLE FILE, AND THAT REPLACED A SHARPER HACK ───────────────────
// Letting the poller arm would shell out to `bd` through a Tauri bridge jsdom does not have, so the
// rows below used to switch `[tools].beads` OFF to keep it quiet. That worked only by accident: it
// leaned on beads-off still resolving whatever was already cached, which is precisely the behaviour
// that had to change — a bead must NOT stay clickable after the user turns beads off. Stubbing the
// two poller actions says what those rows actually meant ("don't poll"), and lets them keep beads
// ON so they exercise the real resolution path.
const realPoller = {
  startPolling: useBeadsStore.getState().startPolling,
  stopPolling: useBeadsStore.getState().stopPolling,
};
beforeEach(() => useBeadsStore.setState({ startPolling: () => {}, stopPolling: () => {} }));
afterEach(() => useBeadsStore.setState(realPoller));

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Bead ids in the concierge are clickable",
    description: "The concierge writes bead ids constantly and every one is dead text.",
    status: "open",
    type: "feature",
    priority: 0,
    labels: [],
    parent: null,
    commentCount: 0,
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

/** jsdom's `visibilityState` is read-only; override the getter so a test can drive it. Mirrors the
 *  helper in `beadsStore.visibility.test.ts` — the sweep is gated on the same signal the poller is. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

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
    // THE STAGE THE CARD SITS IN, never a bd wire value (bead sparkle-az6di8). An in_progress bead
    // is in the board's "Being built" column, so that is what the chip says — the founder's own
    // phrase and the exact string the column header above it uses.
    expect(meta).toContain("Build: Active");
    expect(meta).not.toContain("in_progress");
    expect(meta).not.toContain("in progress");
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
    // Beads stay ON — the poller is stubbed at the top of this file, which is what these rows
    // actually needed. `byProject` is still exactly what the test puts there; refcounting is
    // covered in the store's suite.
    act(() => {
      useSettingsStore.setState({ beadsEnabled: true });
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
    // The STAGE, not the wire status — an open, unblocked bead sits in Backlog and a closed one in
    // Done. The repaint requirement this row guards is unchanged; only the vocabulary is.
    expect(screen.getByTestId("concierge-bead-card-meta").textContent).toContain("Backlog");
    seed([bead({ id: "sparkle-t6wje", status: "closed", title: "renamed since" })]);
    const meta = screen.getByTestId("concierge-bead-card-meta").textContent ?? "";
    expect(meta).toContain("Done");
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

// ── 4b. THE BEAD LIVES IN ANOTHER PROJECT ───────────────────────────────────────────────────────
//
// THE BUG THESE ROWS EXIST FOR, and why nothing above them caught it.
//
// The founder wrote a bare bead id into the concierge and it rendered as dead prose. Every row
// above passes with that bug present, because they all seed `byProject` DIRECTLY — so they prove
// the LOOKUP spans projects (`indexBeads` always did) while never exercising the question that was
// actually broken: does anything ever PUT a non-selected project's beads in the store? It did not.
// `BeadPillHost` claimed a poller for the selected project alone, so a bead belonging to any other
// project was absent, missed the index, and fell through to the prose branch.
//
// These rows therefore drive the store the way production does — real `refresh` calls against a
// stubbed `bd` — rather than seeding it. That is the whole point: a seeded store cannot fail this
// way, which is exactly why the bug survived a 432-line suite.
describe("BeadPill — a bead in a project the founder is not looking at", () => {
  const base = {
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    selectedAgentId: null,
  };
  const SELECTED: Project = { ...base, id: "p1", name: "sparkle", rootPath: "/tmp/sparkle" };
  const OTHER: Project = { ...base, id: "p2", name: "festival", rootPath: "/tmp/festival" };

  /** The selected project's own 5s poller is not what these rows are about, and letting it arm would
   *  leak an interval into the next case. Its claim is pinned by "claims the poller as PASSIVE"
   *  above; here it is stubbed out so only the cross-project sweep is under test. */
  let startPolling: ReturnType<typeof vi.spyOn>;
  let stopPolling: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listBeads.mockReset();
    blockedBeadIdsOrNull.mockReset();
    ensureBeadsDb.mockReset();
    blockedBeadIdsOrNull.mockResolvedValue(new Set());
    listBeads.mockResolvedValue([]);
    startPolling = vi
      .spyOn(useBeadsStore.getState(), "startPolling")
      .mockImplementation(() => {});
    stopPolling = vi.spyOn(useBeadsStore.getState(), "stopPolling").mockImplementation(() => {});
    // Drain the store's MODULE-SCOPE per-project bookkeeping too. `setState` below resets the
    // store's own maps, but the freshness clock the sweep gates on (`beadsPolledAt`) deliberately
    // lives outside state — so without this, a case whose sweep successfully read "p2" leaves p2
    // looking freshly-read to the NEXT case, whose sweep then skips it and never calls `refresh`.
    // The in-flight/steal guards leak the same way; this drains all of them.
    __resetBeadsRefreshInFlightForTest();
    act(() => {
      useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
      useSettingsStore.setState({ beadsEnabled: true });
      useProjectStore.setState({ projects: [SELECTED, OTHER], selectedProjectId: "p1" });
      useUiStore.setState({ boardFocusBeadId: null, pairAssignment: {} });
    });
  });

  afterEach(() => {
    startPolling.mockRestore();
    stopPolling.mockRestore();
    setVisibility("visible");
    act(() => useSettingsStore.setState({ beadsEnabled: true }));
  });

  function mountHosted(text: string) {
    return render(
      <BeadPillHost>
        <Markdown text={text} />
      </BeadPillHost>,
    );
  }

  // THE REPRO. `sparkle-88onj` is a real sparkle bead; the concierge in the founder's session was
  // bound to a DIFFERENT project, so this id resolved against a store that had never loaded sparkle
  // and rendered as the plain words it had always been — with nothing on screen to say why.
  it("resolves an id whose bead lives in a project that is not selected", async () => {
    listBeads.mockImplementation(async (path: string) =>
      path === "/tmp/festival" ? [bead({ id: "sparkle-88onj" })] : [],
    );
    mountHosted("filed as sparkle-88onj for the next pass");
    await waitFor(() => expect(pills()).toHaveLength(1));
    expect(pills()[0]!.getAttribute("data-bead-id")).toBe("sparkle-88onj");
    // And the sentence around it still reads.
    expect(screen.getByText(/for the next pass/)).toBeTruthy();
  });

  // The sweep READS. Both of the trailing `false`s are load-bearing and neither is cosmetic:
  // `runWatchers: false` keeps the decompose watcher — which spends AI and files child beads —
  // from running for a board nobody is looking at, and `allowAutoInit: false` keeps a concierge
  // render from creating a `.beads/` store inside every repo the user ever registered.
  it("reads the other project without writing to it, and leaves the selected one alone", async () => {
    const refresh = vi
      .spyOn(useBeadsStore.getState(), "refresh")
      .mockResolvedValue(undefined as never);
    mountHosted("filed as sparkle-88onj");
    await waitFor(() => expect(refresh).toHaveBeenCalledWith("p2", "/tmp/festival", false, false));
    // The SELECTED project is not swept — it has its own faster claim, and sweeping it too would
    // double every `bd` read for the project that is already the hottest.
    expect(refresh.mock.calls.some((c) => c[0] === "p1")).toBe(false);
    refresh.mockRestore();
  });

  // The write the sweep must never perform, asserted through the real store rather than through the
  // flag. A project that never ran `bd init` rejects every read; the board path self-heals by
  // creating the DB, and that is right for a board someone opened. Doing it here would mean opening
  // the concierge silently writes into every repo on the machine.
  it("never creates a beads DB in a project nobody opened", async () => {
    listBeads.mockImplementation(async (path: string) => {
      if (path === "/tmp/festival") throw new Error("no beads database found");
      return [];
    });
    mountHosted("filed as sparkle-88onj");
    // It did attempt the project — so the row below is a real guarantee, not a vacuous pass on a
    // sweep that never ran.
    await waitFor(() => expect(listBeads).toHaveBeenCalledWith("/tmp/festival"));
    expect(ensureBeadsDb).not.toHaveBeenCalled();
    // And the id stays prose, which is the correct outcome: that project has no beads to resolve
    // against, so nothing is claimed about the token.
    expect(pills()).toHaveLength(0);
  });

  // WHERE THE READER IS ABOUT TO BE SENT. "View on board" calls `selectProject` first, so clicking
  // it on a bead from another project switches the reader's whole selected project. The card names
  // that project so the jump is a choice rather than a surprise.
  it("names the other project on the card", async () => {
    listBeads.mockImplementation(async (path: string) =>
      path === "/tmp/festival" ? [bead({ id: "sparkle-88onj" })] : [],
    );
    mountHosted("filed as sparkle-88onj");
    await waitFor(() => expect(pills()).toHaveLength(1));
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-meta").textContent).toContain("in festival");
  });

  // The other half, and the one that stops the line above from being decoration: a bead in the
  // reader's OWN project says nothing about projects at all. Without this, "name the project"
  // could be implemented as "always name the project" and still pass the row above.
  it("says nothing about the project for a bead in the reader's own", () => {
    act(() => {
      useBeadsStore.setState({
        byProject: { p1: { beads: [bead({ id: "sparkle-88onj" })], board: {} as never, loadedAt: 1 } },
      });
    });
    mountHosted("filed as sparkle-88onj");
    expect(pills()).toHaveLength(1);
    fireEvent.click(pills()[0]!);
    const meta = screen.getByTestId("concierge-bead-card-meta").textContent ?? "";
    expect(meta).not.toContain("in sparkle");
    // It still says everything it said before — the status chip included, now as the board stage.
    expect(meta).toContain("Backlog");
  });

  // ── WHAT THE WIDER `byProject` BROKE, AND HAD TO BE FIXED WITH IT ─────────────────────────────
  //
  // `indexBeads` used to say "first project wins on a collision", justified by ids carrying a
  // project prefix so a collision was unreachable. Loading EVERY project retires that premise, and
  // the collision is not exotic: `bd` resolves `.beads/` through `git-common-dir`, so a worktree of
  // a repo registered as its own project reads the SAME database. Every id then collides and the
  // winner was decided by which `bd` call happened to return first.
  it("prefers the reader's OWN project when the same id is in two of them", () => {
    act(() => {
      useBeadsStore.setState({
        // p2 FIRST in insertion order, which is what "first project wins" would have picked.
        byProject: {
          p2: {
            beads: [bead({ id: "sparkle-88onj", title: "the foreign copy" })],
            board: {} as never,
            loadedAt: 1,
          },
          p1: {
            beads: [bead({ id: "sparkle-88onj", title: "the reader's own" })],
            board: {} as never,
            loadedAt: 1,
          },
        },
      });
    });
    mountHosted("filed as sparkle-88onj");
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-title").textContent).toBe("the reader's own");
    // …and therefore NOT labelled as living elsewhere, which is the visible half of the bug: the
    // card would otherwise offer to send the reader to another project for a bead in this one.
    expect(screen.getByTestId("concierge-bead-card-meta").textContent).not.toContain("in festival");
  });

  // Suppressing auto-init avoids the `bd init` WRITE, but the fall-through used to still write the
  // raw failure into the shared `error` map — which `BoardView` renders as a banner. So the
  // concierge merely mounting would arm an error for a project nobody had opened.
  it("records no error for a project the sweep could not read", async () => {
    listBeads.mockImplementation(async (path: string) => {
      if (path === "/tmp/festival") throw new Error("no beads database found");
      return [];
    });
    mountHosted("filed as sparkle-88onj");
    await waitFor(() => expect(listBeads).toHaveBeenCalledWith("/tmp/festival"));
    await waitFor(() => expect(useBeadsStore.getState().loading.p2).toBe(false));
    expect(useBeadsStore.getState().error.p2).toBeUndefined();
  });

  // `others` filters on `selectedProjectId`, so it changes on every selection change and re-arms the
  // effect — which re-fired the immediate sweep for every remaining project, including ones read
  // seconds earlier. Clicking through the project strip produced back-to-back `bd` convoys.
  it("does not re-read a project it just read when the selection changes", async () => {
    const THIRD: Project = { ...base, id: "p3", name: "third", rootPath: "/tmp/third" };
    act(() => {
      useProjectStore.setState({ projects: [SELECTED, OTHER, THIRD], selectedProjectId: "p1" });
    });
    mountHosted("filed as sparkle-88onj");
    await waitFor(() => expect(listBeads).toHaveBeenCalledWith("/tmp/festival"));
    const before = listBeads.mock.calls.filter((c) => c[0] === "/tmp/festival").length;
    // Switching the selection re-arms the sweep. The festival snapshot is seconds old, so it must
    // be skipped rather than re-read.
    act(() => useProjectStore.setState({ selectedProjectId: "p3" }));
    await act(async () => {});
    const after = listBeads.mock.calls.filter((c) => c[0] === "/tmp/festival").length;
    expect(after).toBe(before);
  });

  // "Off means off" — the same contract `refresh` states at its top. With `[tools].beads` disabled
  // the sweep must not reach `bd` at all, not merely discard what it read.
  it("does not sweep at all when beads are switched off", async () => {
    act(() => useSettingsStore.setState({ beadsEnabled: false }));
    mountHosted("filed as sparkle-88onj");
    await act(async () => {});
    expect(listBeads).not.toHaveBeenCalled();
  });

  // …and the half the row above CANNOT see, because it starts from an empty cache. `byProject` is a
  // cache nobody prunes: switching beads off stops the pollers but clears no snapshot (the clear
  // inside `refresh` only reaches projects that get another call, and with beads off none do). So
  // an implementation that merely stopped sweeping would keep resolving beads read before the
  // switch — beads still clickable with beads turned off.
  it("resolves nothing from the cache once beads are switched off", () => {
    act(() => {
      useBeadsStore.setState({
        byProject: {
          p2: { beads: [bead({ id: "sparkle-88onj" })], board: {} as never, loadedAt: 1 },
        },
      });
    });
    const { rerender } = mountHosted("filed as sparkle-88onj");
    expect(pills()).toHaveLength(1); // resolvable while beads are on
    act(() => useSettingsStore.setState({ beadsEnabled: false }));
    rerender(
      <BeadPillHost>
        <Markdown text="filed as sparkle-88onj" />
      </BeadPillHost>,
    );
    expect(pills()).toHaveLength(0);
  });

  // The same cache outliving the other lifecycle event: removing a project touches `projectStore`
  // only, so its snapshot stays in `byProject`. Indexing that raw gives a pill whose card names a
  // project that no longer exists and whose "View on board" has nowhere to go.
  it("resolves nothing from a project that is no longer registered", () => {
    act(() => {
      useBeadsStore.setState({
        byProject: {
          p2: { beads: [bead({ id: "sparkle-88onj" })], board: {} as never, loadedAt: 1 },
        },
      });
    });
    mountHosted("filed as sparkle-88onj");
    expect(pills()).toHaveLength(1);
    // The user removes the festival project. Its beads must stop resolving even though the
    // snapshot is still cached.
    act(() => useProjectStore.setState({ projects: [SELECTED], selectedProjectId: "p1" }));
    expect(pills()).toHaveLength(0);
  });

  // A hidden window skips the sweep — correct, nobody is looking — but the wait must end when the
  // reader COMES BACK, not when the interval next fires. An unswept project's ids are not merely
  // stale, they are dead prose: the exact bug this change exists to fix, reappearing for up to a
  // full interval after every return to the app.
  it("sweeps on return from a hidden window rather than waiting out the interval", async () => {
    listBeads.mockImplementation(async (path: string) =>
      path === "/tmp/festival" ? [bead({ id: "sparkle-88onj" })] : [],
    );
    setVisibility("hidden");
    mountHosted("filed as sparkle-88onj");
    await act(async () => {});
    expect(listBeads).not.toHaveBeenCalledWith("/tmp/festival");
    expect(pills()).toHaveLength(0);
    await act(async () => {
      setVisibility("visible");
    });
    await waitFor(() => expect(pills()).toHaveLength(1));
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
      useSettingsStore.setState({ beadsEnabled: true });
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
    // THE **Open** GROUP'S board link, not the standalone button — this row mounts the REAL
    // `BeadPillHost`, which supplies both destinations, so the standalone button correctly stands
    // down and "on board" lives in the group. The rows above still use the standalone testid
    // because they mount a context that offers no column destination, which is the other half of
    // the same rule.
    fireEvent.click(screen.getByTestId("concierge-bead-card-open-on-board"));

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

// ── 7. THE CARD IS THE BOARD'S CARD ─────────────────────────────────────────────────────────────
//
// The founder's ask, verbatim: "I want the card on the concierge column to look exactly like the
// card when it's in an open state on the actual plan board, with one exception: it would scroll
// after a certain height." These rows assert the fields that were MISSING from the concierge card,
// which is what "exactly like" cashes out to.

describe("BeadPill — the card is the shared BeadCard", () => {
  it("shows the workflow status line and its stage word", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    // THE REGRESSION THIS WHOLE BEAD IS ABOUT. The line was on the board's collapsed card, vanished
    // when it opened, and had never existed here at all.
    expect(screen.getByTestId("concierge-bead-card-stage")).not.toBeNull();
    expect(screen.getByTestId("concierge-bead-card-stage-label").textContent).toBe("Planned");
  });

  it("shows the bead id, which the concierge card never had", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-id").textContent).toBe("sparkle-t6wje");
  });

  it("shows labels and the parent epic", () => {
    mountMarkdown(
      ctx([bead({ id: "sparkle-t6wje", labels: ["ui", "concierge"], parent: "sparkle-epic1" })]),
      "see sparkle-t6wje",
    );
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-labels").textContent).toBe("ui, concierge");
    expect(screen.getByTestId("concierge-bead-card-parent").textContent).toBe("sparkle-epic1");
  });

  // The founder explicitly KEPT 180px when it was reconsidered at 90. jsdom has no layout engine,
  // so the style value is the fact — a measured height would be all zeroes.
  it("keeps the 180px description clamp", () => {
    mountMarkdown(ctx([bead({ id: "sparkle-t6wje", description: "line\n".repeat(500) })]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.getByTestId("concierge-bead-card-description").style.maxHeight).toBe("180px");
  });
});

// ── 8. THE CARD IS NO LONGER A DEAD END ─────────────────────────────────────────────────────────
//
// The only way out used to be clicking the SAME pill again — "a dead end nobody discovers". Each
// row below asserts the card is GONE from the DOM, not that a listener was registered.

describe("BeadPill — Escape and click-outside close the card", () => {
  it("closes on Escape, and consumes the press", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
    // WRAPPED IN `act`, or the listener's state change is never flushed and a correct component
    // reads as a red row.
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    act(() => {
      window.dispatchEvent(e);
    });
    expect(card()).toBeNull();
    // Cable etiquette: one press peels ONE layer, so the press is consumed on the way out.
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves an Escape a layer above already consumed alone", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    e.preventDefault();
    act(() => {
      window.dispatchEvent(e);
    });
    expect(card()).not.toBeNull();
  });

  it("closes on a press outside it", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    fireEvent.mouseDown(document.body);
    expect(card()).toBeNull();
  });

  it("stays open on a press INSIDE it", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    fireEvent.mouseDown(screen.getByTestId("concierge-bead-card-title"));
    expect(card()).not.toBeNull();
  });

  // THE ANCHOR-CONTAINS GUARD. Without it the capture-phase mousedown ALSO sees the pill's own
  // press, closes the card, and the click handler immediately reopens it — one gesture, no visible
  // response, and the pill would appear never to close.
  it("still toggles shut from the pill itself, in one gesture", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(card()).not.toBeNull();
    fireEvent.mouseDown(pills()[0]!);
    fireEvent.click(pills()[0]!);
    expect(card()).toBeNull();
  });

  // Registered ONLY while open: a thread can hold dozens of pills, and a listener each for a card
  // nobody opened is a real cost.
  it("registers no listener while the card is shut", () => {
    const add = vi.spyOn(window, "addEventListener");
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    const keys = add.mock.calls.filter((c) => c[0] === "keydown" || c[0] === "mousedown");
    expect(keys).toHaveLength(0);
    add.mockRestore();
  });
});

// ── 9. THE PRIORITY WRITE, END TO END ───────────────────────────────────────────────────────────

describe("BeadPill — picking a priority writes it through beads_update", () => {
  const PROJECT: Project = {
    id: "p1",
    name: "sparkle",
    rootPath: "/tmp/sparkle",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    selectedAgentId: null,
  };

  function mountHostedWithProject(beads: Bead[]) {
    act(() => {
      useSettingsStore.setState({ beadsEnabled: true });
      useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
      useBeadsStore.setState({ byProject: { p1: { beads, board: {} as never, loadedAt: 1 } } });
    });
    return render(
      <BeadPillHost>
        <Markdown text="see sparkle-t6wje" />
      </BeadPillHost>,
    );
  }

  // THE SIDE EFFECT, through the REAL wiring: pill → card → menu → `beadsUpdate`. Asserting that a
  // menu option rendered would pass against a pill connected to nothing.
  it("calls beadsUpdate with the project path and the picked priority", async () => {
    beadsUpdate.mockResolvedValue(undefined);
    mountHostedWithProject([bead({ id: "sparkle-t6wje", priority: 0 })]);
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-trigger"));
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-option-1"));
    await waitFor(() =>
      expect(beadsUpdate).toHaveBeenCalledWith("/tmp/sparkle", "sparkle-t6wje", { priority: "1" }),
    );
  });

  // `bd` is heavily contended — a timed-out write is the LIKELY failure here, and "try again in a
  // moment" is the whole remedy, which a generic message hides.
  it("names a bd timeout specifically, and rolls the pill back", async () => {
    beadsUpdate.mockRejectedValue({ kind: "timeout", message: "timed out", exitCode: null });
    mountHostedWithProject([bead({ id: "sparkle-t6wje", priority: 0 })]);
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-trigger"));
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-option-2"));
    await waitFor(() =>
      expect(screen.getByTestId("concierge-bead-card-error").textContent).toBe(
        "bd is busy — priority not saved",
      ),
    );
    expect(
      screen.getByTestId("concierge-bead-card-priority-trigger").getAttribute("data-priority"),
    ).toBe("0");
  });

  // The priority menu PORTALS to document.body, so in DOM ancestry it is outside the card. Without
  // the card's menu-aware guard, picking a priority would close the card under the click.
  it("does not close the card when the press lands on the portaled menu", () => {
    beadsUpdate.mockResolvedValue(undefined);
    mountHostedWithProject([bead({ id: "sparkle-t6wje", priority: 0 })]);
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-trigger"));
    fireEvent.mouseDown(screen.getByTestId("concierge-bead-card-priority-option-1"));
    expect(card()).not.toBeNull();
  });

  // Escape with the menu open peels the MENU, not the card — the card's listener was registered
  // first (it opened first), so without the guard it would take the press.
  it("Escape peels the priority menu before the card", () => {
    beadsUpdate.mockResolvedValue(undefined);
    mountHostedWithProject([bead({ id: "sparkle-t6wje", priority: 0 })]);
    fireEvent.click(pills()[0]!);
    fireEvent.click(screen.getByTestId("concierge-bead-card-priority-trigger"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("concierge-bead-card-priority-menu")).toBeNull();
    expect(card()).not.toBeNull();
  });

  // A surface with no project path is READ-ONLY, which is the property `BeadPillProvider` already
  // had for every fixture-driven caller (SupportModal, agent replies, tests).
  it("offers no priority control on a surface with no project path", () => {
    mountMarkdown(ctx([T6]), "see sparkle-t6wje");
    fireEvent.click(pills()[0]!);
    expect(screen.queryByTestId("concierge-bead-card-priority-trigger")).toBeNull();
    expect(screen.queryByTestId("concierge-bead-card-build-it")).toBeNull();
  });
});

// ── THE CHAT BUTTON ON A CONCIERGE CARD ─────────────────────────────────────────────────────────
//
// bead sparkle-1cpomd. The founder asked for the button on EVERY bead card, and a card sitting in a
// concierge reply is where bead cards are most common — so omitting it here would make "every card"
// false on the surface that has the most of them.
//
// It is not the pointless loop it looks like. This thread is wherever the bead happened to come up
// (a board answer, a fleet summary, a support reply); the button starts a NEW message pinned to
// this ONE bead, so the next thing the founder types is unambiguously about it.
//
// ══ BOTH CANDIDATES ARE MOUNTED AT ONCE ═══════════════════════════════════════════════════════
// The rule picks by `canWrite`, so absence has to be proven against a card that IS in the tree —
// absence in a card nobody rendered is absence for a reason that has nothing to do with the rule.
// One reply, two ids: one bead whose project has a checkout path and one whose does not, both
// cards opened, and the assertions made against each.
describe("BeadPill — the concierge card offers a chat about its own bead", () => {
  const WRITABLE = bead({ id: "sparkle-t6wje", title: "Writable bead" });
  const READONLY = bead({ id: "sparkle-qogah", title: "Pathless bead" });

  /** A reply naming both beads. Only the first has a `rootPath`, which is what `canWrite` reads. */
  function mountBoth() {
    render(
      <BeadPillProvider
        value={{
          beads: new Map([
            [WRITABLE.id, { bead: WRITABLE, projectId: "p1", rootPath: "/tmp/sparkle" }],
            [READONLY.id, { bead: READONLY, projectId: "p2" }],
          ]),
          onViewOnBoard: vi.fn(() => true),
        }}
        >
        <Markdown text={`both: ${WRITABLE.id} and ${READONLY.id}`} />
      </BeadPillProvider>,
    );
    const all = pills();
    expect(all).toHaveLength(2);
    fireEvent.click(all[0]!);
    fireEvent.click(all[1]!);
    const byTitle = (title: string) =>
      screen
        .queryAllByTestId("concierge-bead-card")
        .find((c) => c.textContent?.includes(title));
    const writable = byTitle("Writable bead");
    const readonly = byTitle("Pathless bead");
    // Both cards really are open — otherwise the absence assertion below is vacuous.
    expect(writable).toBeTruthy();
    expect(readonly).toBeTruthy();
    return { writable: writable!, readonly: readonly! };
  }

  it("paints Chat on the writable card and not on the pathless one — both open", () => {
    const { writable, readonly } = mountBoth();
    expect(within(writable).getByTestId("concierge-bead-card-chat")).toBeTruthy();
    // Gated with its neighbours: a surface we cannot even resolve a project path for is the
    // read-only card, and a chat about a bead we cannot address is the same dead control.
    expect(within(readonly).queryByTestId("concierge-bead-card-chat")).toBeNull();
    // …and the pathless card is otherwise a real card, so the line above is about THIS control.
    expect(within(readonly).getByTestId("concierge-bead-card-title").textContent).toBe(
      "Pathless bead",
    );
  });

  it("clicking it hands the composer a draft naming THAT bead, sparkle-routed", () => {
    useComposeHandoffStore.setState({ handoff: null });
    const { writable } = mountBoth();
    fireEvent.click(within(writable).getByTestId("concierge-bead-card-chat"));
    const h = useComposeHandoffStore.getState().take();
    // The bead the founder clicked, not the other one on screen — this is why both are mounted.
    expect(h?.text).toBe("RE: @Writable bead ");
    expect(h?.text).not.toContain("Pathless");
    expect(h?.origin).toBe("bead-chat");
    // Without this the concierge's auto-router could aim the draft at whatever build agent is on
    // screen — captureSends.ts:197-199.
    expect(h?.route).toBe("sparkle");
    // The bead's OWN project, which is not necessarily the selected one: a concierge answer is
    // cross-project by construction.
    expect(h?.projectId).toBe("p1");
  });

  it("leaves the card open — the chat is started beside it, not instead of it", () => {
    const { writable } = mountBoth();
    fireEvent.click(within(writable).getByTestId("concierge-bead-card-chat"));
    expect(screen.queryAllByTestId("concierge-bead-card").length).toBeGreaterThan(0);
  });
});

// ══ THE PILL AND ITS CARD SAY THE BOARD STAGE, NOT bd's WIRE STATUS (bead sparkle-az6di8) ══════
//
// The founder, verbatim: *"instead of saying open, it should say something like 'Being Built'."*
//
// ── WHY THESE ROWS SEED A REAL BOARD ────────────────────────────────────────────────────────
// The concierge has no board of its own, so it reads the placement out of the beads store's
// snapshot (`ResolvedBead.placedIn`). Every OTHER row in this file seeds `board: {} as never`, so
// they all exercise the FALLBACK — which re-derives the column from the bead and happens to give
// the same word for the ordinary cases. That makes the production path untested by construction
// unless something drives it, which is what the blocked row below is for: blockedness is a
// dependency fact no bead carries, so the fallback CANNOT produce "Blocked". Cut the `placedIn`
// thread and that row goes red while its neighbours stay green.
describe("BeadPill — the status word is the board stage", () => {
  const PROJECT: Project = {
    id: "p1",
    name: "sparkle",
    rootPath: "/tmp/sparkle",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    selectedAgentId: null,
  };

  /** Seed the store with a REAL bucketed board, the way a poll leaves it. */
  function seedBoard(beads: Bead[], blocked?: ReadonlySet<string>) {
    act(() => {
      useBeadsStore.setState({
        byProject: { p1: { beads, board: bucketBeads(beads, blocked), loadedAt: 1 } },
      });
    });
  }

  beforeEach(() => {
    act(() => {
      useSettingsStore.setState({ beadsEnabled: true });
      useProjectStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
      useUiStore.setState({ boardFocusBeadId: null, pairAssignment: {} });
    });
  });

  function mountHosted(text: string) {
    return render(
      <BeadPillHost>
        <Markdown text={text} />
      </BeadPillHost>,
    );
  }

  const meta = () => screen.getByTestId("concierge-bead-card-meta").textContent ?? "";

  it("says 'Build: Active' for an in-progress bead, in the card AND in the pill's tooltip", () => {
    seedBoard([bead({ id: "sparkle-t6wje", status: "in_progress" })]);
    mountHosted("recorded on sparkle-t6wje");
    // THE TOOLTIP AND THE CARD ARE ASSERTED TOGETHER. They are two readers of one value, and the
    // whole reason `beadStatus` is a shared module is that a bead must not say one thing in a
    // sentence and another in the card that sentence opens.
    expect(pills()[0]!.getAttribute("title")).toContain("Build: Active");
    fireEvent.click(pills()[0]!);
    expect(meta()).toContain("Build: Active");
    expect(meta()).not.toContain("in progress");
    expect(meta()).not.toContain("open");
  });

  // ── THE ROW THE FALLBACK CANNOT PASS ────────────────────────────────────────────────────────
  it("says 'Blocked' for a bead the STORE's board placed in Blocked, though its status is open", () => {
    seedBoard([bead({ id: "sparkle-t6wje", status: "open" })], new Set(["sparkle-t6wje"]));
    mountHosted("recorded on sparkle-t6wje");
    expect(pills()[0]!.getAttribute("title")).toContain("Blocked");
    fireEvent.click(pills()[0]!);
    expect(meta()).toContain("Blocked");
    // Not the answer a re-derivation from the bead alone would give.
    expect(meta()).not.toContain("Backlog");
    expect(meta()).not.toContain("open");
  });

  // ── THE WIRE STATUS MUST KEEP FLOWING THROUGH UNCHANGED ─────────────────────────────────────
  // Only the LABEL changed. `data-bead-status` is the raw value, read by tests and by anything
  // keying on bd's own vocabulary, and re-labelling the chip must not touch it.
  it("leaves the raw data-bead-status attribute alone", () => {
    seedBoard([bead({ id: "sparkle-t6wje", status: "open" })], new Set(["sparkle-t6wje"]));
    mountHosted("recorded on sparkle-t6wje");
    expect(pills()[0]!.getAttribute("data-bead-status")).toBe("open");
  });

  // A surface with no board behind it — a support modal, an agent's own reply, a fixture — still
  // gets a STAGE word. The fallback deliberately does not revert to `open`, or the defect would
  // survive on exactly the surfaces nobody is watching.
  it("falls back to a stage word, never to 'open', when no board is loaded", () => {
    mountMarkdown(ctx([bead({ id: "sparkle-t6wje", status: "open" })]), "see sparkle-t6wje");
    expect(pills()[0]!.getAttribute("title")).toContain("Backlog");
    fireEvent.click(pills()[0]!);
    expect(meta()).toContain("Backlog");
    expect(meta()).not.toContain("open");
  });
});
