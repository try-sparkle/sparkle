// @vitest-environment jsdom
//
// The cable state machine. These pin the four rules the founder stated for the cockpit, at the one
// place they are decided — so a component can never re-decide them differently.
import { describe, expect, it } from "vitest";
import {
  BUILD_ROW_SELECTOR,
  CABLE_REST,
  isBuildAgentRow,
  pairIsLive,
  patchCable,
  setOverlay,
  unbindCable,
  unbindsOnKey,
  unbindsOnPointerDown,
  type CableState,
} from "./cable";

describe("patching", () => {
  it("puts the live cable on the patched side", () => {
    expect(patchCable(CABLE_REST, "left")).toEqual({ wired: "left", overlay: "off" });
    expect(patchCable(CABLE_REST, "right")).toEqual({ wired: "right", overlay: "off" });
  });

  it("moves the cable rather than lighting both sides — ONE live circuit", () => {
    const left = patchCable(CABLE_REST, "left");
    expect(patchCable(left, "right").wired).toBe("right");
  });

  // "Receding" is the far pair's state, and it is NOT greying out: the pair still renders and its
  // last-active row is still selected. The machine only ever says which side is live; nothing here
  // may grow a notion of a disabled pair.
  it("marks exactly one pair live and the other merely not-live", () => {
    const s = patchCable(CABLE_REST, "left");
    expect(pairIsLive(s, "left")).toBe(true);
    expect(pairIsLive(s, "right")).toBe(false);
    expect(pairIsLive(CABLE_REST, "left")).toBe(false);
    expect(pairIsLive(CABLE_REST, "right")).toBe(false);
  });

  // WIRING DOCKS THE OVERLAY. A floating concierge sits on top of the very row it claims to be
  // wired to, so the two states cannot both be true.
  it("docks a floating concierge when the cable is patched", () => {
    const floating: CableState = { wired: "off", overlay: "assist" };
    expect(patchCable(floating, "right")).toEqual({ wired: "right", overlay: "off" });
  });

  it("docks a floating build column too — nothing floats over a live circuit", () => {
    const floating: CableState = { wired: "off", overlay: "build" };
    expect(patchCable(floating, "left").overlay).toBe("off");
  });

  it("is referentially stable when it changes nothing", () => {
    const s: CableState = { wired: "left", overlay: "off" };
    expect(patchCable(s, "left")).toBe(s);
  });
});

describe("unbinding", () => {
  it("returns the concierge to floating middle", () => {
    expect(unbindCable({ wired: "right", overlay: "off" }).wired).toBe("off");
    expect(unbindCable({ wired: "left", overlay: "off" }).wired).toBe("off");
  });

  it("leaves an unwired state untouched, by identity", () => {
    expect(unbindCable(CABLE_REST)).toBe(CABLE_REST);
  });

  it("says nothing about floating surfaces — unbind is about the cable only", () => {
    expect(unbindCable({ wired: "left", overlay: "build" })).toEqual({
      wired: "off",
      overlay: "build",
    });
  });
});

describe("overlay ⇄ cable", () => {
  it("floating the concierge unbinds — it would sit on the row it claims to be wired to", () => {
    expect(setOverlay({ wired: "right", overlay: "off" }, "assist")).toEqual({
      wired: "off",
      overlay: "assist",
    });
  });

  it("floating the build column over its own terminal does not touch the cable", () => {
    expect(setOverlay({ wired: "right", overlay: "off" }, "build")).toEqual({
      wired: "right",
      overlay: "build",
    });
  });

  it("docking changes nothing about the cable", () => {
    expect(setOverlay({ wired: "left", overlay: "build" }, "off")).toEqual({
      wired: "left",
      overlay: "off",
    });
  });
});

// ── THE TWO GESTURES, WHICH ARE ONE STATE CHANGE ──────────────────────────────────────────────
describe("gestures", () => {
  const wired: CableState = { wired: "right", overlay: "off" };

  it("Escape unbinds while wired", () => {
    expect(unbindsOnKey(wired, "Escape")).toBe(true);
  });

  // Escape is a busy key. Unwired, this handler must be inert so it is not a second listener
  // fighting the palette and every modal for the same press.
  it("Escape is inert while unwired", () => {
    expect(unbindsOnKey(CABLE_REST, "Escape")).toBe(false);
  });

  it("no other key unbinds", () => {
    for (const k of ["Enter", "Tab", " ", "esc", "Esc", "a"]) {
      expect(unbindsOnKey(wired, k)).toBe(false);
    }
  });

  it("a click that is not on a build agent row unbinds", () => {
    document.body.innerHTML = `<div id="elsewhere">chrome</div>`;
    expect(unbindsOnPointerDown(wired, document.getElementById("elsewhere"))).toBe(true);
  });

  it("a click ON a build agent row does not unbind — that is how you patch", () => {
    document.body.innerHTML = `
      <div data-agent-tree>
        <div role="treeitem"><span id="name">Stripe checkout retry</span></div>
      </div>`;
    expect(unbindsOnPointerDown(wired, document.getElementById("name"))).toBe(false);
  });

  it("recognises a row from a descendant of it, not just the row element", () => {
    document.body.innerHTML = `
      <div data-agent-tree>
        <div role="treeitem" id="row"><span><b id="deep">x</b></span></div>
      </div>`;
    expect(isBuildAgentRow(document.getElementById("deep"))).toBe(true);
    expect(isBuildAgentRow(document.getElementById("row"))).toBe(true);
  });

  // A treeitem OUTSIDE the agent tree (any other tree widget the app grows) is not a build row.
  it("does not mistake an unrelated treeitem for a build agent row", () => {
    document.body.innerHTML = `<div role="tree"><div role="treeitem" id="other">x</div></div>`;
    expect(isBuildAgentRow(document.getElementById("other"))).toBe(false);
  });

  it("tolerates a null / non-element target", () => {
    expect(isBuildAgentRow(null)).toBe(false);
    expect(unbindsOnPointerDown(wired, null)).toBe(true);
  });

  it("is inert on every gesture while unwired", () => {
    document.body.innerHTML = `<div id="elsewhere">chrome</div>`;
    expect(unbindsOnPointerDown(CABLE_REST, document.getElementById("elsewhere"))).toBe(false);
  });

  // The selector is the contract between this module and AgentSidebar's markup. If the sidebar
  // stops publishing that role, this fails loudly rather than the gesture silently unbinding on
  // every row click.
  it("matches AgentSidebar's published accessibility structure", () => {
    expect(BUILD_ROW_SELECTOR).toBe('[data-agent-tree] [role="treeitem"]');
  });
});

describe("the circuit, not the row — roborev 54697", () => {
  const wired: CableState = { wired: "right", overlay: "off" };

  /** Build a detached element inside a container matching `selector`-ish markup. */
  function inside(html: string, innerSelector: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    const el = host.querySelector(innerSelector);
    if (!el) throw new Error(`fixture has no ${innerSelector}`);
    return el;
  }

  it("a press inside Sparkle does NOT unbind — this was the bug that made wiring unusable", () => {
    // The primary flow is: patch into an agent, then TYPE to it. Under the old
    // `!isBuildAgentRow(target)` predicate the first click of that flow — into the compose box —
    // dropped the cable, and the consumer is a capture-phase window listener so nothing could
    // opt out.
    const box = inside(
      '<div data-concierge-root><textarea data-testid="compose"></textarea></div>',
      "textarea",
    );
    expect(unbindsOnPointerDown(wired, box)).toBe(false);
  });

  it("a press inside the WIRED pair does not unbind", () => {
    const term = inside(
      '<div data-pair data-wired-pair="true"><div class="xterm"></div></div>',
      ".xterm",
    );
    expect(unbindsOnPointerDown(wired, term)).toBe(false);
  });

  it("a press inside a pair that is NOT wired still unbinds — you have left the circuit", () => {
    const other = inside(
      '<div data-pair data-wired-pair="false"><div class="xterm"></div></div>',
      ".xterm",
    );
    expect(unbindsOnPointerDown(wired, other)).toBe(true);
  });

  it("a press on the shell background still unbinds", () => {
    const bg = inside('<div class="shell"><div class="bg"></div></div>', ".bg");
    expect(unbindsOnPointerDown(wired, bg)).toBe(true);
  });
});

describe("Escape is shared, not claimed — roborev 54697", () => {
  const wired: CableState = { wired: "right", overlay: "off" };

  it("unbinds when nothing else is claiming the press", () => {
    expect(unbindsOnKey(wired, "Escape")).toBe(true);
  });

  it("does NOT unbind while a dismissible surface is open", () => {
    // One Escape aimed at a modal used to produce TWO state changes, and the one the user did not
    // ask for was invisible until the layout reflowed.
    expect(unbindsOnKey(wired, "Escape", { dismissibleOpen: true })).toBe(false);
  });

  it("is still inert when nothing is patched", () => {
    expect(unbindsOnKey({ wired: "off", overlay: "off" }, "Escape")).toBe(false);
  });
});

describe("portalled surfaces are still the circuit — roborev 54821", () => {
  const wired: CableState = { wired: "right", overlay: "off" };

  it("a press in a surface portalled to document.body does not unbind", () => {
    // The hover card and the model menu (plus its full-screen backdrop) are `createPortal`ed to
    // document.body: React children of the row, DOM siblings of the whole app. Ancestry alone put
    // them outside every branch of CIRCUIT_SELECTOR, so hovering the agent you had just patched
    // into and clicking its own popover dropped the cable — the same defect, relocated.
    const host = document.createElement("div");
    host.innerHTML = '<div data-circuit><button data-testid="in-card">Open</button></div>';
    document.body.appendChild(host);
    const btn = host.querySelector('[data-testid="in-card"]')!;
    expect(unbindsOnPointerDown(wired, btn)).toBe(false);
    host.remove();
  });

  it("an unmarked body-level element still unbinds", () => {
    // The opt-in must be explicit, or "portalled" would become a blanket exemption and any
    // stray overlay would silently hold the cable open.
    const host = document.createElement("div");
    host.innerHTML = '<div><button data-testid="stray">x</button></div>';
    document.body.appendChild(host);
    const btn = host.querySelector('[data-testid="stray"]')!;
    expect(unbindsOnPointerDown(wired, btn)).toBe(true);
    host.remove();
  });
});
