// @vitest-environment jsdom
//
// WHERE the span shortcut sits in the header (bead sparkle-6b96h).
//
// The founder was specific about the position, not just the existence: "Give me a little icon next
// to the three dot menu… Between the PR button and the three dot menu." So placement is the
// contract, and `ConciergeColumn.header.test.tsx`'s existing order assertions stop at the PR slot —
// nothing there would notice this landing at the wrong end of the row.
//
// It lives in its own file rather than in that one because it needs a Tauri `invoke` mock (the
// button reads the display layout before deciding to render), and the header suite deliberately
// runs without one — under which this control correctly renders NOTHING.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => <div data-testid="logo-waveform" /> }));
vi.mock("../BalanceBadge", () => ({
  BalanceBadge: () => <button type="button">Open credits</button>,
}));

import { ConciergeColumn } from "./ConciergeColumn";
import type { ConciergeController, ConciergeViewModel } from "./types";
import type { DisplayLayout } from "../../services/displaySpan";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { useAuthStore } from "../../stores/authStore";
import { useTrialStore } from "../../stores/trialStore";
import { useSettingsStore } from "../../stores/settingsStore";

const TWO_DISPLAYS: DisplayLayout = {
  displays: [
    {
      name: "Color LCD",
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      work_area: { x: 0, y: 25, width: 1512, height: 957 },
      scale_factor: 2,
    },
    {
      name: "PM161Q J",
      bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
      work_area: { x: 1512, y: 0, width: 1920, height: 1080 },
      scale_factor: 1,
    },
  ],
  safe: { x: 0, y: 25, width: 3432, height: 957 },
  full: { x: 0, y: 0, width: 3432, height: 1080 },
  spanning_enabled: true,
};

beforeEach(() => {
  enableAiEnhancementsForTests();
  // The avatar renders only once both stores have settled — it is the element the shortcut has to
  // sit BEFORE, so it must actually be in the DOM.
  useAuthStore.setState({ tokenPresent: true, loading: false } as never);
  useTrialStore.setState({ loading: false, started: true } as never);
  useSettingsStore.setState({
    windowSpanMode: "safe",
    windowAutoRespan: true,
    windowIsSpanned: false,
  });
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "display_layout") return Promise.resolve(TWO_DISPLAYS);
    return Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 });
  });
});
afterEach(cleanup);

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 2, running: 5, done: 1 },
  messages: [{ id: "m1", kind: "you", text: "Retry the failing one" }],
};

/** Stands in for `<OpenPrMenu compact />`, which the shell — not this directory — supplies. */
const PR_SLOT = (
  <button type="button" data-testid="pr-slot-stub">
    <svg />3
  </button>
);

function renderHeader() {
  const c: ConciergeController = {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
    onMoveSide: vi.fn(),
    onNeedsYouFilterToggle: vi.fn(),
  };
  render(<ConciergeColumn model={model} controller={c} prSlot={PR_SLOT} />);
}

const header = () => screen.getByTestId("concierge-header");

/** True when `a` precedes `b` in document order. */
const precedes = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the span shortcut sits between the PR count and the ⋮", () => {
  it("is in the header row, after the PR slot and before the kebab", async () => {
    renderHeader();
    const span = await screen.findByTestId("concierge-span-toggle");
    expect(header().contains(span)).toBe(true);

    const pr = screen.getByTestId("pr-slot-stub");
    const kebab = screen.getByRole("button", { name: "Settings" });
    expect(precedes(pr, span), "the shortcut must come AFTER the PR count").toBe(true);
    expect(precedes(span, kebab), "the shortcut must come BEFORE the ⋮ menu").toBe(true);
  });

  it("adds no words to a row that is deliberately silent", async () => {
    renderHeader();
    await screen.findByTestId("concierge-span-toggle");
    // The row's ENTIRE text stays the needs-you count ("2") and the PR stub's ("3"). The shortcut
    // contributes none of its own — bead sparkle-ircc3 deleted a status line from here specifically
    // to reclaim this space, and a labelled button would spend it straight back.
    expect(header().textContent?.trim()).toBe("23");
  });

  it("renders nothing here when there is no display layout to read", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    renderHeader();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("display_layout"));
    await waitFor(() => expect(screen.queryByTestId("concierge-span-toggle")).toBeNull());
    // …and the row it sits in is otherwise unchanged.
    expect(header().contains(screen.getByTestId("pr-slot-stub"))).toBe(true);
  });
});
