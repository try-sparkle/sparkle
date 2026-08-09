// The app's ONE pull-request affordance — a FLEET-WIDE, agent-independent menu of the open pull
// requests this identity owns across every open project tab, grouped by tab name, with a per-PR
// Merge, a per-group "Merge all ready", a Refresh, and a jump to the agent that opened each one.
//
// It mounts in the CONCIERGE HEADER (`compact`, beside the ⋮ — see `ConciergePrChip`), not in the
// project tab strip where the wide "N PRs waiting" pill used to sit. `compact` changes the badge,
// the panel's anchor, and the empty-state rule, and nothing else.
//
// Why it lives here and not on the agent row: the per-agent "Merge PR" CTA dies with its agent, and
// every agent leaves the sidebar when its session ends — so a PR opened by a finished session goes
// invisible exactly when it is waiting to be merged. This menu is the durable, always-present gate.
//
// ── WHY IT ASKS EVERY PROJECT, AND WHY IT NO LONGER UNMOUNTS (bead sparkle-lcx8y) ──────────────
//
// This component used to take ONE `rootPath`/`projectId`, chosen for it by a precedence rule in
// `ConciergeHost`, and the chip rendered only when that rule produced a project. Both halves failed
// the founder in the same session: his concierge was scoped to a project with no pull requests while
// all ten of his — six of them mergeable — lived in another, and when no project resolved at all the
// control UNMOUNTED entirely. A chiclet reading zero would have been honest. Silent absence taught
// him the feature had been deleted.
//
// So scope is not a choice between projects any more. `scopes` is EVERY open project tab, the list
// is grouped by the tab's own name, and the compact badge renders whenever it has a scope to ask
// about — see the empty-state note on `compact` below. Three rules follow, and each one is a way
// this surface could otherwise do real damage:
//
//   • EVERY ROW CARRIES ITS OWN REPO. `runMerge` takes the group's scope rather than reading an
//     ambient one, because `merge_pr` is addressed by (rootPath, number) and PR NUMBERS COLLIDE
//     ACROSS REPOSITORIES. A row that inherited a default repo would merge a stranger's #12. That is
//     the one irreversible mistake available here, so the binding is explicit at every call site and
//     every ledger is keyed by repo+number (`prKeyOf`).
//   • "MERGE ALL READY" IS SCOPED TO ONE GROUP. Fleet-wide it would be a far bigger button than it
//     was per-project — one click merging across repositories. It lives in the GROUP header instead,
//     naming the project it will act on. There is deliberately no fleet-wide merge-everything.
//   • THE GROUPS ARE IN TAB ORDER, which `buildPrGroups` preserves from its caller. Sections read
//     top-to-bottom the way the tabs read left-to-right.
//
// The Merge action is deliberately gated (`prMergeReadiness` — one decision behind the dot, the
// word, the button and the header count) and merges with a MERGE COMMIT via the Rust `merge_pr`
// command — never a blind or `--auto` merge. See services/openPrs.ts and AGENTS.md.
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  FiChevronDown,
  FiChevronRight,
  FiExternalLink,
  FiEyeOff,
  FiGitBranch,
  FiGitPullRequest,
} from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { ModalLayer } from "./ModalLayer";
import { pillStyle } from "./Concierge/pillStyle";
import {
  fetchOpenPrs,
  formatPrBadge,
  mergePr,
  prListSaturated,
  prMergeReadiness,
  OPEN_PR_POLL_MS,
  type JudgedPrRow,
  type PrDotTone,
  type PrProbeState,
  type PrRow,
} from "../services/openPrs";
import {
  evictProbeGates,
  fetchProbeGates,
  probeStateOf,
  refreshProbeGates,
  unansweredBlockingProbes,
  type ProbeDetail,
  type ProbeGateTarget,
} from "../services/probeGate";
import {
  buildPrGroups,
  fleetHeadline,
  fleetState,
  fleetTotals,
  keyOfScope,
  prKeyOf,
  prReadinessSnapshot,
  probeStrength,
  scopeIdentitySetKey,
  scopeSetKey,
  staleProjectNames,
  unreadableProjectNames,
  type FleetTotals,
  type PrGroup,
  type PrScope,
} from "../services/fleetPrs";
import {
  isKnightwatchRefusal,
  knightwatchReasonFor,
  knightwatchReasonIssue,
  refusalLines,
  type KnightwatchOverrideFor,
} from "../services/mergeGuard/knightwatch";
import {
  dismissPr,
  dismissedNumbers,
  fetchDismissals,
  partitionDismissals,
  restorePr,
  type PrDismissal,
} from "../services/prDismissals";
import { usePrReadinessStore } from "../stores/prReadinessStore";
import { log } from "../logger";
import type { Project } from "../types";

export type { PrScope } from "../services/fleetPrs";

/** A live agent that opened a given PR's branch — enough for the menu to offer "Open agent". */
export interface PrAgentLink {
  agentId: string;
  agentName: string;
  projectId: string;
  /** True when the agent lives in the currently-shown project (a same-window select vs a route). */
  isCurrentProject: boolean;
}

/**
 * The live agent whose `branch` field EQUALS `branch`, or null. Searched across ALL projects (a PR
 * you're merging may belong to another project's agent). Pure so the join — the bit most likely to
 * regress (a null branch, a worker sharing a name) — is unit-tested without a component. A
 * null/empty `branch` never matches (an unstarted or think agent has none).
 *
 * This is a LIVE-ROSTER join and dies with the agent, which is why it is no longer the primary
 * answer: see {@link agentLinkForPr}.
 */
export function agentLinkForBranch(
  branch: string,
  projects: Project[],
  currentProjectId: string | null,
): PrAgentLink | null {
  if (!branch) return null;
  for (const p of projects) {
    const a = p.agents.find((ag) => ag.branch === branch);
    if (a)
      return {
        agentId: a.id,
        agentName: a.name,
        projectId: p.id,
        isCurrentProject: p.id === currentProjectId,
      };
  }
  return null;
}

/**
 * The agent that opened `pr`, or null — "Open agent" for a row in the menu.
 *
 * Prefers the DURABLE `pr.agentId` Rust records at PR-creation time, which is right whatever the
 * branch is called; the roster join is only a fallback for a PR opened before the mapping existed.
 * The old code path was the fallback ALONE, which is why a PR on a descriptive branch (no agent id
 * in the name) could never offer "Open agent" at all.
 *
 * A recorded id still has to name an agent that is actually in the roster before it becomes a
 * clickable link — the link's whole job is to OPEN that agent, and a link to an agent that no
 * longer exists is a dead end, not a shortcut.
 *
 * A KNOWN owner that is absent from the roster yields NULL, and specifically does NOT fall through
 * to the branch join (roborev 55253). The fallback exists for a PR whose owner was never recorded;
 * reaching it with a recorded owner in hand would re-attribute that PR by branch name — the very
 * inference this module exists to demote — and hand the reader a pill that opens an agent we
 * already know did not open the PR. "The owner left" and "nobody recorded an owner" are different
 * facts and only the second one may be guessed at.
 */
export function agentLinkForPr(
  pr: Pick<PrRow, "headRefName" | "agentId">,
  projects: Project[],
  currentProjectId: string | null,
): PrAgentLink | null {
  if (pr.agentId) {
    for (const p of projects) {
      const a = p.agents.find((ag) => ag.id === pr.agentId);
      if (a)
        return {
          agentId: a.id,
          agentName: a.name,
          projectId: p.id,
          isCurrentProject: p.id === currentProjectId,
        };
    }
    return null;
  }
  return agentLinkForBranch(pr.headRefName, projects, currentProjectId);
}

// ── CONTAINMENT: THE WIDE FORM CLAMPS IN CSS, THE COMPACT ONE IS PLACED ────────────────────────
//
// These are two different problems and they now have two different answers. Read the whole note
// before reintroducing either half — the CSS-only rule below was right for the case it was written
// for, and applying it to the compact panel is the bug this section exists to record.
//
// THE WIDE (tab-strip) FORM — pure CSS, and deliberately so (roborev 53787). There used to be a
// measure-and-nudge layout effect here: it read the panel's rect, computed a `translateX` via a
// `panelShiftX` helper, and re-ran on `resize`. It was justified by "the app supports zoom, and
// zooming in shrinks the viewport in CSS pixels" — and that is simply not what zoom is in this app.
// `uiStore.zoom` (ZOOM_MIN/ZOOM_MAX) is an application-level FONT-SCALE; its only consumer is
// Terminal.tsx, which multiplies xterm's fontSize by it. It does not change `window.innerWidth`,
// does not change `100vw`, and does not fire a `resize` event. So the effect's one trigger was a
// real window resize — exactly the case the `100vw` clamps handle — while the case it was written
// for could never re-run it. Worse, its deps were `[open, prs?.length]`, so every content-driven
// change while the panel was open (the error banner appearing, "Open agent" appearing once
// resolveAgent finds one, the merge-in-flight labels) left the applied shift stale. It was dropped
// rather than rewired because the clamps genuinely suffice for a panel hung off a badge that is
// itself flush right in a full-width bar.
//
// THE COMPACT (concierge-header) FORM cannot be solved that way, and spent a release trying.
// It spanned the header — `left: 8; right: 8` — which contains it by construction and needs no
// measurement, and that is exactly what the founder filed as a bug (bead sparkle-8g4qh): the
// concierge is a COLUMN, so a panel that spans it is a panel the width of a column, and this menu's
// whole job is to answer "what can I merge, and why not the rest". Every field carrying that answer
// was the field being elided — the primary button sliced to "Merge all re", the failing-check
// reason to "1 c...". Being asked to press "Merge anyway" on a PR whose failure you cannot read is
// the actual damage; the truncated titles are cosmetic beside it.
//
// An overlay does not have to obey the box that spawned it, so this one no longer does. It PORTALS
// to the root layer (`ModalLayer`) and is placed by `panelPlacement` below, clamped to the WINDOW.
// Two things follow, and both are load-bearing:
//
//   • The portal is not decoration. `ConciergeColumn`'s root section is `position: relative` +
//     `CONCIERGE_LIFT_Z` (3), i.e. a stacking context — so this panel's `zIndex: 41` and its
//     backdrop's 40 were capped at 3 for as long as they rendered inside it, and `ColumnPullTab`'s
//     rail (4) and a floated Build column (SIDEBAR_OVERLAY_Z, 25) outranked them. A panel that
//     crosses columns and paints UNDER them has not been fixed. See components/ModalLayer.tsx,
//     which is the app's one primitive for this, and components/layers.ts for the bands.
//
//   • Measurement is back, but ONLY of the anchor — never of the panel. That distinction is what
//     kills the staleness bug the old effect had: the panel's width is a function of the VIEWPORT
//     alone (`min(PANEL_MAX_W, innerWidth - 2·margin)`), not of its content, so no content change
//     can invalidate a placement. The inputs are the anchor rect and the window size, and both have
//     real events — the panel is placed on open and re-placed on resize, and nothing else can move
//     it. A pointer-down anywhere else hits the click-away backdrop and closes it first.
//
// GROUPING BY PROJECT DID NOT CHANGE ANY OF THIS, which is the point of the width being a constant:
// the rows got a section header above them and a project name to carry, and the placement rule did
// not have to be touched, because it never depended on what the panel contains.
//
// Do not "simplify" this back to `left: 8; right: 8`. That is the reported bug, not a tidier form.

/** Clearance the panel keeps from either window edge. */
export const PANEL_EDGE_MARGIN = 8;
/** The gap between the badge's bottom and the panel's top. */
export const PANEL_ANCHOR_GAP = 4;
/**
 * How wide the compact panel gets when the window allows it.
 *
 * WIDER THAN THE CONCIERGE COLUMN ON PURPOSE — that is the entire point of the fix. It is sized to
 * what the CONTENT needs rather than to what the column offers: the header row (count · Refresh),
 * a group header (project name · "Merge all ready (11)") and the widest realistic PR row (dot ·
 * #number and subject · "Open agent" · GitHub · "Merge") all fit here without the two things that
 * may never be elided — the primary action and the reason a PR is red — giving up a pixel.
 *
 * A CONSTANT rather than a measurement of the rendered content, and that is the load-bearing half:
 * a content-derived width would have to be re-measured on every content change while the panel is
 * open, which is the precise defect the deleted measure-and-nudge effect shipped with. Width that
 * depends only on the viewport means placement can only go stale on `resize`, which is an event.
 */
export const PANEL_MAX_W = 640;

/** Where the compact panel is pinned: absolute window coordinates, for a `position: fixed` box. */
export interface PanelPlacement {
  left: number;
  top: number;
  width: number;
}

/**
 * THE ONE CLAMPING RULE for the compact panel — pure, so it is tested without a layout engine.
 *
 * jsdom computes no layout, so a CSS `min()`/`calc()` clamp cannot be verified in the suite at all
 * (only its literal text can, which is how the wide form's clamps are pinned). Doing the arithmetic
 * here instead means the actual containment guarantee is asserted rather than a string that is
 * believed to imply it.
 *
 * The rule, in one line: **hang the panel's RIGHT edge off the badge's, then clamp the whole box
 * inside the window.** Why right-hang, and why one formula covers both docks — the concierge can be
 * moved to either side of the shell, and this is the thing that made "no fixed anchor is right for
 * both" true of the old CSS:
 *
 *   • Concierge docked RIGHT: the badge is near the window's right edge, so right-hanging extends
 *     the panel LEFTWARD across the columns beside it and the clamp never fires. This is the common
 *     arrangement and the one the founder screenshotted.
 *   • Concierge docked LEFT: right-hanging would put the panel's left edge off the window, so the
 *     lower clamp catches it at `PANEL_EDGE_MARGIN` and it extends RIGHTWARD across its neighbours
 *     instead. Same formula, opposite spill, no branch on which side the column is on — which is
 *     good, because this component is not told.
 *
 * SURVIVES THE 50px COLUMN FLOOR (Per Column Zoom, bead sparkle-t3tr) for free: the anchor's own
 * width is never an input. Squeezing the concierge to 50px moves the badge, and the panel follows
 * it at full width instead of shrinking with it. The upper clamp is what stops a badge near the
 * right edge pushing the box off that side, and the width term is what stops a window narrower than
 * `PANEL_MAX_W` overflowing at all — so both extremes are held, and the panel is never wider than
 * the window less its margins whatever the anchor does.
 */
export function panelPlacement(
  anchor: { right: number; bottom: number },
  viewport: { width: number },
): PanelPlacement {
  // Never wider than the window less a margin at each side. `max(0, …)` so a degenerate viewport
  // yields a zero-width box rather than a negative one that would invert the clamp below.
  const width = Math.max(
    0,
    Math.min(PANEL_MAX_W, viewport.width - PANEL_EDGE_MARGIN * 2),
  );
  // The rightmost left-coordinate that still leaves the margin on the right. Floored at the left
  // margin so the range is never inverted — if it were, the two clamps would fight and `Math.min`
  // would win, pushing the panel off the LEFT edge to keep it off the right.
  const rightMost = Math.max(
    PANEL_EDGE_MARGIN,
    viewport.width - PANEL_EDGE_MARGIN - width,
  );
  const left = Math.min(
    Math.max(anchor.right - width, PANEL_EDGE_MARGIN),
    rightMost,
  );
  return { left, top: anchor.bottom + PANEL_ANCHOR_GAP, width };
}

/**
 * Colour for a PR's status dot, keyed off the TONE `prStatusDot` decides — not off the CI rollup.
 *
 * This used to be `checksColor(pr.checks)`, which is how a conflicting-but-green-CI PR (#779) got a
 * confident green dot next to a Merge button that could never work. The whole decision now lives in
 * `prMergeReadiness`, so this is purely the palette.
 *
 * Note there is no longer a muted "nothing to report" colour: the dot answers one yes/no question
 * ("safe to merge right now?"), and a fourth colour was a third answer to it.
 */
function dotColor(tone: PrDotTone): string {
  switch (tone) {
    case "ready":
      return C.success;
    case "waiting":
      return C.amber;
    case "blocked":
      return C.sienna;
  }
}

/**
 * The probe disclosure's name, used for BOTH its `aria-label` and its `title`.
 *
 * One function so the two cannot drift: the tooltip a mouse reader gets and the name a screen
 * reader announces are the same sentence, and the count is stated in both.
 */
function probeDisclosureLabel(count: number, open: boolean): string {
  return open
    ? "Hide the probes blocking this PR"
    : `Show the ${count} unanswered ${count === 1 ? "probe" : "probes"} blocking this PR`;
}

/** Shown in the panel's own staleness slot — BENEATH any merge error, never in place of one — when
 *  a probe failed and the list on screen is what we last managed to read. The two are independent
 *  facts, and the case where both are true is the common one: a merge fails because `gh` is
 *  unavailable, and the refetch that follows fails for exactly the same reason. */
export const PROBE_FAILED =
  "Couldn't reach GitHub just now — this is the last list we could read, so it may be out of date.";

/**
 * The staleness notice, NAMING the projects we could not read rather than counting them.
 *
 * The reader needs to know which PART of the list to distrust; "1 project could not be read" leaves
 * them re-checking all of them. With one project open there is nothing to disambiguate, so it says
 * the original sentence verbatim.
 */
export function probeFailedFor(names: readonly string[]): string {
  if (names.length === 0) return PROBE_FAILED;
  if (names.length === 1) {
    return `Couldn't reach GitHub for ${names[0]} just now — this is the last list we could read for it, so it may be out of date.`;
  }
  return `Couldn't reach GitHub for ${names.join(", ")} just now — this is the last list we could read for them, so those sections may be out of date.`;
}

/**
 * The notice for projects we could not read AT ALL — a failed probe with no earlier list behind it.
 *
 * A DIFFERENT SENTENCE FROM {@link probeFailedFor}, not a shared one with the names swapped. That
 * one says "what you can see may be out of date", which presupposes there is something to see; here
 * there is not. The reader's actual question is "does this list cover my whole fleet", and for these
 * projects the answer is no — so the notice has to say the project is MISSING from the list rather
 * than merely stale, or a repo full of open pull requests reads as a repo with none.
 */
export function probeUnreadableFor(names: readonly string[]): string {
  if (names.length === 0) return "";
  // ONE branch on `names.length`, not three parallel ternaries. The first version picked the
  // subject/verb pair in one place and the pronoun in another, so an edit to either could ship
  // "they isn't counted or listed here" with a green suite (roborev 57724).
  const { pronoun, verb } =
    names.length === 1
      ? { pronoun: "it", verb: "isn't" }
      : { pronoun: "they", verb: "aren't" };
  return `Couldn't reach GitHub for ${names.join(", ")} — ${pronoun} ${verb} counted or listed here. Try Refresh.`;
}

// ── THE KNIGHTWATCH PROBE REFUSAL ──────────────────────────────────────────────────────────────
//
// Rust's `merge_pr` refuses a PR that still carries unanswered knightwatch `[blocking]` review
// probes, and it refuses with SEVERAL LINES: each probe, its specialist, a link to the comment, and
// the probe's first line quoted. Everything below exists because a refusal the founder cannot act on
// is just an obstacle — the message has to arrive with its structure intact, and the way past it has
// to be reachable without leaving the panel.

/** What the row's override button says before it is armed. Short by construction: this is the
 *  primary action slot and the hard rule on this surface is that it never truncates. */
export const PROBE_OVERRIDE_LABEL = "Override probes…";
/** …and after. It names what the second click DOES, the way the `unstable` override's
 *  "Merge anyway?" does — the arming step is worth nothing if the armed label is the same word. */
export const PROBE_OVERRIDE_ARMED_LABEL = "Merge with reason";
/** The standing hint under the reason box. Says where the sentence GOES, because that is the fact
 *  that makes an override cost something: it is recorded on the pull request under your name. */
export const PROBE_REASON_HINT =
  "A sentence, please — it is recorded on the pull request as your reason for merging with the probe unanswered. Answering the probe on the PR is the way through; this is not.";
/** Shown when the typed reason will not do yet, so the disabled button is never mute. */
export const PROBE_REASON_SHORT =
  "That is not a reason yet — say why merging unanswered is safe.";

/**
 * The bulk-merge report: which PRs a batch left BEHIND, and why they are not all covered by one
 * decision.
 *
 * "Merge all ready" walks N pull requests. A single reason spent across the batch would turn a
 * per-PR judgement into a blanket waiver — and the probes are per-PR by construction, since each is
 * a reviewer's question about that diff. So a refused PR is reported and SKIPPED, and its override
 * is offered on its own row afterwards.
 */
export function probeRefusedInBatch(numbers: readonly number[]): string {
  const list = numbers.map((n) => `#${n}`).join(", ");
  return `Skipped ${numbers.length} PRs with unanswered knightwatch probes (${list}). Each probe is a question about that PR, so one reason cannot cover them — override them one row at a time.`;
}

/**
 * The merge error, rendered so it survives being read.
 *
 * ONE ELEMENT PER LINE rather than a `white-space: pre-wrap` string, and that is a testability
 * decision as much as a visual one: jsdom lays nothing out and never loads the stylesheet, so an
 * assertion about wrapping CSS proves nothing (docs/jsdom-test-caveats.md). A line that is its own
 * element is a fact the suite can hold onto.
 *
 * The LINKS are buttons, not text. The refusal's whole value is that it points at the comment
 * carrying the question; a URL the reader has to select and retype points nowhere. Ordinary
 * single-line errors ("Pull request is not mergeable") pass through this unchanged — one line, no
 * links, same rendering as before.
 */
function MergeErrorText({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink: (url: string) => void;
}) {
  return (
    <>
      {refusalLines(text).map((segments, i) => (
        <div
          key={i}
          data-testid="merge-error-line"
          // Indentation carries meaning in the probe list (the link sits under its probe), and a
          // block box strips leading whitespace without this.
          style={{
            whiteSpace: "pre-wrap",
            minHeight: segments.length === 0 ? "0.7em" : undefined,
          }}
        >
          {segments.map((s, j) =>
            s.kind === "link" ? (
              <button
                key={j}
                data-testid="merge-error-link"
                title={s.url}
                onClick={() => onOpenLink(s.url)}
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: C.violetInk,
                  textDecoration: "underline",
                  cursor: "pointer",
                  // A URL is one long unbreakable token; without this it forces the panel wide.
                  wordBreak: "break-all",
                  textAlign: "left",
                }}
              >
                {s.text}
              </button>
            ) : (
              <span key={j}>{s.text}</span>
            ),
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The one sentence the badge says — as its accessible NAME and as its tooltip, so a mouse user and
 * a screen-reader user are told the same thing. Shared rather than written twice because the compact
 * badge has no readable label of its own: its whole visible content is a glyph and a numeral.
 *
 * RENDERS FROM `fleetState` AND NOTHING ELSE, which is the point. This function and `fleetHeadline`
 * have to make the same claims about the same fleet, and three reviews running found them
 * disagreeing — a hedge added to the panel and not the badge, then added to one branch of both and
 * not its neighbour. The badge is the surface that matters more for this: the headline costs a
 * click, while this string is what a hover and a screen reader get for free. Taking the whole
 * `totals` and switching on the shared state is what makes "they cannot drift" structural rather
 * than something a reviewer has to keep noticing.
 */
export function prBadgeTitle(
  label: string | null,
  totals: FleetTotals,
  /**
   * Whether any probe behind `totals` came back TRUNCATED, so `totals.total` is a floor.
   *
   * The `counted`-with-ready branch below builds its own sentence out of `totals.total` instead of
   * reusing `label`, so the hedge `formatPrBadge` applies would not have reached it — the pill would
   * read "300+ PRs waiting" while its own accessible name said "3 of 300 open pull requests". This
   * is the audit AGENTS.md asks for when a behaviour's honesty changes: every string that restates
   * the number has to restate the hedge too.
   */
  saturated = false,
): string {
  // "at least N" wherever the total is spelled out. `label` already carries its own hedge.
  const total = saturated ? `${totals.total}+` : `${totals.total}`;
  switch (fleetState(totals)) {
    case "nothing-askable":
      return "No project with a GitHub remote";
    case "checking":
      return "Pull requests — checking GitHub";
    case "unreachable":
      return "Pull requests — couldn't reach GitHub";
    case "zero-partial":
      return "No open pull requests in the projects we could read";
    case "zero":
      return "No open pull requests";
    case "counted":
      return totals.ready > 0
        ? `${totals.ready} of ${total} open pull request${totals.total === 1 ? "" : "s"} ready to merge`
        : `${label ?? "Pull requests"} — none ready to merge yet`;
  }
}

/**
 * The panel's backdrop + card, either portaled to the root layer or left where they are.
 *
 * ONE WRAPPER RATHER THAN TWO COPIES of the panel's JSX, which is ~180 lines of merge controls: the
 * two forms differ in where the markup LANDS and in nothing else, and duplicating it to branch on a
 * portal is how the wide form quietly stops receiving the fixes the compact one gets. Written as a
 * component rather than as a `portaled ? createPortal(x) : x` expression at the call site because
 * `ModalLayer` owns a hook (it tracks the host's inherited `visibility`), so it has to be a real
 * element in the tree.
 */
function PanelLayer({
  portaled,
  children,
}: {
  portaled: boolean;
  children: ReactNode;
}) {
  return portaled ? <ModalLayer>{children}</ModalLayer> : <>{children}</>;
}

/** Drop every entry whose key has left the live scope set — returning `prev` UNCHANGED when nothing
 *  went, so a re-render caused by an unrelated prop cannot cascade into another one. */
function pruneMap<V>(
  prev: ReadonlyMap<string, V>,
  live: ReadonlySet<string>,
): ReadonlyMap<string, V> {
  let dropped = false;
  const next = new Map<string, V>();
  for (const [k, v] of prev) {
    if (live.has(k)) next.set(k, v);
    else dropped = true;
  }
  return dropped ? next : prev;
}

/** The `pruneMap` twin for the key sets (`stale`), with the same identity-preserving contract. */
function pruneSet(
  prev: ReadonlySet<string>,
  keep: (k: string) => boolean,
): ReadonlySet<string> {
  let dropped = false;
  const next = new Set<string>();
  for (const k of prev) {
    if (keep(k)) next.add(k);
    else dropped = true;
  }
  return dropped ? next : prev;
}

export function OpenPrMenu({
  scopes,
  resolveAgent,
  onOpenAgent,
  compact = false,
}: {
  /**
   * EVERY repo this menu asks about — one entry per open project tab, in tab-strip order.
   *
   * The array's identity is not a dependency of anything: the poll and the fetch key off the
   * scopes' KEYS (`scopesKey` below), so a caller that rebuilds this array on every render — which
   * `ConciergePrChip` does, since it derives it from two stores — does not restart the polling or
   * re-probe GitHub.
   */
  scopes: readonly PrScope[];
  resolveAgent: (pr: PrRow) => PrAgentLink | null;
  onOpenAgent: (link: PrAgentLink) => void;
  /**
   * The CONCIERGE HEADER form: a small icon-and-number chip that sits beside the ⋮, rather than
   * the wide bordered "3 PRs waiting" pill that used to sit in the project tab strip.
   *
   * Three things change, and only three — the merge rules are identical either way:
   * - the badge is a green CHICLET carrying the PR icon plus a COUNT OF GREEN PRs, with the number
   *   omitted entirely when none are green (an icon and no number, never a zero) and the chiclet's
   *   edge dropped with it, so a calm header stays calm;
   * - the panel PORTALS to the root layer and is placed against the window rather than against any
   *   box in the column — see `panelPlacement` and the containment note above. It is deliberately
   *   WIDER than the concierge and floats across the columns beside it;
   * - THE EMPTY STATE IS SHOWN, NOT HIDDEN. This form renders as long as it has a scope to ask
   *   about, including at a genuine fleet-wide zero, where it is an icon with no numeral and a
   *   panel that says "No open pull requests".
   *
   *   That last one is the fix, and it is worth being explicit about why it is safe to state a zero
   *   here when `formatPrBadge`'s whole contract is that zero and unknown both render nothing. That
   *   contract is about the NUMBER, and it still holds — the numeral is still omitted for both. What
   *   changed is the CONTROL. The wide pill was a sentence ("3 PRs waiting") that says nothing
   *   useful at zero, so it went away; this is a button in a fixed header slot, and a button that
   *   vanishes is read as a button that was removed. The founder read it exactly that way. So the
   *   chip persists and the PANEL carries the honest distinction: "No open pull requests" once a
   *   probe has answered, "Checking GitHub…" before one has (see `fleetHeadline`).
   *
   *   The wide form keeps the old rule — it renders nothing at zero or unknown — because it is a
   *   labelled pill in a flowing bar rather than a fixed slot, and nothing about it disappearing
   *   reads as a deletion.
   */
  compact?: boolean;
}) {
  // ── PER-SCOPE STATE, ALL KEYED BY REPO ────────────────────────────────────────────────────────
  //
  // Every ledger below is keyed by `scopeKeyOf(rootPath, projectId)` or by `prKeyOf(scope, number)`.
  // That is not uniformity for its own sake: PR numbers collide across repositories, so a ledger
  // keyed on a bare number would let one repo's #12 stand in for another's — greying out the wrong
  // row, or (in `overrideArmed`) authorising a merge the user armed somewhere else.
  //
  // Keys also make the SWITCH cheap. The single-repo version cleared everything whenever its props
  // changed, because a stale list would otherwise render under the new repo's name. Nothing here
  // needs that: opening a fourth project tab cannot make the other three's rows wrong, so the effect
  // below PRUNES departed scopes instead of blanking the lot, and the tabs you kept keep their data.
  /** What the last probe returned per scope. A missing key is UNKNOWN; `null` never lands here. */
  /**
   * Per scope, per PR number: what the knightwatch probe read said.
   *
   * A SEPARATE MAP FROM `byKey`, NOT A FIELD ON THE ROW, and that is deliberate. `PrRow` mirrors
   * Rust's `project_open_prs` payload, which carries no probe data and must not start carrying it:
   * one probe read is a `gh api ... --paginate` SUBPROCESS under a 45 s timeout, and the PR list is
   * on the panel's critical path. Keeping them separate is what lets the rows PAINT IMMEDIATELY and
   * refine as the reads land, instead of the whole panel waiting on the slowest repo.
   *
   * An absent entry means "no read has landed", which the readiness rule treats exactly like an
   * unknown read: it withholds nothing and manufactures nothing.
   */
  const [probesByKey, setProbesByKey] = useState<
    ReadonlyMap<string, ReadonlyMap<number, PrProbeState>>
  >(() => new Map());
  /** The unanswered blocking probes themselves, for the expanded row. Kept beside the counts rather
   *  than inside them so the readiness projection stays three small fields. */
  const [probeDetailByKey, setProbeDetailByKey] = useState<
    ReadonlyMap<string, ReadonlyMap<number, ProbeDetail[]>>
  >(() => new Map());
  /** Which row has its probe detail expanded, as `prKeyOf(groupKey, number)`. One at a time: this
   *  panel is already a scrolling list and two open drawers push the rest off screen. */
  const [probeExpanded, setProbeExpanded] = useState<string | null>(null);

  const [byKey, setByKey] = useState<ReadonlyMap<string, PrRow[]>>(
    () => new Map(),
  );
  /** Scopes whose LATEST PROBE FAILED, whether or not an older list survives. `buildPrGroups`
   *  splits that into "stale" (we have an older list to show) and "unreadable" (we have nothing,
   *  so this project contributes no rows and its absence proves nothing). */
  const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [open, setOpen] = useState(false);
  /** Which PRs are mid-merge (`prKeyOf`) — drives per-row spinners and disables the row's actions.
   *  A Set so a group's "Merge all ready" can mark several at once without clobbering a single
   *  in-flight merge, and repo-keyed so another project's merge never disables this one's row. */
  const [merging, setMerging] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** Which PR's override button is ARMED (`prKeyOf`, one at a time). Arming is the first of the two
   *  deliberate acts a non-green merge costs; see the override button below. REPO-KEYED, which
   *  matters more here than anywhere else on this surface: an arm is a standing authorisation, and
   *  a bare number would let it be spent on a different repo's PR of the same number. */
  const [overrideArmed, setOverrideArmed] = useState<string | null>(null);
  /**
   * PRs whose LAST merge attempt was refused for unanswered knightwatch probes, `prKeyOf` → the
   * refusal message. This is what turns the row's Merge into the written override.
   *
   * Held per PR rather than as one panel-wide flag, and that is the whole safety property of this
   * feature: a probe is a reviewer's question about ONE diff, so "the founder decided to merge past
   * it" is a fact about one pull request and can never be spent on another. The reason typed for
   * #1176 is passed to #1176's merge and to nothing else — see `runMerge`.
   *
   * NOT pruned when a project tab closes, for the same reason `merging` is not: the keys carry the
   * repo, so an entry can never match a row in another one, and dropping it would lose the state
   * explaining a row the user comes back to. A successful merge of the same PR clears its entry.
   */
  const [probeRefusals, setProbeRefusals] = useState<
    ReadonlyMap<string, string>
  >(() => new Map());

  /**
   * Forget every recorded probe refusal.
   *
   * THE LEDGER MUST NOT OUTLIVE THE STATE IT DESCRIBES. A row's action slot is
   * `probeRefusal ? <override> : <merge>`, so an entry REPLACES the ordinary Merge affordance. The
   * ledger was previously cleared only by a successful merge of the same PR — which meant the one
   * path this whole feature exists to steer people onto was the one path it punished: answer the
   * probe on GitHub, come back, and the row still offers nothing but "Override probes…", so the
   * only way through is to type a sentence justifying a merge with the probe unanswered for a probe
   * that is now answered. Rust's `decide` returns Allow before it ever reads the reason once
   * nothing is blocking, so that sentence is discarded and no override record is posted — the user
   * is made to fabricate a waiver that is then thrown away.
   *
   * Cleared on the two DELIBERATE re-read signals — opening the panel and pressing Refresh — and
   * NOT inside `refetch`, because `runMerge` calls `refetch` itself and would erase the refusal it
   * had just recorded, taking the override affordance with it. A PR that is still refusing simply
   * re-enters the ledger on the next merge attempt, which costs one click and cannot get stuck.
   *
   * THE TWO SIGNALS ARE NOT THE SAME STRENGTH FOR PROBE GATES, and this ledger is only half the
   * row's state. Open evicts the readings for rows whose REPORTED BLOCKER IS PROBES
   * (`evictProbeGates`, targets from `probeBlockedTargets`); Refresh drops all of them and bumps
   * the generation. So on open, a row whose probe read is cached clean — or whose probes are
   * outranked by a conflict, by missing merge rights, or waived by a recorded override — keeps that
   * reading while its refusal is dropped, which is correct: the refusal is the older fact, and
   * re-reading buys nothing when no value of the reading can change the row.
   *
   * Do not read "cleared on open" as "everything about probes is re-asked on open".
   */
  const clearProbeRefusals = useCallback(() => {
    setProbeRefusals((prev) => (prev.size === 0 ? prev : new Map()));
  }, []);
  /** What the founder is typing into the armed row's reason box. ONE string because only one row can
   *  be armed at a time — and it is cleared on every arm, so a reason typed for one PR can never be
   *  inherited by the next row armed. */
  const [overrideReason, setOverrideReason] = useState("");
  /** WHICH SCOPE SET has a user-initiated Refresh in flight, or null — so the button says so rather
   *  than looking inert for the length of a `gh` round trip.
   *
   *  Keyed by the scope SET rather than being a plain boolean, for the same reason the per-repo
   *  version was: this is the panel's designated ESCAPE HATCH, and it is the worst control in the
   *  app to leave unscoped. Press Refresh while `gh` is hung (exactly what it exists for), change
   *  which project tabs are open, and an unscoped boolean leaves the recovery control disabled and
   *  reading "Refreshing…" for a round trip that is no longer about anything on screen — or flips
   *  it back to enabled mid-probe with nothing saying why. The set is the right granularity because
   *  the button re-asks EVERY scope at once. */
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  /**
   * What each scope has DISMISSED — the durable "not now" set, read back from Rust on every probe.
   *
   * Keyed by scope like every other ledger here, for the same reason: PR numbers collide across
   * repositories, so a bare number would let a dismissal in one repo hide a stranger's pull request
   * in another.
   *
   * Held as the full records rather than as a set of numbers because the Dismissed section renders
   * `dismissedAt`, and because {@link partitionDismissals} needs the stored fingerprint to decide
   * whether a dismissal has run out.
   */
  const [dismissedByKey, setDismissedByKey] = useState<
    ReadonlyMap<string, PrDismissal[]>
  >(() => new Map());
  /** Whether the Dismissed section is expanded. Collapsed by default: it is a review surface, not
   *  part of the ready list, and it must never push the actionable rows down the panel. */
  const [showDismissed, setShowDismissed] = useState(false);
  // Set to false on unmount. Unmount only — the per-scope guard is `liveKeysRef` below, because this
  // effect sets it back to `true` on every re-run and so cannot answer "is this repo still listed".
  const aliveRef = useRef(true);
  // THE SCOPES CURRENTLY LISTED, and their keys. An async result compares the scope it was issued
  // against to this set and writes only on a match: a probe or a merge belonging to a project tab
  // the user has since CLOSED must not paint, and — the case a generation counter got wrong — one
  // belonging to a tab they closed and reopened still must (roborev 56193).
  const scopesRef = useRef<readonly PrScope[]>(scopes);
  const liveKeysRef = useRef<ReadonlySet<string>>(new Set());
  // What the last SUCCESSFUL probe returned per scope. Read by `refetch` to tell "GitHub says there
  // are no PRs" apart from "we could not ask", which `fetchOpenPrs` collapses into one `null`.
  const lastGoodRef = useRef<Map<string, PrRow[] | null>>(new Map());
  // PER SCOPE, WHICH PROBE BATCH IS THE LATEST ONE ASKED FOR. The reads below are fired and never
  // awaited (see the block that issues them), so a 3-minute poll and a Refresh press overlap freely
  // — and `gh` gives no ordering guarantee, so the SLOWER batch can resolve last and write its older
  // answer over the newer one. That is the panel's whole failure mode wearing a different hat: a PR
  // that has just become probe-blocked paints green again, or an answered probe stays red, and the
  // next write is 180 s away. `fetchProbeGates` fences its own CACHE on a module generation; these
  // two React setters had no fence at all, which is where the stale answer landed.
  const probeSeqRef = useRef<Map<string, number>>(new Map());
  // THE ANCHOR the compact panel hangs off — the badge's own box. Measured, not guessed, because the
  // concierge can be docked to either side of the shell and moved while the app is running.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // Where the portaled panel is pinned, or null when it is closed (or not compact). See the
  // containment note above for why this is measured at all, and why measuring the ANCHOR rather
  // than the PANEL is what keeps it from going stale.
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);

  // THE SCOPE SET AS A VALUE, so the effect below re-runs when the OPEN TABS change and not when the
  // caller merely re-rendered. `ConciergePrChip` derives `scopes` from two stores and so hands us a
  // fresh array every render; keying the poll on the array's identity would tear down and restart
  // the 3-minute interval — and re-probe GitHub — on every unrelated store write in the app.
  const scopesKey = useMemo(() => scopeSetKey(scopes), [scopes]);
  /** This scope set's own refresh — see `refreshingScope`. */
  const refreshing = refreshingScope === scopesKey;

  // LAYOUT effect, not a passive one: the panel must be pinned before the browser paints, or it
  // flashes at the top-left corner for a frame on every open.
  useLayoutEffect(() => {
    if (!compact || !open) {
      // Dropped on close so a stale placement can never be reused by the next open at a moment when
      // the window or the column has moved. Re-measuring is cheap; a wrong pin is not.
      setPlacement(null);
      return;
    }
    const place = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPlacement(
        panelPlacement(
          { right: r.right, bottom: r.bottom },
          { width: window.innerWidth },
        ),
      );
    };
    place();
    // THE ONLY THING THAT CAN INVALIDATE A PLACEMENT. Content cannot — the width is a function of
    // the viewport alone — and a column drag cannot reach here either, because it begins with a
    // pointer-down that lands on the click-away backdrop and closes the panel first.
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [compact, open]);

  // ONE PROBE PER SCOPE, ISSUED CONCURRENTLY. Sequential would make the list's freshness a function
  // of how many tabs are open — four repos behind a slow `gh` would leave the last one minutes
  // behind the first — and each scope writes only its own key, so they cannot race each other.
  const refetch = useMemo(
    () => async () => {
      await Promise.all(
        scopesRef.current.map(async (scope) => {
          if (!scope.rootPath) return;
          const key = keyOfScope(scope);
          const rows = await fetchOpenPrs(scope.rootPath, scope.projectId);
          if (!aliveRef.current || !liveKeysRef.current.has(key)) return;
          // A FAILED PROBE MUST NOT ERASE WHAT WE ALREADY KNOW. `fetchOpenPrs` swallows every
          // failure and returns `null`, and `null` used to render no badge at all — so a
          // rate-limited or offline `gh` made the whole PR chip VANISH from the header, panel
          // included, until some later poll happened to succeed. That is bad for the 3-minute poll
          // and worse for Refresh, whose entire purpose is recovering from a state where nothing
          // else works: press it at the wrong moment and the control you pressed disappears
          // (roborev 56164).
          //
          // So a null that follows a good list keeps the list and SAYS that scope is stale. A null
          // with nothing behind it leaves the scope UNKNOWN — which is not zero, and is why
          // `buildPrGroups` distinguishes the two.
          if (rows === null) {
            // EVERY failure is recorded, not just the ones with a list behind them. Gating this on
            // `lastGoodRef` meant a scope that had NEVER been read successfully left no trace at
            // all — so a repo the app cannot reach (no remote, unauthed, offline: it fails on every
            // poll, so this is the persistent case, not a blip) was indistinguishable from a repo
            // with genuinely nothing open, and the panel would state a flat "No open pull requests"
            // across it. `buildPrGroups` splits the two back out via `known`.
            setFailedKeys((prev) =>
              prev.has(key) ? prev : new Set(prev).add(key),
            );
            return;
          }
          lastGoodRef.current.set(key, rows);
          setByKey((prev) => new Map(prev).set(key, rows));
          // ── PROBE READS: FIRED, NEVER AWAITED ──────────────────────────────────────────────
          //
          // Deliberately NOT awaited here, and not inside the `Promise.all` above. Each read is its
          // own `gh` subprocess; the panel routinely lists 27 PRs across 6 projects, so awaiting
          // them would hold the rows off screen behind the slowest repo's slowest PR — trading the
          // founder's "these look ready" for a blank panel, which is not a better failure. The rows
          // are already set on the line above; these arrive and refine them.
          //
          // `fetchProbeGates` never rejects and caches by `updatedAt`, so a poll that changes
          // nothing costs no subprocesses at all.
          void (async () => {
            // Claimed BEFORE the read, so a batch issued later always outranks this one.
            const seq = (probeSeqRef.current.get(key) ?? 0) + 1;
            probeSeqRef.current.set(key, seq);
            const gates = await fetchProbeGates(scope.rootPath!, rows);
            if (!aliveRef.current || !liveKeysRef.current.has(key)) return;
            if (probeSeqRef.current.get(key) !== seq) return; // a newer batch already answered
            const states = new Map<number, PrProbeState>();
            const details = new Map<number, ProbeDetail[]>();
            for (const [number, gate] of gates) {
              const st = probeStateOf(gate);
              if (st) states.set(number, st);
              // PURE DATA — every unanswered blocking probe, with NO judgement applied here.
              //
              // The judgement (does this row REPORT probes as its blocker?) belongs at render, not
              // here, and putting it here was a second computation site of exactly the kind this
              // whole line of work removes. The row's label comes from `prMergeReadiness` over
              // `judgedByKey` at render time; deciding the drawer at READ time meant hand-rebuilding
              // that join against the rows captured in this closure, and the two snapshots can
              // disagree: a PR that has just become conflicting (its base moved, so `updatedAt` is
              // unchanged and the gate is a cache hit) would render "Conflicts" with the previous
              // poll's disclosure still hanging off it, and two overlapping refetches could leave
              // the map computed against the older rows with nothing to re-run it.
              const unanswered = unansweredBlockingProbes(gate);
              if (unanswered && unanswered.length > 0) details.set(number, unanswered);
            }
            setProbesByKey((prev) => new Map(prev).set(key, states));
            setProbeDetailByKey((prev) => new Map(prev).set(key, details));
          })();
          // ── RECONCILE THE DISMISSALS AGAINST WHAT WE JUST READ ────────────────────────────
          //
          // Only on a SUCCESSFUL probe, and that is the whole safety rule here. `rows` is a
          // complete open list, so it is safe to hand its numbers to Rust for pruning (a dismissed
          // PR that has since merged or closed stops being stored) and safe to judge each
          // dismissal's fingerprint against it. On a FAILED probe neither is true — the early
          // return above leaves the dismissals exactly as they were, because reading a `gh` failure
          // as "nothing is open" would erase the user's dismissals, and judging a dismissal against
          // rows we could not read would revive on missing data. Both directions of that mistake
          // end with the app deciding on the user's behalf what it may stop hiding.
          // A SATURATED READ IS NOT A COMPLETE LIST, so it may not drive pruning. The rule above
          // ("`rows` is a complete open list") was written before the probe could truncate: at the
          // cap, a PR that is still open is simply ABSENT, and handing these numbers to Rust would
          // delete its dismissal record as though it had merged. Omitting them keeps every stored
          // dismissal — the same "we could not see all of it, so decide nothing" stance the failed
          // probe takes one branch up. Judging fingerprints against the rows we DID read stays
          // correct: a row present in a truncated list is still a row we actually read.
          const listComplete = !rows.some((r) => r.listSaturated);
          const stored = await fetchDismissals(
            scope.projectId,
            listComplete ? rows.map((r) => r.number) : undefined,
          );
          if (!aliveRef.current || !liveKeysRef.current.has(key)) return;
          const { active, revived } = partitionDismissals(stored, rows);
          setDismissedByKey((prev) => new Map(prev).set(key, active));
          // A DISMISSAL THAT HAS RUN OUT IS DROPPED FROM THE STORE, not merely ignored here.
          // Leaving it would make the row reappear on every poll while the record silently
          // outlived its reason — and then a later change (a force-push back to the old SHA) could
          // resurrect a dismissal the user has no memory of making. Fire-and-forget: the local
          // state above has already un-hidden the row, so a failed write costs one more revival
          // pass on the next poll and nothing else.
          for (const d of revived) {
            log.info(
              "open-pr-menu",
              `dismissal expired for ${scope.projectName} PR #${d.number}`,
            );
            void restorePr(scope.projectId, d.number);
          }
          // Only this scope's staleness flag. A merge error is a different fact and is not answered
          // by a probe succeeding — the user still needs to read why their merge failed.
          setFailedKeys((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }),
      );
    },
    // STABLE FOR THE COMPONENT'S LIFETIME, and that is deliberate rather than an oversight.
    //
    // It closes over nothing that changes: the scopes come off `scopesRef` at CALL time, and the
    // rest are setters and refs, all of which React guarantees are stable. So there is no version
    // of this function that can go stale, and it does not need re-making when the open tabs change
    // — the effect below re-runs on `scopesKey` and calls this, which is what re-probes.
    //
    // Keying it on `scopesKey` instead would be a dependency the body never reads, and it would
    // give every caller a new identity on each tab change for no behavioural gain.
    [],
  );

  useEffect(() => {
    aliveRef.current = true;
    // The scopes every in-flight result is judged against, updated BEFORE anything is kicked off.
    scopesRef.current = scopes;
    const keys = new Set(scopes.map(keyOfScope));
    liveKeysRef.current = keys;
    // PRUNE, DON'T BLANK. Only the scopes that LEFT are forgotten; a tab you still have open keeps
    // the list we already read for it. The single-repo version cleared everything on any prop
    // change because a stale list would otherwise render under the new repo's name — repo-keyed
    // state makes that impossible, so clearing would now only throw away good data and put every
    // remaining tab back into "Checking GitHub…" for a round trip.
    for (const k of [...lastGoodRef.current.keys()])
      if (!keys.has(k)) lastGoodRef.current.delete(k);
    setByKey((prev) => pruneMap(prev, keys) as ReadonlyMap<string, PrRow[]>);
    setFailedKeys((prev) => pruneSet(prev, (k) => keys.has(k)));
    // Same prune, same reason: a closed tab's dismissals are re-read from Rust when it comes back.
    setDismissedByKey(
      (prev) => pruneMap(prev, keys) as ReadonlyMap<string, PrDismissal[]>,
    );
    // A merge already in flight is DELIBERATELY not pruned — it is keyed by repo, so it can never
    // match a scope that is still listed, and dropping it is how a merge that finished while its
    // tab was closed leaves a row permanently greyed out when the tab comes back.
    //
    // An armed override is dropped whenever the scope set moves: it is a standing authorisation to
    // merge a red PR, and the cheapest safe rule for one is that it does not survive anything.
    setOverrideArmed(null);
    // …AND THE SENTENCE TYPED INTO IT. A written probe override is authorisation for one pull
    // request in one repo; carrying the words across a scope change is how they would end up
    // recorded on a different PR than the one they were written about.
    setOverrideReason("");
    // AND THE PANEL CLOSES. The list the user was reading just changed shape underneath them —
    // sections appearing or disappearing while their pointer is over a Merge button is exactly the
    // way to make them click a row they did not mean to. In practice this is unreachable rather
    // than disruptive: changing which project tabs are open takes a click outside the panel, and
    // that click lands on the click-away backdrop and closes it first.
    setOpen(false);
    void refetch();
    const id = window.setInterval(() => void refetch(), OPEN_PR_POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
    // `scopes` is intentionally absent: the effect keys off `scopesKey`, the VALUE, so a caller
    // rebuilding the array on every render cannot restart the poll. `scopesRef` is what carries the live
    // objects in, and it is written on the line above before anything reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopesKey, refetch]);

  /** The dismissed NUMBERS per scope — what `buildPrGroups` filters on. Derived rather than stored
   *  so the records and the filter can never disagree about which rows are hidden. */
  const hiddenByKey = useMemo(() => {
    const out = new Map<string, ReadonlySet<number>>();
    for (const [k, ds] of dismissedByKey) out.set(k, dismissedNumbers(ds));
    return out;
  }, [dismissedByKey]);
  /**
   * The listed rows with their probe reading attached — what every count and every dot is taken from.
   *
   * JOINED HERE, IN ONE PLACE, for the same reason `buildPrGroups` splits dismissals in one place:
   * the row's dot, the row's word, the section's ready count, the section's blocked count and the
   * merge-all button's scope must all be reading the SAME judgement. They all bottom out in
   * `prMergeReadiness`, so attaching the probe state once — before the groups are built — is what
   * makes that one fact instead of five that have to be kept in agreement.
   *
   * A row with no reading yet is passed through UNCHANGED, not defaulted to "no probes". The
   * readiness rule reads an absent `probes` exactly as it reads an unknown one.
   */
  const judgedByKey = useMemo(() => {
    const out = new Map<string, JudgedPrRow[]>();
    for (const [k, rows] of byKey) {
      const states = probesByKey.get(k);
      out.set(
        k,
        states ? rows.map((r) => ({ ...r, probes: states.get(r.number) })) : rows,
      );
    }
    return out;
  }, [byKey, probesByKey]);
  /**
   * A dep the POLL deliberately does not share — see `scopeIdentitySetKey`.
   *
   * Repo keys are resolved by a git subprocess and backfilled a beat after hydrate, so the grouping
   * has to recompute when one lands or two tabs on one repository would stay unfolded for the rest
   * of the session. Folding two sections into one changes nothing about WHAT to ask GitHub, though,
   * so putting it in `scopesKey` would restart the 3-minute poll and spend a `gh` round trip per
   * open repo for a purely local fact.
   */
  const repoIdentityKey = useMemo(() => scopeIdentitySetKey(scopes), [scopes]);
  const groups = useMemo(
    () => buildPrGroups(scopes, judgedByKey, failedKeys, hiddenByKey),
    // Same reasoning as the effect: recompute when the scope SET, the data, or the staleness moves —
    // plus `repoIdentityKey`, which moves when a repo key arrives and two sections become one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopesKey, repoIdentityKey, judgedByKey, failedKeys, hiddenByKey],
  );
  /**
   * The probe DETAIL a section's rows should show, keyed by group — merged across the group's
   * members exactly like the counts are.
   *
   * THE BUG THIS FIXES (roborev 59958). `probeDetailByKey` is written per SCOPE, and the row read it
   * at `group.key` — the PRIMARY's scope key. Once two tabs on one repository fold into one section
   * the count and the detail stopped coming from the same place: the merged row takes the STRONGEST
   * probe reading across members (`fleetPrs.probeStrength`), so a row could say "Blocked: 2 probes"
   * on the worktree's reading while its disclosure read the primary's map and found NOTHING. A row
   * that names a blocker and then cannot show it is the worst version of this feature — the reader
   * is told to go and answer probes the panel will not name.
   *
   * SELECTED BY `probeStrength` — THE SAME FUNCTION `mergeRepoRows` USES, not a rule that merely
   * resembles it (roborev 59974). "Longest list wins" was the first attempt and it diverges on
   * OVERRIDDEN readings: `probeStrength` ranks an overridden gate as not-blocking whatever its
   * count, while `probeDetailByKey` stores the unanswered list for an overridden gate too. So a
   * member holding a fresh `{overridden: true, unansweredBlocking: 4}` beat a member holding a stale
   * `{overridden: false, unansweredBlocking: 1}` on LENGTH while losing to it on STRENGTH — the row
   * said "Blocked: 1 probe" and the drawer announced four, three of them already waived. That is the
   * same contradiction this whole memo exists to remove, pointed the other way.
   *
   * Ties keep the EARLIER member, exactly as `mergeRepoRows` does, so the two selections are the
   * same selection rather than two that happen to agree.
   */
  const probeDetailByGroup = useMemo(() => {
    const out = new Map<string, Map<number, ProbeDetail[]>>();
    for (const g of groups) {
      const merged = new Map<number, ProbeDetail[]>();
      const strongest = new Map<number, number>();
      for (const member of g.members) {
        const memberKey = keyOfScope(member);
        const detail = probeDetailByKey.get(memberKey);
        if (!detail) continue;
        const states = probesByKey.get(memberKey);
        for (const [number, list] of detail) {
          const strength = probeStrength(states?.get(number));
          const prev = strongest.get(number);
          if (prev !== undefined && strength <= prev) continue;
          strongest.set(number, strength);
          merged.set(number, list);
        }
      }
      out.set(g.key, merged);
    }
    return out;
  }, [groups, probeDetailByKey, probesByKey]);

  /**
   * The PRs whose row is REPORTING probes as its blocker, as `(root, number)` pairs.
   *
   * A function rather than a memo: it is read once per panel-open, and closing over the current
   * `groups` is the point — this must reflect what the rows say right now.
   *
   * DERIVED FROM THE RENDERED ROWS, NOT FROM THE PER-SCOPE LISTS (roborev 59958). It used to walk
   * `scopesRef.current` and judge `judgedByKey`'s unmerged rows, which put a SECOND ranking beside
   * the one the panel paints — the exact "one ranking, one answer" discipline `PrBlocker` was
   * introduced to enforce. Once two tabs on one repository fold into one section the two can
   * disagree: the merged row carries the strongest probe reading across members (see
   * `fleetPrs.probeStrength`), so a section the panel shows as clean could still be listed here by
   * whichever member happened to hold a blocking reading the merge declined to use, and every PR in
   * a folded section was emitted once per tab.
   *
   * IT STILL WALKS EVERY MEMBER'S ROOT, though, and that half is deliberate: the gate cache is keyed
   * `(root, number)` (`probeGate.cacheKey`), so a repo open under two checkouts has an entry per
   * checkout and evicting only the primary's would leave the other stale — the next read would serve
   * the pre-answer verdict from cache. One decision, taken from the rendered row; every cache entry
   * that decision implicates, dropped.
   */
  const probeBlockedTargets = useCallback((): ProbeGateTarget[] => {
    const out: ProbeGateTarget[] = [];
    for (const group of groups) {
      for (const row of group.prs) {
        if (prMergeReadiness(row).blocker !== "probes") continue;
        for (const member of group.members) {
          if (member.rootPath) out.push({ root: member.rootPath, number: row.number });
        }
      }
    }
    return out;
  }, [groups]);

  const totals = fleetTotals(groups);

  /**
   * PUBLISH WHAT GITHUB SAID, so the concierge's "N need merge" line can stop promising merges that
   * are not available (bead `sparkle-mf501`).
   *
   * This component is the app's only pull-request probe and it is mounted exactly once, in the
   * concierge header — so it is the one place that can answer "can this actually be merged", and the
   * concierge is one component away with no path to ask. See `stores/prReadinessStore` for why a
   * store rather than a prop threaded back up through `ConciergeColumnProps.prSlot`.
   *
   * AN EFFECT, NEVER A RENDER-TIME WRITE. Writing a zustand store during render makes any subscriber
   * re-render inside this one's render phase, which React treats as an update loop.
   *
   * `resolveAgent` IS A REAL DEPENDENCY, not noise to be silenced with a ref. It closes over the
   * project roster, so a green PR whose owning agent joins the roster after the probe landed is only
   * attributable once this re-runs — pinning it to `groups` alone would leave that agent uncounted
   * until the next three-minute poll. The identity churns every parent render, which is affordable
   * precisely because the store DROPS A NO-OP PUBLISH (`sameSnapshot`): a re-run that computes the
   * same answer costs one small scan and notifies nobody.
   */
  useEffect(() => {
    const snap = prReadinessSnapshot(groups, resolveAgent);
    usePrReadinessStore.getState().publishPrReadiness({
      probedProjectIds: snap.knownProjectIds,
      readyAgentIds: snap.readyAgentIds,
    });
  }, [groups, resolveAgent]);

  /**
   * DID ANY SCOPE'S PROBE COME BACK TRUNCATED — i.e. is the number below a FLOOR rather than a total?
   *
   * `gh pr list --limit N` truncates with no signal, so a saturated read cannot be presented as an
   * exact count: the panel is then missing pull requests, and "Needs merge" is work the founder owes
   * (bead sparkle-qogah). Derived from the rows themselves rather than from `totals`, because
   * `fleetTotals` sums lengths and a length cannot say "and there are more".
   *
   * ANY scope is enough. With four repos open, one truncated list is one set of hidden rows, and
   * requiring all of them to be full would hedge exactly never.
   */
  const listSaturated = useMemo(
    () => Array.from(byKey.values()).some((rows) => prListSaturated(rows)),
    [byKey],
  );
  // The wide pill's sentence ("3 PRs waiting"), which is also what the accessible name falls back to
  // when nothing is green. Null at zero or unknown — see `formatPrBadge`. Reads "N+ …" when any
  // probe was truncated, so the pill never states a capped number as the total.
  const label = formatPrBadge(
    totals.known ? totals.total : null,
    listSaturated,
  );
  /**
   * The WIDE pill's text — the count sentence, or, when everything open has been DISMISSED, what
   * is being held back.
   *
   * WITHOUT THIS THE WIDE FORM DELETES ITS OWN UNDO. Its render rule is `!label → render nothing`,
   * and `label` is null at a total of zero — so dismissing your last visible PR removed the only
   * control that could list the dismissal or restore it. The row would have been hidden with no
   * way back, which is precisely the invisible-state failure the Dismissed section exists to
   * prevent, reintroduced one level up. A dismissal may hide a row; it may never hide the door.
   */
  const wideLabel =
    label ??
    (totals.dismissed > 0
      ? `${totals.dismissed} dismissed PR${totals.dismissed === 1 ? "" : "s"}`
      : null);

  // ── WHEN THIS CONTROL IS ALLOWED NOT TO EXIST ────────────────────────────────────────────────
  //
  // The WIDE form keeps the original rule: a labelled pill whose label is meaningless at zero.
  //
  // The COMPACT form renders whenever it has a scope to ask about, and that is the whole bead. The
  // ONLY thing that removes it is having no open project tab at all — i.e. the app's "Welcome to
  // Sparkle, open a project with +" state, where there is no repo in the app to have a pull request
  // in. That cannot be caused by scope, by a failed probe, or by a count of zero, which is exactly
  // the property that was missing: before this, a concierge pointed at the wrong project unmounted
  // the app's only pull-request affordance while six PRs sat mergeable.
  // `wideLabel`, not `label`: a wide form holding dismissals must keep rendering, or it takes the
  // only way to review and undo them with it. See `wideLabel` above.
  /**
   * DISARM WHENEVER THE ARMED ROW IS NOT ON SCREEN.
   *
   * `overrideArmed` is a standing authorisation to merge a red PR, and this file's own rule is that
   * it "does not survive anything" — it is cleared on a scope change and on panel open/close. But
   * Dismiss and Restore happen INSIDE the open panel, so neither reset fires: arm a row, dismiss it,
   * restore it, and it returns with `data-armed="yes"` and its typed reason intact, so a SINGLE
   * click spends a waiver whose deliberate second act happened before the row was hidden. Auto-
   * revival (a dismissed PR reappearing after a push) reaches the same state with no click at all.
   * Both the probe override and the `unstable` "Merge anyway?" button read this flag.
   *
   * IT HAS TO BE AN EFFECT, not a render-time `&& rowVisible` guard. The restored row comes back
   * under the SAME `rowKey`, so by the time it renders again both conditions hold and such a guard
   * is inert — it would read as a fix and change nothing. Clearing while the row is ABSENT is the
   * only version that works, and deriving it from the rendered set (rather than clearing inside
   * `runDismiss`/`runRestore`) means a future path that removes a row cannot forget to disarm.
   */
  useEffect(() => {
    if (!overrideArmed) return;
    const visible = groups.some((g) =>
      g.prs.some((pr) => prKeyOf(g.key, pr.number) === overrideArmed),
    );
    if (!visible) {
      setOverrideArmed(null);
      setOverrideReason("");
    }
  }, [groups, overrideArmed]);

  if (compact ? scopes.length === 0 : !wideLabel) return null;

  const badgeTitle = prBadgeTitle(label, totals, listSaturated);
  const staleNames = staleProjectNames(groups);
  const unreadableNames = unreadableProjectNames(groups);
  /** Sections are drawn for groups that have something in them; an empty tab is covered by the
   *  headline's total rather than by an empty section per project. */
  const sections = groups.filter((g) => g.prs.length > 0);
  /** Every dismissed row across the fleet, flattened with the group it belongs to — the Dismissed
   *  section is fleet-wide, so each row has to carry its own scope for the Restore call and its own
   *  project name for the reader. In group (tab) order, then probe order, like the list above. */
  const dismissedSections = groups.flatMap((group) =>
    group.dismissed.map((pr) => ({ group, pr })),
  );

  /**
   * Merge `nums` IN `scope` — the repo binding is a parameter, never an ambient default.
   *
   * `merge_pr` is addressed by (rootPath, number), and PR numbers collide across repositories, so
   * a caller that let this read some "current" repo would eventually merge the right number in the
   * wrong repo. That is the one irreversible action on this surface, so it is passed in at every
   * call site: the per-row button passes its own group's scope, and a group's "Merge all ready"
   * passes that group's.
   */
  const runMerge = async (
    scope: PrScope,
    nums: number[],
    /**
     * A written knightwatch override, BOUND TO ONE PR NUMBER.
     *
     * The number is not redundant with `nums`. "Merge all ready" calls this with N numbers, and a
     * reason that applied to whatever the loop happened to be on would turn a per-PR judgement into
     * a blanket waiver of every probe in the batch — the single most damaging thing this surface
     * could do. Carrying the number means the loop can only spend the reason on the PR it was
     * written for, whatever else is in the list.
     */
    override?: KnightwatchOverrideFor,
  ) => {
    if (!scope.rootPath || nums.length === 0) return;
    // THE SCOPE THIS MERGE WAS ISSUED AGAINST, compared to what is listed when it lands. `aliveRef`
    // answers unmount and nothing else — the effect sets it back to `true` on every re-run — and
    // `ConciergePrChip` renders this menu UNKEYED, so closing a project tab is a prop change on the
    // same instance. A merge still in flight across one used to land its results under another
    // repo's name: an error reading "PR #12: <gh message>" about a number that means a different PR
    // in the repo now on screen (roborev 56187).
    const key = keyOfScope(scope);
    const listed = () => aliveRef.current && liveKeysRef.current.has(key);
    /**
     * THE HEAD THIS CLICK WAS ABOUT — the sha of the row as it was rendered, which is the same
     * snapshot `prMergeEligibility` read to enable the button. It is sent with the merge so GitHub
     * refuses one whose branch has moved since, instead of merging a head this gate never judged.
     *
     * Reading the RENDER-TIME `groups` is the point, not a stale-closure bug: the question is what
     * the user approved, and a fresher sha would silently re-approve someone else's push. `undefined`
     * (a build or fixture with no `headRefOid`) merges unguarded, exactly as before.
     */
    const headOidOf = (n: number) => {
      const group = groups.find((g) => g.key === key);
      const row =
        group?.prs.find((pr) => pr.number === n) ??
        group?.dismissed.find((pr) => pr.number === n);
      return row?.headRefOid;
    };
    const prKeys = nums.map((n) => prKeyOf(key, n));
    setError(null);
    setMerging((prev) => new Set([...prev, ...prKeys]));
    let firstError: string | null = null;
    /** Rows refused for unanswered probes this run, `prKeyOf` → the refusal, and their numbers in
     *  list order for the batch report. */
    const refusedProbes = new Map<string, string>();
    const refusedNumbers: number[] = [];
    /** Rows that MERGED — any probe refusal recorded for them is now history. */
    const merged: string[] = [];
    // Sequential on purpose: merging PR B right after A picks up A's landing, and it keeps the gh
    // calls from racing each other's rate limit. One failure is recorded but does not abort the rest.
    for (const n of nums) {
      const prKey = prKeyOf(key, n);
      try {
        // THE REASON IS SPENT ON EXACTLY ONE PR — see `knightwatchReasonFor`, which is a named
        // function precisely so the binding can be asserted against without a UI path that merges a
        // batch WITH an override. A batch and a single-row merge take this same line.
        await mergePr(
          scope.rootPath,
          n,
          knightwatchReasonFor(n, override),
          headOidOf(n),
        );
        merged.push(prKey);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(
          "open-pr-menu",
          `merge failed for ${scope.projectName} PR #${n}`,
          msg,
        );
        // A PROBE REFUSAL IS A DIFFERENT KIND OF FAILURE: nothing is wrong with the PR, a reviewer
        // asked a question nobody answered. It is recorded per row so the row itself can offer the
        // way through — which is also how a batch stays per-PR.
        if (isKnightwatchRefusal(msg)) {
          refusedProbes.set(prKey, msg);
          refusedNumbers.push(n);
        }
        // NAMED BY PROJECT, because #12 alone no longer identifies a pull request in this list.
        if (!firstError) firstError = `${scope.projectName} PR #${n}: ${msg}`;
      }
    }
    // THE SPINNERS CLEAR UNCONDITIONALLY. They are this scope's own keys, so releasing them is
    // correct wherever the user happens to be looking — and NOT releasing them is how a merge that
    // finished while its tab was closed leaves its row permanently greyed out.
    setMerging((prev) => {
      const next = new Set(prev);
      for (const k of prKeys) next.delete(k);
      return next;
    });
    // THE PROBE LEDGER, like the spinners above, is repo-keyed and updated unconditionally: it is
    // the state that lets a row offer its own override when the user comes back to it.
    if (refusedProbes.size > 0 || merged.length > 0)
      setProbeRefusals((prev) => {
        const next = new Map(prev);
        for (const k of merged) next.delete(k);
        for (const [k, v] of refusedProbes) next.set(k, v);
        return next;
      });
    // The MESSAGE is different: it is addressed to whoever is reading this panel, so it goes up only
    // while the repo it is about is still listed.
    //
    // A BATCH REPORTS WHAT IT SKIPPED. `firstError` alone names one PR, which reads as "one failed"
    // when four were refused — and the other three would sit there looking merged. The refusal
    // itself is kept verbatim; the batch line is appended, never substituted for it.
    if (firstError && listed())
      setError(
        refusedNumbers.length > 1
          ? `${firstError}\n\n${probeRefusedInBatch(refusedNumbers)}`
          : firstError,
      );
    // Reconcile with the truth: merged PRs drop out, a failed one stays (now visibly still open).
    if (listed()) await refetch();
  };

  /**
   * Hide `pr` from the ready list until something about it changes — the founder's Dismiss.
   *
   * OPTIMISTIC, then reconciled. The local map is written first so the row leaves the list on the
   * click rather than a `gh`-free but still asynchronous IPC round trip later; the reply then
   * replaces it with whatever Rust actually holds, so a rejected write cannot leave the UI claiming
   * a dismissal that was never stored. A null reply means the write FAILED, and the optimistic
   * entry is rolled back — a row that stays visible is the safe direction, and it is the direction
   * this whole feature is allowed to fail in.
   *
   * Scoped by `scope.projectId`, never by a bare number: see `prKeyOf`.
   */
  const runDismiss = async (scope: PrScope, key: string, pr: PrRow) => {
    const before = dismissedByKey.get(key) ?? [];
    const optimistic: PrDismissal = {
      number: pr.number,
      headRefOid: pr.headRefOid ?? "",
      tone: prMergeReadiness(pr).tone,
      viewerCanMerge: pr.viewerCanMerge === true,
      dismissedAt: Math.floor(Date.now() / 1000),
    };
    setDismissedByKey((prev) =>
      new Map(prev).set(key, [...before, optimistic]),
    );
    const stored = await dismissPr(scope.projectId, pr);
    if (!aliveRef.current || !liveKeysRef.current.has(key)) return;
    setDismissedByKey((prev) => new Map(prev).set(key, stored ?? before));
  };

  /** Put a dismissed PR back in the ready list — the user's Restore. Same optimistic shape. */
  const runRestoreIn = async (scope: PrScope, key: string, number: number) => {
    const before = dismissedByKey.get(key) ?? [];
    setDismissedByKey((prev) =>
      new Map(prev).set(
        key,
        before.filter((d) => d.number !== number),
      ),
    );
    const stored = await restorePr(scope.projectId, number);
    if (!aliveRef.current || !liveKeysRef.current.has(key)) return;
    setDismissedByKey((prev) => new Map(prev).set(key, stored ?? before));
  };

  /**
   * Restore across EVERY member of the section that is holding this dismissal.
   *
   * THE BUG THIS FIXES (roborev 59902, Medium). Dismissals are stored by Rust per PROJECT ID, and a
   * section that folds two tabs on one repository reads them as a UNION — so a row can be hidden by
   * a record belonging to the NON-PRIMARY tab. Restore addressed only `group.scope`, the primary, so
   * clicking it wrote to a store that did not hold the record: the IPC succeeded, the local map for
   * the primary's key was already empty, and the union kept the row hidden. A Restore button that
   * reports success and restores nothing is worse than a missing one — the row is gone and the one
   * affordance for getting it back appears to have been used.
   *
   * Every member is asked rather than just the one we think holds it, because "who holds it" is
   * exactly the state that can be stale here, and `restorePr` on a record that is not there is a
   * no-op. Sequential so two writes to the same store cannot race.
   */
  const runRestore = async (group: PrGroup, number: number) => {
    for (const member of group.members) {
      await runRestoreIn(member, keyOfScope(member), number);
    }
  };

  const openGithub = (url: string) => {
    if (!url) return;
    void openUrl(url).catch((e) =>
      log.warn("open-pr-menu", "could not open PR", e),
    );
  };

  const anyMergingIn = (group: PrGroup) =>
    [...merging].some((k) => k.startsWith(`${group.key}#`));
  /**
   * A merge in flight in a scope that is STILL LISTED — what Refresh is allowed to be blocked by.
   *
   * NOT `merging.size > 0`. That ledger is deliberately never pruned when a project tab closes (so
   * a merge you left running still shows its spinner when you come back), which means a hung merge
   * — a wedged `gh`, i.e. exactly when you want to press Refresh — in a tab the user has since
   * CLOSED would disable the panel's designated escape hatch indefinitely, with no row on screen to
   * explain why. This is the unscoped-flag bug the notes above record as already fixed twice
   * (roborev 56164, 56193), and it came back one control over.
   */
  const anyListedMerging = [...merging].some((k) =>
    groups.some((g) => k.startsWith(`${g.key}#`)),
  );

  return (
    // THIS WRAPPER IS THE COMPACT PANEL'S ANCHOR, AND NOTHING ELSE. It stays `static` there on
    // purpose — it must NOT be the positioned ancestor, because the panel is portaled out of this
    // subtree entirely and pinned in window coordinates by `panelPlacement`. It is measured
    // (`anchorRef`) rather than positioned against, so the panel hangs off this badge's box while
    // being free of every box between here and the root. See the containment note above; the
    // `left: 8; right: 8` spanning form this once had is the reported bug, not a simpler shape.
    //
    // The WIDE form is the opposite and keeps `relative`: its panel really does render in here and
    // is positioned off this wrapper.
    <div
      ref={anchorRef}
      style={{ position: compact ? "static" : "relative" }}
      data-testid="open-pr-menu"
    >
      <button
        data-testid="open-pr-badge"
        data-ready={totals.ready > 0 ? "yes" : "no"}
        // NAMED EXPLICITLY, because compact's content is a bare numeral and an `aria-hidden` glyph —
        // and `title` is ignored for the accessible name the moment an element has text content, so
        // the app's sole pull-request entry point would announce itself as "1, button". The wide
        // form got its name from its "3 PRs waiting" label and the old concierge chip carried an
        // aria-label; neither survives here, so the name has to be stated (roborev 56141).
        aria-label={badgeTitle}
        title={badgeTitle}
        onClick={() => {
          setOpen((v) => !v);
          // Disarm on EITHER edge. An override armed before the panel closed must not still be
          // armed when it reopens — that would turn a single later click into a merge of a red PR,
          // which is the whole thing the two-step exists to prevent.
          setOverrideArmed(null);
          setOverrideReason("");
          if (!open) {
            clearProbeRefusals(); // see clearProbeRefusals — answering the probe is the remedy
            // RE-ASK, BUT ONLY FOR THE ROWS ACTUALLY REPORTING PROBES. A full `refreshProbeGates()`
            // here is the 27-subprocesses-per-open cost `probeGate.ts` exists to prevent; dropping
            // nothing leaves a row pinned at "Blocked: N probes" after a probe answered by EDITING
            // an existing reply (that bumps the comment's stamp, never the PR's), recoverable only
            // via a Refresh the reader has no cue to press.
            //
            // The TARGETS come from the same `prMergeReadiness` call the label and the count use.
            // Deriving them inside probeGate could only ever re-implement the probe branch, never
            // the ranking — the cache holds no row facts — so a conflicting or unmergeable-by-this
            // -viewer PR got re-read on every open for a reading that cannot change its row.
            evictProbeGates(probeBlockedTargets());
            void refetch(); // refresh on open so the user acts on current state
          }
        }}
        style={
          compact
            ? {
                // THE CHICLET — `.pill`'s box, shared with the needs-you filter one slot over rather
                // than re-typed here, so the two chips in this header are the same kind of object.
                // The founder asked for this by name ("it should be in a little chiclet which is
                // not right now — it used to be"): in v0.74.0 the count was green but bare, which
                // reads as loose text beside a chip rather than as a control.
                ...pillStyle(totals.ready > 0 ? C.successInk : "transparent"),
                // GREEN ONLY WHEN SOMETHING IS ACTUALLY MERGEABLE — the same "green means go" rule
                // the per-row dots follow, so the header chip cannot promise more than the panel
                // delivers. The EDGE goes with the ink: a chiclet drawn around "nothing to merge"
                // is a box asking to be looked at, and this header's standing rule is that the calm
                // state says nothing beside the wordmark (ConciergeColumn's `.ahd` note). So the
                // border is transparent, not absent — the box keeps its width either way and the
                // row does not shift when the first PR goes green.
                //
                // `successInk`, not `success`: this is 10px bold text and a glyph, and the fill
                // tier does not clear AA on the light column. The same split is why the violet end
                // below is `violetInk`.
                color: totals.ready > 0 ? C.successInk : C.muted,
                whiteSpace: "nowrap",
                position: "relative",
                zIndex: 42,
              }
            : {
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "transparent",
                // The BORDER keeps the brand literal (violet is a stroke here).
                border: `1px solid ${C.violet}`,
                borderRadius: 6,
                color: totals.ready > 0 ? C.successInk : C.violetInk,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: FONT_WEIGHT.semibold,
                padding: "3px 8px",
                whiteSpace: "nowrap",
                position: "relative",
                zIndex: 42,
              }
        }
      >
        {compact ? (
          <>
            {/* The ICON IS ALWAYS THERE; the NUMBER only when something is green. No zero: an
                explicit "0" is a count of nothing, and reads as a state rather than an absence.
                The icon standing alone is the calm state — and, since this chip no longer unmounts,
                it is also what a genuine fleet-wide zero looks like. The panel says which. */}
            <FiGitPullRequest size={11} aria-hidden />
            {totals.ready > 0 ? totals.ready : null}
          </>
        ) : (
          <>
            {/* The git-branch mark, matching the "In PR" stage colour (violet) used by WorkflowLine. */}
            <FiGitBranch size={12} aria-hidden />
            {wideLabel}
            <FiChevronDown size={12} aria-hidden style={{ opacity: 0.7 }} />
          </>
        )}
      </button>

      {open && (compact ? placement !== null : true) && (
        // PORTALED IN COMPACT, nested in the wide form. Compact's panel has to cross the columns
        // beside the concierge, and `ConciergeColumn`'s lift (`zIndex: CONCIERGE_LIFT_Z`) makes that
        // column a stacking context — so nested, both layers below were capped at 3 and the pull
        // tab's rail painted over them. The wide form renders in a full-width bar that is not a
        // stacking context and is positioned off its own wrapper, so portaling it would break its
        // anchor for no gain. See the containment note above and components/ModalLayer.tsx.
        <PanelLayer portaled={compact}>
          <div
            onClick={() => {
              setOpen(false);
              setOverrideArmed(null); // closing the panel discards the deliberate act
              setOverrideReason(""); // …and the sentence written to justify it
            }}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            data-testid="open-pr-panel"
            style={{
              // COMPACT is pinned in WINDOW coordinates by `panelPlacement` — deliberately wider
              // than the concierge column, floating across its neighbours, clamped to the window at
              // both edges. `position: fixed` rather than `absolute` because it is portaled to
              // `document.body` and must not be positioned off whatever the page happens to scroll.
              //
              // The WIDE form stays anchored to the badge's RIGHT edge in its own wrapper. The badge
              // is flush right in the tab bar, so a left anchor put 340–460px of panel outside the
              // window and clipped every control.
              ...(compact
                ? {
                    position: "fixed" as const,
                    top: placement!.top,
                    left: placement!.left,
                    width: placement!.width,
                  }
                : {
                    position: "absolute" as const,
                    top: "100%",
                    right: 0,
                    // Clamped to the window. BOTH need the clamp: min-width beats max-width in the
                    // cascade, so clamping only max-width leaves a 340px floor that can exceed a
                    // narrow viewport. These two lines plus the right anchor ARE the containment —
                    // see the note above the component for why the measured nudge that used to
                    // follow them is gone.
                    minWidth: "min(340px, calc(100vw - 16px))",
                    maxWidth: "min(460px, calc(100vw - 16px))",
                    marginTop: 4,
                  }),
              // Same idea vertically: never taller than the window, and scroll inside when the list
              // is longer than that.
              maxHeight: "min(420px, calc(100vh - 80px))",
              overflowY: "auto",
              background: C.deepForest,
              border: `1px solid ${C.hairline}`,
              borderRadius: 6,
              boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              padding: 6,
              zIndex: 41,
            }}
          >
            {/* Header: what this list covers, and the escape hatch. NOTE WHAT IS *NOT* HERE — there
                is no fleet-wide "merge everything". See the group headers below. */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px 8px",
                borderBottom: `1px solid ${C.hairline}`,
                marginBottom: 4,
              }}
            >
              {/* THE ONE THING IN THIS ROW ALLOWED TO GIVE WAY, and it has to be told so twice.
                  `flex: 1` alone lets it GROW but not shrink below its min-content width — a flex
                  item's automatic minimum size is its content — so at a hostile width the browser
                  took the space out of the BUTTON beside it instead, which is how the founder was
                  shown a primary action reading "Merge all re". `minWidth: 0` is what makes this
                  item the one that yields; the ellipsis is what makes yielding legible. */}
              <span
                data-testid="pr-count-label"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: C.cream,
                  fontSize: 13,
                  fontWeight: FONT_WEIGHT.semibold,
                }}
              >
                {fleetHeadline(totals)}
              </span>
              {/* RE-ASK GITHUB, ON DEMAND — every scope at once. The gate withholds Merge while
                  mergeability is `unknown`, which is the honest answer — but GitHub invalidates
                  mergeability on every push to the base, so merging one PR routinely leaves the
                  REST of the list unknown. With only the poll (OPEN_PR_POLL_MS = 3 minutes) that is
                  a panel where every control is dead and the sole recovery is closing and reopening
                  it. This is the escape hatch that makes blocking on `unknown` affordable
                  (roborev 56050). */}
              <button
                data-testid="pr-refresh"
                disabled={anyListedMerging || refreshing}
                aria-label="Refresh — re-ask GitHub about these pull requests"
                title="Refresh — re-ask GitHub about these pull requests"
                onClick={() => {
                  // SAYS SO WHILE IT WORKS. A `gh` round trip is seconds, and a control whose whole
                  // job is "try again" must not look like it ignored the click meanwhile.
                  const scope = scopesKey;
                  setRefreshingScope(scope);
                  clearProbeRefusals(); // see clearProbeRefusals — answering the probe is the remedy
                  refreshProbeGates(); // ...and re-ASK, rather than re-showing the cached reading
                  // DISARM ALONGSIDE THE CLEAR, for the same reason the open/close toggle does it.
                  // Dropping the refusal takes the row out of the `probeRefusal` branch, so if the
                  // refetch shows the PR as not-green-but-overridable it renders the `unstable`
                  // override button instead — and `armed` is shared state, so that button would
                  // come up already reading "Merge anyway?" with its first click consumed. One
                  // click would then merge a red PR whose two-step the user never performed.
                  setOverrideArmed(null);
                  setOverrideReason("");
                  // Clears only if it is still OURS. A refresh for a different set of open tabs may
                  // have started in the meantime and owns the flag now; ending this one must not
                  // flip that button back to idle.
                  void refetch().finally(() => {
                    if (aliveRef.current)
                      setRefreshingScope((s) => (s === scope ? null : s));
                  });
                }}
                style={{
                  // `flex: 0 0 auto` — see the count label above. `whiteSpace: nowrap` stops the
                  // text WRAPPING, and does nothing at all to stop the BOX being shrunk under it
                  // and the text clipped; the two are separate defences and this row shipped with
                  // only the first.
                  flex: "0 0 auto",
                  background: "transparent",
                  color: C.muted,
                  border: `1px solid ${C.hairline}`,
                  borderRadius: 6,
                  padding: "3px 8px",
                  fontSize: 12,
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor:
                    anyListedMerging || refreshing ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {error && (
              <div
                data-testid="merge-error"
                style={{
                  color: C.sienna,
                  fontSize: 12,
                  padding: "4px 8px 8px",
                  wordBreak: "break-word",
                  // The probe refusal is several lines and they are the whole point of it. Room to
                  // scroll rather than a clipped or panel-stretching block: this sits above the PR
                  // list, and a long refusal must not push the rows it is about off screen.
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                <MergeErrorText text={error} onOpenLink={openGithub} />
              </div>
            )}

            {/* ITS OWN SLOT, BENEATH the merge error rather than sharing it. The two are independent
                facts and either can be true alone — and the case where both are true is the common
                one, not a corner: a merge fails because `gh` is unavailable, and the refetch that
                follows fails for exactly the same reason. Sharing one slot meant the staleness
                notice reliably ate the only text saying why the merge failed. Amber, not sienna:
                this is "what you are looking at may be old", not "something went wrong". */}
            {/* COULD NOT READ AT ALL — no rows, no count, so its absence from the list below proves
                nothing. Its OWN slot rather than the stale one: that notice says "what you can see
                may be out of date", which would be describing a list this project does not have. */}
            {unreadableNames.length > 0 && (
              <div
                data-testid="pr-unreadable-notice"
                style={{
                  color: C.amber,
                  fontSize: 12,
                  padding: error ? "0 8px 8px" : "4px 8px 8px",
                  wordBreak: "break-word",
                }}
              >
                {probeUnreadableFor(unreadableNames)}
              </div>
            )}

            {staleNames.length > 0 && (
              <div
                data-testid="pr-stale-notice"
                style={{
                  color: C.amber,
                  fontSize: 12,
                  padding: error ? "0 8px 8px" : "4px 8px 8px",
                  wordBreak: "break-word",
                }}
              >
                {probeFailedFor(staleNames)}
              </div>
            )}

            {sections.map((group) => {
              const groupMerging = anyMergingIn(group);
              return (
                <div
                  key={group.key}
                  data-testid="pr-group"
                  data-project-id={group.scope.projectId}
                >
                  {/* ── THE SECTION HEADER: WHICH PROJECT, AND THE ONLY BULK ACTION ────────────
                      The founder's ask verbatim — "listed by project tab name in the actual PR list
                      the user sees when clicking on the chiclet".

                      "Merge all ready" LIVES HERE rather than in the panel header, and that is a
                      safety decision, not a layout one. Fleet-wide it would be one click merging
                      across repositories — a far bigger button than the per-project one it replaced,
                      with no statement of what it is about to touch. Sitting in the group header it
                      is scoped by construction: it can only ever act on the repo whose name is on
                      the same line, and it passes that group's scope explicitly to `runMerge`. */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px 4px",
                      marginTop: 2,
                    }}
                  >
                    <span
                      data-testid="pr-group-name"
                      data-also-open-as={group.alsoOpenAs.join(", ") || undefined}
                      title={
                        // THE FOLD IS STATED, NEVER SILENT. When two tabs are one repository the
                        // section that vanished has to be findable, and the tooltip is where someone
                        // hunting for it will look — so it names every checkout's PATH, which is the
                        // fact that tells an agent's owner which working copy they are in.
                        group.members.length > 1
                          ? group.members
                              .map((m) => `${m.projectName}: ${m.rootPath ?? "(no folder)"}`)
                              .join("\n")
                          : (group.scope.rootPath ?? group.scope.projectName)
                      }
                      style={{
                        // Yields before the button does — same ranking as the panel header, same
                        // reason: the action must never be the thing that truncates.
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: C.muted,
                        fontSize: TYPE.micro,
                        fontWeight: FONT_WEIGHT.semibold,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                      }}
                    >
                      {group.scope.projectName}
                      {group.alsoOpenAs.length > 0 && (
                        // ONE REPOSITORY, TWO TABS — said out loud in the heading (the founder's
                        // choice of the three presentations offered). A linked worktree means the
                        // two tabs share every pull request, so the rows are listed once here; the
                        // other checkout is named rather than dropped, because agents live in a
                        // PROJECT ENTRY and the reader has to be able to tell which one they are
                        // looking at. Lowercase and un-tracked so it reads as an aside against the
                        // uppercase project name rather than a second heading.
                        <span
                          data-testid="pr-group-also-open-as"
                          style={{
                            fontWeight: FONT_WEIGHT.regular,
                            letterSpacing: "normal",
                            textTransform: "none",
                            opacity: 0.75,
                          }}
                        >
                          {` · also open as ${group.alsoOpenAs.join(", ")}`}
                        </span>
                      )}
                    </span>
                    {/* THE NUMBER THE FOUNDER READ AS "ELEVEN READY".
                        It was `group.prs.length` — the total open — sitting beside a "Merge all
                        ready" button, while eight of those eleven were hard-blocked on unanswered
                        knightwatch probes. One number cannot carry both facts, and the one it did
                        carry was the one nobody needed. So: split it, and only once there is a
                        second fact to tell. With nothing probe-blocked this is the plain total it
                        has always been, because "3 ready · 0 blocked" is chrome noise. */}
                    <span
                      data-testid="pr-group-count"
                      data-ready={group.readyCount}
                      data-blocked={group.blockedCount}
                      title={
                        group.blockedCount > 0
                          ? `${group.readyCount} ready to merge · ${group.blockedCount} blocked on unanswered knightwatch probes (${group.prs.length} open)`
                          : `${group.prs.length} open`
                      }
                      style={{
                        flex: "0 0 auto",
                        color: C.muted,
                        fontSize: TYPE.micro,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {group.blockedCount > 0 ? (
                        <>
                          {group.readyCount} ready
                          <span style={{ opacity: 0.5 }}> · </span>
                          <span style={{ color: C.sienna }}>{group.blockedCount} blocked</span>
                        </>
                      ) : (
                        group.prs.length
                      )}
                    </span>
                    {/* PRESENT EVEN WITH NOTHING GREEN, and disabled — not omitted. A button that
                        vanishes when it cannot act takes its own EXPLANATION with it, and the
                        tooltip here is the only place the reader is told what "ready" is waiting on
                        (checks pending or failing, a conflict, or GitHub not having finished
                        working out whether it can merge). That is the same mistake, one control
                        down, as the chip unmounting when its scope resolved to nothing. */}
                    <button
                      data-testid="merge-all"
                      data-project-id={group.scope.projectId}
                      disabled={group.readyCount === 0 || groupMerging}
                      title={
                        // NAMES THE PROBE CASE TOO. This copy enumerated the reasons a PR is held
                        // back and predates probes being one of them — so in the founder's own
                        // scenario (green CI, eight PRs blocked on unanswered probes) it sent the
                        // reader to go and look at a CI that was never the problem.
                        group.readyCount === 0
                          ? `No PRs in ${group.scope.projectName} are ready to merge — checks pending or failing, conflicts, unanswered knightwatch probes, or GitHub has not finished working out whether they can merge`
                          : `Merge the ${group.readyCount} PR${
                              group.readyCount === 1 ? "" : "s"
                            } in ${group.scope.projectName} whose checks have passed and that are not showing an unanswered probe`
                      }
                      onClick={() =>
                        void runMerge(
                          group.scope,
                          group.prs
                            .filter((p) => prMergeReadiness(p).canMerge)
                            .map((p) => p.number),
                        )
                      }
                      style={{
                        // THE PRIMARY ACTION. It may never be truncated — that is the hard
                        // constraint on this whole surface — so it never shrinks, and the project
                        // name beside it yields first.
                        flex: "0 0 auto",
                        background:
                          group.readyCount === 0 || groupMerging
                            ? "transparent"
                            : C.teal,
                        color:
                          group.readyCount === 0 || groupMerging
                            ? C.muted
                            : "#fff",
                        border: `1px solid ${
                          group.readyCount === 0 || groupMerging
                            ? C.muted
                            : C.teal
                        }`,
                        borderRadius: 6,
                        padding: "3px 10px",
                        fontSize: 12,
                        fontWeight: FONT_WEIGHT.semibold,
                        cursor:
                          group.readyCount === 0 || groupMerging
                            ? "default"
                            : "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {/* "Merge N ready", not "Merge all ready (N)". The old wording put the
                          COUNT in a parenthetical after the word "all", so a section reading
                          "11 · Merge all ready" invited exactly the reading the founder gave it.
                          Naming the number the button will actually act on makes the exclusion
                          visible BEFORE the click, which is why nothing is ever "skipped"
                          afterwards. */}
                      {groupMerging
                        ? "Merging…"
                        : group.readyCount
                          ? `Merge ${group.readyCount} ready`
                          : "Merge all ready"}
                    </button>
                  </div>

                  {group.prs.map((pr) => {
                    const ready = prMergeReadiness(pr);
                    const rowKey = prKeyOf(group.key, pr.number);
                    /** The unanswered blocking probes on this row, when a read has landed and found
                     *  any. Drives the disclosure — an ACTION-free STATUS, which is the distinction
                     *  the "Override probes…" button could not carry on its own: it looked identical
                     *  whether the PR had zero probes or five. */
                    // GATED ON THE ROW'S OWN VERDICT — the same `prMergeReadiness` call the label
                    // above comes from, so the count, the word and the drawer are three views of
                    // ONE decision rather than two calls over two snapshots.
                    //
                    // Only two facts outrank probes: a CONFLICT and NO MERGE RIGHTS. Probes rank
                    // above every check state and above draft and protection — an earlier version
                    // of this comment claimed draft and protection outranked them, which is simply
                    // wrong (see `prMergeReadiness`), and in this codebase a comment like that is
                    // read as the contract.
                    const probeDetail =
                      ready.blocker === "probes"
                        ? probeDetailByGroup.get(group.key)?.get(pr.number)
                        : undefined;
                    const probesOpen = probeExpanded === rowKey;
                    const busy = merging.has(rowKey);
                    const armed = overrideArmed === rowKey;
                    const agent = resolveAgent(pr);
                    /** This row's last merge was refused for unanswered probes — the message, or
                     *  undefined. Takes precedence over `ready` in the action slot: the PR was green
                     *  enough for us to try, and Rust said no for a reason `ready` cannot see. */
                    const probeRefusal = probeRefusals.get(rowKey);
                    /** Why the typed reason will not do yet, or null. Read at RENDER time so the
                     *  button's enabled state and the hint under the box cannot disagree. */
                    const reasonIssue = knightwatchReasonIssue(overrideReason);
                    return (
                      <Fragment key={rowKey}>
                        <div
                          data-testid="pr-row"
                          data-project-id={group.scope.projectId}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 8px",
                            borderRadius: 6,
                          }}
                        >
                          <span
                            // Not aria-hidden: the dot now carries the BLOCKING REASON, not just a
                            // decorative CI colour, so it has to be readable rather than skipped.
                            role="img"
                            aria-label={ready.title}
                            data-testid={`pr-dot-${pr.number}`}
                            data-tone={ready.tone}
                            title={ready.title}
                            style={{
                              flex: "0 0 auto",
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: dotColor(ready.tone),
                            }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                color: C.cream,
                                fontSize: 13,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                              title={pr.title}
                            >
                              <span style={{ color: C.muted }}>
                                #{pr.number}
                              </span>{" "}
                              {pr.title || pr.headRefName}
                            </div>
                            {/* A FLEX ROW, so the two halves of this line can be ranked. It was one
                              text node with a single ellipsis across the whole thing, which
                              ellipsises LEFT-TO-RIGHT — and the state label comes first, so at a
                              narrow width the reader got "1 c…" and neither fact. The founder's
                              screenshot is exactly that. The blocking reason is the most important
                              string on this surface (it is the answer to "why can't I merge this"),
                              so it is pinned; the branch is recoverable from the row's other
                              controls, so the branch yields. */}
                            <div
                              style={{
                                display: "flex",
                                alignItems: "baseline",
                                color: C.muted,
                                fontSize: 12,
                              }}
                            >
                              {/* The STATE IN WORDS, so a non-green row does not depend on colour
                                perception alone. Green needs none — its enabled Merge button says
                                it. */}
                              {ready.label ? (
                                <span
                                  data-testid={`pr-state-${pr.number}`}
                                  title={ready.title}
                                  style={{
                                    // NEVER ELIDED. See the note above.
                                    flex: "0 0 auto",
                                    whiteSpace: "nowrap",
                                    color: dotColor(ready.tone),
                                    fontWeight: FONT_WEIGHT.semibold,
                                  }}
                                >
                                  {ready.label}
                                </span>
                              ) : null}
                              {/* BEHIND A CLICK, which is what the founder chose. The probe's text,
                                its durable id and how to answer it are several lines each; inline
                                they would push every other row off screen, and above the list they
                                were the wall of red prose whose decisive line got cut off at the
                                fold. So the row carries the FACT and this opens the DETAIL. */}
                              {probeDetail ? (
                                <button
                                  data-testid={`probe-disclosure-${pr.number}`}
                                  aria-expanded={probesOpen}
                                  // NAMED, not left to the icon. A `title` is ignored for the
                                  // accessible name the moment an element has text content, and an
                                  // icon-only button has none to fall back on either — the same
                                  // trap `open-pr-badge` documents 500 lines up (roborev 56141).
                                  // This is the control that carries the blocking detail, so it may
                                  // not announce itself as an unlabelled button.
                                  aria-label={probeDisclosureLabel(probeDetail.length, probesOpen)}
                                  title={probeDisclosureLabel(probeDetail.length, probesOpen)}
                                  onClick={() => setProbeExpanded(probesOpen ? null : rowKey)}
                                  style={{
                                    flex: "0 0 auto",
                                    marginLeft: 5,
                                    background: "transparent",
                                    border: "none",
                                    padding: "0 2px",
                                    color: C.sienna,
                                    fontSize: TYPE.small,
                                    lineHeight: 1,
                                    cursor: "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                  }}
                                >
                                  {/* AN ICON, NOT A GLYPH. `▸`/`▾` are typed characters wearing an
                                    affordance's clothes: they inherit the text font, so they render
                                    differently on every machine and read as punctuation to a screen
                                    reader. The `glyphIcons` ratchet fails on exactly this, and it
                                    is a founder-stated rule for the whole app — react-icons/fi,
                                    which is already imported here for the other three. */}
                                  {probesOpen ? (
                                    <FiChevronDown aria-hidden size={12} />
                                  ) : (
                                    <FiChevronRight aria-hidden size={12} />
                                  )}
                                </button>
                              ) : null}
                              {/* PADDING, not the literal spaces this used to be written with. Making
                                the line a flex row BLOCKIFIES every child, and leading/trailing
                                whitespace in a block box is stripped — so `" · "` rendered as a bare
                                `·` jammed against both neighbours. Caught in the capture, not by the
                                suite: jsdom lays nothing out, so no assertion here could see it. */}
                              {ready.label ? (
                                <span
                                  aria-hidden
                                  style={{
                                    flex: "0 0 auto",
                                    opacity: 0.5,
                                    padding: "0 5px",
                                  }}
                                >
                                  ·
                                </span>
                              ) : null}
                              <span
                                data-testid={`pr-branch-${pr.number}`}
                                title={pr.headRefName}
                                style={{
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {pr.headRefName}
                              </span>
                            </div>
                          </div>

                          {agent && (
                            <button
                              data-testid={`open-agent-${pr.number}`}
                              title={`Open ${agent.agentName} — the agent that opened this PR`}
                              onClick={() => {
                                setOpen(false);
                                onOpenAgent(agent);
                              }}
                              style={{
                                flex: "0 0 auto",
                                background: "transparent",
                                color: C.accentInk,
                                border: `1px solid ${C.accentMid}`,
                                borderRadius: 6,
                                padding: "3px 8px",
                                fontSize: 12,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              Open agent
                            </button>
                          )}

                          <button
                            data-testid={`open-github-${pr.number}`}
                            title="View this PR on GitHub"
                            onClick={() => openGithub(pr.url)}
                            disabled={!pr.url}
                            style={{
                              flex: "0 0 auto",
                              background: "transparent",
                              // Ink vs stroke, as on the chip above: violetInk for the label the user
                              // READS, the brand literal for the box it sits in.
                              color: pr.url ? C.violetInk : C.muted,
                              border: `1px solid ${pr.url ? C.violet : C.muted}`,
                              borderRadius: 6,
                              padding: "3px 8px",
                              fontSize: 12,
                              cursor: pr.url ? "pointer" : "default",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <FiExternalLink size={12} aria-hidden />
                          </button>

                          {/* DISMISS — "not now", and the founder's literal ask ("next to the Merge
                            button we need a DISMISS"). It sits BEFORE Merge so the destructive-
                            looking control is never the one under a pointer aimed at the primary
                            action, and it is icon-only for the same reason the GitHub link is: this
                            row's hard constraint is that the primary action never truncates, and a
                            sixth worded control is what would spend the width to break it.

                            NOT DISABLED WHILE MERGING. Dismiss touches only a local JSON store,
                            so there is no interaction with an in-flight merge worth guarding — and
                            the row a merge is stuck on is exactly the one a user reaches to dismiss.
                            A dismissed PR that then merges is pruned by the next probe. */}
                          <button
                            data-testid={`dismiss-${pr.number}`}
                            data-project-id={group.scope.projectId}
                            aria-label={`Dismiss PR #${pr.number} — stop offering it here until something changes`}
                            title={`Dismiss — stop offering this PR here. It comes back if you gain merge rights, if it is pushed to, or if it becomes mergeable. Restore it any time from "Dismissed" at the bottom of this list.`}
                            onClick={() =>
                              void runDismiss(group.scope, group.key, pr)
                            }
                            style={{
                              flex: "0 0 auto",
                              background: "transparent",
                              color: C.muted,
                              border: `1px solid ${C.hairline}`,
                              borderRadius: 6,
                              padding: "3px 8px",
                              fontSize: 12,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <FiEyeOff size={12} aria-hidden />
                          </button>

                          {/* GREEN ONLY gets the one-click Merge. A non-green PR with an ambiguous
                            answer (GitHub would accept it, but a non-required check is red or still
                            running) gets a two-step override instead — the user has to mean it.
                            Everything else gets a disabled button that says why.

                            A PROBE REFUSAL OUTRANKS BOTH. It is not a property of the PR's checks —
                            `ready` will still say this row is green — it is Rust having refused a
                            merge we already attempted. Its override is the same two-step grammar
                            with one thing added: the second step COSTS A SENTENCE, because unlike
                            "GitHub would accept this anyway" there is a reviewer's unanswered
                            question here and the reason is recorded on the PR beside it. */}
                          {probeRefusal ? (
                            <button
                              data-testid={`probe-override-${pr.number}`}
                              data-project-id={group.scope.projectId}
                              data-armed={armed ? "yes" : "no"}
                              // Armed with nothing written is DISABLED, not a silent no-op: the button
                              // that does the merge must never look like it did something.
                              disabled={busy || (armed && reasonIssue !== null)}
                              title={
                                armed
                                  ? PROBE_REASON_HINT
                                  : "Refused: this PR still carries unanswered knightwatch [blocking] probes. Answering them on the pull request is the way through — this records a written reason for merging without one."
                              }
                              onClick={() => {
                                // Two deliberate acts, as everywhere else on this surface — plus the
                                // sentence. The first click only arms the row and opens the box.
                                if (!armed) {
                                  setOverrideArmed(rowKey);
                                  // CLEARED ON EVERY ARM, so a reason typed for one PR can never be
                                  // inherited by the next row the user arms.
                                  setOverrideReason("");
                                  return;
                                }
                                const reason = overrideReason.trim();
                                if (knightwatchReasonIssue(reason) !== null)
                                  return;
                                setOverrideArmed(null);
                                setOverrideReason("");
                                // BOUND TO THIS PR NUMBER. See `runMerge`'s `override` parameter.
                                void runMerge(group.scope, [pr.number], {
                                  number: pr.number,
                                  reason,
                                });
                              }}
                              style={{
                                flex: "0 0 auto",
                                background: "transparent",
                                color:
                                  armed && reasonIssue === null
                                    ? C.sienna
                                    : C.muted,
                                border: `1px solid ${armed && reasonIssue === null ? C.sienna : C.muted}`,
                                borderRadius: 6,
                                padding: "3px 10px",
                                fontSize: 12,
                                fontWeight: FONT_WEIGHT.semibold,
                                cursor:
                                  busy || (armed && reasonIssue !== null)
                                    ? "default"
                                    : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {busy
                                ? "Merging…"
                                : armed
                                  ? PROBE_OVERRIDE_ARMED_LABEL
                                  : PROBE_OVERRIDE_LABEL}
                            </button>
                          ) : ready.canMerge || !ready.override ? (
                            <button
                              data-testid={`merge-${pr.number}`}
                              data-project-id={group.scope.projectId}
                              disabled={!ready.canMerge || busy}
                              title={
                                ready.canMerge
                                  ? `Merge this PR into ${group.scope.projectName}'s main (merge commit)`
                                  : ready.title
                              }
                              onClick={() =>
                                void runMerge(group.scope, [pr.number])
                              }
                              style={{
                                flex: "0 0 auto",
                                background:
                                  ready.canMerge && !busy
                                    ? C.teal
                                    : "transparent",
                                color:
                                  ready.canMerge && !busy ? "#fff" : C.muted,
                                border: `1px solid ${ready.canMerge && !busy ? C.teal : C.muted}`,
                                borderRadius: 6,
                                padding: "3px 10px",
                                fontSize: 12,
                                fontWeight: FONT_WEIGHT.semibold,
                                cursor:
                                  ready.canMerge && !busy
                                    ? "pointer"
                                    : "default",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {busy ? "Merging…" : "Merge"}
                            </button>
                          ) : (
                            <button
                              data-testid={`merge-override-${pr.number}`}
                              data-project-id={group.scope.projectId}
                              data-armed={armed ? "yes" : "no"}
                              disabled={busy}
                              title={`${ready.title}. ${ready.override.reason}`}
                              onClick={() => {
                                // Two deliberate acts. The first only ARMS the button and relabels it
                                // with the consequence; merging takes a second, informed click.
                                if (!armed) {
                                  setOverrideArmed(rowKey);
                                  return;
                                }
                                setOverrideArmed(null);
                                void runMerge(group.scope, [pr.number]);
                              }}
                              style={{
                                flex: "0 0 auto",
                                background: "transparent",
                                color: armed ? C.sienna : C.muted,
                                border: `1px solid ${armed ? C.sienna : C.muted}`,
                                borderRadius: 6,
                                padding: "3px 10px",
                                fontSize: 12,
                                fontWeight: FONT_WEIGHT.semibold,
                                cursor: busy ? "default" : "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {busy
                                ? "Merging…"
                                : armed
                                  ? "Merge anyway?"
                                  : ready.override.label}
                            </button>
                          )}
                        </div>

                        {/* THE SENTENCE, on its own line UNDER the row it belongs to.
                          Not a modal: the panel already has a deliberate two-step arming grammar and
                          a modal would be a second one, with the row's own context (its number, its
                          state, its branch) hidden behind it. Not inline in the row either — the row
                          is a ranked flex line whose rule is that the action never truncates, and a
                          text box in it would fight the title for the same space. */}
                        {/* ONE PROBE PER BLOCK: its specialist, its DURABLE id, its words, and a
                          way to open the comment that raised it. The durable `<commentId>#<index>`
                          form is the one that keeps working from any later comment — a bare
                          "Probe 1" is read against the review the reply follows, so a newer review
                          puts older probes out of its reach. That is why it is the thing rendered
                          and the thing the copy button copies. */}
                        {probeDetail && probesOpen && (
                          <div
                            data-testid={`probe-detail-${pr.number}`}
                            style={{
                              padding: "0 8px 8px 24px",
                              display: "flex",
                              flexDirection: "column",
                              gap: 6,
                            }}
                          >
                            {probeDetail.map((probe) => {
                              const id = `${probe.commentId}#${probe.index}`;
                              return (
                                <div
                                  key={id}
                                  data-testid={`probe-item-${pr.number}-${probe.index}`}
                                  style={{
                                    borderLeft: `2px solid ${C.sienna}`,
                                    paddingLeft: 8,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 3,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 6,
                                      flexWrap: "wrap",
                                      fontSize: TYPE.micro,
                                      color: C.muted,
                                    }}
                                  >
                                    <span style={{ fontWeight: FONT_WEIGHT.semibold }}>
                                      Probe {probe.index}
                                    </span>
                                    <code data-testid={`probe-id-${pr.number}-${probe.index}`}>
                                      {id}
                                    </code>
                                    {probe.from ? <span>from: {probe.from}</span> : null}
                                  </div>
                                  <div style={{ fontSize: 12, color: C.cream }}>{probe.text}</div>
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                      data-testid={`probe-open-${pr.number}-${probe.index}`}
                                      title="Open the review comment that raised this probe"
                                      onClick={() => openGithub(probe.url)}
                                      disabled={!probe.url}
                                      style={{
                                        background: "transparent",
                                        border: `1px solid ${C.accentMid}`,
                                        borderRadius: 6,
                                        color: C.accentInk,
                                        padding: "2px 8px",
                                        fontSize: TYPE.micro,
                                        cursor: probe.url ? "pointer" : "default",
                                      }}
                                    >
                                      Open on GitHub
                                    </button>
                                    <button
                                      data-testid={`probe-copy-${pr.number}-${probe.index}`}
                                      title="Copy the durable probe id — cite it in a reply on the PR to answer it"
                                      onClick={() => void navigator.clipboard?.writeText(id)}
                                      style={{
                                        background: "transparent",
                                        border: `1px solid ${C.accentMid}`,
                                        borderRadius: 6,
                                        color: C.accentInk,
                                        padding: "2px 8px",
                                        fontSize: TYPE.micro,
                                        cursor: "pointer",
                                      }}
                                    >
                                      Copy probe id
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {probeRefusal && armed && (
                          <div
                            data-testid={`probe-override-row-${pr.number}`}
                            style={{ padding: "0 8px 8px 24px" }}
                          >
                            <input
                              data-testid={`probe-override-reason-${pr.number}`}
                              // The row was armed by a deliberate click; the caret belongs here.
                              autoFocus
                              value={overrideReason}
                              onChange={(e) =>
                                setOverrideReason(e.target.value)
                              }
                              placeholder="Why is it safe to merge with the probe unanswered?"
                              aria-label={`Reason for merging PR #${pr.number} with unanswered knightwatch probes`}
                              style={{
                                width: "100%",
                                boxSizing: "border-box",
                                background: "transparent",
                                color: C.cream,
                                border: `1px solid ${reasonIssue === null ? C.sienna : C.muted}`,
                                borderRadius: 6,
                                padding: "4px 8px",
                                fontSize: 12,
                              }}
                            />
                            <div
                              data-testid={`probe-override-hint-${pr.number}`}
                              style={{
                                color: reasonIssue === null ? C.muted : C.amber,
                                // TYPE.micro, not a literal: the theme ratchet counts off-scale
                                // fontSize values and this is a hint, the register `micro` is for.
                                fontSize: TYPE.micro,
                                paddingTop: 4,
                              }}
                            >
                              {reasonIssue === null
                                ? PROBE_REASON_HINT
                                : PROBE_REASON_SHORT}
                            </div>
                          </div>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              );
            })}

            {/* ── DISMISSED: THE HALF THAT KEEPS "NOT NOW" FROM MEANING "NEVER" ────────────────
                A dismissal that cannot be seen or undone is worse than the un-pressable Merge
                button this feature removes: a mergeable pull request would be invisible, uncounted,
                and with nothing on screen to say where it went. The founder has been bitten by
                invisible state repeatedly, so hiding a row obliges this section to exist.

                AT THE BOTTOM, AND COLLAPSED. It is a review surface rather than part of the ready
                list, so it may never push an actionable row down the panel — and the summary line
                is always rendered when there is anything in it, so the count is visible without a
                click. Fleet-wide rather than per group: dismissals are rare and scattered, and a
                per-project empty section in every group would cost more chrome than it explains. */}
            {dismissedSections.length > 0 && (
              <div data-testid="pr-dismissed" style={{ marginTop: 4 }}>
                <button
                  data-testid="pr-dismissed-toggle"
                  aria-expanded={showDismissed}
                  title={
                    showDismissed
                      ? "Hide the dismissed pull requests"
                      : "Show the pull requests you've dismissed — each can be restored"
                  }
                  onClick={() => setShowDismissed((v) => !v)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderTop: `1px solid ${C.hairline}`,
                    color: C.muted,
                    padding: "8px 8px 6px",
                    marginTop: 2,
                    fontSize: TYPE.micro,
                    fontWeight: FONT_WEIGHT.semibold,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <FiChevronDown
                    size={12}
                    aria-hidden
                    style={{
                      flex: "0 0 auto",
                      // A rotation rather than a second glyph, so the control cannot end up drawn
                      // with one icon and the opposite `aria-expanded`.
                      transform: showDismissed ? "none" : "rotate(-90deg)",
                    }}
                  />
                  Dismissed ({totals.dismissed})
                </button>
                {showDismissed && (
                  <div data-testid="pr-dismissed-list">
                    {/* The one sentence that makes this list read as a PAUSE and not a graveyard.
                        Without it a reader has to infer the revival rule from rows reappearing. */}
                    <div
                      style={{
                        color: C.muted,
                        fontSize: 12,
                        padding: "0 8px 6px",
                        wordBreak: "break-word",
                      }}
                    >
                      These aren't listed or counted above. Each comes back on
                      its own if you gain merge rights, if it's pushed to, or if
                      it becomes mergeable.
                    </div>
                    {dismissedSections.map(({ group, pr }) => (
                      <div
                        key={prKeyOf(group.key, pr.number)}
                        data-testid="pr-dismissed-row"
                        data-project-id={group.scope.projectId}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "6px 8px",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            title={pr.title}
                            style={{
                              color: C.muted,
                              fontSize: 13,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            #{pr.number} {pr.title || pr.headRefName}
                          </div>
                          {/* NAMES ITS PROJECT, because this section is fleet-wide and sits below
                              every group header — the row has no other context to inherit, and
                              #39 alone does not identify a pull request in a fleet-wide list. */}
                          <div
                            style={{
                              color: C.muted,
                              fontSize: TYPE.micro,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {group.scope.projectName}
                          </div>
                        </div>
                        <button
                          data-testid={`restore-${pr.number}`}
                          data-project-id={group.scope.projectId}
                          aria-label={`Restore PR #${pr.number} to the list`}
                          title="Restore — list and count this PR again"
                          onClick={() =>
                            void runRestore(group, pr.number)
                          }
                          style={{
                            flex: "0 0 auto",
                            background: "transparent",
                            color: C.accentInk,
                            border: `1px solid ${C.accentMid}`,
                            borderRadius: 6,
                            padding: "3px 8px",
                            fontSize: 12,
                            fontWeight: FONT_WEIGHT.semibold,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </PanelLayer>
      )}
    </div>
  );
}
