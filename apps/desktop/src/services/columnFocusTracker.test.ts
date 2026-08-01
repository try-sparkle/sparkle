// @vitest-environment jsdom
//
// The tracker's behaviour, asserted through the SIDE EFFECT — what `focusedZoomColumn()` returns
// after a gesture — rather than through the listeners it registered. Registering a listener is a
// precondition that was true before this file existed; the reading is the output.
//
// THE HEADLINE CASE is "clicking a button in a build column leaves that column addressable". That is
// the one a focus-only implementation gets wrong, so it is asserted by REPLAYING the WKWebView event
// sequence (pointerdown → focusout → activeElement is <body>, no focusin) rather than by trusting a
// jsdom click to reproduce a WebKit quirk it does not implement.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZOOM_COLUMN_ATTR } from "../engine/columnZoom";
import {
  __resetZoomColumnForTest,
  focusedZoomColumn,
  installColumnFocusTracker,
  onZoomColumnChange,
} from "./columnFocusTracker";

let uninstall: (() => void) | null = null;

/** A column root carrying `key`, with a `<button>` and a focusable `<textarea>` inside it. */
function column(key: string) {
  const root = document.createElement("div");
  root.setAttribute(ZOOM_COLUMN_ATTR, key);
  const button = document.createElement("button");
  const textarea = document.createElement("textarea");
  root.append(button, textarea);
  document.body.appendChild(root);
  return { root, button, textarea };
}

/** Replay the macOS/WKWebView button click: the press lands, the caret is blurred to <body>, and NO
 *  focusin follows. This is the sequence a focus-only tracker mis-reads. */
function webkitButtonClick(el: Element) {
  el.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  // activeElement is already <body> in jsdom unless something was focused; make it explicit.
  (document.activeElement as HTMLElement | null)?.blur?.();
}

beforeEach(() => {
  document.body.innerHTML = "";
  __resetZoomColumnForTest();
  uninstall = installColumnFocusTracker();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  __resetZoomColumnForTest();
});

describe("installColumnFocusTracker", () => {
  it("starts with NO column — a fresh launch must not address one by default", () => {
    expect(focusedZoomColumn()).toBeNull();
  });

  it("records the column a pointer press lands in", () => {
    const { button } = column("build-left");
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBe("build-left");
  });

  it("KEEPS the column when a WKWebView button click blurs focus to <body>", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. A focus-only tracker — or one that cleared on any
    // unresolvable focus event — reports null here, which is exactly "Cmd +/- does nothing in the
    // build column and the concierge".
    const { button } = column("build-right");
    webkitButtonClick(button);
    await new Promise((r) => setTimeout(r, 1)); // let the deferred focusout read run
    expect(focusedZoomColumn()).toBe("build-right");
  });

  it("switches between the two build columns independently", () => {
    // Requirement 1: focus in the left build column must not address the right one.
    const left = column("build-left");
    const right = column("build-right");
    left.button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBe("build-left");
    right.button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBe("build-right");
  });

  it("CLEARS when a press lands outside every column", () => {
    // The other half of the asymmetry: a deliberate press elsewhere means "no column", so the
    // gesture does nothing rather than firing into whatever was last touched.
    const { button } = column("concierge");
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBe("concierge");

    const banner = document.createElement("div");
    document.body.appendChild(banner);
    banner.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBeNull();
  });

  it("promotes on focus for the keyboard-only path (no press at all)", () => {
    const { textarea } = column("terminal-left");
    textarea.focus();
    textarea.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true }));
    expect(focusedZoomColumn()).toBe("terminal-left");
  });

  it("does not clear on window blur — the column survives an app switch", () => {
    const { button } = column("terminal-right");
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new window.Event("blur"));
    expect(focusedZoomColumn()).toBe("terminal-right");
  });

  it("refuses an unrecognised marker rather than addressing a neighbour", () => {
    const { button } = column("build-middle");
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBeNull();
  });

  it("notifies subscribers only when the answer CHANGES", () => {
    const seen: (string | null)[] = [];
    onZoomChangeCollect(seen);
    const { button, textarea } = column("concierge");
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    textarea.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(seen).toEqual(["concierge"]); // two presses in one column, one notification
  });

  it("stops observing after uninstall", () => {
    const { button } = column("build-left");
    uninstall?.();
    uninstall = null;
    button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
    expect(focusedZoomColumn()).toBeNull();
  });
});

function onZoomChangeCollect(sink: (string | null)[]) {
  onZoomColumnChange((c) => sink.push(c));
}
