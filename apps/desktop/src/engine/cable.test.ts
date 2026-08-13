// @vitest-environment jsdom
//
// The cable state machine. These pin the four rules the founder stated for the cockpit, at the one
// place they are decided — so a component can never re-decide them differently.
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_ROW_SELECTOR,
  CABLE_REST,
  isBuildAgentRow,
  clearsSelectionOnKey,
  DISMISSIBLE_SELECTOR,
  dismissibleSurfaceOpen,
  releaseStillArmed,
  RELEASE_ARM_WINDOW_MS,
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
    expect(patchCable(CABLE_REST, "left", null)).toEqual({ wired: "left", overlay: "off", agentId: null });
    expect(patchCable(CABLE_REST, "right", null)).toEqual({ wired: "right", overlay: "off", agentId: null });
  });

  it("moves the cable rather than lighting both sides — ONE live circuit", () => {
    const left = patchCable(CABLE_REST, "left", null);
    expect(patchCable(left, "right", null).wired).toBe("right");
  });

  // "Receding" is the far pair's state, and it is NOT greying out: the pair still renders and its
  // last-active row is still selected. The machine only ever says which side is live; nothing here
  // may grow a notion of a disabled pair.
  it("marks exactly one pair live and the other merely not-live", () => {
    const s = patchCable(CABLE_REST, "left", null);
    expect(pairIsLive(s, "left")).toBe(true);
    expect(pairIsLive(s, "right")).toBe(false);
    expect(pairIsLive(CABLE_REST, "left")).toBe(false);
    expect(pairIsLive(CABLE_REST, "right")).toBe(false);
  });

  // WIRING DOCKS THE OVERLAY. A floating concierge sits on top of the very row it claims to be
  // wired to, so the two states cannot both be true.
  it("docks a floating concierge when the cable is patched", () => {
    const floating: CableState = { wired: "off", overlay: "assist", agentId: null };
    expect(patchCable(floating, "right", null)).toEqual({ wired: "right", overlay: "off", agentId: null });
  });

  it("docks a floating build column too — nothing floats over a live circuit", () => {
    const floating: CableState = { wired: "off", overlay: "build", agentId: null };
    expect(patchCable(floating, "left", null).overlay).toBe("off");
  });

  it("is referentially stable when it changes nothing", () => {
    const s: CableState = { wired: "left", overlay: "off", agentId: null };
    expect(patchCable(s, "left", null)).toBe(s);
  });
});

describe("unbinding", () => {
  it("returns the concierge to floating middle", () => {
    expect(unbindCable({ wired: "right", overlay: "off", agentId: null }).wired).toBe("off");
    expect(unbindCable({ wired: "left", overlay: "off", agentId: null }).wired).toBe("off");
  });

  it("leaves an unwired state untouched, by identity", () => {
    expect(unbindCable(CABLE_REST)).toBe(CABLE_REST);
  });

  it("says nothing about floating surfaces — unbind is about the cable only", () => {
    expect(unbindCable({ wired: "left", overlay: "build", agentId: "a1" })).toEqual({
      wired: "off",
      overlay: "build",
      // …but it DOES say something about the far end: the pin goes with the cable. A remembered
      // agent behind an unwired concierge is a target nothing on screen claims.
      agentId: null,
    });
  });
});

describe("overlay ⇄ cable", () => {
  it("floating the concierge unbinds — it would sit on the row it claims to be wired to", () => {
    expect(setOverlay({ wired: "right", overlay: "off", agentId: "a1" }, "assist")).toEqual({
      wired: "off",
      overlay: "assist",
      // The SECOND path to `wired: "off"`, and it clears the pin by the same rule as `unbindCable`.
      // One path clearing and the other not is exactly how an unclaimable far end comes to exist.
      agentId: null,
    });
  });

  it("floating the build column over its own terminal does not touch the cable", () => {
    expect(setOverlay({ wired: "right", overlay: "off", agentId: "a1" }, "build")).toEqual({
      wired: "right",
      overlay: "build",
      // "Does not touch the cable" now includes its far end — floating a build column happens
      // INSIDE a pair and says nothing about who the concierge is talking to.
      agentId: "a1",
    });
  });

  it("docking changes nothing about the cable", () => {
    expect(setOverlay({ wired: "left", overlay: "build", agentId: "a1" }, "off")).toEqual({
      wired: "left",
      overlay: "off",
      agentId: "a1",
    });
  });
});

// ── THE TWO GESTURES, WHICH ARE ONE STATE CHANGE ──────────────────────────────────────────────
describe("gestures", () => {
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

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

// ══ THE LATCH EXPIRES, BECAUSE THE EVENT-BASED CLEARS ARE NOT EXHAUSTIVE (roborev 55491) ═════════
//
// The consumer clears the latch on a pointer press, on a non-Escape keydown and on blur — none of
// which fire while the user types into a focused terminal, because xterm's own handler ends in
// `CoreBrowserTerminal.cancel()` and that calls `preventDefault()` AND `stopPropagation()` for every
// key it turns into a PTY sequence. So a latch armed before an hour of keyboard-only work was still
// armed after it, and the first Escape to arrive once focus fell outside the terminal blanked the
// column — the same "arbitrarily far away, in a different context" defect, one surface along.
//
// A wall clock is the fix precisely BECAUSE it is not another event: no component can cancel it.
describe("releaseStillArmed", () => {
  it("is not armed when it was never armed", () => {
    expect(releaseStillArmed(null, 1_000)).toBe(false);
  });

  it("stays armed across the deliberate double press", () => {
    expect(releaseStillArmed(1_000, 1_000)).toBe(true);
    expect(releaseStillArmed(1_000, 1_000 + RELEASE_ARM_WINDOW_MS)).toBe(true);
  });

  it("expires one millisecond past the window", () => {
    expect(releaseStillArmed(1_000, 1_000 + RELEASE_ARM_WINDOW_MS + 1)).toBe(false);
  });

  // A latch stamped in the FUTURE means the clock moved backwards under us (NTP correction, a laptop
  // waking with a corrected clock). The fail-closed reading is to decline the destructive rung — an
  // unbounded `elapsed <= WINDOW` test would treat a far-future stamp as freshly armed forever.
  it("declines a latch from the future rather than trusting it", () => {
    expect(releaseStillArmed(10_000, 1_000)).toBe(false);
  });
});

// ESCAPE IS A TWO-STEP RELEASE: first press unwires the concierge, second clears the active build
// row. These are the rungs as pure predicates; Workspace.cockpit.test.tsx drives the real key
// events through the listener and asserts the store writes that follow.
describe("Escape — the progressive release", () => {
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

  const armed = { releaseArmed: true };

  it("does NOT clear the selection on the press that is still unwiring", () => {
    // The whole point of two steps. If this were true while wired, ONE press would both unwire the
    // concierge AND empty the terminal column — the user would never see the intermediate state
    // they asked for, and the second press would have nothing left to do.
    expect(clearsSelectionOnKey(wired, "Escape", armed)).toBe(false);
  });

  it("clears the selection on an Escape that follows the one which unwired", () => {
    expect(clearsSelectionOnKey(CABLE_REST, "Escape", armed)).toBe(true);
  });

  // ══ THE REGRESSION THIS PREDICATE WAS REWRITTEN FOR (roborev 55373) ═══════════════════════════
  // The first version was the exact complement of `unbindsOnKey` — fire whenever `wired === "off"`.
  // That reads as elegant and is a serious bug: `wired === "off"` IS `CABLE_REST`, the app's
  // DEFAULT. It does not mean "you already pressed Escape once", it means "no cable was ever
  // patched". So every Escape anywhere in the app blanked the terminal column — including the most
  // common key in an agent terminal (vim, `less`, interrupting Claude Code), which `Terminal.tsx`
  // lets bubble straight to the window listener.
  //
  // Asserted against `CABLE_REST` BY NAME, not against a hand-built `{wired:"off"}`, so the test
  // says out loud that the unarmed case is the resting state of the whole app.
  it("is INERT at rest — an unarmed Escape must never clear the row", () => {
    expect(clearsSelectionOnKey(CABLE_REST, "Escape")).toBe(false);
    expect(clearsSelectionOnKey(CABLE_REST, "Escape", { releaseArmed: false })).toBe(false);
  });

  // The two rungs are deliberately NOT exhaustive, which is the opposite of what the first version
  // claimed. An Escape claimed by NEITHER rung is the common case: it is what every Escape did
  // before this feature existed, and what an Escape in a terminal must keep doing.
  it("lets an ordinary Escape through untouched, claimed by neither rung", () => {
    for (const state of [CABLE_REST, { wired: "off", overlay: "assist", agentId: null }] as CableState[]) {
      expect(unbindsOnKey(state, "Escape")).toBe(false);
      expect(clearsSelectionOnKey(state, "Escape")).toBe(false);
    }
  });

  // What DOES still hold: at most one rung per press, so a single Escape can never produce two
  // releases. Checked armed AND unarmed, across every reachable cable state.
  it("never lets both rungs claim the same press", () => {
    for (const state of [
      CABLE_REST,
      { wired: "left", overlay: "off", agentId: null },
      { wired: "right", overlay: "off", agentId: null },
      { wired: "off", overlay: "assist", agentId: null },
      { wired: "left", overlay: "build", agentId: null },
    ] as CableState[]) {
      for (const releaseArmed of [true, false]) {
        const claims = [
          unbindsOnKey(state, "Escape"),
          clearsSelectionOnKey(state, "Escape", { releaseArmed }),
        ].filter(Boolean).length;
        expect(claims).toBeLessThanOrEqual(1);
      }
    }
  });

  // Arming can never RESURRECT rung 2 while a cable is patched — rung 1 owns that press, and a
  // stale latch (armed, then re-patched without a pointer press to clear it) must not double-fire.
  it("stays inert while wired, however it was armed", () => {
    expect(clearsSelectionOnKey(wired, "Escape", armed)).toBe(false);
    expect(clearsSelectionOnKey({ wired: "left", overlay: "build", agentId: null }, "Escape", armed)).toBe(false);
  });

  // Same hazard as roborev 54697, one rung further along — and worse here. A press aimed at a modal
  // that ALSO empties the terminal column behind it is a change the user did not ask for and cannot
  // watch happen, because the dialog is covering the thing that changed.
  it("leaves the row alone when a dismissible surface owns the press", () => {
    expect(
      clearsSelectionOnKey(CABLE_REST, "Escape", { releaseArmed: true, dismissibleOpen: true }),
    ).toBe(false);
    // …and then neither rung fires, which is the correct total for a press that belongs to a modal.
    expect(unbindsOnKey(wired, "Escape", { dismissibleOpen: true })).toBe(false);
  });

  it("no other key clears the row", () => {
    for (const k of ["Enter", "Tab", " ", "esc", "Esc", "a", "Backspace", "Delete"]) {
      expect(clearsSelectionOnKey(CABLE_REST, k, armed)).toBe(false);
    }
  });
});

// ══ AN ESCAPE TYPED INTO A PTY BELONGS TO THE PROCESS, NOT TO THE CABLE ═════════════════════════
//
// The block above already states the requirement in as many words — "what an Escape in a terminal
// must keep doing" — but only rung 2 was actually guarded, by the `releaseArmed` latch. Rung 1 had
// no terminal term at all, and `dismissibleOpen` cannot stand in for one: it probes for
// `[role="dialog"], [role="menu"], [data-dismissible-open]`, and a terminal pane is none of those.
//
// So with a cable patched, ONE Escape both signalled the process and unbound the cable — the roborev
// 54697 defect (two state changes for one press, the unasked-for one invisible until the layout
// reflowed) still live for terminals. It matters more now that clicking a terminal PATCHES the cable,
// because then the wired state is the normal state while typing in a terminal, and Escape is the
// single most common key there: leaving insert mode in vim, dismissing `less`, interrupting Claude
// Code.
// ══ RUNG 2 IS UNREACHABLE FROM A TERMINAL THE USER CHOSE ════════════════════════════════════════
//
// Rung 1 carries NO terminal term, deliberately. Whether an Escape belongs to the process is decided
// before these predicates run, by `engine/terminalEscape`, because it needs three facts the cable has
// no business knowing (in a terminal / did the user put the caret there / has the one-press toll been
// paid). A bare "is the caret in a terminal" term was tried here and was wrong in the worst
// direction: the caret is in a terminal by DEFAULT, so it made Escape-to-unbind unreachable in the
// normal state rather than an edge case.
//
// Rung 2 does carry one, and the asymmetry is the point. "Escape twice unmounts" needs rung 1 to be
// reachable inside a terminal; nothing needs rung 2 to be, and three Escapes inside five seconds is a
// real gesture for a vim user. Blanking the terminal column of the agent being typed in is roborev
// 55373's destructive outcome, so no press count reaches it from a terminal the user chose.
// ONE PROBE, ASKED BY BOTH ESCAPE PATHS. `unbindsOnKey` is only as shared as the selector feeding it, so
// a copy-pasted probe would let a new Escape-owning surface be registered in one path and not the other —
// silently re-creating the divergence that routing both through one predicate was meant to end.
describe("dismissibleSurfaceOpen", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sees each surface that owns Escape", () => {
    for (const html of [
      `<div role="dialog"></div>`,
      `<div role="menu"></div>`,
      `<div data-dismissible-open="true"></div>`,
    ]) {
      document.body.innerHTML = html;
      expect(dismissibleSurfaceOpen(document)).toBe(true);
    }
  });

  it("is false at rest, and for a surface that merely LOOKS dismissible", () => {
    document.body.innerHTML = `<div role="tooltip"></div><div data-dismissible-open="false"></div>`;
    expect(dismissibleSurfaceOpen(document)).toBe(false);
  });

  // The selector is the contract between the two paths. Pinned literally so a change here is a
  // deliberate edit to a shared rule rather than a drive-by tweak in one consumer.
  it("is the single selector both paths share", () => {
    expect(DISMISSIBLE_SELECTOR).toBe(
      '[role="dialog"], [role="menu"], [data-dismissible-open="true"]',
    );
  });
});

// ── THE PROBE MUST COUNT ONLY SURFACES THAT ARE ACTUALLY ON SCREEN (bead sparkle-thm9o) ─────────
//
// The founder's app wedged with "I could not unmount the concierge". The probe used to be a bare
// `querySelector`, so ONE node anywhere in the document carrying `role="dialog"`/`role="menu"`/
// `data-dismissible-open="true"` — hidden, `inert`, `aria-hidden`, or simply left behind by a
// surface that had already closed — made `dismissibleOpen` permanently true. Both Escape paths read
// that one value, so ESC-to-unmount died APP-WIDE, silently, while ConciergeColumn kept drawing the
// "ESC to unmount" hint. Related: bead sparkle-gielc, agents parked in `status:"approval"` with no
// dialog visible in the pane, which is exactly the leaked-node shape.
//
// EVERY CASE BELOW IS ATTRIBUTE- OR INLINE-STYLE-DERIVED, on purpose. jsdom has no layout engine
// (docs/jsdom-test-caveats.md): `getBoundingClientRect` is always 0, `offsetParent` is always null,
// and jsdom 25 does not implement `checkVisibility` at all — so a guard asserted through a
// measurement would be asserted through a MOCK, which proves nothing. These are the signals jsdom
// genuinely evaluates, and they are the ones the fix is built on.
//
// THE DIRECTION OF SAFETY. Over-reporting "open" kills Escape everywhere and is unrecoverable
// without a relaunch; under-reporting means one Escape both closes a dialog and unbinds the cable,
// which is recoverable by clicking. So the probe is deliberately conservative about calling a node
// open — but the last case here pins that a REAL dialog still protects Escape, or the fix would
// have traded one silent breakage for another.
describe("dismissibleSurfaceOpen only counts surfaces that are genuinely rendered", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // SELF-HIDDEN. Each of these is a node the DOM itself says is not being shown.
  //
  // `hidden` and `<dialog>`-without-`open` are BEHAVIOUR, not a branch: both are answered by the UA
  // stylesheet through `getComputedStyle`, not by an attribute read — see `elementIsHiddenHere`,
  // where an explicit `hidden` check was removed precisely because deleting it left this suite
  // green. They stay pinned here because the CONTRACT is "these do not own Escape", regardless of
  // which mechanism delivers it.
  it.each([
    ["the hidden attribute", `<div role="dialog" hidden></div>`],
    ["inline display:none", `<div role="menu" style="display: none"></div>`],
    ["inline visibility:hidden", `<div role="dialog" style="visibility: hidden"></div>`],
    ["aria-hidden", `<div data-dismissible-open="true" aria-hidden="true"></div>`],
    ["inert", `<div role="dialog" inert></div>`],
    // The UA stylesheet's `dialog:not([open]) { display: none }` — jsdom implements it, so a
    // <dialog> that was never shown (or was closed and left in the tree) reads as not rendered.
    ["a <dialog> that is not open", `<dialog role="dialog"></dialog>`],
  ])("ignores a leaked surface hidden by %s", (_why, html) => {
    document.body.innerHTML = html;
    expect(dismissibleSurfaceOpen(document)).toBe(false);
  });

  // ANCESTORS — the case a computed-style read CANNOT answer. jsdom does not propagate a parent's
  // `display:none`/`hidden` down to a child's computed style (probed: the child still reads
  // `display: block`), and neither `aria-hidden` nor `inert` is a style at all in any engine. A
  // dismissible left inside a collapsed panel is the realistic leak shape, so the probe walks the
  // ancestor chain rather than reading the matched node alone.
  it.each([
    ["a hidden ancestor", `<div hidden><div role="dialog"></div></div>`],
    ["a display:none ancestor", `<section style="display: none"><div role="menu"></div></section>`],
    ["an aria-hidden ancestor", `<div aria-hidden="true"><div role="dialog"></div></div>`],
    ["an inert ancestor", `<div inert><div data-dismissible-open="true"></div></div>`],
  ])("ignores a surface buried under %s", (_why, html) => {
    document.body.innerHTML = html;
    expect(dismissibleSurfaceOpen(document)).toBe(false);
  });

  // ONE LEAKED NODE MUST NOT MASK A LIVE ONE. The probe answers "is ANY of them open", so a hidden
  // leak sitting beside a real dialog has to leave the real dialog's answer alone.
  it("still sees a live surface standing next to a leaked one", () => {
    document.body.innerHTML = `<div role="dialog" hidden></div><div role="menu"></div>`;
    expect(dismissibleSurfaceOpen(document)).toBe(true);
  });

  // THE REGRESSION GUARD. An <dialog open> and a plain rendered div must both still own Escape —
  // a probe that answered `false` for everything would "fix" the wedge by breaking every modal.
  it("still sees a surface that is genuinely on screen", () => {
    document.body.innerHTML = `<dialog role="dialog" open></dialog>`;
    expect(dismissibleSurfaceOpen(document)).toBe(true);
    document.body.innerHTML = `<div hidden></div><div role="dialog"></div>`;
    expect(dismissibleSurfaceOpen(document)).toBe(true);
  });
});

describe("Escape in a terminal — rung 2 stays out of reach", () => {
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

  it("does not clear the build row when the user deliberately entered the terminal", () => {
    expect(
      clearsSelectionOnKey(CABLE_REST, "Escape", { releaseArmed: true, terminalOwnsEscape: true }),
    ).toBe(false);
  });

  it("stays out of reach at any press count and in every cable state", () => {
    for (const state of [
      CABLE_REST,
      { wired: "left", overlay: "off", agentId: null },
      { wired: "right", overlay: "off", agentId: null },
      { wired: "off", overlay: "assist", agentId: null },
      { wired: "left", overlay: "build", agentId: null },
    ] as CableState[]) {
      for (const releaseArmed of [true, false]) {
        expect(
          clearsSelectionOnKey(state, "Escape", { releaseArmed, terminalOwnsEscape: true }),
        ).toBe(false);
      }
    }
  });

  // RUNG 1 IS NOT GUARDED HERE, and that is load-bearing rather than an omission: it is what lets the
  // second Escape inside a terminal unmount, and what keeps the FIRST one unbinding when the app —
  // not the user — parked the caret there.
  it("leaves rung 1 alone — the terminal decision happens before it", () => {
    expect(unbindsOnKey(wired, "Escape")).toBe(true);
    expect(unbindsOnKey(wired, "Escape", { dismissibleOpen: false })).toBe(true);
  });

  // …and the guard is NARROW. Outside a chosen terminal, rung 2 works exactly as it did, so this
  // cannot be mistaken for "Escape stopped clearing the row".
  it("still clears the row when the terminal does not own the press", () => {
    expect(
      clearsSelectionOnKey(CABLE_REST, "Escape", { releaseArmed: true, terminalOwnsEscape: false }),
    ).toBe(true);
  });

  // Omitting the option must read as "the terminal does not own it", or every existing caller
  // silently changes behavior. Pinned so the default cannot be flipped to the safe-sounding-but-wrong
  // direction.
  it("defaults to not-owned-by-a-terminal when the option is omitted", () => {
    expect(clearsSelectionOnKey(CABLE_REST, "Escape", { releaseArmed: true })).toBe(true);
  });
});

describe("the circuit, not the row — roborev 54697", () => {
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

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
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

  it("unbinds when nothing else is claiming the press", () => {
    expect(unbindsOnKey(wired, "Escape")).toBe(true);
  });

  it("does NOT unbind while a dismissible surface is open", () => {
    // One Escape aimed at a modal used to produce TWO state changes, and the one the user did not
    // ask for was invisible until the layout reflowed.
    expect(unbindsOnKey(wired, "Escape", { dismissibleOpen: true })).toBe(false);
  });

  it("is still inert when nothing is patched", () => {
    expect(unbindsOnKey({ wired: "off", overlay: "off", agentId: null }, "Escape")).toBe(false);
  });
});

describe("portalled surfaces are still the circuit — roborev 54821", () => {
  const wired: CableState = { wired: "right", overlay: "off", agentId: null };

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
