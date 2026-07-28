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
//           Both are `position: fixed; inset: 0` rendered from hosts that are NOT stacking contexts
//           (ProjectTabsBar for the PR menu), so they compete at ROOT against these two constants.
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
// AgentSidebar.pullTabs.test.tsx asserts the ordering invariant against these constants and that the
// sidebar renders at its own; Workspace.tabs.test.tsx pins the board to PLAN_COLUMN_Z. Changing
// either number in a way that inverts them fails a test instead of silently restoring the bug.
export const SIDEBAR_OVERLAY_Z = 25;
export const PLAN_COLUMN_Z = 26;
