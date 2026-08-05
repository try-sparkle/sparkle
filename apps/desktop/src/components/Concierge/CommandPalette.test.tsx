// @vitest-environment jsdom
//
// The concierge ⌘K palette. Driven through the REAL historyStore (query/results source of
// truth) with services/history mocked off the Tauri bridge, and routing injected via the
// `jump` prop so every outcome is assertable without a webview: filtering, keyboard
// navigation (↑↓ wrap, ↩ jumps, esc closes), jump dispatch per outcome, and the empty states.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Order-safe shared seed: `vi.hoisted` runs before the hoisted `vi.mock` factory and the
// tests, so both reference the same handle (same idiom as HistorySearch.test).
const h = vi.hoisted(() => ({ seeded: [] as HistoryHit[] }));

// Keep the store's debounced search off the Tauri bridge: return our seeded hits instead.
vi.mock("../../services/history", async (orig) => {
  const actual = await orig<typeof import("../../services/history")>();
  return {
    ...actual,
    recordHistory: vi.fn(async () => {}),
    searchHistory: vi.fn(async () => h.seeded),
    pruneHistory: vi.fn(async () => 0),
  };
});

import { AGENT_CLOSED_MESSAGE, CommandPalette, PaletteTrigger } from "./CommandPalette";
import { useHistoryStore } from "../../stores/historyStore";
import { BADGE_EDGE_PCT } from "../../theme/colors";
import type { HistoryHit } from "../../services/history";
import type { JumpOutcome } from "./paletteJump";

const hit = (over: Partial<HistoryHit> = {}): HistoryHit => ({
  id: "h1",
  kind: "prompt",
  source: "build",
  projectId: "p1",
  agentId: "a1",
  projectName: "Demo",
  agentName: "Builder",
  snippet: "loving <b>rust</b> lately",
  createdAt: Date.now() - 60_000,
  ...over,
});

const jumped: JumpOutcome = { kind: "jumped-here" };

beforeEach(() => {
  h.seeded = [hit()];
  useHistoryStore.setState({ query: "", results: [], entitlement: "24h", searching: false });
});
afterEach(() => cleanup());

describe("CommandPalette — visibility + filtering", () => {
  it("renders nothing while closed", () => {
    render(<CommandPalette open={false} onClose={vi.fn()} jump={() => jumped} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("open with a blank query shows the hint, no result rows", () => {
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    expect(screen.getByRole("dialog", { name: "Search history" })).toBeTruthy();
    expect(screen.getByText(/type to search your conversation/i)).toBeTruthy();
    expect(screen.queryByTestId("palette-result")).toBeNull();
  });

  it("typing updates the store query (the store owns the debounced search)", () => {
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search history" }), {
      target: { value: "rust" },
    });
    expect(useHistoryStore.getState().query).toBe("rust");
  });

  it("renders store results: snippet bolding, kind badge, project · agent, relative time", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded });
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    // The <b> match marker renders as bold text (split safely, never innerHTML).
    expect(screen.getByText("rust")).toBeTruthy();
    expect(screen.getByText("Demo · Builder")).toBeTruthy();
    expect(screen.getByText("prompt")).toBeTruthy();
    expect(screen.getByText(/minute ago/i)).toBeTruthy();
  });

  // ── THE PAINTED BORDER MUST CONSUME THE CONSTANT THE THEME GUARD MEASURES ─────────────────────
  // chromeContrast.test.ts measures BADGE_EDGE_PCT composited over the surfaces this badge renders
  // on, which is only worth anything if the component still READS that constant. It did not always:
  // the weights were inline literals while the guard kept its own copy, so writing `? 85 : 32` back
  // into the template — the exact edit that produced an invisible light-mode edge in roborev 54231 —
  // left the guard measuring 45% and passing (54263, 54266). This is the link in that chain:
  // numeric floor → constant → rendered style. Break any one of the three and a test fails.
  it("the kind badge paints the edge weight the contrast guard measures", () => {
    useHistoryStore.setState({
      query: "rust",
      results: [hit({ id: "p", kind: "prompt" }), hit({ id: "o", kind: "response" })],
    });
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    const badgeFor = (label: string) => screen.getByText(label) as HTMLElement;

    expect(badgeFor("prompt").style.border).toContain(`${BADGE_EDGE_PCT.prompt}%`);
    expect(badgeFor("response").style.border).toContain(`${BADGE_EDGE_PCT.other}%`);
    // …and the two really are different weights, so the kind is carried by something.
    expect(BADGE_EDGE_PCT.prompt).not.toBe(BADGE_EDGE_PCT.other);
    // No fill on either: a tint of `accentInk` under `accentInk` text is what made the label
    // illegible, which is why the edge carries the kind at all.
    for (const label of ["prompt", "response"]) {
      expect(badgeFor(label).style.background).toBe("transparent");
    }
  });

  it("shows the retention-scoped empty state when a query has no matches", () => {
    useHistoryStore.setState({ query: "zzz", results: [], searching: false });
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    expect(screen.getByText("No matches in the last 24 hours.")).toBeTruthy();
  });

  it("shows Searching… instead of a false 'no matches' while the search is in flight", () => {
    useHistoryStore.setState({ query: "zzz", results: [], searching: true });
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(screen.queryByText(/no matches/i)).toBeNull();
  });
});

describe("CommandPalette — keyboard navigation", () => {
  const two = () => [hit(), hit({ id: "h2", agentName: "Deployer", snippet: "ship <b>rust</b>" })];

  it("arrows move the selection and wrap at both ends", () => {
    useHistoryStore.setState({ query: "rust", results: two() });
    render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    const dialog = screen.getByRole("dialog");
    const options = () => screen.getAllByTestId("palette-result");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(dialog, { key: "ArrowDown" }); // wraps to the top
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(dialog, { key: "ArrowUp" }); // wraps to the bottom
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter jumps to the SELECTED hit and closes, clearing the shared query", () => {
    useHistoryStore.setState({ query: "rust", results: two() });
    const jump = vi.fn<(x: HistoryHit) => JumpOutcome>(() => jumped);
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} jump={jump} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(jump).toHaveBeenCalledTimes(1);
    expect(jump.mock.calls[0]![0].id).toBe("h2");
    expect(onClose).toHaveBeenCalled();
    // Closing clears the store query so the sidebar HistorySearch can't reopen on stale input.
    expect(useHistoryStore.getState().query).toBe("");
  });

  it("Escape closes without jumping", () => {
    useHistoryStore.setState({ query: "rust", results: two() });
    const jump = vi.fn(() => jumped);
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} jump={jump} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(jump).not.toHaveBeenCalled();
  });

  it("an EXTERNAL close (⌘K toggle / closePalette) also clears the shared query", () => {
    // roborev 46074: only the internal close paths cleared the store, so closing via the
    // controller left stale input that could reopen the sidebar HistorySearch dropdown.
    useHistoryStore.setState({ query: "rust", results: two() });
    const { rerender } = render(<CommandPalette open onClose={vi.fn()} jump={() => jumped} />);
    rerender(<CommandPalette open={false} onClose={vi.fn()} jump={() => jumped} />);
    expect(useHistoryStore.getState().query).toBe("");
  });
});

describe("CommandPalette — jump dispatch", () => {
  it("clicking a row jumps to that hit and reports the outcome via onJumped", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded });
    const jump = vi.fn(() => jumped);
    const onJumped = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} jump={jump} onJumped={onJumped} />);
    fireEvent.click(screen.getByTestId("palette-result"));
    expect(jump).toHaveBeenCalledTimes(1);
    expect(onJumped).toHaveBeenCalledWith(h.seeded[0], jumped);
    expect(onClose).toHaveBeenCalled();
  });

  it("an agent-closed outcome shows the inline notice and keeps the palette open", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded });
    const jump = vi.fn((): JumpOutcome => ({ kind: "agent-closed" }));
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} jump={jump} />);
    fireEvent.click(screen.getByTestId("palette-result"));
    expect(screen.getByRole("alert").textContent).toBe(AGENT_CLOSED_MESSAGE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a hit whose project is gone renders disabled and never dispatches", () => {
    useHistoryStore.setState({ query: "rust", results: [hit({ projectId: null })] });
    const jump = vi.fn(() => jumped);
    render(<CommandPalette open onClose={vi.fn()} jump={jump} />);
    const row = screen.getByTestId("palette-result");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(jump).not.toHaveBeenCalled();
  });

  it("backdrop click closes; a click inside the panel doesn't", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded });
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} jump={() => jumped} />);
    fireEvent.mouseDown(screen.getByText("Demo · Builder"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PaletteTrigger", () => {
  const trigger = () => screen.getByRole("button", { name: "Search history (⌘K)" });
  /** The reserved keycap's wrapper — the `aria-hidden` span the reveal toggles. */
  const keycapSlot = () => {
    const el = trigger().querySelector<HTMLElement>("span[aria-hidden]");
    if (!el) throw new Error("no reserved keycap slot in the trigger");
    return el;
  };

  it("fires onOpen (the affordance U7 drops into the concierge header)", () => {
    const onOpen = vi.fn();
    render(<PaletteTrigger onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Search history (⌘K)" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // ── NARROW CONCIERGE COLUMN (bead sparkle-kk9dg.3) ──────────────────────────────────────────
  // Founder: "The search field is small and left-floating, with a stray empty box artifact
  // directly beneath its lower-left corner."
  //
  // MEASURED IN A REAL BROWSER at a 280px concierge (the visual harness's `?concierge=280`, painted
  // width asserted): the slot offers 247px and this button took 109px of it, hard against the left
  // edge, while the nudge card and compose box directly below span the full width. Of those 109px,
  // 33 were the reserved-but-invisible ⌘K box trailing the word "Search" — a bordered control
  // ending in an empty stub.
  //
  // jsdom HAS NO LAYOUT ENGINE, so none of that is observable here: `getBoundingClientRect` is 0
  // and `visibility` reserves nothing measurable (docs/jsdom-test-caveats.md). What IS checkable is
  // the STYLE SHAPE — the three declarations the fix adds, every one of which was absent before —
  // and that is deliberately all these assert. The real-layout proof is the capture.
  describe("at a narrow concierge column", () => {
    beforeEach(() => render(<PaletteTrigger onOpen={vi.fn()} />));

    it("fills its slot rather than shrink-wrapping to its text", () => {
      // `inline-flex` is what made it shrink-wrap and float left. A block-level flex container at
      // 100% spans the column like everything under it.
      expect(trigger().style.display).toBe("flex");
      expect(trigger().style.width).toBe("100%");
    });

    it("parks the reserved keycap on the RIGHT EDGE, so no dead stub trails the label", () => {
      // Without this the reserved box sits immediately after "Search" and every pixel from there to
      // the border is unexplained empty bordered space — the artifact the founder read.
      expect(keycapSlot().style.marginLeft).toBe("auto");
    });

    it("STILL reserves the keycap's box, so the button cannot twitch on hover", () => {
      // The pre-existing decision this fix must not undo (see PaletteTrigger's docblock): the pill
      // is hidden, never un-rendered. Asserted from both ends — the node exists while hidden, and
      // revealing it changes only `visibility`.
      expect(keycapSlot().style.visibility).toBe("hidden");
      expect(keycapSlot().textContent).toBe("⌘K");
      fireEvent.mouseEnter(trigger());
      expect(keycapSlot().style.visibility).toBe("visible");
      expect(keycapSlot().style.marginLeft).toBe("auto");
    });
  });
});
