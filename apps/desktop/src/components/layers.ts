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
//   PLAN_COLUMN_Z      Plan mode's opaque board, laid over BOTH columns. Must stay above the
//                      floating sidebar: if the sidebar wins it paints through the board and covers
//                      the PlanBuildToggle, which is the only way back to Build.
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
export const PLAN_COLUMN_Z = 26;

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
