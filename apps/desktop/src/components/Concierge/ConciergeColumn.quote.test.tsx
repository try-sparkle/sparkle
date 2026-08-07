// @vitest-environment jsdom
//
// SELECTION-TO-QUOTE, end to end through the real component tree (founder, 2026-08-06):
// highlight some of the concierge's output → a "Quote in response" chiclet appears → activating it
// puts the selection into the compose box as a removable quote carrying the source message id.
//
// EVERYTHING BELOW THE HARNESS IS THE REAL THING — the real `ConciergeColumn`, `ConciergeThread`,
// `useQuoteOnSelection`, `QuoteChiclet`, `useConciergeQuote`, `ComposeBox` and `QuoteChip`. The
// harness only plays the part `ConciergeHost` plays (own the quote, hand it back down as
// `model.quote`), and it does so by calling the SAME hook the host calls rather than by
// reimplementing the staging — a guard written against a copy of its mechanism proves nothing about
// the mechanism.
//
// TWO jsdom FACTS SHAPE THIS FILE (docs/jsdom-test-caveats.md):
//   • jsdom NEVER originates `selectionchange`. Mutating the selection dispatches nothing, so the
//     event is hand-dispatched below. A version of this test that passes WITHOUT that line is not
//     evidence the feature works — it is evidence the feature never ran.
//   • jsdom never lays out, so every box is {0,0,0,0}. These assert the chiclet's PRESENCE and the
//     chip's CONTENT, never coordinates; the placement math is `selectionPopupPosition`'s own
//     already-tested pure function.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import type { ConciergeController, ConciergeMessage, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { useConciergeQuote } from "../../hooks/useConciergeQuote";
import { QUOTE_CHICLET_LABEL, QUOTE_CHICLET_TESTID } from "./QuoteChiclet";
import { QUOTE_CHIP_REMOVE_TESTID, QUOTE_CHIP_TESTID } from "./QuoteChip";
import { SHORTCUT_DEFAULTS } from "../../stores/keybindingsStore";

const ANSWER = "PR 1430 is blocked on the CI check that never ran";

const MESSAGES: ConciergeMessage[] = [
  { id: "sparkle-15", kind: "sparkle", text: ANSWER },
  { id: "you-9", kind: "you", text: "what is blocking it" },
];

beforeEach(() => {
  enableAiEnhancementsForTests();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

/** The host's job, and only the host's job: own the staged quote and hand it back down. */
function Harness({ messages = MESSAGES }: { messages?: ConciergeMessage[] }) {
  const quoteApi = useConciergeQuote("concierge");
  const controller = useMemo<ConciergeController>(
    () => ({
      onSend: vi.fn(),
      onAttach: vi.fn(),
      onNudgeClick: vi.fn(),
      onNudgeAction: vi.fn(),
      onQuote: quoteApi.stage,
      onRemoveQuote: quoteApi.remove,
    }),
    [quoteApi],
  );
  const model: ConciergeViewModel = {
    scope: {},
    vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
    messages,
    quote: quoteApi.quote,
  };
  return <ConciergeColumn model={model} controller={controller} />;
}

/** The first text node under `root` containing `needle`. */
function textNodeWith(root: HTMLElement, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) if (n.textContent?.includes(needle)) return n as Text;
  throw new Error(`no text node containing ${needle}`);
}

/**
 * A real drag, as the browser would deliver it: press, a real Range in the real Selection, the
 * `selectionchange` jsdom will not send by itself, then release.
 */
function dragOver(needle: string, chars?: [number, number]): void {
  const row = screen.getByTestId("concierge-thread");
  const node = textNodeWith(row, needle);
  fireEvent.mouseDown(document, { button: 0 });
  const range = document.createRange();
  if (chars) {
    range.setStart(node, chars[0]);
    range.setEnd(node, chars[1]);
  } else {
    range.selectNodeContents(node);
  }
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  fireEvent.mouseUp(document, { button: 0 });
}

const chiclet = () => screen.queryByTestId(QUOTE_CHICLET_TESTID);
const chip = () => screen.queryByTestId(QUOTE_CHIP_TESTID);
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("selection-to-quote", () => {
  it("raises a 'Quote in response' chiclet on a selection, and quotes it into the compose box", () => {
    render(<Harness />);
    // Nothing is offered until something is selected.
    expect(chiclet()).toBeNull();
    expect(chip()).toBeNull();

    dragOver(ANSWER);

    const pill = chiclet();
    expect(pill).not.toBeNull();
    // THE WORDING IS PART OF THE ASK, so it is pinned to the LITERAL. Asserting the render against
    // `QUOTE_CHICLET_LABEL` alone proves the button draws its own constant and nothing about what
    // that constant says — rename it to "Quote" or "Reply with quote" and the check stays green.
    // The founder specified this affordance as "a little Chicklet … that says Quote in response",
    // so the string is a requirement, not an implementation detail. Both assertions are needed: the
    // literal fixes the words, the render proves the button actually shows them.
    expect(QUOTE_CHICLET_LABEL).toBe("Quote in response");
    expect(pill!.textContent).toContain(QUOTE_CHICLET_LABEL);

    fireEvent.click(pill!);

    // THE SIDE EFFECT, not the precondition: the compose box now holds the selection as a quote…
    const staged = chip();
    expect(staged).not.toBeNull();
    expect(staged!.textContent).toContain(ANSWER);
    // …carrying the id of the message it came from — the invisible ref the founder chose, which is
    // what lets the concierge resolve the FULL original rather than just this fragment.
    expect(staged!.getAttribute("data-quote-source-id")).toBe("sparkle-15");
    // …captioned with the surface it came from.
    expect(staged!.textContent).toContain("Concierge");
    // And the affordance stands down once it has been used.
    expect(chiclet()).toBeNull();
  });

  it("PRESERVES an existing draft — the quote attaches above it, nothing typed is lost", () => {
    render(<Harness />);
    fireEvent.change(composer(), { target: { value: "this one's actually a flake, not us" } });

    dragOver(ANSWER);
    fireEvent.click(chiclet()!);

    expect(chip()).not.toBeNull();
    // The founder's hand-rolled version pastes the quote ABOVE what he has written; staging one
    // must never rewrite or clear the draft.
    expect(composer().value).toBe("this one's actually a flake, not us");
  });

  it("quotes the user's OWN past messages too, captioned as such", () => {
    render(<Harness />);
    dragOver("what is blocking it");
    fireEvent.click(chiclet()!);

    expect(chip()!.getAttribute("data-quote-source-id")).toBe("you-9");
    expect(chip()!.textContent).toContain("You");
  });

  it("takes the quote back out when the chip's × is pressed", () => {
    render(<Harness />);
    dragOver(ANSWER);
    fireEvent.click(chiclet()!);
    expect(chip()).not.toBeNull();

    fireEvent.click(screen.getByTestId(QUOTE_CHIP_REMOVE_TESTID));
    expect(chip()).toBeNull();
  });

  it("offers nothing for a selection with no words in it", () => {
    render(<Harness />);
    // A zero-width range is what a click leaves behind; it is an accident of dragging, never an
    // intent to quote.
    dragOver(ANSWER, [3, 3]);
    expect(chiclet()).toBeNull();
  });

  it("dismisses on Escape without staging anything", () => {
    render(<Harness />);
    dragOver(ANSWER);
    expect(chiclet()).not.toBeNull();

    // Registered on `window` by QuoteChiclet — fired at the same target it listens on.
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    expect(chiclet()).toBeNull();
    expect(chip()).toBeNull();
  });

  it("raises the affordance from the KEYBOARD, with no mouse gesture at all", () => {
    render(<Harness />);
    // A keyboard selection: no mousedown, no mouseup — shift+arrows just stops, which is why the
    // chord exists as the explicit "I am done selecting".
    const node = textNodeWith(screen.getByTestId("concierge-thread"), ANSWER);
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(chiclet()).toBeNull();

    // DERIVED FROM THE SHIPPED DEFAULT, not hand-typed. The first cut of this test hard-coded
    // `{ key: "'", shiftKey: true }` — a combination no browser emits, since Shift+' reports `"` —
    // so it passed green against a chord that was dead in the real app (roborev 59799). Reading the
    // binding means the event fired here is the one the app actually ships, and
    // `keybindingsStore.test.ts` separately refuses a default that no keypress could produce, which
    // is the half this file cannot check without modelling a keyboard layout.
    const chord = SHORTCUT_DEFAULTS.quoteSelection;
    if (chord.kind !== "chord") throw new Error("quoteSelection must be a chord");
    fireEvent.keyDown(document, {
      key: chord.key,
      metaKey: chord.meta,
      ctrlKey: chord.ctrl,
      altKey: chord.alt,
      shiftKey: chord.shift,
    });

    expect(chiclet()).not.toBeNull();
    fireEvent.click(chiclet()!);
    expect(chip()!.getAttribute("data-quote-source-id")).toBe("sparkle-15");
  });

  it("stands the chiclet down when a NEW selection begins", () => {
    render(<Harness />);
    dragOver(ANSWER);
    expect(chiclet()).not.toBeNull();

    // A press anywhere but the chiclet starts a new gesture, so the old offer no longer matches
    // what is on screen.
    fireEvent.mouseDown(document, { button: 0 });
    expect(chiclet()).toBeNull();
  });
});
