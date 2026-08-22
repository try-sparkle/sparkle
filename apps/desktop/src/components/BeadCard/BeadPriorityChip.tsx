// The bead's priority chiclet for a card face — the `● P1` pill on every board card and epic row.
//
// ══ IT USED TO BE A READOUT. THE FOUNDER ASKED FOR IT BACK AS A CONTROL ════════════════════════
// Verbatim, 2026-08-22: "I also want to be able to click on the chicklet to change the priority.
// Clicking on the priority chicklet should not open the row but it should just change the priority.
// It should give me a little drop down to change the priority. This should work whether the row is
// open or closed."
//
// So the chip now opens `PriorityMenu` and writes the pick through `setBeadPriority`. Its VISUAL
// design is untouched — same `tag()` treatment, same urgent dot, same `priorityShort` — because he
// asked for behaviour, not a restyle.
//
// ══ EDITING IS OPT-IN, AND THAT IS NOT TIMIDITY ════════════════════════════════════════════════
// With no `beadId`/`projectPath` the chip renders EXACTLY the span it always did: no role, no
// handler, no listeners, no portal. Three reasons, in descending order of how much they cost to get
// wrong:
//
//   1. A SURFACE WITH NO PROJECT PATH CANNOT WRITE. This is the rule `BeadCard` already follows
//      ("an absent callback is an absent affordance"), and the satellite window depends on it. A
//      chip that offered a menu it could not save from would be a promise the surface cannot keep.
//   2. HUNDREDS OF CARDS. The read-only path mounts no state and no listeners, which is why the
//      chip was split out of `PriorityPill` in the first place. Opt-in keeps that true of every
//      card that is not asked to be editable.
//   3. `Workspace.epicsColumn.test.tsx` clicks every descendant of the epic row and asserts the row
//      opens. A chip that unconditionally swallowed the click would red that guard for surfaces
//      nobody asked to change. When a call site opts IN, swallowing the click is the point, and
//      that guard is the thing the call site must update.
//
// ══ WHY THE TRIGGER IS A `<span role="button">` AND NOT A `<button>` ═══════════════════════════
// Both call sites render this INSIDE a `<button>`: the epic row (`EpicsColumn`, one big `<button>`
// per epic) and the board card (`BoardView`, a `<button>` wrapping the whole card face). A
// `<button>` inside a `<button>` is invalid HTML that browsers reflow unpredictably — the parent
// may be closed early, which relocates the chip out of the row it belongs to. `PriorityPill` can
// use a real button because the detail card is not one; this cannot. So: `role="button"`,
// `tabIndex={0}`, and Enter/Space handled explicitly, which is the whole cost of that swap.
//
// ══ THE CLICK MUST NOT REACH THE ROW ═══════════════════════════════════════════════════════════
// `click` alone is not enough. `pointerdown` and `mousedown` fire FIRST and row-level handlers do
// listen there (the board's overlay dismissal is a mousedown guard), so a chip that stopped only
// the click would still toggle the row on the press before it. All three are stopped here, and
// `PriorityMenu` stops its own — necessary because React bubbles portal events through the JSX
// tree, so a menu row's click would otherwise re-emerge at the row `<button>` this renders inside.
//
// ══ OPTIMISTIC, WITH AN HONEST FAILURE ═════════════════════════════════════════════════════════
// The chip shows the picked level immediately and ROLLS BACK if `bd` refuses, surfacing the
// reason. It never keeps showing a priority the store declined. The optimistic value is held here
// rather than in `beadsStore` because that store replaces its whole snapshot every five seconds and
// would clobber it; the effect below retires it when the poll catches up.
import { useEffect, useRef, useState } from "react";
import { C } from "../../theme/colors";
import { tag } from "../labelTreatment";
import { isUrgentPriority, priorityShort, setBeadPriority } from "./beadPriority";
import { PriorityMenu, type PriorityMenuAnchor } from "./PriorityMenu";

export function BeadPriorityChip({
  priority,
  beadId,
  projectPath,
  testId = "bead-priority-chip",
}: {
  /** The bead's priority (`undefined` renders as `P?` — an unset priority is the one most worth
   *  seeing, not hiding). */
  priority: number | undefined;
  /** The bead to write to. Supply BOTH this and {@link projectPath} to make the chip editable;
   *  omit either and it stays the read-only span it has always been. */
  beadId?: string;
  /** The project whose `bd` store holds the bead. `null` is the shape `rootPath` already has at
   *  every call site, so wiring is `projectPath={rootPath}` with no massaging. */
  projectPath?: string | null;
  testId?: string;
}) {
  // BOTH HALVES OR NOTHING: a chip that can name a bead but not a store cannot write, and neither
  // can one that can name a store but not a bead. Narrowed into ONE object rather than a boolean
  // so the write below needs no non-null assertions — a boolean's narrowing does not survive into
  // the closure that performs the write, and asserting there is how a half-configured call site
  // turns into `setBeadPriority(undefined, …)` at runtime.
  const target =
    beadId !== undefined &&
    beadId !== "" &&
    projectPath !== undefined &&
    projectPath !== null &&
    projectPath !== ""
      ? { projectPath, beadId }
      : null;
  const editable = target !== null;

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PriorityMenuAnchor | null>(null);
  const [optimistic, setOptimistic] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const triggerRef = useRef<HTMLSpanElement>(null);

  // Retire the optimistic value once the 5-second poll delivers the same answer. Clearing it at the
  // end of the write instead would snap the chip back to the OLD level and then forward again.
  useEffect(() => {
    if (optimistic !== null && priority === optimistic) setOptimistic(null);
  }, [priority, optimistic]);

  // A pick while a write is in flight would race two writes against a store whose ordering nobody
  // controls. Closing the menu is what makes "busy" true of the whole control, not just its trigger.
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  const shown = optimistic ?? priority;
  const urgent = isUrgentPriority(shown);
  const ink = urgent ? C.dangerInk : C.muted;

  function close() {
    setOpen(false);
    triggerRef.current?.focus(); // menu rows can hold focus; hand it back to the chip
  }

  function toggle() {
    if (busy) return;
    if (open) {
      close();
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    // LEFT-aligned under the chip, for the reason `PriorityPill` gives: these live at the left edge
    // of a narrow column, and a right-aligned menu there hangs off the side it is anchored to.
    // In jsdom every rect is zeroes (nothing lays out), which is harmless — position is never
    // asserted, only that the menu mounted.
    setAnchor(r ? { top: r.bottom + 4, left: Math.max(8, r.left) } : null);
    setOpen(true);
  }

  async function pick(p: number) {
    close();
    if (target === null || busy) return;
    const previous = optimistic;
    setErr("");
    setOptimistic(p);
    setBusy(true);
    try {
      await setBeadPriority(target.projectPath, target.beadId, p);
    } catch (e) {
      // ROLL BACK. The chip is the only thing that moved, so the only honest thing to show is the
      // level the bead still carries — beside the reason it did not change.
      setOptimistic(previous);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── THE READ-ONLY CHIP, unchanged from the day it was split out of `PriorityPill` ─────────────
  const face = (
    <>
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 6,
          height: 6,
          // A dot is a circle — exempt from the radius ratchet, same as every other status dot.
          borderRadius: "50%",
          // `sienna` as FILL only (it can't be text ink at 3.83:1); the label above is `dangerInk`.
          background: urgent ? C.sienna : C.muted,
        }}
      />
      {priorityShort(shown)}
    </>
  );
  const faceStyle = {
    ...tag(ink),
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flex: "0 0 auto",
    background: "transparent",
    padding: "1px 6px",
  } as const;

  if (!editable) {
    return (
      <span
        data-testid={testId}
        data-priority={shown === undefined ? "" : String(shown)}
        // No title/click: it is a readout on this surface. The editable form below carries the
        // "click to change" affordance, so a second one here would promise an action this cannot do.
        style={faceStyle}
      >
        {face}
      </span>
    );
  }

  return (
    <>
      <span
        ref={triggerRef}
        data-testid={testId}
        data-priority={shown === undefined ? "" : String(shown)}
        data-editable="true"
        data-busy={busy ? "true" : undefined}
        data-error={err === "" ? undefined : err}
        // NOT a `<button>` — see the header. `role`/`tabIndex`/`onKeyDown` are the three things that
        // buys back, and all three have to be here for the swap to be honest.
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        title={
          err !== ""
            ? err
            : busy
              ? "Saving priority…"
              : `Priority ${priorityShort(shown)} — click to change how soon this gets done`
        }
        // ALL THREE PRESS EVENTS. `pointerdown`/`mousedown` fire before `click` and row handlers do
        // listen there, so stopping only the click still toggles the row on the press before it.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          // `preventDefault` on Space stops the page scrolling; `stopPropagation` keeps the press
          // off a row that may act on Enter itself.
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        style={{ ...faceStyle, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}
      >
        {face}
        {err !== "" && (
          // A SENTENCE WILL NOT FIT. This chip lives in a 280px epic row beside a title that is
          // already ellipsised, so the failure shows as a mark whose `title` (above) carries the
          // reason, with the sentence itself in the live region below for anyone not using a mouse.
          <span aria-hidden style={{ marginLeft: 2, color: C.dangerInk }}>
            !
          </span>
        )}
      </span>
      {err !== "" && (
        // Same clip-rect shape the concierge column's announcer uses — this codebase has no sr-only
        // utility, and inventing a second one would be the thing that drifts.
        <span
          data-testid={`${testId}-error`}
          role="status"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          {err}
        </span>
      )}
      {open && (
        <PriorityMenu
          anchor={anchor}
          priority={shown}
          testId={testId}
          onClose={close}
          // No focus handoff on the scroll path: refocusing scrolls the chip back into view and
          // fights the very scroll that dismissed the menu.
          onDismiss={() => setOpen(false)}
          onPick={(p) => void pick(p)}
        />
      )}
    </>
  );
}
