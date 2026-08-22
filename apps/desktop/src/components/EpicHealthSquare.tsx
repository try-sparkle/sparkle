// THE EPIC ROW'S SQUARE. One presentational leaf; every decision it renders is made in
// `engine/epicHealth`, which is where the reasoning lives.
//
// ══ SQUARE IS LOAD-BEARING, NOT DECORATION ═════════════════════════════════════════════════════
// The founder asked for it twice in one breath — *"status icons for the epics ... They should be
// square instead of circle"* — and the reason is that the build column's rows are DISCS. Shape is
// what tells him, at a glance across two columns, whether he is looking at an epic's health or an
// agent's. Rounding this off to match `StatusDot` would delete the distinction he asked for.
//
// THE CORNERS ARE HARD (`borderRadius: 0`), for two reasons that happen to agree. It is the most
// unmistakably NOT-a-disc a 9px mark can be, which is the property the founder named; and `0` is one
// of the three values `theme/scale.test.ts`'s radius ratchet exempts (alongside `PILL` and `50%`,
// the idiomatic circle). That ratchet's ceiling is now **0** — the migration off hand-typed radii is
// COMPLETE — so a softening 1px here is not a nicety, it is a fleet-red on a finished ratchet. Do
// not add one.
//
// ══ IT IS A READOUT WITH NO HANDLER, AND THAT IS ENFORCED ══════════════════════════════════════
// `EpicRow` is ONE `<button>`, and `Workspace.epicsColumn.test.tsx` clicks EVERY descendant of it
// asserting the row's own click still fires. A clickable child here would swallow that click, which
// is the exact live bug the epic goal span shipped (`sparkle-huw924.3`, fixed in PR #2285). So this
// takes no `onClick`, has no `role`, and stops no propagation — same contract `BeadPriorityChip`
// follows one slot over.
//
// ══ COLOURS COME FROM `AGENT_STATUS`, RAW ══════════════════════════════════════════════════════
// Same rule `components/rowClock.ROLLUP_DOT_COLOR` states: this is a FILLED SHAPE, so it takes the
// tier colour straight rather than through `statusInk` (which resolves a colour for legible TEXT
// and would land a near-miss of the build column's own green beside it). A rolled-up epic green is
// then pixel-identical to a working agent's dot, which is what "just like the build agents" means.
import { AGENT_STATUS } from "../theme/colors";
import { epicHealthLabel, type EpicHealth } from "../engine/epicHealth";

/** 9px. Large enough to read a hollow outline at, small enough that it costs the (already
 *  ellipsised) epic title almost nothing in a 280px column. */
const SIDE = 9;

const FILL: Record<Exclude<EpicHealth, "unstaffed">, string> = {
  red: AGENT_STATUS.waiting.color,
  amber: AGENT_STATUS.lapsed.color,
  green: AGENT_STATUS.working.color,
};

/**
 * The health square for one epic row.
 *
 * ── WHY `unstaffed` IS HOLLOW RATHER THAN A FOURTH COLOUR ────────────────────────────────────────
 * It is drawn in the SAME amber as `amber`, with no fill. Three things had to be true at once and
 * a fourth hue satisfies none of them:
 *
 *   • It must not read as calm. Green and gray both do — see `engine/epicHealth`'s header for the
 *     two founder rules that rule each of them out.
 *   • It must not build a wall of alarm. Most Backlog epics genuinely have no agent, so a solid red
 *     or solid amber here would paint most of the column one colour — the failure
 *     `packages/ui/tokens.ts` records from 2026-07-26, where 27 of 51 agents in one band made the
 *     band carry no information at all.
 *   • It must say WHICH kind of not-green it is, without a legend. An empty box reads as "nobody is
 *     in here", which is precisely the fact. A fifth hue would have to be learned.
 *
 * The border is 1.5px rather than 1px because at 9px a hairline outline and a solid fill are hard
 * to tell apart in peripheral vision, and telling them apart is the entire job.
 */
export function EpicHealthSquare({ health }: { health: EpicHealth }) {
  const hollow = health === "unstaffed";
  const ink = hollow ? AGENT_STATUS.lapsed.color : FILL[health];
  return (
    <span
      data-testid="epic-health"
      data-health={health}
      title={epicHealthLabel(health)}
      // The square carries the row's only statement about progress, so it is announced rather than
      // hidden: the row's `aria-pressed` says whether the card is open, not whether anyone is
      // building the epic.
      role="img"
      aria-label={epicHealthLabel(health)}
      style={{
        flex: "0 0 auto",
        // The row is `alignItems: "baseline"` for the title/chiclet/count; a 9px box has no useful
        // baseline of its own, so it centres against the row instead of hanging off the text's.
        alignSelf: "center",
        width: SIDE,
        height: SIDE,
        borderRadius: 0,
        background: hollow ? "transparent" : ink,
        border: hollow ? `1.5px solid ${ink}` : "none",
        boxSizing: "border-box",
      }}
    />
  );
}
