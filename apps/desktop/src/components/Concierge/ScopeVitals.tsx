// The concierge header's ONE status line: scope + who needs you, e.g. `All projects · 2` or
// `All projects · 2 here · 1 in mobile`. The text derivations are exported pure so tests pin the
// exact strings the founder reads.
//
// ── IT USED TO BE TWO LINES, AND THAT WAS THE COMPLAINT ─────────────────────────────────────────
// A scope line ("Following all projects") stacked over a vitals line ("2 Need you · 5 Running").
// Founder, 2026-07-27 voice session: "it's taking up too much space." Column one is a CONVERSATION
// (PRD §2a) and every row of header is a row the thread doesn't get, so the two collapsed into one
// and three things went with them:
//   • "Following" — the wordmark above already says whose scope this is. `All projects` is the
//     same fact in a third of the width.
//   • the RUNNING count. It is not something you act on; the Needs-you number is. Running is still
//     carried in the view-model (and still banded, badged and chipped elsewhere) — it just no
//     longer spends a line of the founder's scarcest column.
//   • the words "Need you" as VISIBLE text. A red status dot in the Needs-you band's own color
//     says it, in the same vocabulary the tab badges glow in. The words survive verbatim as the
//     dot's accessible name (`bandCountLabel`), so nothing is lost to a screen reader.
//
// ── PER-PROJECT SEGMENTS: COLUMN ONE IS THE GLOBAL INDEX ────────────────────────────────────────
// PRD §2a listed "Grouping key across projects" as an OPEN QUESTION — per-project lines, or one
// line for the worst project? Answered by the founder 2026-07-28: column two stays project-scoped
// (mixing projects there destroys the one thing it is good at), so column one is where the global
// picture lives. The line therefore splits by project, WORST FIRST, and the segments for other
// projects are buttons that switch to them — through the same `openProjectTab` path bead
// `sparkle-vohh` fixed, not a second switcher.
import { bandColor, bandCountLabel } from "../../engine/statusBandLabels";
import type { StatusBand } from "../../engine/buildSections";
import { C, FONT_WEIGHT } from "../../theme/colors";

/** What the line says when nothing needs you. */
export const CALM_TEXT = "all calm";

/** The band the header reports. `done` and `running` are deliberately absent — see the header. */
const VITAL_BAND: StatusBand = "needs_you";

/** One project's share of the Needs-you total, as the column is handed it. */
export interface ProjectNeedsYou {
  projectId: string;
  projectName: string;
  /** This project's share of `vitals.needs_you` (feed.projects[].scopedCounts.needs_you). */
  needsYou: number;
  /** True for the project whose tab is selected — the segment that reads "here". */
  isActive: boolean;
}

/** One rendered piece of the Needs-you count: "2" · "2 here" · "1 in mobile" · "4 elsewhere". */
export interface NeedsYouSegment {
  /** The project to switch to, or null for a segment that names no single project — the undivided
   *  total, and the "N elsewhere" tail. */
  projectId: string | null;
  text: string;
  count: number;
  /** Clickable → switch to that project. False for "here" (you are already there), for the
   *  undivided total and for the tail (there is nowhere specific to go). */
  switchable: boolean;
}

/** How many segments the line may carry. THREE, because the header's whole point is that it fits on
 *  one line in a ~320px column: past this, wrapping makes it TALLER than the two-line header this
 *  replaced — it would regress the very complaint it answers. Beyond the cap the tail collapses to
 *  "N elsewhere", which keeps the segments summing to the stated total. */
const MAX_SEGMENTS = 3;

/** Longest project name a segment prints. Long names are the other way the line wraps, and folder
 *  names in this app are routinely long ("sparkle-desktop-experiments"). Truncating is a PURE rule
 *  rather than a CSS ellipsis so the width is bounded in characters — the thing that actually
 *  decides whether the line wraps — and so a test can pin it. */
const MAX_NAME_CHARS = 16;

/** The name budget UNDER PRESSURE — what a name shrinks to before its whole segment is given up.
 *
 *  Folding was the fitter's only lever, and that made it far too blunt (roborev 54254): a single
 *  long folder name cost the line its entire cross-project SWITCH AFFORDANCE, not just some
 *  characters. With `sparkle-desktop-experiments` — this repo's own canonical example, and long
 *  names are routine here — `4 here · 3 in sparkle-desktop… · 3 elsewhere` costs 47 of 43, so the
 *  split degraded to `All projects · 4 here · 6 elsewhere` and the answer to PRD §2a became
 *  unreachable from the header in exactly the case it was built for.
 *
 *  Ten characters keeps the same line at `4 here · 3 in sparkle-d… · 3 elsewhere` — 41, inside the
 *  budget, still ending on the non-interactive tail, and still carrying the button. An abbreviated
 *  name you can click beats a name you cannot see; the FULL name is on the button's `title` and in
 *  its accessible name either way, so nothing is actually lost. Tried only when the roomier budget
 *  does not fit, so ordinary readings never see it. */
const TIGHT_NAME_CHARS = 10;

/** How many characters the SEGMENTS may spend — their own text plus the " · " in front of each.
 *
 *  This exists because the CSS backstop below clips whatever runs past the edge, and the things
 *  furthest right on this line are BUTTONS. A clipped button is unclickable by mouse while still
 *  sitting in the tab order — an affordance that lies in the opposite direction from the inert one
 *  already guarded against (roborev 54233). So segments that will not fit fold into "N elsewhere",
 *  which is a plain span: the clip can then only ever bite on text.
 *
 *  A SEGMENT budget, not a whole-line one, because the rest of the line is not made of segment-
 *  shaped characters and cannot be priced as if it were (roborev 54244). Subtracting
 *  `scopeText().length` was wrong twice over: the scope renders at normal weight while every
 *  segment renders BOLD, and the red dot is a 7px box plus a 5px margin that no character count can
 *  see at all. The arithmetic instead starts from pixels and converts once:
 *
 *    column 360 (Workspace) − header padding 16×2  = 328px of text
 *    − "All projects" at ~5.2px/char (normal)       = −62
 *    − the dot's 7px box + 5px margin               = −12
 *                                                   ≈ 254px for segments and their separators
 *    ÷ ~5.9px per BOLD character at 11px            ≈ 43
 *
 *  Still approximate — a character is not a fixed width — which is why it is paired with
 *  {@link EDGE_MARGIN} and with the CSS clip underneath. But it is now approximate about the right
 *  quantity, and every term is stated so the next person can re-derive it when the column resizes. */
const MAX_SEGMENT_CHARS = 43;

/** How far inside {@link MAX_SEGMENT_CHARS} the line must sit before it may END on a button.
 *
 *  The budget alone does not carry the invariant, and this is the gap roborev 54244 found: a line
 *  can sit AT the ceiling with its counts summing exactly to the total, so `withTail` adds nothing
 *  and the rightmost element is a switchable segment — precisely the case the budget was added to
 *  prevent. Two long names and no active project is the worked example.
 *
 *  So the rule is structural rather than arithmetic: near the ceiling, the last thing on the line is
 *  always the non-interactive tail. That matters more here than it would with `overflow: hidden`,
 *  because `clip` (see the render) creates no scroll container — a clipped button could never be
 *  brought into view at all, so it must never be clipped in the first place. The margin is what
 *  absorbs the error in the estimate above. */
const EDGE_MARGIN = 5;

/** "sparkle-desktop-experiments" → "sparkle-deskto…". Short names pass through untouched.
 *
 *  `max` is the budget to spend; it is a parameter rather than a constant because the fitter drops
 *  to {@link TIGHT_NAME_CHARS} under pressure before it will give up a whole segment. */
export function shortProjectName(name: string, max: number = MAX_NAME_CHARS): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** The scope half of the line. The pinned name spends the SAME character budget the segments do —
 *  it is the other half of the same one line, and "Pinned to sparkle-desktop-experiments · 2" is
 *  ~41 characters in a ~320px column, i.e. a wrap, i.e. the height this header exists to give back.
 *  The pinned path is also the one that skips the split, so no segment rule ever reached it
 *  (roborev 54176). The full name survives as the span's `title` — see ScopeVitals. */
export function scopeText(pinnedProjectName?: string): string {
  return pinnedProjectName ? `Pinned to ${shortProjectName(pinnedProjectName)}` : "All projects";
}

/** The accessible name behind the red dot — the words the line stopped printing.
 *
 *  Straight from the SHARED `bandCountLabel`, so the singular/plural agreement ("1 Needs you" vs
 *  "3 Need you") is the same rule the project-tab badges and the sidebar chips inflect by, and
 *  cannot drift from them. */
export function needsYouLabel(total: number): string {
  return bandCountLabel(VITAL_BAND, total);
}

/**
 * The Needs-you count, split per project, worst first.
 *
 * Ordering is a TOTAL order — count descending, then the active project, then name — so the line
 * is stable across feed ticks rather than reshuffling whenever two projects tie.
 *
 * Three collapses matter:
 *   • ONE segment, and it is where you already are → the bare number ("2"). This is the founder's
 *     target reading, `All projects · 2`: "here" is noise when there is no "there".
 *   • the breakdown does not ADD UP to `total` → the bare number, undivided. The number column one
 *     states is a promise about what the thread accounts for (ConciergeHost.surfacing.test), and
 *     that promise outranks the per-project detail; segments that sum to less would quietly
 *     understate the fleet. Callers hand us `feed.projects[].scopedCounts.needs_you`, which sums to
 *     `feed.scopedCounts.needs_you` by construction, so this is a guard, not a path.
 *   • more projects than `MAX_SEGMENTS` → the tail becomes "N elsewhere", where N is the rest of the
 *     count, not the number of projects. The line stays one line and the arithmetic still adds up —
 *     and the ACTIVE project keeps a slot regardless of where it ranks, so "elsewhere" never
 *     silently contains the project you are already in.
 */
export function needsYouSegments(
  total: number,
  byProject?: readonly ProjectNeedsYou[],
): NeedsYouSegment[] {
  if (total <= 0) return [];
  const undivided: NeedsYouSegment[] = [
    { projectId: null, text: String(total), count: total, switchable: false },
  ];
  const named = (byProject ?? []).filter((p) => p.needsYou > 0);
  if (named.length === 0) return undivided;
  if (named.reduce((n, p) => n + p.needsYou, 0) !== total) return undivided;
  if (named.length === 1 && named[0]!.isActive) return undivided;
  const ranked = [...named].sort(
    (a, b) =>
      b.needsYou - a.needsYou ||
      Number(b.isActive) - Number(a.isActive) ||
      a.projectName.localeCompare(b.projectName),
  );
  // Room for the tail when there are more projects than segments: keep the worst MAX-1 and sum the
  // rest into "N elsewhere". At exactly MAX every project still gets named.
  //
  // ONE SLOT IS RESERVED FOR WHERE YOU ARE STANDING. Ranking by count alone drops "here" into the
  // tail whenever MAX-1 other projects outrank it (active=1, others 4/3/2), and the line then reads
  // `4 in mobile · 3 in api · 3 elsewhere` while 1 of that "elsewhere" is right here, in the column
  // being read. "elsewhere" is then false for part of its own count, and it hides the one project
  // the founder can act on WITHOUT switching — the opposite of what the split is for (roborev
  // 54176). The `isActive` tie-break in the sort above only covers EQUAL counts, so it cannot reach
  // this case.
  //
  // The slot is paid for out of the WEAKEST kept segment, which goes to the tail — where it is
  // honestly described, because switching is exactly what it would cost you. Order is preserved for
  // free: the trade only fires when the active project ranks below every kept one (`activeIdx >=
  // kept`), so appending it still leaves the segments worst-first. No active project in the
  // breakdown at all — reachable, since the selected project may have nothing needing you and gets
  // filtered out above — leaves `activeIdx` at -1 and the plain cap applies.
  let shown = ranked;
  if (ranked.length > MAX_SEGMENTS) {
    const kept = MAX_SEGMENTS - 1;
    const activeIdx = ranked.findIndex((p) => p.isActive);
    shown =
      activeIdx >= kept
        ? [...ranked.slice(0, kept - 1), ranked[activeIdx]!]
        : ranked.slice(0, kept);
  }
  return fitToLine(shown, total);
}

/** One project's segment at a given name budget. */
function segmentFor(p: ProjectNeedsYou, nameChars: number): NeedsYouSegment {
  return {
    projectId: p.projectId,
    count: p.needsYou,
    text: p.isActive
      ? `${p.needsYou} here`
      : `${p.needsYou} in ${shortProjectName(p.projectName, nameChars)}`,
    switchable: !p.isActive,
  };
}

/** Which projects would this name budget render under a name ANOTHER project also renders under?
 *
 *  Folder basenames are what these segments print (ConciergeHost hands over `p.name`), and shared
 *  prefixes are the norm in this repo — `sparkle-desktop`, `sparkle-desktop-experiments` and
 *  `sparkle-desktop-web` all collapse to `sparkle-d…`. Two segments reading the same thing are two
 *  BUTTONS that switch to different projects with nothing visible to tell them apart, so the only
 *  way to choose is to hover for the `title` and a wrong click moves the founder to the wrong
 *  project (roborev 54262).
 *
 *  So abbreviating may buy width, but never ambiguity: a colliding budget is refused, and the ladder
 *  falls through to the drop lever. This returns the PARTICIPANTS rather than a bare yes/no because
 *  the drop lever needs them: resolving a collision means giving up one of the pair, and any other
 *  segment it takes instead is paid for twice (roborev 54267 — see {@link fitToLine}). Order is
 *  `kept`'s, so the result is worst-first like everything else on this line.
 *
 *  Only switchable segments are compared — "N here" names no project and cannot be confused with
 *  one, and it is the one segment the fitter may never drop anyway. */
function collidingProjects(
  kept: readonly ProjectNeedsYou[],
  nameChars: number,
): ProjectNeedsYou[] {
  const switchable = kept.filter((p) => !p.isActive);
  const seen = new Map<string, number>();
  for (const p of switchable) {
    const name = shortProjectName(p.projectName, nameChars);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return switchable.filter((p) => (seen.get(shortProjectName(p.projectName, nameChars)) ?? 0) > 1);
}

/** Does this line fit — both by width and by what sits at its right edge?
 *
 *  Two clauses, and the second is the one that carries the invariant:
 *   • over {@link MAX_SEGMENT_CHARS} → no. The plain width rule.
 *   • within {@link EDGE_MARGIN} of it AND ending on a switchable segment → also no. A line can sit
 *     AT the ceiling with its counts summing exactly to the total, so no tail is appended and the
 *     rightmost element is a BUTTON — precisely the case the width rule was added to prevent
 *     (roborev 54244). Near the edge, the last thing on the line must be the non-interactive tail.
 *     That matters more under `overflow: clip` than it would under `hidden`: there is no scroll
 *     container left, so a clipped control could never be brought into view at all. */
function lineFits(segs: readonly NeedsYouSegment[]): boolean {
  const spent = segs.reduce((n, s) => n + SEPARATOR.length + s.text.length, 0);
  if (spent > MAX_SEGMENT_CHARS) return false;
  return !(segs[segs.length - 1]?.switchable && spent > MAX_SEGMENT_CHARS - EDGE_MARGIN);
}

/** Render `shown` as a line that {@link lineFits}, giving up as little as possible to get there.
 *
 *  The levers, cheapest first — the order IS the policy:
 *   1. full names. What every ordinary reading uses; nothing below is reached.
 *   2. {@link TIGHT_NAME_CHARS}. Abbreviating a name costs characters the full name is already
 *      recoverable from (the button's `title` and accessible name carry it in full). Dropping a
 *      segment costs the whole switch affordance, so trying this first is not a nicety — it is what
 *      keeps a long folder name from silently removing the feature (roborev 54254).
 *      A budget that makes two projects read the SAME is skipped outright — see
 *      {@link collidingProjects}. Width is worth buying; ambiguity between two live buttons is not.
 *   3. drop a switchable segment into the "N elsewhere" tail, and start again from full names, since
 *      one fewer segment may make them affordable.
 *
 *  WHICH segment lever 3 drops is the whole of roborev 54267. The weakest one globally is right when
 *  the blocker is WIDTH — the line is simply too long and the cheapest characters go. It is wrong
 *  when the blocker is a COLLISION, because the ambiguity lives in a specific pair and an outsider's
 *  segment does nothing to resolve it: the line pays once for the innocent segment and then again
 *  for one of the pair on the next pass. Worked example (none active, total 10):
 *  `my-desktop-experiments`(5), `my-desktop-web`(4), `api`(1) — full names cost 57 of 43 and the
 *  tight budget collides the first two, so dropping the weakest overall spends `api` and still ends
 *  at one named project, while dropping the colliding loser keeps two and every button unambiguous:
 *  `5 in my-deskto… · 1 in api · 4 elsewhere`.
 *
 *  So the target is the weakest participant in the collision that blocked the CHEAPEST budget — the
 *  loosest one, since resolving a tighter budget's ambiguity would leave the looser one still
 *  refused. With no collision in the ladder at all, the blocker really was width and the weakest
 *  segment overall goes, exactly as before.
 *
 *  Two invariants hold throughout: the ACTIVE segment is never dropped — it is the slot reserved
 *  above, the one project you can act on without switching, and also the shortest segment there is,
 *  so it can never be what pushed the line over — and the tail is rebuilt from the TOTAL each pass,
 *  so the segments keep summing to the number the line states however much was given up.
 *
 *  Terminates: every pass removes one droppable project, and the last one is never dropped. */
function fitToLine(shown: readonly ProjectNeedsYou[], total: number): NeedsYouSegment[] {
  const withTail = (kept: readonly ProjectNeedsYou[], nameChars: number): NeedsYouSegment[] => {
    const named = kept.map((p) => segmentFor(p, nameChars));
    const rest = total - named.reduce((n, s) => n + s.count, 0);
    return rest > 0
      ? [...named, { projectId: null, count: rest, text: `${rest} elsewhere`, switchable: false }]
      : named;
  };
  let kept = [...shown];
  for (;;) {
    // The collision that refused the CHEAPEST budget, if any — the drop target below comes from it
    // rather than from the line at large. Empty means every budget was refused on width alone.
    let blocked: readonly ProjectNeedsYou[] = [];
    for (const nameChars of [MAX_NAME_CHARS, TIGHT_NAME_CHARS]) {
      const clash = collidingProjects(kept, nameChars);
      if (clash.length > 0) {
        if (blocked.length === 0) blocked = clash;
        continue;
      }
      const out = withTail(kept, nameChars);
      if (lineFits(out)) return out;
    }
    // The WEAKEST droppable project — the LAST one, since both lists are worst-first. Never the only
    // one left: a bare line says less than an abbreviated one, and a single segment plus its tail
    // is ~44 characters at the very worst, which the tight pass above always brings inside budget.
    // `blocked` never contains the active project, so the reserved slot survives either way.
    const droppable = blocked.length > 0 ? blocked : kept;
    const drop = kept.length > 1 ? [...droppable].reverse().find((p) => !p.isActive) : undefined;
    if (!drop) return withTail(kept, TIGHT_NAME_CHARS);
    kept = kept.filter((p) => p !== drop);
  }
}

/** The breakdown the LINE may use, given the scope.
 *
 *  A pin scopes every count to one project (services/conciergeFeed), so under a pin the split can
 *  only ever name the project the line already opens with — "Pinned to web · 2 in web", saying the
 *  same project twice and offering to switch you to where you are. The pin IS the grouping key, so
 *  the split is dropped and the total stands undivided. */
function splitFor(
  pinnedProjectName: string | undefined,
  byProject?: readonly ProjectNeedsYou[],
): readonly ProjectNeedsYou[] | undefined {
  return pinnedProjectName ? undefined : byProject;
}

/** The WHOLE line as one string — what `container.textContent` reads. Exported so a test can pin
 *  the founder's reading end to end rather than assembling it from pieces. */
export function vitalsLineText(
  pinnedProjectName: string | undefined,
  total: number,
  byProject?: readonly ProjectNeedsYou[],
): string {
  const parts = needsYouSegments(total, splitFor(pinnedProjectName, byProject)).map((s) => s.text);
  return [scopeText(pinnedProjectName), ...(parts.length > 0 ? parts : [CALM_TEXT])].join(" · ");
}

/** The accessible name of a switchable segment — where the click goes, and what is waiting. */
export function switchLabel(projectName: string, count: number): string {
  return `Switch to ${projectName} — ${needsYouLabel(count)}`;
}

const SEPARATOR = " · ";

export function ScopeVitals({
  pinnedProjectName,
  counts,
  byProject,
  onProjectClick,
  dense = false,
}: {
  pinnedProjectName?: string;
  counts: Record<StatusBand, number>;
  /** Per-project split of `counts.needs_you`. Absent → the line states the undivided total. */
  byProject?: readonly ProjectNeedsYou[];
  /** A segment naming ANOTHER project was clicked: switch to it. */
  onProjectClick?: (projectId: string) => void;
  /** THE SCOPE PILL: this line rendered as one item INSIDE the concierge's single header row
   *  (rev4.html's `.ahd`) rather than as a centred block of its own beneath it.
   *
   *  It drops the top margin and the centring — both belong to a block that owns its own line —
   *  and becomes shrinkable, so the pills and the avatar to its right keep their width and the
   *  scope text is what gives way when the column narrows. Everything that makes the line correct
   *  is untouched: the character budget, the elide-don't-wrap rule, the per-segment accessible
   *  names. This is a placement flag, not a second rendering. */
  dense?: boolean;
}) {
  const total = counts[VITAL_BAND];
  const split = splitFor(pinnedProjectName, byProject);
  const segments = needsYouSegments(total, split);
  const tint = bandColor(VITAL_BAND);
  return (
    <div
      data-testid="concierge-vitals-line"
      // A plain INLINE flow, deliberately not a flex row: the separators are literal " · " text
      // nodes, and inside a flex item their leading/trailing spaces are stripped from the item's
      // own line box — so a flex layout renders "All projects·2" while `textContent` still reads
      // the spaces, i.e. a spacing regression no assertion on the text could see.
      style={{
        textAlign: dense ? "left" : "center",
        marginTop: dense ? 0 : 8,
        // In the header row this is the ONE item that may give way — the pills and the avatar
        // beside it have fixed content and a fixed cost, and the scope text already knows how to
        // elide (see the clip/ellipsis note below).
        ...(dense ? { flex: "1 1 auto", minWidth: 0 } : null),
        fontSize: 12,
        color: C.conciergeMuted,
        // THE ONE-LINE PROMISE, enforced rather than merely budgeted. `MAX_SEGMENTS` and
        // `MAX_NAME_CHARS` bound the line in CHARACTERS — the thing that actually decides a wrap —
        // but a character is not a fixed width: a theme with a wider face, browser zoom, or a
        // narrower column all move the boundary, and nothing about a wrapped line throws. So past
        // the budget the line ELIDES instead of growing a second row, because a second row is the
        // exact complaint the collapse answered (founder, 2026-07-27).
        //
        // Container-level, NOT per-segment `maxWidth`: these segments are inline spans in a
        // deliberately inline flow (see below), and `max-width` does nothing to an inline box —
        // making them `inline-block` to honour it is precisely what strips the literal " · "
        // separators' spaces from each item's line box, rendering "All projects·2" while
        // `textContent` still reads the spaces. One clip on the container costs none of that.
        // `clip`, NOT `hidden` (roborev 54233): `hidden` makes this a SCROLL CONTAINER, and this
        // line holds focusable buttons. Focusing one that sits past the edge scrolls the box
        // programmatically, and with no scrollbar there is nothing the user can do to scroll back —
        // the line stays offset for the rest of the session. `clip` creates no scroll container at
        // all, so that is unreachable. `text-overflow` still applies (it wants any `overflow` other
        // than `visible`), and `clip` is WebKit-supported since Safari 16 — this app is a WKWebView.
        //
        // MAX_LINE_CHARS is what keeps a BUTTON off the clipped edge in the first place; this is the
        // pixel-level backstop under that arithmetic, and by then the rightmost element is the
        // non-interactive "N elsewhere" tail.
        whiteSpace: "nowrap",
        overflow: "clip",
        textOverflow: "ellipsis",
      }}
    >
      <span
        // The FULL pinned name on hover, since `scopeText` spends the same width budget the
        // segments do — the truncation is a width budget, not a rename. Nothing to recover when
        // unpinned ("All projects" is not a name), so no title there.
        title={pinnedProjectName}
        // …and the full name to ASSISTIVE TECH too. `title` on a role-less span is not part of the
        // accessible name computation, so a screen reader would otherwise read the elided
        // "Pinned to sparkle-desktop…" — while the segment buttons beside it deliberately announce
        // their project's full name, because a screen reader has no width problem (roborev 54233).
        // `role="text"` is what gives a span an accessible name at all; unpinned there is nothing
        // hidden, so it takes neither.
        {...(pinnedProjectName
          ? { role: "text", "aria-label": `Pinned to ${pinnedProjectName}` }
          : null)}
        style={{
          // Prototype `.scope.pinned { color: var(--gold) }` — the same accent the pinned tab tilts
          // to. The themed ink, since this is TEXT (see C.goldInk).
          color: pinnedProjectName ? C.goldInk : C.conciergeMuted,
        }}
      >
        {scopeText(pinnedProjectName)}
      </span>
      {segments.length === 0 ? (
        <span>{`${SEPARATOR}${CALM_TEXT}`}</span>
      ) : (
        <>
          <span>{SEPARATOR}</span>
          {/* THE COUNT'S ONLY WORDS, and they are for the screen reader. `role="img"` is what makes
              an empty box carry an accessible name at all; without it this dot is invisible to
              assistive tech and the number beside it means nothing. */}
          <span
            data-testid="concierge-needs-dot"
            role="img"
            aria-label={needsYouLabel(total)}
            style={{
              display: "inline-block",
              verticalAlign: "middle",
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: tint,
              marginRight: 5,
            }}
          />
          {segments.map((seg, i) => (
            <span key={seg.projectId ?? "all"}>
              {i > 0 ? <span>{SEPARATOR}</span> : null}
              {/* A BUTTON only when there is somewhere to go AND something to take you there. With
                  no `onProjectClick` (both it and the controller field are optional) a button would
                  be an affordance that lies: focusable, underlined, cursor-pointer, named "Switch
                  to X" — and inert. */}
              {seg.switchable && seg.projectId !== null && onProjectClick ? (
                <button
                  type="button"
                  // The FULL project name in the accessible name and on hover, even when the
                  // visible text is truncated: the truncation is a width budget, not a rename, and
                  // a screen reader has no width problem.
                  aria-label={switchLabel(segmentProjectName(split, seg.projectId), seg.count)}
                  title={segmentProjectName(split, seg.projectId)}
                  onClick={() => onProjectClick(seg.projectId!)}
                  style={{
                    // A LINK-shaped button, not a chip: the line is a sentence and a boxed control
                    // in the middle of it re-inflates exactly the header height this change bought.
                    appearance: "none",
                    background: "none",
                    border: "none",
                    padding: 0,
                    font: "inherit",
                    fontWeight: FONT_WEIGHT.bold,
                    color: tint,
                    cursor: "pointer",
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                  }}
                >
                  {seg.text}
                </button>
              ) : (
                <span style={{ fontWeight: FONT_WEIGHT.bold, color: tint }}>{seg.text}</span>
              )}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/** The name behind a segment's project id. The segment carries the id (that is what the click
 *  needs); the label wants the name, and re-deriving it here keeps `NeedsYouSegment` from carrying
 *  two spellings of the same project that could disagree. */
function segmentProjectName(
  byProject: readonly ProjectNeedsYou[] | undefined,
  projectId: string,
): string {
  return (byProject ?? []).find((p) => p.projectId === projectId)?.projectName ?? projectId;
}
