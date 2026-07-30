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

/** Every surface that treats Escape as "close me", as the DOM identifies itself to assistive tech.
 *
 *  ONE STRING, because `unbindsOnKey` is only as shared as the selector feeding it. Both Escape paths —
 *  `Workspace`'s window listener and `Terminal`'s xterm key handler — ask this question, and having the
 *  probe copy-pasted into each meant adding an Escape-owning surface (or renaming the marker attribute)
 *  in one place and not the other would silently re-create the divergence that routing both through one
 *  predicate was meant to end. It lives here beside `BUILD_ROW_SELECTOR`/`CIRCUIT_SELECTOR` for the same
 *  reason those do. */
export const DISMISSIBLE_SELECTOR =
  '[role="dialog"], [role="menu"], [data-dismissible-open="true"]';

/** Is a surface that owns Escape currently open? The `dismissibleOpen` input, read from the live DOM.
 *
 *  `doc` IS REQUIRED, with no default and no optional chain. Both call sites pass a live `document`, so a
 *  document-less host is not a reachable state — and the version that guarded against it came with a test
 *  named "tolerates a document-less host" that proved nothing: an explicitly passed `undefined` triggers
 *  the default parameter, so the assertion was reading jsdom's real document and passing only because the
 *  preceding cleanup had emptied `body`. Deleting the `?.` left it green. An unfalsifiable guard plus the
 *  test that appears to cover it is worse than neither, so both are gone. */
export function dismissibleSurfaceOpen(doc: Document): boolean {
  return doc.querySelector(DISMISSIBLE_SELECTOR) != null;
}

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
 *
 * TERMINALS ARE ARBITRATED BEFORE THIS PREDICATE, NOT INSIDE IT. An Escape typed into a PTY belongs
 * to the process (leaving insert mode in vim, interrupting Claude Code), and a terminal is not one of
 * the `[role="dialog"], [role="menu"]` surfaces `dismissibleOpen` can see — so it needs its own
 * decision. That decision lives in `engine/terminalEscape`, because it takes THREE facts this
 * predicate has no business knowing: whether the caret is in a terminal, whether the USER put it
 * there or the pane's auto-focus did, and whether the one-press toll has been paid. The consumer
 * returns early on a press the terminal owns, so by the time this runs the press is the cable's.
 *
 * Do NOT add a bare "is the caret in a terminal" term here. That was tried, and it was wrong in the
 * worst direction: the caret is in a terminal by DEFAULT (see `terminalEscape`'s header), so it made
 * Escape-to-unbind unreachable in the normal state rather than in an edge case.
 */
export function unbindsOnKey(
  state: CableState,
  key: string,
  { dismissibleOpen = false }: { dismissibleOpen?: boolean } = {},
): boolean {
  return key === "Escape" && state.wired !== "off" && !dismissibleOpen;
}

/** How long an armed release stays armed. See {@link releaseStillArmed}.
 *
 *  Sized to a DELIBERATE double press — long enough to press Escape, look at the screen, and press
 *  again, short enough that it cannot outlive the gesture and surprise someone later. It is a
 *  ceiling on how wrong a stale latch can be, not a target anyone should aim at. */
export const RELEASE_ARM_WINDOW_MS = 5_000;

/**
 * Is a release armed at `armedAt` still live at `now`?
 *
 * `null` means never armed. A NEGATIVE delta also reads as not-armed: `Date.now()` can go backwards
 * (NTP correction, the laptop waking with a corrected clock), and the fail-closed reading of "this
 * latch is from the future" is to decline the destructive rung rather than to trust it.
 */
export function releaseStillArmed(armedAt: number | null, now: number): boolean {
  if (armedAt === null) return false;
  const elapsed = now - armedAt;
  return elapsed >= 0 && elapsed <= RELEASE_ARM_WINDOW_MS;
}

/**
 * Should this key clear the ACTIVE BUILD ROW — the second step of the progressive release?
 *
 * ESCAPE IS A TWO-STEP RELEASE, and the founder's ask names both steps precisely: *"pressing Escape
 * once detaches the concierge from the build row"* — that is {@link unbindsOnKey} — and *"pressing
 * Escape AGAIN detaches the ACTIVE BUILD ROW itself. After the second Escape there is no active
 * build row at all, and the terminal column shows nothing."*
 *
 * ══ `releaseArmed` IS THE WHOLE SAFETY OF THIS, AND IT IS NOT OPTIONAL ══════════════════════════
 * The first cut was the exact complement of `unbindsOnKey` — fire whenever `wired === "off"` — on
 * the reasoning that "not attached" means "the next thing to release is the row". That reasoning is
 * WRONG, and roborev 55373 caught it: `wired === "off"` is `CABLE_REST`, the app's **default**. It
 * does not mean "you already pressed Escape once", it means "no cable has ever been patched". So
 * that version made EVERY Escape pressed anywhere in the app, at any time, blank the terminal
 * column — and Escape is the single most common key in an agent terminal (vim, `less`, interrupting
 * Claude Code). `Terminal.tsx`'s `attachCustomKeyEventHandler` only claims the composer chord and
 * ⌘C, so an Escape typed into a PTY bubbles straight to the `window` listener: the user would have
 * deselected the very agent whose terminal they were typing in, and watched it vanish.
 *
 * The fix is to require POSITIVE EVIDENCE that a release sequence is under way, rather than
 * inferring it from the absence of a cable. `releaseArmed` is that evidence, and the consumer sets
 * it only when {@link unbindsOnKey} has actually fired — so rung 2 is reachable ONLY by pressing
 * Escape a second time, and is strictly NARROWER than rung 1. That is the safe direction: rung 1's
 * exposure is behavior the founder has already confirmed is right, and rung 2 must not exceed it.
 *
 * This is also why the two predicates are deliberately NOT exhaustive. An Escape that claims neither
 * rung is the common case — it is what every Escape did before this feature existed, and it is what
 * an Escape in a terminal must keep doing.
 *
 * A COUNTER IS STILL THE WRONG SHAPE, for the original reason: unbinding by CLICKING away
 * (`unbindsOnPointerDown`) is not a keypress, so a count would drift from the cable's real state.
 * `releaseArmed` is not a count — it is a latch, and the consumer clears it on rung 2 firing, on any
 * pointer press, on any keydown that is not Escape *and that reaches `window`*, and when focus leaves
 * the window. It does NOT clear on re-patch (this comment used to imply otherwise — roborev 55478);
 * the `wired === "off"` term below is what makes a latch left standing across a patch harmless, so
 * that term is load-bearing rather than merely a tidy complement of `unbindsOnKey`.
 *
 * ══ THE LATCH ALSO EXPIRES, BECAUSE THE KEYDOWN LIST ABOVE IS NOT ACTUALLY EXHAUSTIVE ════════════
 * "Any keydown that is not Escape" sounds total and is not: xterm's own handler ends in
 * `CoreBrowserTerminal.cancel()`, which calls `preventDefault()` AND `stopPropagation()` for every
 * key it turns into a PTY sequence — all ordinary typing, arrows, Enter. Those presses never reach
 * the `window` listener, so a latch armed before an hour of keyboard-only work in a focused terminal
 * was still armed at the end of it, and the first Escape to arrive once focus fell back outside the
 * terminal fired rung 2 (roborev 55491). That is the same "arbitrarily far away, in a different
 * context" defect the latch was supposed to close, one surface along.
 *
 * {@link releaseStillArmed} is the answer, and the reason it is a WALL-CLOCK expiry rather than
 * another event to listen for: it holds no matter which surface swallowed the intervening keys, so it
 * cannot be defeated by the next component that decides to cancel its own keydowns.
 *
 * `dismissibleOpen` is honored for the SAME reason it is honored above: fifteen components treat
 * Escape as "close me" and the consumer listens on `window`, so a press aimed at a modal must not
 * also empty the terminal column behind it (roborev 54697's failure, one step further along).
 *
 * ══ `terminalOwnsEscape` — RUNG 2 IS UNREACHABLE FROM A TERMINAL THE USER CHOSE ═══════════════════
 * Rung 1 is reachable inside a terminal after the one-press toll (`engine/terminalEscape`), so the
 * founder's "press escape twice and it unmounts" works. Rung 2 is NOT, at any press count, and that
 * asymmetry is deliberate: three consecutive Escapes inside five seconds is a real gesture for a vim
 * user, and letting it blank the terminal column of the very agent being typed in is exactly the
 * destructive outcome roborev 55373 was written about. Unbinding is recoverable by clicking; watching
 * your agent vanish is not, in the way that matters to someone mid-task.
 *
 * The term is true only for a caret the USER put in a terminal. A caret the app's auto-focus parked
 * there is the resting state, where the founder-confirmed two-step ladder must keep working — which
 * is also why this cannot be a bare "in a terminal" check. It also covers the latch armed legitimately
 * from the COMPOSER and carried into a terminal (unbind in the compose box, click into a terminal,
 * press Escape): roborev 55491's shape arriving by a change of focus rather than by swallowed
 * keydowns, which no wall-clock expiry could catch.
 *
 * THE THIRD PRESS DOES NOTHING, and that is delivered by the consumer rather than by a third
 * predicate here: the latch is cleared when rung 2 fires, so a third press finds it disarmed — and
 * `selectAgent(projectId, null)` on an already-null selection is a documented no-op in projectStore
 * even if it somehow got through. The founder asked that a third press "do nothing rather than
 * escalating further"; the safest way to honour that is to have no third rung on the ladder at all.
 */
export function clearsSelectionOnKey(
  state: CableState,
  key: string,
  {
    dismissibleOpen = false,
    releaseArmed = false,
    terminalOwnsEscape = false,
  }: { dismissibleOpen?: boolean; releaseArmed?: boolean; terminalOwnsEscape?: boolean } = {},
): boolean {
  return (
    key === "Escape" &&
    state.wired === "off" &&
    releaseArmed &&
    !dismissibleOpen &&
    !terminalOwnsEscape
  );
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

// ── THE EFFECTIVE SIDE: A CIRCUIT WITH NOTHING ON THE FAR END IS NOT A CIRCUIT ─────────────────
//
// `wired` is what the user's gesture WROTE. `effectiveWired` is what the shell should DRAW, and they
// differ in exactly one case: the named pair has no selected agent, so the cable is plugged into
// nothing.
//
// WHY THIS IS A READ-SIDE PROJECTION AND NOT A STORE INVARIANT. `selectAndWire` refuses to patch
// when it seats no agent, which closes one route in — and cannot close the ones that REMOVE
// something, because nothing is being acquired: switch the wired pair's project tab to a project
// with no agents, or close its last agent, and `wired` still names that side. Enforcing it on write
// would mean every removal path remembering to unbind; deriving it on read means none of them has to,
// and re-selecting an agent relights the cable with no second gesture (roborev 55249).
//
// AND IT MUST BE DERIVED ONCE. The first cut projected it at the shell root only, while `wired` has
// THREE readers — `ConciergeHost` passes the raw value to the column for its own `data-wired`, the
// flood and the lift; `AgentSidebar` reads `pairIsLive` for the row joint. So the state stayed fully
// representable and became self-contradictory on top: the shell root said "off" while the concierge
// column still flooded and the rows still drew their joints open. The flood is the exact consequence
// the finding was filed for, and it was driven by the unprojected value (roborev 55386). Hence one
// helper here, in the module that already owns "one live circuit", rather than a second expression
// per surface.
//
// NOT FOR CIRCUIT MEMBERSHIP. `unbindsOnPointerDown` and `data-wired-pair` must keep keying off the
// RAW `wired`: they answer "is this press inside the live circuit", and a pair that is momentarily
// drawing as unwired is still the pair the cable is patched into. Gating membership on the projection
// makes a press in that pair unbind the store before a re-selection can relight it — so the user has
// to click a build row again, which is precisely the "no second gesture" property this exists to
// preserve. Visual treatment takes the projection; membership takes the store.
export function effectiveWired(wired: WiredSide, farEndHasAgent: boolean): WiredSide {
  return farEndHasAgent ? wired : "off";
}
