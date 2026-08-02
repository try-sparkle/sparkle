// The app's ONE pull-request affordance — a repo-scoped, agent-independent menu of the open pull
// requests this identity owns, with a per-PR Merge, a "Merge all ready", a Refresh, and a jump to
// the agent that opened each one.
//
// It mounts in the CONCIERGE HEADER now (`compact`, beside the ⋮ — see `ConciergePrChip`), not in
// the project tab strip where the wide "N PRs waiting" pill used to sit. `compact` changes the
// badge and the panel's anchor and nothing else.
//
// Why it lives here and not on the agent row: the per-agent "Merge PR" CTA dies with its agent, and
// every agent leaves the sidebar when its session ends — so a PR opened by a finished session goes
// invisible exactly when it is waiting to be merged. This menu is the durable, always-present gate.
// It replaced the old dot cluster that sat right of the project name.
//
// The Merge action is deliberately gated (`prMergeReadiness` — one decision behind the dot, the
// word, the button and the header count) and merges with a MERGE COMMIT via the Rust `merge_pr`
// command — never a blind or `--auto` merge. See services/openPrs.ts and AGENTS.md.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiChevronDown, FiExternalLink, FiGitBranch, FiGitPullRequest } from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalLayer } from "./ModalLayer";
import { pillStyle } from "./Concierge/pillStyle";
import {
  fetchOpenPrs,
  formatPrBadge,
  mergePr,
  prMergeReadiness,
  prReadyCount,
  OPEN_PR_POLL_MS,
  type PrDotTone,
  type PrRow,
} from "../services/openPrs";
import { log } from "../logger";
import type { Project } from "../types";

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
// Do not "simplify" this back to `left: 8; right: 8`. That is the reported bug, not a tidier form.

/** Clearance the panel keeps from either window edge. */
export const PANEL_EDGE_MARGIN = 8;
/** The gap between the badge's bottom and the panel's top. */
export const PANEL_ANCHOR_GAP = 4;
/**
 * How wide the compact panel gets when the window allows it.
 *
 * WIDER THAN THE CONCIERGE COLUMN ON PURPOSE — that is the entire point of the fix. It is sized to
 * what the CONTENT needs rather than to what the column offers: the header row (count · Refresh ·
 * "Merge all ready (11)") and the widest realistic PR row (dot · #number and subject · "Open agent"
 * · GitHub · "Merge") both fit here without the two things that may never be elided — the primary
 * action and the reason a PR is red — giving up a pixel.
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
  const width = Math.max(0, Math.min(PANEL_MAX_W, viewport.width - PANEL_EDGE_MARGIN * 2));
  // The rightmost left-coordinate that still leaves the margin on the right. Floored at the left
  // margin so the range is never inverted — if it were, the two clamps would fight and `Math.min`
  // would win, pushing the panel off the LEFT edge to keep it off the right.
  const rightMost = Math.max(PANEL_EDGE_MARGIN, viewport.width - PANEL_EDGE_MARGIN - width);
  const left = Math.min(Math.max(anchor.right - width, PANEL_EDGE_MARGIN), rightMost);
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
 * The identity of the repo a render — or an in-flight probe or merge — belongs to.
 *
 * ONE function rather than a template literal written at each site, which is not fastidiousness: the
 * two sites disagreed about their separator for one revision (a literal NUL against a space), every
 * async result compared unequal to the panel showing it, and the menu rendered NOTHING at all. A
 * guard that can silently be wrong about "is this the same repo" has to have exactly one definition.
 * The separator is a character no path or id contains, so distinct pairs cannot collide.
 */
const scopeOf = (rootPath: string | null, projectId: string) => `${rootPath ?? ""}\u0000${projectId}`;

/** Shown in the panel's own staleness slot — BENEATH any merge error, never in place of one — when
 *  a probe failed and the list on screen is what we last managed to read. The two are independent
 *  facts, and the case where both are true is the common one: a merge fails because `gh` is
 *  unavailable, and the refetch that follows fails for exactly the same reason. */
export const PROBE_FAILED =
  "Couldn't reach GitHub just now — this is the last list we could read, so it may be out of date.";

/**
 * The one sentence the badge says — as its accessible NAME and as its tooltip, so a mouse user and
 * a screen-reader user are told the same thing. Shared rather than written twice because the compact
 * badge has no readable label of its own: its whole visible content is a glyph and a numeral.
 */
export function prBadgeTitle(label: string, readyCount: number, total: number): string {
  return readyCount > 0
    ? `${readyCount} of ${total} open pull request${total === 1 ? "" : "s"} ready to merge`
    : `${label} — none ready to merge yet`;
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
function PanelLayer({ portaled, children }: { portaled: boolean; children: ReactNode }) {
  return portaled ? <ModalLayer>{children}</ModalLayer> : <>{children}</>;
}

export function OpenPrMenu({
  rootPath,
  projectId,
  resolveAgent,
  onOpenAgent,
  compact = false,
}: {
  rootPath: string | null;
  /** Scopes the durable PR→agent lookup Rust does while listing. */
  projectId: string;
  resolveAgent: (pr: PrRow) => PrAgentLink | null;
  onOpenAgent: (link: PrAgentLink) => void;
  /**
   * The CONCIERGE HEADER form: a small icon-and-number chip that sits beside the ⋮, rather than
   * the wide bordered "3 PRs waiting" pill that used to sit in the project tab strip.
   *
   * Two things change, and only two — the menu's behaviour is identical either way:
   * - the badge is a green CHICLET carrying the PR icon plus a COUNT OF GREEN PRs, with the number
   *   omitted entirely when none are green (an icon and no number, never a zero) and the chiclet's
   *   edge dropped with it, so a calm header stays calm;
   * - the panel PORTALS to the root layer and is placed against the window rather than against any
   *   box in the column — see `panelPlacement` and the containment note above. It is deliberately
   *   WIDER than the concierge and floats across the columns beside it.
   */
  compact?: boolean;
}) {
  // WHICH REPO THIS RENDER IS ABOUT — the identity every async result is judged against.
  //
  // It replaced a generation COUNTER, and the difference is a dropped merge failure. A counter only
  // increments, so returning to the repo you started in yields a different number for the same
  // repo: click Merge in /repo, switch to /other, switch back, and the failure arrives to a guard
  // that says "not yours" and is silently discarded — the user is looking at the right panel, their
  // merge failed, and nothing says so. Identity answers the question the guard is actually asking,
  // which is "is the panel showing a DIFFERENT repo now", not "has anything happened since"
  // (roborev 56193).
  const scopeKey = scopeOf(rootPath, projectId);
  const [prs, setPrs] = useState<PrRow[] | null>(null);
  const [open, setOpen] = useState(false);
  // Which PRs are mid-merge — drives per-row spinners and disables the row's actions. A Set so
  // "Merge all" can mark several at once without clobbering an in-flight single merge.
  //
  // KEYED BY REPO + NUMBER, not by number. PR numbers collide across repositories, so a plain number
  // set let an in-flight merge of the old repo's #12 grey out the NEW repo's #12 and, through
  // `anyMerging`, the whole panel's "Merge all ready". Clearing the set on a switch fixed that and
  // broke something else: a merge still running when you switched away and back had no spinner, so
  // its row was live again and a second click issued a second `mergePr` for a PR already merging.
  // Scoping the key fixes both at once and needs no reset — another repo's keys simply never match.
  const [merging, setMerging] = useState<ReadonlySet<string>>(new Set());
  const mergeKey = (scope: string, n: number) => `${scope}#${n}`;
  const [error, setError] = useState<string | null>(null);
  // "The list on screen is what we last managed to read." ITS OWN STATE, not a value written into
  // `error`: staleness and a merge failure are independent facts and either can be true alone. They
  // shared the slot for one commit, and `runMerge` made that a deterministic clobber rather than a
  // race — it sets the merge failure and then immediately refetches, and when `gh` is down (the most
  // likely reason the merge just failed) that probe fails too and overwrote the only text saying
  // WHY the merge failed with a generic staleness notice (roborev 56167).
  const [stale, setStale] = useState(false);
  // Which PR's override button is ARMED (one at a time). Arming is the first of the two deliberate
  // acts a non-green merge costs; see the override button below.
  const [overrideArmed, setOverrideArmed] = useState<number | null>(null);
  // WHICH REPO has a user-initiated Refresh in flight, or null — so the button says so rather than
  // looking inert for the length of a `gh` round trip. Scoped for the same reason `merging` is: as a
  // plain boolean it was a second unreset cross-repo flag, and on the panel's designated ESCAPE
  // HATCH. Press Refresh while `gh` is hung (exactly what it exists for), switch project, and the
  // recovery control sat disabled and reading "Refreshing…" for the other repo's round trip with
  // nothing saying why — or flipped back to enabled mid-probe when that round trip ended.
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const refreshing = refreshingScope === scopeKey;
  // Set to false on unmount. Unmount only — the SWITCH guard is `scopeRef` below, because the effect
  // sets this back to `true` on every re-run and so cannot answer "which repo is on screen".
  const aliveRef = useRef(true);
  // The scope the panel is CURRENTLY showing. An async result compares the scope it was issued
  // against to this, and writes only when they match: a probe or a merge that belongs to a repo the
  // user has navigated away from must not paint under the new repo's name, and — the case a counter
  // got wrong — one that belongs to the repo they navigated BACK to still must.
  const scopeRef = useRef(scopeKey);
  // What the last SUCCESSFUL probe returned. Read by `refetch` below to tell "GitHub says there are
  // no PRs" apart from "we could not ask", which `fetchOpenPrs` collapses into one `null`.
  const lastGoodRef = useRef<PrRow[] | null>(null);
  // THE ANCHOR the compact panel hangs off — the badge's own box. Measured, not guessed, because the
  // concierge can be docked to either side of the shell and moved while the app is running.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // Where the portaled panel is pinned, or null when it is closed (or not compact). See the
  // containment note above for why this is measured at all, and why measuring the ANCHOR rather
  // than the PANEL is what keeps it from going stale.
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);

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
      setPlacement(panelPlacement({ right: r.right, bottom: r.bottom }, { width: window.innerWidth }));
    };
    place();
    // THE ONLY THING THAT CAN INVALIDATE A PLACEMENT. Content cannot — the width is a function of
    // the viewport alone — and a column drag cannot reach here either, because it begins with a
    // pointer-down that lands on the click-away backdrop and closes the panel first.
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [compact, open]);

  const refetch = useMemo(
    () => async () => {
      if (!rootPath) return;
      const scope = scopeOf(rootPath, projectId);
      const rows = await fetchOpenPrs(rootPath, projectId);
      if (!aliveRef.current || scope !== scopeRef.current) return;
      // A FAILED PROBE MUST NOT ERASE WHAT WE ALREADY KNOW. `fetchOpenPrs` swallows every failure
      // and returns `null`, and `null` renders no badge at all — so a rate-limited or offline `gh`
      // used to make the whole PR chip VANISH from the header, panel included, until some later
      // poll happened to succeed. That is bad for the 3-minute poll and worse for Refresh, whose
      // entire purpose is recovering from a state where nothing else works: press it at the wrong
      // moment and the control you pressed disappears (roborev 56164).
      //
      // So a null that follows a good list keeps the list and SAYS it is stale. A null with nothing
      // behind it still renders nothing — that is the honest unknown the badge already models, and
      // "0 PRs" would be a claim we cannot make.
      if (rows === null && lastGoodRef.current !== null) {
        setStale(true);
        return;
      }
      lastGoodRef.current = rows;
      setPrs(rows);
      // Only the staleness flag. A merge error is a different fact and is not answered by a probe
      // succeeding — the user still needs to read why their merge failed.
      setStale(false);
    },
    [rootPath, projectId],
  );

  useEffect(() => {
    aliveRef.current = true;
    // The scope every in-flight result is judged against, updated BEFORE anything is kicked off.
    scopeRef.current = scopeKey;
    if (!rootPath) {
      lastGoodRef.current = null;
      setPrs(null);
      setStale(false);
      return;
    }
    // Clear on switch so the previous repo's list can't linger under the new name until the probe
    // returns (up to the network timeout). `lastGoodRef` clears WITH it — otherwise the keep-what-
    // we-know rule above would hold the OLD repo's PRs under the new repo's name, which is the one
    // thing this reset exists to prevent.
    lastGoodRef.current = null;
    setPrs(null);
    setError(null);
    setStale(false);
    setOpen(false);
    // `merging` and `refreshing` are DELIBERATELY not reset here — both are scoped by repo now, so
    // another repo's entries can never match this one's, and a merge or a refresh you left running
    // is still correctly shown as running when you come back to it. A reset would be the thing that
    // loses it.
    //
    // An armed override must not survive a project switch: the number it points at means a
    // different PR in the new repo.
    setOverrideArmed(null);
    void refetch();
    const id = window.setInterval(() => void refetch(), OPEN_PR_POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
    // `scopeKey` is derived from the same two props `refetch` is memoized on, so listing it adds
    // no extra runs — it is here because the effect WRITES it into `scopeRef`, and a dep list that
    // omits the value a guard is seeded from is how that guard silently goes stale.
  }, [rootPath, refetch, scopeKey]);

  const label = formatPrBadge(prs?.length ?? null);
  // Nothing waiting, or we couldn't find out — both render nothing (same rule as the old badge). Also
  // covers the moment a switch clears the list before the new probe returns.
  if (!label) return null;

  const list = prs ?? [];
  // "Merge all ready" counts GREEN and nothing else — the same answer the per-row button gives, so
  // the header count and the buttons under it can never tell different stories.
  const eligible = list.filter((p) => prMergeReadiness(p).canMerge);
  // THROUGH THE EXPORTED HELPER, not `eligible.length`. The two agree by construction — the readiness
  // invariant is `canMerge` ⟺ `tone === "ready"` — but `prReadyCount`'s own doc calls it "the number
  // the small header pill shows", and a helper the component recomputes inline instead of calling is
  // a claim nothing enforces. Routing the badge through it makes that doc true (roborev 56050).
  const readyCount = prReadyCount(list);
  // THIS repo's in-flight merges only. `merging` holds every repo's, so a plain `.size > 0` would
  // put the whole panel into "Merging…" for work happening somewhere else.
  const anyMerging = [...merging].some((k) => k.startsWith(`${scopeKey}#`));

  const runMerge = async (nums: number[]) => {
    if (!rootPath || nums.length === 0) return;
    // THE SCOPE THIS MERGE WAS ISSUED AGAINST, compared to what is on screen when it lands.
    // `aliveRef` answers unmount and nothing else — the effect sets it back to `true` on every
    // re-run — and `ConciergePrChip` renders this menu UNKEYED, so a project switch is a prop change
    // on the same instance. A merge still in flight across one used to land its results under the
    // new repo's name: an error reading "PR #12: <gh message>" about a number that means a different
    // PR in the repo now on screen (roborev 56187). Identity rather than a counter, so switching
    // away and BACK still shows the failure — a counter said "not yours" and dropped it silently,
    // leaving the user in front of the right panel with no idea their merge had failed (56193).
    const scope = scopeKey;
    const showing = () => aliveRef.current && scope === scopeRef.current;
    const keys = nums.map((n) => mergeKey(scope, n));
    setError(null);
    setMerging((prev) => new Set([...prev, ...keys]));
    let firstError: string | null = null;
    // Sequential on purpose: merging PR B right after A picks up A's landing, and it keeps the gh
    // calls from racing each other's rate limit. One failure is recorded but does not abort the rest.
    for (const n of nums) {
      try {
        await mergePr(rootPath, n);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn("open-pr-menu", `merge failed for PR #${n}`, msg);
        if (!firstError) firstError = `PR #${n}: ${msg}`;
      }
    }
    // THE SPINNERS CLEAR UNCONDITIONALLY. They are this scope's own keys, so releasing them is
    // correct wherever the user happens to be looking — and NOT releasing them is how a merge that
    // finished while you were in another project leaves its row permanently greyed out.
    setMerging((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
    // The MESSAGE is different: it is addressed to whoever is reading this panel, so it goes up only
    // when the panel is still showing the repo it is about.
    if (firstError && showing()) setError(firstError);
    // Reconcile with the truth: merged PRs drop out, a failed one stays (now visibly still open).
    // Guarded like the message above: refetch carries its own scope check today, but tightening it
    // here keeps the whole method's discipline uniform rather than relying on that internal guard
    // staying put.
    if (showing()) await refetch();
  };

  const openGithub = (url: string) => {
    if (!url) return;
    void openUrl(url).catch((e) => log.warn("open-pr-menu", "could not open PR", e));
  };

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
        data-ready={readyCount > 0 ? "yes" : "no"}
        // NAMED EXPLICITLY, because compact's content is a bare numeral and an `aria-hidden` glyph —
        // and `title` is ignored for the accessible name the moment an element has text content, so
        // the app's sole pull-request entry point would announce itself as "1, button". The wide
        // form got its name from its "3 PRs waiting" label and the old concierge chip carried an
        // aria-label; neither survives here, so the name has to be stated (roborev 56141).
        aria-label={prBadgeTitle(label, readyCount, list.length)}
        title={prBadgeTitle(label, readyCount, list.length)}
        onClick={() => {
          setOpen((v) => !v);
          // Disarm on EITHER edge. An override armed before the panel closed must not still be
          // armed when it reopens — that would turn a single later click into a merge of a red PR,
          // which is the whole thing the two-step exists to prevent.
          setOverrideArmed(null);
          if (!open) void refetch(); // refresh on open so the user acts on current state
        }}
        style={
          compact
            ? {
                // THE CHICLET — `.pill`'s box, shared with the needs-you filter one slot over rather
                // than re-typed here, so the two chips in this header are the same kind of object.
                // The founder asked for this by name ("it should be in a little chiclet which is
                // not right now — it used to be"): in v0.74.0 the count was green but bare, which
                // reads as loose text beside a chip rather than as a control.
                ...pillStyle(readyCount > 0 ? C.successInk : "transparent"),
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
                color: readyCount > 0 ? C.successInk : C.muted,
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
                color: readyCount > 0 ? C.successInk : C.violetInk,
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
                explicit "0" is a count of nothing, and reads as a state rather than an absence. */}
            <FiGitPullRequest size={11} aria-hidden />
            {readyCount > 0 ? readyCount : null}
          </>
        ) : (
          <>
            {/* The git-branch mark, matching the "In PR" stage colour (violet) used by WorkflowLine. */}
            <FiGitBranch size={12} aria-hidden />
            {label}
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
            {/* Header: count + Merge all ready. */}
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
                  took the space out of the two BUTTONS beside it instead, which is how the founder
                  was shown a primary action reading "Merge all re". `minWidth: 0` is what makes
                  this item the one that yields; the ellipsis is what makes yielding legible.

                  Belt and braces with the wider panel, on purpose: the panel is now sized so this
                  never fires in practice, but "the primary action must never truncate" should not
                  rest on a width constant staying ahead of the copy. */}
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
                {list.length} open pull {list.length === 1 ? "request" : "requests"}
              </span>
              {/* RE-ASK GITHUB, ON DEMAND. The gate now withholds Merge while mergeability is
                  `unknown`, which is the honest answer — but GitHub invalidates mergeability on
                  every push to the base, so merging one PR routinely leaves the REST of the list
                  unknown. With only the poll (OPEN_PR_POLL_MS = 3 minutes) that is a panel where
                  every control is dead and the sole recovery is closing and reopening it. This is
                  the escape hatch that makes blocking on `unknown` affordable (roborev 56050). */}
              <button
                data-testid="pr-refresh"
                disabled={anyMerging || refreshing}
                aria-label="Refresh — re-ask GitHub about these pull requests"
                title="Refresh — re-ask GitHub about these pull requests"
                onClick={() => {
                  // SAYS SO WHILE IT WORKS. A `gh` round trip is seconds, and a control whose whole
                  // job is "try again" must not look like it ignored the click meanwhile.
                  const scope = scopeKey;
                  setRefreshingScope(scope);
                  // Clears only if it is still OURS. Another repo's refresh started in the meantime
                  // owns the flag now, and ending this one must not flip that button back to idle.
                  void refetch().finally(() => {
                    if (aliveRef.current) setRefreshingScope((s) => (s === scope ? null : s));
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
                  cursor: anyMerging || refreshing ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button
                data-testid="merge-all"
                disabled={eligible.length === 0 || anyMerging}
                title={
                  eligible.length === 0
                    ? "No PRs are ready to merge — checks pending or failing, conflicts, or GitHub has not finished working out whether they can merge"
                    : `Merge the ${eligible.length} PR${eligible.length === 1 ? "" : "s"} whose checks have passed`
                }
                onClick={() => void runMerge(eligible.map((p) => p.number))}
                style={{
                  // THE PRIMARY ACTION. It may never be truncated — that is the hard constraint on
                  // this whole surface — so it never shrinks, and the label beside it yields first.
                  flex: "0 0 auto",
                  background: eligible.length === 0 || anyMerging ? "transparent" : C.teal,
                  color: eligible.length === 0 || anyMerging ? C.muted : "#fff",
                  border: `1px solid ${eligible.length === 0 || anyMerging ? C.muted : C.teal}`,
                  borderRadius: 6,
                  padding: "3px 10px",
                  fontSize: 12,
                  fontWeight: FONT_WEIGHT.semibold,
                  cursor: eligible.length === 0 || anyMerging ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {anyMerging ? "Merging…" : `Merge all ready${eligible.length ? ` (${eligible.length})` : ""}`}
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
                }}
              >
                {error}
              </div>
            )}

            {/* ITS OWN SLOT, BENEATH the merge error rather than sharing it. The two are independent
                facts and either can be true alone — and the case where both are true is the common
                one, not a corner: a merge fails because `gh` is unavailable, and the refetch that
                follows fails for exactly the same reason. Sharing one slot meant the staleness
                notice reliably ate the only text saying why the merge failed. Amber, not sienna:
                this is "what you are looking at may be old", not "something went wrong". */}
            {stale && (
              <div
                data-testid="pr-stale-notice"
                style={{
                  color: C.amber,
                  fontSize: 12,
                  padding: error ? "0 8px 8px" : "4px 8px 8px",
                  wordBreak: "break-word",
                }}
              >
                {PROBE_FAILED}
              </div>
            )}

            {list.map((pr) => {
              const ready = prMergeReadiness(pr);
              const busy = merging.has(mergeKey(scopeKey, pr.number));
              const armed = overrideArmed === pr.number;
              const agent = resolveAgent(pr);
              return (
                <div
                  key={pr.number}
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
                      <span style={{ color: C.muted }}>#{pr.number}</span> {pr.title || pr.headRefName}
                    </div>
                    {/* A FLEX ROW, so the two halves of this line can be ranked. It was one text
                        node with a single ellipsis across the whole thing, which ellipsises
                        LEFT-TO-RIGHT — and the state label comes first, so at a narrow width the
                        reader got "1 c…" and neither fact. The founder's screenshot is exactly
                        that. The blocking reason is the most important string on this surface (it
                        is the answer to "why can't I merge this"), so it is pinned; the branch is
                        recoverable from the row's other controls, so the branch yields. */}
                    <div style={{ display: "flex", alignItems: "baseline", color: C.muted, fontSize: 12 }}>
                      {/* The STATE IN WORDS, so a non-green row does not depend on colour
                          perception alone. Green needs none — its enabled Merge button says it. */}
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
                      {/* PADDING, not the literal spaces this used to be written with. Making the
                          line a flex row BLOCKIFIES every child, and leading/trailing whitespace in
                          a block box is stripped — so `" · "` rendered as a bare `·` jammed against
                          both neighbours. Caught in the capture, not by the suite: jsdom lays
                          nothing out, so no assertion here could see it. */}
                      {ready.label ? (
                        <span aria-hidden style={{ flex: "0 0 auto", opacity: 0.5, padding: "0 5px" }}>
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

                  {/* GREEN ONLY gets the one-click Merge. A non-green PR with an ambiguous answer
                      (GitHub would accept it, but a non-required check is red or still running)
                      gets a two-step override instead — the user has to mean it. Everything else
                      gets a disabled button that says why. */}
                  {ready.canMerge || !ready.override ? (
                    <button
                      data-testid={`merge-${pr.number}`}
                      disabled={!ready.canMerge || busy}
                      title={ready.canMerge ? "Merge this PR into main (merge commit)" : ready.title}
                      onClick={() => void runMerge([pr.number])}
                      style={{
                        flex: "0 0 auto",
                        background: ready.canMerge && !busy ? C.teal : "transparent",
                        color: ready.canMerge && !busy ? "#fff" : C.muted,
                        border: `1px solid ${ready.canMerge && !busy ? C.teal : C.muted}`,
                        borderRadius: 6,
                        padding: "3px 10px",
                        fontSize: 12,
                        fontWeight: FONT_WEIGHT.semibold,
                        cursor: ready.canMerge && !busy ? "pointer" : "default",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {busy ? "Merging…" : "Merge"}
                    </button>
                  ) : (
                    <button
                      data-testid={`merge-override-${pr.number}`}
                      data-armed={armed ? "yes" : "no"}
                      disabled={busy}
                      title={`${ready.title}. ${ready.override.reason}`}
                      onClick={() => {
                        // Two deliberate acts. The first only ARMS the button and relabels it with
                        // the consequence; merging takes a second, informed click.
                        if (!armed) {
                          setOverrideArmed(pr.number);
                          return;
                        }
                        setOverrideArmed(null);
                        void runMerge([pr.number]);
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
                      {busy ? "Merging…" : armed ? "Merge anyway?" : ready.override.label}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </PanelLayer>
      )}
    </div>
  );
}
