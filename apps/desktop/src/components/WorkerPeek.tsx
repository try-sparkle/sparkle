import { C } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { DEPTH_INDENT } from "../engine/rowGeometry";
import { bandColor } from "../engine/statusBandLabels";
import type { AgentTab } from "../types";

/**
 * THE PEEK: one inset line under a CLOSED head, shown only when a worker beneath it needs you.
 *
 * This is not the subtree, and the distinction is the whole feature. It is a single line no matter
 * how many workers are red — several red workers collapse to a COUNT rather than several lines,
 * because a peek that grows with the fleet is an expansion wearing a different name. The head stays
 * `aria-expanded="false"`, the `group` of real child rows is not rendered, and nothing is written to
 * `collapsedOrchestrators`; when the red clears the line simply stops being rendered, leaving the
 * user's collapse exactly as they left it.
 *
 * It replaces the capability the deleted auto-expander provided — "something under this closed head
 * needs you" — without the cost that made that machinery wrong: it cannot leave a subtree standing
 * open after the red has gone, because it never opened one.
 *
 * GREEN AND GRAY WORKERS NEVER REACH HERE (see engine/workerExpansion.attentionWorkersOf), so a
 * settled fleet is exactly as compact as it was before.
 *
 * Clicking it opens the parent for real — the peek names a row you cannot otherwise click, so the
 * obvious gesture has to lead somewhere. That click goes through the same
 * `toggleOrchestratorCollapsed` as the head row: it is the USER opening the subtree, which is
 * allowed, rather than the app doing it on their behalf, which is what this feature removed.
 */
export function WorkerPeek({
  workers,
  headName,
  onOpen,
}: {
  workers: readonly AgentTab[];
  headName: string;
  onOpen: () => void;
}) {
  const n = workers.length;
  // One line, always. With several red workers the NAMES are dropped rather than joined — a joined
  // list is how this becomes two lines at the first long agent name.
  const label = n === 1 ? (workers[0]?.name ?? "") : `${n} workers`;
  return (
    <button
      type="button"
      // A `treeitem`, not a bare button. This sits as a direct child of the stage section's
      // `role="group"` inside `role="tree"`, and a tree may own ONLY treeitems and groups —
      // the same invariant the subtree `group` three lines up exists to satisfy (roborev 53891).
      // A generic button here is content AT drops or misannounces, which would silently swallow
      // the one affordance saying "something under this closed head needs you".
      role="treeitem"
      // The WORKER's level, not the head's. Row treeitems declare `aria-level={depth + 1}` — heads
      // are 1, their workers 2 — and this element stands for a worker. Without it AT falls back to
      // DOM nesting, which is FLAT here (the peek is a sibling of the head row inside the section
      // group, not a descendant), so the one line saying "something under this head needs you"
      // would announce at the same level as the head and read as another top-level agent.
      aria-level={2}
      // NO aria-expanded. This treeitem owns no group and can never be expanded — activating it
      // toggles the HEAD's collapse, after which the peek unmounts entirely. Announcing "collapsed"
      // here would duplicate the head row's own aria-expanded for the same subtree and offer a state
      // no keyboard path can act on (see tabIndex below).
      // NOT a Tab stop. The column is roving-tabindex — one stop for the whole list — so a
      // `tabIndex=0` here would add one per peek. It is deliberately not in the arrow-key ring
      // either: the peek is a REDUNDANT affordance (the head row carries the same red on its own
      // dot, and opening that head is what reveals the real worker row), so a keyboard user loses
      // no reachable path. Pointer users get the shortcut; nobody depends on it.
      tabIndex={-1}
      data-testid="worker-peek"
      data-peek-count={n}
      onClick={onOpen}
      aria-label={`${label} under ${headName} ${n === 1 ? "needs" : "need"} you — open this subtree`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        // Indented like a child row so it reads as belonging to the head above it, but deliberately
        // NOT the full row chrome — no tracker, no timer, no controls. It is a signpost.
        marginLeft: DEPTH_INDENT,
        width: `calc(100% - ${DEPTH_INDENT}px)`,
        padding: "2px 6px",
        background: "transparent",
        border: "none",
        borderRadius: 3,
        cursor: "pointer",
        font: "inherit",
        // TYPE.small, not a raw 11: the type scale is a ratchet (src/theme/scale.test.ts) and an
        // off-scale value fails it. One step down from the row body this line sits under.
        fontSize: TYPE.small,
        color: C.muted,
        textAlign: "left",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: bandColor("needs_you"),
        }}
      />
      <span
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        {label}
      </span>
      {/* The marker that says WHY this line is here. Same vocabulary as the filter chips and the
          band counts, via bandCountLabel, so the column says "needs you" in one voice. */}
      <span
        style={{
          flex: "0 0 auto",
          marginLeft: "auto",
          fontSize: TYPE.micro,
          fontWeight: 600,
          color: bandColor("needs_you"),
        }}
      >
        {n === 1 ? "needs you" : "need you"}
      </span>
    </button>
  );
}
