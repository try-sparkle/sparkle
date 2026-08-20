import { C } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { DEPTH_INDENT } from "../engine/rowGeometry";
import { bandColor } from "../engine/statusBandLabels";
import { STATUS_BANDS, bandOfStatus, type StatusBand } from "../engine/buildSections";
import { StatusDot } from "./StatusDot";
import type { AgentTab, AgentTabStatus } from "../types";

/**
 * THE PEEK: one inset line under a CLOSED head, shown only when a worker beneath it needs you.
 *
 * This is not the subtree, and the distinction is the whole feature. It is a single line no matter
 * how many workers are asking — several collapse to a COUNT rather than several lines, because a
 * peek that grows with the fleet is an expansion wearing a different name. The head stays
 * `aria-expanded="false"`, the `group` of real child rows is not rendered, and nothing is written to
 * `collapsedOrchestrators`; when the ask clears the line simply stops being rendered, leaving the
 * user's collapse exactly as they left it.
 *
 * It replaces the capability the deleted auto-expander provided — "something under this closed head
 * needs you" — without the cost that made that machinery wrong: it cannot leave a subtree standing
 * open after the red has gone, because it never opened one.
 *
 * CALM WORKERS NEVER REACH HERE (see engine/workerExpansion.attentionWorkersOf), so a settled fleet
 * is exactly as compact as it was before.
 *
 * Clicking it opens the parent for real — the peek names a row you cannot otherwise click, so the
 * obvious gesture has to lead somewhere. That click goes through the same
 * `toggleOrchestratorCollapsed` as the head row: it is the USER opening the subtree, which is
 * allowed, rather than the app doing it on their behalf, which is what this feature removed.
 *
 * ══ THE LIST IS MIXED-BAND, SO THE LINE MUST BE PAINTED PER WORKER (the 2026-08-13 fix) ══════════
 * `attentionWorkersOf` deliberately admits THREE different things: the red `needs_you` band, the
 * BLUE `questions` band, and the GRAY `unmerged` ("Needs merge") — an ask the founder can act on
 * that is explicitly not an alarm (read that function's header for why each one peeks). This
 * component used to paint every one of them with a hardcoded `bandColor("needs_you")` and write the
 * literal words "needs you", which made the peek disagree with the worker's OWN row about the same
 * worker at the same instant: the founder caught a worker showing a red dot and "needs you" in the
 * peek, and a gray dot with "Saved" once he expanded its parent. At most one of those can be true.
 *
 * So the dot is a real {@link StatusDot} carrying that worker's status — the SAME component the
 * expanded row's disc uses. Agreement is structural rather than a claim two files each make
 * separately, which is what let them drift.
 * `workerPeekRowAgreement.test.tsx` walks the whole status taxonomy and pins it.
 *
 * ⚠️ THE AGREEMENT IS NO LONGER "NEITHER SIDE OVERRIDES THE COLOUR". It used to rest on `AgentRow`
 * passing no `color` for a worker, so both sides fell through to `AGENT_STATUS[status].color`. The
 * row now DOES override it — the founder's 2026-08-19 rule repaints a disc whose work is short of a
 * terminal section — so the peek must be handed the same paint or the two drift again, in the
 * opposite direction to the original bug (gray collapsed, amber expanded). That is what
 * {@link WorkerPeekProps.dotColorOf} is for: the caller resolves BOTH discs through one expression.
 * It is REQUIRED, so there is no fallback path to lean on — see the prop's own doc for why.
 */
export function WorkerPeek({
  workers,
  statusOf,
  dotColorOf,
  headName,
  onOpen,
}: {
  workers: readonly AgentTab[];
  /** Each worker's presented status — the SAME map the caller's `attentionWorkersOf` selection was
   *  made from, threaded in rather than looked up again here. A second status source is precisely
   *  how the peek and the row came to disagree, and a pure component cannot reach for one. */
  statusOf: (id: string) => AgentTabStatus;
  /** The dot's fill for a given worker, or `undefined` FROM THE RESOLVER to let {@link StatusDot}
   *  use the status's own tier colour. Supplied by the caller so the peek and the expanded row
   *  resolve the SAME expression — see the header.
   *
   *  ⚠️ REQUIRED, DELIBERATELY. An optional prop with a silent fallback is the exact shape that has
   *  now produced this same defect three times on this branch (`rowSection?`, then `paintSection?`,
   *  then this) — the defaulted-seam trap in AGENTS.md: the production call site is the only thing
   *  that supplies the real value, so a caller that forgets it compiles, renders, and quietly
   *  reinstates the founder-screenshot bug. There is exactly one caller; making it mandatory means a
   *  second one cannot be added without answering this question. */
  dotColorOf: (id: string) => string | undefined;
  headName: string;
  onOpen: () => void;
}) {
  const n = workers.length;
  // One line, always. With several workers the NAMES are dropped rather than joined — a joined list
  // is how this becomes two lines at the first long agent name.
  const label = n === 1 ? (workers[0]?.name ?? "") : `${n} workers`;
  // WHICH worker the single line speaks for. With one worker it is that worker; with several it is
  // the loudest band present, so a red under a fold is never demoted to "needs merge" by a calmer
  // sibling sharing the line. Everything the line renders — dot, marker, aria-label — comes from
  // this ONE status, so the three cannot describe different workers.
  const spokesman = dominant(workers, statusOf);
  const status = spokesman === undefined ? "stopped" : statusOf(spokesman.id);
  const marker = markerFor(status, n);
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
      // either: the peek is a REDUNDANT affordance (the head row carries the same signal on its own
      // dot, and opening that head is what reveals the real worker row), so a keyboard user loses
      // no reachable path. Pointer users get the shortcut; nobody depends on it.
      tabIndex={-1}
      data-testid="worker-peek"
      data-peek-count={n}
      onClick={onOpen}
      // THE SAME WORDS THE LINE SHOWS. The marker below is the visible half of this sentence, so
      // they are one expression: a screen reader saying "needs you" about a line reading "needs
      // merge" is the original bug with a smaller audience.
      aria-label={`${label} under ${headName} ${marker} — open this subtree`}
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
      {/* `aria-hidden` on the WRAPPER rather than the dot, because StatusDot takes no such prop and
          renders a `title`. The button's own aria-label already carries the whole sentence in words;
          leaving the disc in the a11y tree would only add a second, terser reading of it. */}
      <span aria-hidden style={{ display: "flex", flex: "0 0 auto" }}>
        {/* 6px, the signpost size this line has always used — a peek is a smaller mark than a row's
            disc on purpose. Only the SIZE is local; the ink comes from the shared taxonomy. */}
        <StatusDot
          status={status}
          size={6}
          color={spokesman === undefined ? undefined : dotColorOf(spokesman.id)}
        />
      </span>
      <span
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        {label}
      </span>
      {/* The marker that says WHY this line is here — inked from the same band it is worded from, so
          a "needs merge" can never arrive wearing the alarm colour. */}
      <span
        style={{
          flex: "0 0 auto",
          marginLeft: "auto",
          fontSize: TYPE.micro,
          fontWeight: 600,
          // ⚠️ BAND INK, AND THE GRAY-RULE EXEMPTION IS DELIBERATE (roborev 65719). The disc beside
          // this marker now obeys the founder's 2026-08-19 terminal-gray rule and can read amber
          // while these words stay gray. That is not an oversight and it is not fixable by sourcing
          // the ink from the painted status: `lapsed` and `unmerged` are in the SAME band (`done`),
          // so `bandColor(bandOfStatus(...))` returns the identical gray either way.
          //
          // The marker is a BAND LEGEND, not a finishedness signal — it is inked from the same band
          // it is WORDED from, which is what stops a "needs merge" ever arriving in the alarm
          // colour. The words already say the row is unfinished; the disc carries the
          // finished-or-not claim. Re-inking this from the status would break the legend invariant
          // to restate something the text next to it says in words.
          color: bandColor(bandOfStatus(status)),
        }}
      >
        {marker}
      </span>
    </button>
  );
}

/** The worker the single line speaks for: the one in the highest-priority band present.
 *
 *  Priority is STATUS_BANDS' own order (needs_you › questions › running › done) read out of the
 *  taxonomy rather than listed here — the same discipline `buildSections.ASKING_BANDS` documents, so
 *  a fifth band is a decision made in one place instead of a silent omission in this one. Ties go to
 *  the first worker, which is the caller's order. */
function dominant(
  workers: readonly AgentTab[],
  statusOf: (id: string) => AgentTabStatus,
): AgentTab | undefined {
  const rank = (w: AgentTab) => STATUS_BANDS.findIndex((b) => b.id === bandOfStatus(statusOf(w.id)));
  let best: AgentTab | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const w of workers) {
    const r = rank(w);
    if (r < bestRank) {
      best = w;
      bestRank = r;
    }
  }
  return best;
}

/** What this line SAYS, agreeing in number with the count beside it.
 *
 *  The vocabulary matches `statusBandLabels.bandCountLabel`'s, and it inflects the same two ways for
 *  the same reason: `needs_you` is a SENTENCE, so a plural subject takes the plural VERB ("3 workers
 *  NEED you"), while `questions` is a NOUN and gains its -s instead ("3 questions"). "Needs merge" is
 *  a sentence like the first, so it loses its -s in the plural.
 *
 *  `unmerged` is checked BEFORE the band because it is the one status whose band does not name it:
 *  it falls in `done` (gray — a landing state, not an alarm) while still owing the founder an action,
 *  which is the whole reason it peeks at all. See workerExpansion.isOwedAsk. */
function markerFor(status: AgentTabStatus, n: number): string {
  if (status === "unmerged") return n === 1 ? "needs merge" : "need merge";
  const band: StatusBand = bandOfStatus(status);
  if (band === "needs_you") return n === 1 ? "needs you" : "need you";
  if (band === "questions") return n === 1 ? "question" : "questions";
  // UNREACHABLE against today's admission rule — `attentionWorkersOf` returns only the two bands
  // above plus `unmerged` — and written anyway so this function is total. A future status admitted
  // to the peek gets its band's own word here rather than silently inheriting somebody else's.
  return bandLabelWord(band);
}

/** A band's chip label as a mid-sentence word ("Running" → "running"). */
function bandLabelWord(band: StatusBand): string {
  return (STATUS_BANDS.find((b) => b.id === band)?.label ?? "").toLowerCase();
}
