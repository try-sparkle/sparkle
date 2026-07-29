// THE CABLE — the cockpit's one connection state, as a pure state machine.
//
// The layout the founder approved (PRD/sparkle/ui-directions/rev4.html) is an F1 cockpit:
//
//     TERM │ BUILD │ CONCIERGE │ BUILD │ TERM
//
// Build is ALWAYS adjacent to the concierge; the terminals sit at the outer edges. A PAIR is a
// build column plus its terminal and is never split — they are one project, which is why the
// project tabs belong to the pair and never sit above the concierge.
//
// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
// MAPPING.md is explicit: *"`data-wired` is the whole connection feature. One value, and every
// visual consequence follows from CSS — the receding pair, the row bleed, the flood, the trace.
// Do not implement it as scattered component state."*
//
// So the feature is ONE enum living in ONE store, projected onto the shell root as a `data-`
// attribute. Every visual consequence (the concierge taking the terminal's material, the seam
// vanishing at the wired boundary, the far pair receding) is a CSS rule keyed off that attribute
// in `index.css`. Nothing reads a second copy of this, and nothing derives "am I wired" from a
// component's local state. This module is the machine; the store is a thin holder for it.
//
// ── THE UNBIND GESTURES ───────────────────────────────────────────────────────────────────────
// Founder, this session: pressing ESCAPE unbinds from the left/right build agent and returns the
// concierge to floating middle; clicking anywhere that is NOT a build agent row does the same.
// Both are the SAME single state change — `wired → "off"` — which is why they are one function
// here and not two code paths that can drift apart.

/** Which side holds the live cable. `off` = the concierge floats free in the middle. */
export type WiredSide = "off" | "left" | "right";

/** Which side of the concierge a pair sits on. Drives the mirror (terminal outboard). */
export type PairSide = "left" | "right";

/** How many pairs flank the concierge. */
export type PairCount = 1 | 2;

/** What, if anything, is floating over its neighbour. `assist` = the concierge is overlaid. */
export type OverlaySurface = "off" | "assist" | "build";

export interface CableState {
  readonly wired: WiredSide;
  readonly overlay: OverlaySurface;
}

/** Unplugged and docked — the concierge floating in the middle, lifted, nothing patched. */
export const CABLE_REST: CableState = { wired: "off", overlay: "off" };

/**
 * Patch the cable into `side`.
 *
 * WIRING DOCKS THE OVERLAY. A floating concierge sits on top of the very row it claims to be
 * wired to, so those two states cannot both be true — plugging in ends the overlay. (Founder call,
 * 2026-07-29; the mock's rail does the same thing in `rev4.html`'s `wire()`.) Docking here rather
 * than at the render site is what makes the invariant unfakeable: there is no ordering of calls
 * that leaves the app both wired and overlaid.
 */
export function patchCable(state: CableState, side: PairSide): CableState {
  if (state.wired === side && state.overlay === "off") return state;
  return { wired: side, overlay: "off" };
}

/**
 * Unbind — back to floating middle. The ONE state change both gestures produce.
 *
 * Returns the same object when already unwired so a no-op gesture (a click on empty chrome while
 * nothing is patched) cannot cause a re-render, and so the store's `set` is genuinely idempotent.
 * The overlay is deliberately untouched: unbinding says "you are not plugged into that agent", not
 * "put every floating surface back".
 */
export function unbindCable(state: CableState): CableState {
  if (state.wired === "off") return state;
  return { ...state, wired: "off" };
}

/**
 * Float or dock a surface.
 *
 * Floating the CONCIERGE is the mirror image of `patchCable`: it re-creates the very conflict
 * wiring resolves (the concierge over the row it claims to be wired to), so it unbinds. Floating
 * the BUILD column over its own terminal is not that conflict — it happens entirely inside a pair,
 * on the far side of the row from the concierge — so it leaves the cable alone.
 */
export function setOverlay(state: CableState, overlay: OverlaySurface): CableState {
  if (state.overlay === overlay && !(overlay === "assist" && state.wired !== "off")) return state;
  return { wired: overlay === "assist" ? "off" : state.wired, overlay };
}

// ── THE CLICK-AWAY TEST ───────────────────────────────────────────────────────────────────────
//
// "Anywhere that is NOT a build agent row" needs a way to recognise a build agent row from outside
// AgentSidebar. It is matched STRUCTURALLY, against the accessibility tree the sidebar already
// publishes — `role="treeitem"` inside the `[data-agent-tree]` container — rather than against a
// marker attribute added for this feature. Two reasons: the sidebar is another agent's file this
// session, and a role the screen reader depends on is far less likely to be renamed on a whim than
// a private data-attribute nobody else reads.
export const BUILD_ROW_SELECTOR = '[data-agent-tree] [role="treeitem"]';

/** Is this event target inside a build agent row? */
export function isBuildAgentRow(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(BUILD_ROW_SELECTOR) != null;
}

/** Everything that is PART OF the live circuit, and therefore cannot be a press that leaves it. */
export const CIRCUIT_SELECTOR = [
  BUILD_ROW_SELECTOR, // the rows — this is how you patch, not how you unbind
  "[data-concierge-root]", // Sparkle itself: the whole point of being wired is to talk to it
  '[data-pair][data-wired-pair="true"]', // the patched pair's own build column and terminal
  // PORTALLED SURFACES. The three above are found by DOM ANCESTRY (`closest`), and the surfaces
  // you reach for most on the agent you just patched into are rendered with `createPortal` to
  // `document.body` — the agent hover card, and the model menu together with its full-screen
  // backdrop. They are React children of the row and DOM siblings of the whole app, so ancestry
  // puts them OUTSIDE every branch above and hovering the wired row then clicking its own popover
  // dropped the cable. That is the same defect this predicate was written to fix, relocated from
  // the compose box to the row's own menus (roborev 54821). Portal roots opt in explicitly.
  "[data-circuit]",
].join(", ");

/** Is this event target inside the live circuit? */
export function isInsideCircuit(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CIRCUIT_SELECTOR) != null;
}

/**
 * Should this pointer press unbind the cable?
 *
 * "OUTSIDE THE LIVE CIRCUIT", NOT "OUTSIDE A ROW". The first cut was `!isBuildAgentRow(target)`,
 * which made the wired state unreachable in practice: the primary flow is to patch into an agent
 * and then TYPE to it, and every press in that flow — the compose box, Send, scrolling the thread,
 * the connection badge, the wired pair's own terminal — is "not a build agent row" and dropped the
 * cable on the first click. The consumer listens on `window` in the CAPTURE phase, so no component
 * could opt out by stopping propagation either. (roborev 54697.)
 *
 * The circuit is the row you patched, Sparkle, and the pair holding the cable. A press anywhere
 * else — the far pair, the tab strip, the shell background — means you have left, and unbinds.
 */
export function unbindsOnPointerDown(state: CableState, target: EventTarget | null): boolean {
  return state.wired !== "off" && !isInsideCircuit(target);
}

/**
 * Should this key unbind the cable?
 *
 * ESCAPE, only while wired, AND only when nothing else is claiming the press.
 *
 * The `wired !== "off"` gate alone was not enough, and the comment that said it was overclaimed:
 * fifteen other components own Escape (ModalShell, CommandPalette, KebabMenu, SelectionPopup,
 * HintOverlay, the sidebar's rename input, Composer…), and the consumer listens on `window`. With
 * a cable patched, one Escape meant to dismiss a modal ALSO unbound the cable — two state changes
 * for one press, and the unasked-for one invisible until the layout reflowed. (roborev 54697.)
 *
 * `dismissibleOpen` is that missing input: whether any surface that treats Escape as "close me" is
 * currently open. When one is, Escape belongs to it and the cable stays patched.
 */
export function unbindsOnKey(
  state: CableState,
  key: string,
  { dismissibleOpen = false }: { dismissibleOpen?: boolean } = {},
): boolean {
  return key === "Escape" && state.wired !== "off" && !dismissibleOpen;
}

/**
 * Does `pair` hold the live circuit?
 *
 * ONE LIVE CIRCUIT: with pairs on both sides, patching left makes the right pair recede. Receding
 * is NOT greying out — the far pair is still rendering, its last-active row still selected. It
 * simply isn't plugged into you, which is a statement about connection, not about liveness. The
 * CSS that consumes this must never reach for `opacity`/`filter` on the far pair.
 */
export function pairIsLive(state: CableState, pair: PairSide): boolean {
  return state.wired === pair;
}
