// apps/desktop/src/components/BeadSelection.tsx
//
// The board's consolidate gesture (bead `sparkle-xelans.2`): tick several beads, then move them all
// under one epic — or take them all off theirs — in ONE `bd update`.
//
// Two pieces, kept together because they are two halves of one interaction and neither is useful
// alone: {@link BeadSelectCheckbox}, which each board card renders, and {@link BeadSelectionBar},
// which the board renders once above the columns and only while something is ticked.
//
// ══ THE BAR APPEARS ONLY WHEN THERE IS A SELECTION ════════════════════════════════════════════
// A permanently-mounted toolbar would take a row of the board's height from the cards on every
// session, to offer an action almost nobody is mid-way through. Rendering nothing at zero also
// makes the affordance self-explaining: ticking one card is what produces the thing that says what
// ticking cards is for.
import { useMemo, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, PILL } from "../theme/scale";
import type { Bead } from "../services/beads";
import { epicDisplayTitle, epicIndexOf, isEpicIndexed } from "../services/beads";
import { reparentBeads, unparentBeads } from "../services/beadReparent";
import { toBeadsError } from "../services/beadsCommands";
import { useBeadSelectionStore } from "../stores/beadSelectionStore";

/** The per-card tick.
 *
 *  A SIBLING of the card's body button, never a child of it: a `<button>` may not contain another
 *  interactive control, and a checkbox nested in the body would open the detail overlay on every
 *  click. `stopPropagation` is belt-and-braces for the same reason.
 *
 *  It subscribes to the store ITSELF rather than taking a `selected` prop, so ticking one card
 *  re-renders that card and nothing else — the board mounts hundreds of these and `Card` is
 *  memoized precisely so an unrelated change cannot walk them all. */
export function BeadSelectCheckbox({
  projectId,
  beadId,
}: {
  projectId: string;
  beadId: string;
}) {
  const selected = useBeadSelectionStore((s) => (s.selected[projectId] ?? []).includes(beadId));
  return (
    <input
      type="checkbox"
      data-testid={`board-card-select-${beadId}`}
      // NAMED, not left to the visual context. A bare checkbox on a card reads as unlabelled to a
      // screen reader, and the card's title is inside a button it is not allowed to point at.
      aria-label={`Select bead ${beadId}`}
      checked={selected}
      onChange={() => useBeadSelectionStore.getState().toggle(projectId, beadId)}
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 2,
        flexShrink: 0,
        cursor: "pointer",
        // Muted until it is doing something, so a board of untouched cards does not read as a form.
        accentColor: C.accentInk,
        opacity: selected ? 1 : 0.45,
      }}
    />
  );
}

/** What the bar is currently doing. `null` is idle; a string is the message under the controls. */
type BarNote = { kind: "error" | "ok"; text: string } | null;

/**
 * The action bar: "N selected · [epic picker] Move to epic · Unparent · Clear".
 *
 * ══ ONE CALL PER GESTURE, AND THE REFRESH IS FORCED ═══════════════════════════════════════════
 * `reparentBeads` / `unparentBeads` batch the whole selection into one `beads_reparent`, which is
 * the Rust side's contract — see `services/beadReparent.ts`. On success this then FORCES a beads
 * refresh rather than waiting for the poll. The poll would carry the new parent edge eventually,
 * but its cadence is DERIVED from how long a read takes (`BEADS_POLL_DUTY_FACTOR`) and is capped at
 * `BEADS_POLL_MAX_INTERVAL_MS` = 60s — so on the founder's own store, which is where consolidating
 * an epic actually matters, "eventually" can be a full minute of the board showing the old parent
 * after a click that reported success. `onDone` is the seam the board passes its refresh through,
 * so this component does not have to know the store.
 */
export function BeadSelectionBar({
  projectId,
  projectPath,
  allBeads,
  onDone,
}: {
  projectId: string;
  projectPath: string | null;
  allBeads: readonly Bead[];
  /** Called after a move lands, so the board can pull the new parent edges immediately. */
  onDone: () => void;
}) {
  const selected = useBeadSelectionStore((s) => s.selected[projectId]);
  const [epicId, setEpicId] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<BarNote>(null);

  // ── WHAT COUNTS AS AN EPIC HERE IS THE BOARD'S OWN ANSWER ────────────────────────────────────
  // Membership comes from `isEpicIndexed`, never from a bare `type === "epic"`. // epic-guard-ok
  //   (the escape hatch is here because `epic-membership-guard.sh` greps for that idiom and cannot
  //   tell a line that USES it from one that forbids it — and naming it is the whole point below.)
  // This repo's real parents include beads typed
  // `feature`/`bug`/`task`, one of them with 19 children, and a type check would leave every one of
  // them out of the picker — so the epics a user can already SEE grouping work would be exactly the
  // ones they could not move work into. Index-backed for the same reason `Card` is: the picker
  // would otherwise walk the whole store on every render of the bar.
  const epics = useMemo(() => {
    const index = epicIndexOf(allBeads as Bead[]);
    return allBeads
      .filter((b) => b.status !== "closed" && isEpicIndexed(index, b))
      .map((b) => ({ id: b.id, title: epicDisplayTitle(b.title) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [allBeads]);

  // Nothing ticked → no bar at all. Deliberately AFTER the hooks, which may not be conditional.
  if (selected === undefined || selected.length === 0) return null;

  const count = selected.length;
  // A project with no path cannot be written to at all — every bd call is addressed by path — so
  // the bar degrades to read-only rather than offering a control that can only fail. Bound to a
  // local const so TypeScript NARROWS it inside the click handlers below: the alternative is an
  // `as string` at each call site, which is an assertion that this guard exists rather than a use
  // of it, and would survive the guard being deleted.
  const path = projectPath;
  const writable = path !== null;

  /** Run one move, then report. Takes the project path as an ARGUMENT rather than reading it from
   *  the closure, so the null check below is the thing that produces the `string` the callers get —
   *  no `as string` at any call site, and deleting the check is a type error rather than a runtime
   *  one. `path` is a const, so narrowing it here also narrows it for the `move(path)` call. */
  async function run(move: (p: string) => Promise<void>, done: string) {
    if (path === null) return; // buttons are disabled in this state; belt-and-braces
    setBusy(true);
    setNote(null);
    try {
      await move(path);
      // CLEARED ONLY ON SUCCESS. A failed move leaves the ticks exactly as they were, so the retry
      // is the same click again rather than re-finding several cards across a scrolled board.
      useBeadSelectionStore.getState().clear(projectId);
      setNote({ kind: "ok", text: done });
      onDone();
    } catch (e) {
      // `.message` off the shared `BeadsError` shape — this renders the client-side refusals
      // (nothing chosen, a self-parent) and bd's own failures through one path.
      setNote({ kind: "error", text: toBeadsError(e).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="board-selection-bar"
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
        padding: "8px 16px",
        borderBottom: `1px solid ${C.hairline}`,
        background: C.deepForest,
        color: C.cream,
        fontFamily: FONT_UI,
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      <span data-testid="board-selection-count" style={{ fontWeight: FONT_WEIGHT.semibold }}>
        {count === 1 ? "1 bead selected" : `${count} beads selected`}
      </span>
      <span style={{ color: C.muted }}>·</span>

      <select
        data-testid="board-selection-epic"
        aria-label="Epic to move the selected beads under"
        value={epicId}
        disabled={busy || !writable}
        onChange={(e) => setEpicId(e.target.value)}
        // THE FIELD PAIR, not the shell's planes. `inputSurface`/`inputEdge` is the spec's treatment
        // for a control the user types or chooses into, and `modalChrome.test.ts` ratchets the count
        // of fields still borrowing `forest` + `hairline` DOWNWARD — so a new one painted the old
        // way reds that suite (measured: it took the count 31 → 32). This is a real `<select>`, not
        // one of the bordered panels that land on that list as false positives, so the honest move
        // is to paint it correctly rather than to raise the ceiling.
        style={{
          background: C.inputSurface,
          color: C.cream,
          border: `1px solid ${C.inputEdge}`,
          borderRadius: PILL,
          font: "inherit",
          padding: "3px 6px",
          maxWidth: 280,
        }}
      >
        {/* The empty option is a PROMPT, not the unparent path. `reparentBeads` refuses a blank
            parent outright — unparenting has its own button — so leaving this unchosen produces a
            sentence rather than silently detaching the selection. */}
        <option value="">Choose an epic…</option>
        {epics.map((e) => (
          <option key={e.id} value={e.id}>
            {e.title} ({e.id})
          </option>
        ))}
      </select>

      <button
        type="button"
        data-testid="board-selection-move"
        disabled={busy || !writable}
        onClick={() =>
          void run(
            (p) => reparentBeads(p, selected, epicId),
            count === 1 ? "Moved 1 bead" : `Moved ${count} beads`,
          )
        }
        style={barButton(busy || !writable)}
      >
        Move to epic…
      </button>

      <button
        type="button"
        data-testid="board-selection-unparent"
        disabled={busy || !writable}
        onClick={() =>
          void run(
            (p) => unparentBeads(p, selected),
            count === 1 ? "Unparented 1 bead" : `Unparented ${count} beads`,
          )
        }
        style={barButton(busy || !writable)}
      >
        Unparent
      </button>

      <button
        type="button"
        data-testid="board-selection-clear"
        disabled={busy}
        onClick={() => {
          useBeadSelectionStore.getState().clear(projectId);
          setNote(null);
        }}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          color: C.accentInk,
          cursor: busy ? "default" : "pointer",
          font: "inherit",
          textDecoration: "underline",
        }}
      >
        Clear
      </button>

      {!writable && (
        <span data-testid="board-selection-note" style={{ color: C.muted }}>
          This project has no path on disk yet — beads cannot be moved.
        </span>
      )}
      {note && (
        <span
          data-testid="board-selection-note"
          style={{ color: note.kind === "error" ? C.sienna : C.muted }}
        >
          {note.text}
        </span>
      )}
    </div>
  );
}

/** The two action buttons share a shape; a local helper rather than two copies that can drift. */
function barButton(disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${C.hairline}`,
    borderRadius: PILL,
    color: disabled ? C.muted : C.accentInk,
    cursor: disabled ? "default" : "pointer",
    font: "inherit",
    padding: "3px 10px",
  };
}
