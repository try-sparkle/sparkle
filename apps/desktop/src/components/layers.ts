// The two paint layers inside the ②+③ wrapper, in ONE place because the only thing that matters
// about them is their ORDER, and that order lived as two hand-copied literals in two files plus a
// third in a test assertion.
//
// The wrapper (`Workspace.tsx`, the `flex:1; position:relative` div holding the sidebar and the
// terminal stage) is `position: relative` with `z-index: auto`, so it is NOT a stacking context.
// Its positioned children compete directly with one another and with the rest of the shell, and
// these two numbers are the whole contract:
//
//   SIDEBAR_OVERLAY_Z  the Build column once the overlay pull tab has floated it over the terminal.
//   PLAN_COLUMN_Z      a pair's opaque Plan board, laid over BOTH of that pair's columns.
//
// THE BOARD OUT-RANKS THE FLOATED COLUMN, AND WHICH WAY THIS POINTS FOLLOWS FROM ONE FACT: HOW MUCH
// THE BOARD COVERS. It has been both, so the reasoning is worth keeping rather than the value.
//
// While the board filled one column's TERMINAL SLOT, the sidebar had to win. Floating the Build
// column over the terminal is an explicit user gesture, the board was simply what occupied the
// terminal at that moment, and the reverse order hid the column the user had just floated. That
// ordering shipped, and it was right for that geometry.
//
// The board spans the PAIR again (founder, 2026-07-31: "They should be in both the terminal and the
// builder area") — so it covers the Build column, takes that column's header with it, and carries
// its own PlanBuildToggle because otherwise there is no way back to Build. That restores the
// constraint the terminal-slot version had removed, and it is the stronger one: if the sidebar
// painted through, it would cover the only control that closes the board, which is a dead end
// rather than a cosmetic overlap. The float gesture loses nothing real — its pull tab is under the
// board in Plan mode, so it cannot be started there, and leaving Plan hands the floated column
// straight back.
//
// WHY THESE ARE BIG-ISH NUMBERS AND NOT 1 AND 2. `terminal-stage` is `position: relative` with
// `z-index: auto`, so it is not a stacking context either, and the things inside it do not stay
// inside it: PinnedPrompt and the drop overlay sit at 20, the pane kebab at 19–21, Composer at 5/6.
// Most are contained today only incidentally, by the `zIndex: 1` that `paneVisibilityStyle` puts on
// each pane root for an unrelated reason (keeping the active pane above the inert hidden ones) —
// and a stage-level overlay outside any pane root is not contained at all. A floating column at 4
// loses to those. Clearing 21 with room to spare is what makes the panel reliably visible.
//
// AND WHY NOT `isolation: isolate` ON THE STAGE, which would let these be small again: it contains
// the stage's overlays downward but also demotes the stage's full-window `position: fixed` surfaces
// — `composer/ModalOverlay` at zIndex 1000, AgentPane's click-away backdrop — which exist precisely
// to cover column ①. Isolated, they lose to any `z-index: 1` descendant of the concierge column.
// Out-numbering the stage costs nothing; isolating it breaks modals. See the note at `terminal-stage`.
//
// CEILING — and it is TIGHTER than "anything under 50". The bands above, in order:
//
//   40      SettingsDialog's backdrop (41 its dialog) and OpenPrMenu's click-away backdrop (41/42).
//           Both are `position: fixed; inset: 0` competing at ROOT against these two constants.
//           PLAN_COLUMN_Z sat at exactly 40 for one commit: the tie went to the plan board on DOM
//           order (it renders after ProjectTabsBar), so in Plan mode a click over the board hit a
//           card instead of dismissing the open PR menu, which then stayed open. Stay clear of the
//           whole 38–45 band; do not tune it to "just below 41" and rely on a tie.
//   50      the row hover card's portal (mounted to document.body) — a row card must still pop out
//           over the floating panel.
//   61+     the app-modal band: NewCloudAgentDialog 61, ProjectModal 100, AccountLoginModal 120,
//           CommandPalette and composer/ModalOverlay 1000. Every dialog covers both of these.
//
// So the usable window is roughly 22–37. These sit at the bottom of it.
//
// ── "COMPETES AT ROOT" IS A PROPERTY OF THE PORTAL, NOT OF THE NUMBER ──────────────────────────
// This ladder only describes reality for surfaces that actually REACH the root stacking context,
// and that line above used to justify itself with "rendered from hosts that are NOT stacking
// contexts". That premise was true when written and rotted silently. `Concierge/KebabMenu` mounts
// SettingsDialog inside `ConciergeColumn`'s root `<section>`, which is `position: relative` +
// `CONCIERGE_LIFT_Z` (3) — a stacking context — so the dialog's 40/41 were capped at 3 and the pull
// tab's rail at `PULL_TAB_RAIL_Z` (4), a sibling of the column, painted over an app-modal dialog and
// its scrim. Nothing in this file was wrong; the modal simply never arrived in the layer the file
// describes.
//
// The premise is now enforced instead of assumed: every modal that paints its own scrim wraps
// itself in `components/ModalLayer`, which portals it to `document.body`. Read these numbers as
// "where a modal lands ONCE PORTALED" — a modal that skips ModalLayer is not on this ladder at all,
// whatever it typed. `modalLayering.test.ts` fails the build if a new one skips it, and
// `ModalLayer.wiring.test.tsx` re-opens the settings dialog through the real column and checks it
// escaped. The corollary for anyone adding a lifted container: you may make your column a stacking
// context freely — that is no longer a way to break a modal.
//
// AgentSidebar.pullTabs.test.tsx asserts the ordering invariant against these constants and that the
// sidebar renders at its own; Workspace.tabs.test.tsx pins the board to PLAN_COLUMN_Z. Changing
// either number in a way that inverts them fails a test instead of silently restoring the bug.
export const SIDEBAR_OVERLAY_Z = 25;
// Above the floated Build column (see above) — the board covers that column, so it must also cover
// it when floated — and clear of the stage's own overlays at 19-21. Well under the 38–45 band.
//
// `PreviewSlot` SHARES THIS NUMBER RATHER THAN DECLARING AN EQUAL ONE. It is the same geometry —
// an inset-0 overlay over a pair's `paircols`, covering the Build column and carrying its own way
// back out — so every word above applies to it unchanged. And the two can never be on screen
// together: a pair has ONE `workMode`, and the board and the preview are two of its three values,
// so they are mutually exclusive by construction and there is no ordering between them to express.
// A second constant with the same value would be pure drift surface — kept equal by hand forever,
// and the first time it drifted nothing could say which of the two was right.
export const PLAN_COLUMN_Z = 26;

/**
 * THE SEAM OF A FLOATED COLUMN — the one thing that must outrank everything the column floats over,
 * including the board that covers the column itself.
 *
 * A column that grows OUTBOARD grows over the very seam it was pulled from, overhanging a 6px rail
 * by hundreds of pixels. Hover is detected on the rail, so a buried rail never fires it and the
 * chevron that docks the column never appears: the panel is on screen and its only mouse-reachable
 * way out is gone. `AgentSidebar` avoids this by mounting its tab INSIDE the floated element; the
 * concierge cannot, because its rails are pinned as SIBLINGS of the box
 * (`Workspace.resize.test.tsx`'s `assertRowStructure`), so the rail is lifted instead.
 *
 * DERIVED FROM THE LADDER, NOT FROM ONE NEIGHBOUR. The first cut spelled this
 * `SIDEBAR_OVERLAY_Z + 1`, which is 26 — exactly `PLAN_COLUMN_Z`. That is not "above the board", it
 * is a TIE, and this file already says a tie is resolved by DOM order and must never be relied on.
 * It broke in opposite directions on the two sides: the right pair renders after
 * `data-concierge-root`, so a concierge overlaid onto a pair in Plan mode was buried by the board
 * and the trap was fully restored; on the left the tie went the other way and the tab's overhang
 * paints and hit-tests OVER a board whose whole contract is that nothing beneath it is reachable.
 *
 * So it is one above the highest thing it can be occluded by, stated as an expression of both so a
 * later change to either cannot silently re-create the tie. Still well under the 38–45 modal band —
 * a seam is chrome, not a modal.
 */
export const OVERLAID_RAIL_Z = Math.max(SIDEBAR_OVERLAY_Z, PLAN_COLUMN_Z) + 1;

// ── THE TWO COLUMNS OF A PAIR, AT REST ─────────────────────────────────────────────────────────
// Separate from the two constants above, which are about a column that has been FLOATED. These are
// the ordinary docked case, and they exist because of one visible defect: the selected agent row
// bleeds 9px out of the Build column and into the terminal pane — that overhang, and the concave
// fillets that shape it, are what make the row read as an opening INTO the pane it selects.
//
// It was invisible. The direction diagnoses it directly (`rev4.html`, and MAPPING.md's "Geometry
// vocabulary" section): the terminal is LATER IN THE DOM than the Build column, and at equal
// stacking level a later sibling paints last — so the pane simply covered the overhang. The mock
// fixes it with two declarations and nothing else:
//
//     .paircols .build{position:relative;z-index:2}
//     .paircols .term {position:relative;z-index:1}
//
// The fix is NOT to remove the overhang. That was tried, it "worked", and it deleted the one piece
// of geometry the whole selected-row treatment is built on.
//
//   BUILD_COLUMN_Z    the Build column (`AgentSidebar`'s docked root, `Workspace.tsx`'s ② slot).
//   EPICS_COLUMN_Z    the Epics column, one step above it so its pull tab's overhang is not clipped
//                     by the build column it overhangs into — see the constant's own note.
//   TERMINAL_PANE_Z   an agent pane inside the terminal stage — what `paneVisibilityStyle` puts on
//                     the VISIBLE pane to keep it above the inert hidden ones it overlaps.
//
// WHY THE PANE AND NOT THE STAGE CARRIES THE LOWER NUMBER. The mock's `.term` is one element; the
// app's terminal stage is a stage full of stacked panes. Putting a z-index on `terminal-stage`
// would make it a STACKING CONTEXT, which is the exact move the note at that element (and the
// `isolation: isolate` note above) says breaks the app: every `position: fixed` surface rendered
// from inside a pane — `composer/ModalOverlay` at 1000, AgentPane's click-away backdrop — exists to
// cover column ①, and a contained stage caps them under the columns. The panes are ALREADY
// stacking contexts (`paneVisibilityStyle` has always given the visible one a z-index), so pinning
// them one below the Build column reproduces the mock's ordering without containing anything new.
//
// The ordering — not the values — is the contract, and `paneVisibility.test.ts` asserts it.
export const TERMINAL_PANE_Z = 1;
export const BUILD_COLUMN_Z = 2;
/**
 * The EPICS column — one step ABOVE the Build column, and the step is the whole reason it exists.
 *
 * This column's pull tab is an absolute child anchored at its BUILD-FACING edge, and the tab
 * chiclet is centred on that 6px rail — so roughly a third of it overhangs the column's border box
 * into the build column beside it. Both roots carry a z-index and so are stacking contexts; at
 * EQUAL z-index the winner is tree order, and `Workspace` renders Epics BEFORE `AgentSidebar` on
 * both pairs (`row-reverse` mirrors layout, not the tree). So with a shared value the build
 * column's opaque `deepForest` paints over the overhang and the grip renders sliced flat at the
 * boundary.
 *
 * `AgentSidebar`'s own tab has the same overhang and never shows it, but only because
 * `BUILD_COLUMN_Z` already outranks `TERMINAL_PANE_Z` on the side it overhangs into. There is no
 * equivalent margin here, so it has to be stated.
 *
 * NOT solvable from inside the column: `PULL_TAB_RAIL_Z` is local to this column's own stacking
 * context and cannot lift anything past a sibling.
 *
 * As above, the ORDERING is the contract, not the values.
 */
export const EPICS_COLUMN_Z = 3;
