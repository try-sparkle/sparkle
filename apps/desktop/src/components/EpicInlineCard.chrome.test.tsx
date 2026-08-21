// @vitest-environment jsdom
//
// THE PRODUCTION SEAM for the epic card's chrome — `EpicInlineCard`, the connected wrapper the
// Epics column actually mounts.
//
// ══ WHY THIS EXISTS ALONGSIDE `BeadCard/BeadCardChrome.test.tsx` ═══════════════════════════════
// That suite drives `BeadCard` directly and passes `showStageLine` / `onChat` by hand, which leaves
// the lines that SUPPLY them covered by nothing — the defaulted-seam trap AGENTS.md names (bead
// `sparkle-lgbwf`, seen 4×). Delete `showStageLine={false}` from `EpicInlineCard` and that suite
// stays green with the blue bar back on screen; delete `onChat={…}` and the Chat button silently
// disappears, because it is gated on the callback being defined. Both deletions are red here.
//
// ══ AND THE BORDER COUNT CAN ONLY BE ASKED HERE ════════════════════════════════════════════════
// "No double border" is a claim about a CHAIN — every box from the card up to the column. A card
// rendered on its own has no chain, so the question is unanswerable in the component suite; this
// mounts the wrapper the column mounts and counts what the founder would actually see.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The Tauri boundary is the only thing stubbed — the same line `EpicInlineCard.goal.test.tsx` takes.
// Mocking `beadChat` or the card itself would be mocking the wiring this file exists to exercise.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
const { useProjectStore } = await import("../stores/projectStore");
const { useComposeHandoffStore } = await import("../stores/composeHandoffStore");
type Bead = import("../services/beads").Bead;

const PROJECT = "p1";
const ROOT = "/repo";
const EPIC_ID = "sparkle-huw924";
const T = "epics-bead-card";

const EPIC: Bead = {
  id: EPIC_ID,
  title: "Epics column and epic card redesign",
  description: "Items 15-24 of the founder's 2026-08-20 self-interview.",
  status: "open",
  labels: [],
  type: "epic",
};

function seed() {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: ROOT,
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents: [],
      },
    ],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  useComposeHandoffStore.setState({ handoff: null });
});
afterEach(cleanup);

function mount(over: Partial<Parameters<typeof EpicInlineCard>[0]> = {}) {
  return render(
    <EpicInlineCard
      bead={EPIC}
      projectId={PROJECT}
      rootPath={ROOT}
      allBeads={[EPIC]}
      onClose={() => {}}
      {...over}
    />,
  );
}

/** The card really rendered, asserted before any absence claim — AGENTS.md's fourth vacuous shape:
 *  absence in a component that is not in the tree proves nothing. */
function assertTheCardIsReallyThere() {
  expect(screen.getByTestId(`${T}-title`).textContent).toBe(EPIC.title);
  expect(screen.getByTestId(`${T}-meta`)).toBeTruthy();
  expect(screen.getByTestId(`${T}-description`).textContent).toContain("Items 15-24");
  expect(screen.getByTestId(`${T}-id`).textContent).toBe(EPIC_ID);
}

/**
 * Every box from the card up to (and including) the render root that paints ANY edge.
 *
 * See `BeadCard/BeadCardChrome.test.tsx` for why this reads the shorthand and the side longhands
 * rather than `border-*-style`: jsdom will not expand `border` when its colour is a `var()`.
 */
function borderedBoxesInChain(from: HTMLElement, root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let el: HTMLElement | null = from; el !== null; el = el.parentElement) {
    const s = el.style;
    const painted = [s.border, s.borderTop, s.borderRight, s.borderBottom, s.borderLeft].some(
      (v) => v !== "" && v !== "none",
    );
    if (painted) out.push(el);
    if (el === root) break;
  }
  return out;
}

// ── ITEM 19 — ONE BORDER IN THE WHOLE CHAIN ─────────────────────────────────────────────────────

describe("item 19 — the open epic card has exactly ONE border around it", () => {
  // [09:41] "So we can get rid of the double border. Just have one border."
  //
  // COUNTED, not asserted-absent on one element: "no double border" is satisfied by zero borders
  // too, and a card with no edge at all is a different bug, not a fix. Exactly one is the claim.
  it("counts one bordered box from the card up through its frame", () => {
    const { container } = mount();
    assertTheCardIsReallyThere();

    const card = screen.getByTestId(T);
    const frame = screen.getByTestId("epic-inline-card");
    expect(frame.contains(card)).toBe(true);

    const bordered = borderedBoxesInChain(card, container as HTMLElement);
    expect(bordered).toHaveLength(1);
    // …and it is the CARD that carries it, not a wrapper — so the edge follows the card's own
    // corners rather than boxing it in a second, squarer one.
    expect(bordered[0]).toBe(card);
  });
});

// ── ITEMS 20 + 21 — SQUARE TOP, NO DIVIDING LINE ────────────────────────────────────────────────

describe("items 20+21 — the card is a continuation of its row, not a floating box", () => {
  // [12:55] "the top of the card is rounded. But it shouldn't be rounded." [13:07] "there's a line
  // in between the row and the card, it should just be solid."
  it("paints no top edge and squares the top corners", () => {
    mount();
    assertTheCardIsReallyThere();
    const card = screen.getByTestId(T);

    // THE LINE the founder saw WAS this edge — two same-coloured fills with a hairline between.
    expect(card.style.borderTop).toBe("");
    expect(card.style.border).toBe("");
    // The other three survive, so this is "the top edge went away" and not "the border went away".
    expect(card.style.borderBottom).not.toBe("");
    expect(card.style.borderLeft).not.toBe("");
    expect(card.style.borderRight).not.toBe("");

    expect(card.style.borderRadius.startsWith("0 0 ")).toBe(true);
  });
});

// ── ITEM 22 — NO BLUE BAR ON THIS CARD ──────────────────────────────────────────────────────────

describe("item 22 — the blue bar is off the epic card, and this wrapper is what takes it off", () => {
  // [13:17] "we don't wanna have this little blue bar here. Don't do that."
  it("renders no stage line, with the rest of the card fully on screen", () => {
    mount();
    assertTheCardIsReallyThere();
    expect(screen.queryByTestId(`${T}-stage`)).toBeNull();
    expect(screen.queryByTestId(`${T}-stage-label`)).toBeNull();
  });
});

// ── ITEMS 15 + 16 — THE CHAT BUTTON IS WIRED HERE ───────────────────────────────────────────────

describe("items 15+16 — the Chat button the epic card was missing", () => {
  // [07:30] "We're also missing a chat button." The button is gated on the callback, so its mere
  // PRESENCE is already the wiring assertion — but presence alone would pass for a button bound to
  // a no-op, so the row below drives it.
  it("renders it in the top-right cluster, to the RIGHT of the id", () => {
    mount();
    const corner = screen.getByTestId(`${T}-corner`);
    const id = screen.getByTestId(`${T}-id`);
    const chat = screen.getByTestId(`${T}-chat`);

    expect(corner.contains(id)).toBe(true);
    expect(corner.contains(chat)).toBe(true);
    expect(Boolean(id.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  // THE SIDE EFFECT: pressing it must put a draft in the composer handoff, addressed to THIS
  // project. That store is what `ConciergeHost` reads; a button that renders and writes nothing is
  // the failure every assertion above is blind to.
  it("HANDS A DRAFT TO THE COMPOSER, routed to sparkle and addressed to this project", async () => {
    mount();
    fireEvent.click(screen.getByTestId(`${T}-chat`));

    await waitFor(() => {
      const h = useComposeHandoffStore.getState().handoff;
      expect(h).not.toBeNull();
      expect(h!.origin).toBe("bead-chat");
      expect(h!.projectId).toBe(PROJECT);
      expect(h!.text).toContain(EPIC.title);
      // The founder pressed Chat, next to a Build It he did NOT press — `route: "sparkle"` is what
      // stops the concierge's auto-router aiming the draft at a build agent instead.
      expect(h!.route).toBe("sparkle");
    });
  });

  // Every write on this card is gated on a project path, and a chat draft is a write. Mounted and
  // checked: the read-only card IS on screen, so the missing button is about `rootPath`.
  it("offers no Chat at all on a read-only card", () => {
    mount({ rootPath: null });
    expect(screen.getByTestId(`${T}-title`).textContent).toBe(EPIC.title);
    expect(screen.queryByTestId(`${T}-chat`)).toBeNull();
  });
});

// ── ITEMS 17 + 18 — THE GOLD PILL ON THE REAL CARD ──────────────────────────────────────────────

describe("items 17+18 — the gold EPIC pill on the card the column mounts", () => {
  // [10:08] "it should look the same when it's open as it does when it's closed."
  it("sits above the title, on the card's top-left", () => {
    mount();
    const pill = screen.getByTestId(`${T}-epic-pill`);
    const title = screen.getByTestId(`${T}-title`);

    expect(pill.textContent).toBe("EPIC");
    expect(Boolean(pill.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });
});
