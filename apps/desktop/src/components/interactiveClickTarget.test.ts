// @vitest-environment jsdom
//
// The container-level guard from bead `sparkle-92md3i`. `BeadCard.linkInBody.test.tsx` proves the
// behaviour end to end in the real component; this file pins the two boundary rules that a card
// cannot reach from outside, because the card's own root does not happen to match the interactive
// selector — so a container that DOES is built here by hand.
//
// jsdom lays nothing out, and none of this needs it: `closest`/`contains` are tree queries.
import { afterEach, describe, expect, it } from "vitest";
import { isInteractiveClickTarget } from "./interactiveClickTarget";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Build `<div id="root">…html…</div>`, attached, and hand back the root. */
function tree(html: string): HTMLElement {
  const root = document.createElement("div");
  root.id = "root";
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

describe("isInteractiveClickTarget — what counts as a press that already has an owner", () => {
  it("reports an interactive descendant, however deeply nested", () => {
    const root = tree('<span><em><a href="https://example.com">go</a></em></span>');
    const inner = root.querySelector("em") as HTMLElement;
    const link = root.querySelector("a") as HTMLElement;

    // The press's target is whatever the pointer landed on — often a text-bearing child of the
    // control, not the control itself. Both must answer the same way.
    expect(isInteractiveClickTarget(link, root)).toBe(true);
    expect(isInteractiveClickTarget(inner.firstChild ?? link, root)).toBe(true);
  });

  it("reports inert body as inert", () => {
    const root = tree("<span><em>just prose</em></span>");
    expect(isInteractiveClickTarget(root.querySelector("em"), root)).toBe(false);
    expect(isInteractiveClickTarget(root, root)).toBe(false);
  });

  // AN `<a>` WITH NO `href` IS NOT A LINK — it is styled text with no activation of its own, so a
  // container that stayed out of a press on it would lose the gesture entirely.
  it("does not count an anchor with no href", () => {
    const root = tree("<a>not a link</a>");
    expect(isInteractiveClickTarget(root.querySelector("a"), root)).toBe(false);
  });

  // THE IDENTITY RULE. A clickable row commonly carries `role="button"` on the very element that
  // owns the handler. It is not its own interactive descendant; without this, EVERY press on such
  // a container would be swallowed and the surface would be permanently dead — a worse bug than
  // the one being fixed, and a silent one.
  it("never treats the boundary itself as an interactive descendant", () => {
    const root = tree("<span>prose</span>");
    root.setAttribute("role", "button");

    expect(isInteractiveClickTarget(root, root)).toBe(false);
    // …and its inert child is still inert, rather than inheriting the root's own role.
    expect(isInteractiveClickTarget(root.querySelector("span"), root)).toBe(false);
  });

  // THE CONTAINMENT RULE. `closest` walks the whole document, so a card mounted inside somebody
  // else's control would otherwise report its own inert body as interactive.
  it("ignores an interactive ancestor that lives OUTSIDE the boundary", () => {
    const outer = tree('<button type="button"><span id="card"><em>prose</em></span></button>');
    const card = outer.querySelector("#card") as HTMLElement;

    expect(isInteractiveClickTarget(card.querySelector("em"), card)).toBe(false);
    // The same press, judged against the OUTER control, is a press on that control.
    expect(isInteractiveClickTarget(card.querySelector("em"), outer)).toBe(true);
  });

  // A DISABLED CONTROL STILL OWNS THE GESTURE as far as a person is concerned; a container that
  // collapsed out from under a press on a greyed-out button reads as the identical bug.
  it("counts a disabled control", () => {
    const root = tree('<button type="button" disabled>nope</button>');
    expect(isInteractiveClickTarget(root.querySelector("button"), root)).toBe(true);
  });

  it("answers false for a target that is not an element at all", () => {
    const root = tree("<span>prose</span>");
    expect(isInteractiveClickTarget(null, root)).toBe(false);
    expect(isInteractiveClickTarget(window, root)).toBe(false);
  });

  // A missing boundary is not a reason to fail open in the other direction: with nothing to bound
  // the walk, the nearest interactive ancestor is still the honest answer.
  it("falls back to the nearest interactive ancestor when given no boundary", () => {
    const root = tree('<a href="https://example.com"><em>go</em></a>');
    expect(isInteractiveClickTarget(root.querySelector("em"), null)).toBe(true);
    expect(isInteractiveClickTarget(root.querySelector("em"), window)).toBe(true);
  });
});
