// @vitest-environment jsdom
//
// ══ THE DEFECT THAT ONLY EXISTS IN A MERGE — bead `sparkle-92md3i` ═════════════════════════════
//
// Two changes, each correct on its own, each with a green suite:
//
//   * one made the card BODY a click target, so a press anywhere on it collapses the card;
//   * one put LINKS inside that body.
//
// Composed, a press on a link navigated AND collapsed the card in the same gesture. Neither
// branch's tests could see it, because neither branch contained both halves. So this file's whole
// reason to exist is that it MOUNTS BOTH HALVES AT ONCE: the real `BeadCard` with its real
// `onToggleCollapsed`, and the real `<Markdown>` link component inside it — not a hand-rolled
// `<a>` that happens to resemble one. A stub anchor would test this file's idea of a link; the
// shipped one is the thing that failed, and it is the one that does not call `stopPropagation`.
//
// ══ BOTH DIRECTIONS, ALWAYS ═══════════════════════════════════════════════════════════════════
// "Pressing the link does not collapse" is VACUOUSLY true of a card whose toggle is wired to
// nothing, of a link that never rendered, and of a guard that suppresses every press on the card.
// So every row here asserts the pair:
//
//   * the link's own action REALLY RAN (`openUrl` was called with the href), and the card did NOT
//     toggle; and
//   * a press on INERT BODY in the same mounted tree DID toggle.
//
// jsdom never lays out and never loads the stylesheet, so nothing here reads a computed style or a
// measured box (`docs/jsdom-test-caveats.md`) — these are events and the accessibility tree only.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadCard } from "./BeadCard";
import { Markdown } from "../Markdown";
import type { Bead } from "../../services/beads";

// The link's "navigation" IS this call: `Markdown`'s anchor always `preventDefault`s and hands an
// allowlisted href to the opener, because a webview must not navigate itself away from the app.
// Asserting on it is asserting the side effect the press exists for.
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

const B: Bead = {
  id: "sparkle-92md3i",
  title: "A press on a link is not a press on the card",
  description: "The body is the expand target and the body now carries links.",
  status: "open",
  type: "bug",
  priority: 2,
  labels: [],
  parent: null,
  commentCount: 0,
};

const t = "concierge-bead-card";
const HREF = "https://example.com/the-linked-thing";

/**
 * The card with a link in its body.
 *
 * The link goes through `footer`, which is the honest seam: it is arbitrary caller-supplied content
 * rendered INSIDE the card's border and, unlike every control this component owns, it is NOT
 * wrapped in a `stopPropagation` box. That is exactly the position a future contributor's markup
 * lands in — the one nobody remembers to protect.
 */
function mount(over: Partial<Parameters<typeof BeadCard>[0]> = {}) {
  return render(
    <BeadCard
      bead={B}
      chrome="concierge"
      stage="planned"
      workers={[]}
      collapsed={false}
      footer={<Markdown text={`[the linked thing](${HREF})`} />}
      {...over}
    />,
  );
}

/**
 * The card's inert body — prose, no control, no link. The other half of every pair below.
 *
 * Sanity-checked on the way out, because "a press on the body still collapses" would silently stop
 * meaning that if the description ever became a control itself. The check looks at the element and
 * its own subtree ONLY: its ANCESTORS include the card root, which carries the chrome's
 * `role="status"` — a live region, not something a press can activate.
 */
function inertBody(): HTMLElement {
  const body = screen.getByTestId(`${t}-description`);
  const CONTROLS = "a[href],button,input,select,textarea,summary,label,[role=\"button\"]";
  expect(body.matches(CONTROLS)).toBe(false);
  expect(body.querySelector(CONTROLS)).toBeNull();
  return body;
}

describe("BeadCard — a link inside the body navigates WITHOUT collapsing the card", () => {
  it("presses the link: the opener runs and the card does not toggle", () => {
    const onToggleCollapsed = vi.fn();
    mount({ onToggleCollapsed });

    const link = screen.getByRole("link", { name: "the linked thing" });
    // The link really is INSIDE the card — otherwise there is no ancestor handler to collide with
    // and the row would pass against a card that never contained it.
    expect(screen.getByTestId(t).contains(link)).toBe(true);

    fireEvent.click(link);

    // THE LINK REALLY ACTED. Without this, "the card did not toggle" is true of a dead link.
    expect(openUrl).toHaveBeenCalledWith(HREF);
    // …AND THE CARD STAYED OPEN. This is the founder-visible half of the defect.
    expect(onToggleCollapsed).not.toHaveBeenCalled();
  });

  it("presses the inert body of that SAME card: it still toggles", () => {
    const onToggleCollapsed = vi.fn();
    mount({ onToggleCollapsed });

    fireEvent.click(inertBody());

    // The guard is a scalpel, not an off switch: the click-the-card gesture is intact.
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    // And pressing the body is not a navigation.
    expect(openUrl).not.toHaveBeenCalled();
  });

  // ONE GESTURE, ONE OUTCOME — the shape the other branch's idempotence test tripped over: the
  // first press collapsed the card and removed the element the second press needed. Driving both
  // presses against ONE mounted card is what proves the two outcomes are separable in the tree
  // that actually ships, rather than in two independently-mounted ones.
  it("keeps the two apart in a single mounted card", () => {
    const onToggleCollapsed = vi.fn();
    mount({ onToggleCollapsed });

    fireEvent.click(screen.getByRole("link", { name: "the linked thing" }));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(1);

    // The link is still there to be pressed again, because the card never collapsed under it.
    fireEvent.click(screen.getByRole("link", { name: "the linked thing" }));
    expect(onToggleCollapsed).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledTimes(2);

    // …and the body still works.
    fireEvent.click(inertBody());
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // THE POINT OF PUTTING THE CHECK ON THE CONTAINER. A contributor adding one of these writes no
  // `stopPropagation` and reads no comment; the card has to be right anyway. Each row asserts its
  // control ACTED, so none of them can pass by being inert.
  it("extends to a button and a field a future contributor drops in, with no wrapper", () => {
    const onToggleCollapsed = vi.fn();
    const pressed = vi.fn();
    mount({
      onToggleCollapsed,
      footer: (
        <>
          <button type="button" data-testid="future-button" onClick={() => pressed()}>
            Something new
          </button>
          <input data-testid="future-input" defaultValue="" />
        </>
      ),
    });

    fireEvent.click(screen.getByTestId("future-button"));
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(onToggleCollapsed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("future-input"));
    expect(onToggleCollapsed).not.toHaveBeenCalled();

    // The paired direction, in the same tree: the body still collapses.
    fireEvent.click(inertBody());
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  // A PRESS ON THE ROOT ELEMENT ITSELF still toggles. The guard reads the press's TARGET, so the
  // one element it must never treat as its own interactive descendant is the container — and the
  // identity case is pinned properly, against a boundary that really does match the selector, in
  // `../interactiveClickTarget.test.ts`.
  it("still toggles when the press lands on the card root itself", () => {
    const onToggleCollapsed = vi.fn();
    mount({ onToggleCollapsed });

    const root = screen.getByTestId(t);
    fireEvent.click(root);

    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });
});
