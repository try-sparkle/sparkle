// Project tabs for Concierge Mode (bead sparkle-qd80 / CM-U7). In the single-window concierge shell,
// each open project is a TAB across the top of the workspace (replacing multi-window). The Sparkle
// concierge column is NOT part of the tabs — it is persistent across all projects. Pinning a project
// scopes the concierge to it ("disregard all other project alerts so you can focus").
//
// Presentational + prop-driven so it's decoupled from the stores and unit-testable: the integration
// (Workspace) supplies the projects, selection, pin state, and per-project status-band counts (from
// the concierge feed), plus the callbacks.

import {
  Fragment,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MdOutlinePushPin } from "react-icons/md";
import { FiPlus, FiX, FiExternalLink, FiAlertTriangle } from "react-icons/fi";
import type { StatusBand } from "../engine/buildSections";
import { bandColor, bandCountLabel } from "../engine/statusBandLabels";
import { BandBadge } from "./BandBadge";
import { C, FONT_WEIGHT } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { PROJECT_TAB_HINT } from "../keyboardHints/hintTargets";
import { resolveTabDrag, type TabDragResult, type TabRect } from "./tabDrag";
import { StaleCheckoutPanel, type StaleTarget } from "./StaleCheckoutPanel";

export interface ProjectTabItem {
  id: string;
  name: string;
  /**
   * The project's checkout directory — what the stale-checkout panel diagnoses and remedies.
   *
   * OPTIONAL, and its absence means NO BADGE rather than a crash. Every live caller has it (the
   * project store carries `rootPath` on every record), but this component is presentational and is
   * rendered from fixtures in half a dozen test files; a required field would turn "this fixture
   * predates the panel" into a type error in files that have nothing to do with staleness. A badge
   * with no root to diagnose would be a button that can only ever fail, so it simply does not
   * render — the same fail-closed reading `stalenessByProject` itself follows.
   */
  rootPath?: string;
}
/** Per-project status-band counts (from the concierge feed) that drive the tab glow + count badge. */
export type ProjectTabCounts = Record<StatusBand, number>;

export interface ProjectTabsProps {
  projects: ProjectTabItem[];
  selectedProjectId: string | null;
  /** The pinned project, if any — its tab shows a solid pin and the concierge is scoped to it. */
  pinnedProjectId: string | null;
  countsByProject: Record<string, ProjectTabCounts>;
  onSelect: (projectId: string) => void;
  /** Toggle pin for a project (pinning one unpins any other; pinning the pinned one unpins). */
  onTogglePin: (projectId: string) => void;
  /** Double-click a tab → that project's settings (rename / move). This is where the old TopBar's
   *  project button lived; omit it and a double-click is just two selects. */
  onOpenSettings?: (projectId: string) => void;
  /** Close a project's tab — put the project away WITHOUT deleting it (deleting lives in project
   *  settings). Omit it and tabs render with no close control at all, which is what the pre-close
   *  tab bar was. */
  onClose?: (projectId: string) => void;
  onAddProject?: () => void;
  /** Is this strip painted right-to-left (the left pair)? Feeds the drag resolver — see tabDrag. */
  reversed?: boolean;
  /** Top-right cluster (kebab menu + avatar) rendered flush-right in the tab bar. */
  topRight?: ReactNode;
  /** Drop a dragged tab into a new slot. `beforeId` is the tab to insert before; null = append.
   *  Omit it and tabs are not reorderable (the gesture still tears off). */
  onReorder?: (projectId: string, beforeId: string | null) => void;
  /** The tab was dragged clear of the strip and released — put it in its own window at that GLOBAL
   *  SCREEN point (`PointerEvent.screenX/screenY`, i.e. Tauri's logical desktop space, NOT client
   *  coordinates). Omit it and dragging out is inert. */
  onTearOff?: (projectId: string, screenPoint: { x: number; y: number }) => void;
  /** Projects currently living in their own window. Their tab stays in the strip — it is how you
   *  get back to that window — but it is dimmed and badged, because its columns are elsewhere. */
  tornOutProjectIds?: ReadonlySet<string>;
  /** How far each project's OWN checkout lags the branch it tracks, keyed by project id.
   *
   *  ONLY STALE PROJECTS BELONG IN HERE. Omission means "nothing to say" — a fresh checkout and a
   *  checkout we could not measure are both simply absent, which is what makes the fail-closed
   *  reading from `repo_freshness` survive the trip to the UI: `unknown` can never arrive as a
   *  confident "0 behind" and paint a reassuring badge over a tree nobody has verified. */
  stalenessByProject?: Record<string, ProjectTabStaleness>;
}

/** A project checkout that has fallen behind the branch it tracks. See `stalenessByProject`. */
export interface ProjectTabStaleness {
  /** Commits the checkout is BEHIND `base`. */
  behind: number;
  /** What it is behind, e.g. `origin/main` — named on screen so the number means something. */
  base: string;
}

/** Movement below this is still a click, so a tab with a slightly shaky press still just selects. */
const DRAG_SLOP = 5;
/**
 * How far past the strip the pointer must go before the drag means "give this its own window".
 *
 * Roughly a tab's own height. Small enough that a deliberate pull-down reads as a tear-off on the
 * first try, large enough that ordinary horizontal reordering — which drifts vertically by a few
 * pixels as the hand moves — never accidentally spawns a window. Below ~24 the strip's own top edge
 * is close enough to the menu bar that a high drag would tear off; above ~80 the gesture stops
 * feeling connected to the cursor.
 */
const TEAR_MARGIN = 48;

/** An in-flight press. Lives in a ref, not state: it updates on every pointermove and re-rendering
 *  the whole strip at pointer rate would drop frames. Only the VISUAL summary goes to state. */
interface TabGesture {
  projectId: string;
  pointerId: number;
  /** Press origin in CLIENT space — the same space the strip and tab rects are measured in. */
  origin: { x: number; y: number };
  /** Latches true on the first non-idle result and never clears (tabDrag's module header). */
  dragging: boolean;
  last: TabDragResult;
  /** Last pointer position in GLOBAL SCREEN space — where a tear-off would place the window. */
  lastScreen: { x: number; y: number };
}

/** The close button's accessible name. Names the PROJECT, so a screen reader hears "Close Alpha"
 *  rather than N identical "Close" buttons — and says what closing does not do, because "×" next to
 *  a project is otherwise easy to read as "delete this project". */
export function closeTitle(projectName: string): string {
  return `Close ${projectName} — the project and its agents are kept`;
}

/**
 * The tab's hover tooltip. It is the ONLY place the drag gesture is discoverable — a tab that can be
 * pulled onto a second monitor looks exactly like one that cannot, and a feature nobody knows the
 * gesture for may as well not ship. Torn-out tabs say what clicking does instead, because for those
 * the answer changed: it raises another window rather than switching this one.
 */
export function tabTitle(
  projectName: string,
  o: { hasSettings: boolean; tornOut: boolean; canTearOff: boolean },
): string {
  if (o.tornOut) return `${projectName} — open in its own window; click to bring that window forward`;
  const parts = [projectName];
  if (o.hasSettings) parts.push("double-click for project settings");
  if (o.canTearOff) parts.push("drag out for its own window");
  return parts.join(" — ");
}

/** The pin tooltip describes what pinning DOES — asymmetric copy for pin vs unpin. */
export function pinTitle(isPinned: boolean): string {
  return isPinned
    ? "Unpin — Sparkle will watch alerts across all projects again"
    : "Pin this project and Sparkle will disregard all other project alerts so you can focus";
}

/** The band a tab's glow/badge reflects: `needs_you` when anything in the project is asking for you,
 *  then `questions` when an agent there is waiting on an answer, otherwise nothing.
 *
 *  TWO BANDS BADGE, NOT ONE — and the second is not a re-run of the two-alarm mistake below. The old
 *  two-tier version lit a YELLOW glow for a "wants you eventually" tier, so the bar carried two
 *  competing ALARM colors for a distinction the user never acted on differently — both meant "go
 *  look". `questions` is different in kind: it is not an alarm at all, and the founder's whole ask
 *  was that it be distinguishable from one. Omitting it here would have been the actual bug — a
 *  question asked in a project you are not currently looking at would have had NO surface anywhere
 *  in the app, which is precisely "an agent stalled where nobody can see it".
 *
 *  RED STILL WINS when a project has both. A tab is one glow and one number; work that has STOPPED
 *  outranks work that is about to be done right. The question is not lost — it is one click away on
 *  the tab's own chips.
 *
 *  `running` and `done` still deliberately do NOT badge: a tab that glows whenever any agent is
 *  working glows permanently, and a signal that is always on is not a signal. */
export function tabBand(counts: ProjectTabCounts | undefined): StatusBand | null {
  if (!counts) return null;
  if (counts.needs_you > 0) return "needs_you";
  if (counts.questions > 0) return "questions";
  return null;
}

// The GLOW/edge value for whichever band the tab is reporting, taken from the band itself so the
// tab, the dots it counts, and the sidebar's filter chips can't drift apart. This is a shape, not
// text — the badge's NUMERAL uses the themed ink instead; see `TabCountBadge`.
function tabGlowColor(band: StatusBand): string {
  return bandColor(band);
}

// The NUMERAL's ink, per band. Both raw brand colors fail AA as text on `barSurface` (the red
// measures 4.29:1 dark / 3.66:1 light; the azure is worse in light), so each maps to its themed
// twin. Pinned numerically in ProjectTabs.test.tsx rather than asserted by comment.
function tabBadgeInk(band: StatusBand): string {
  return band === "questions" ? C.questionsInk : C.dangerInk;
}

/**
 * Does this tab show a count badge, and of what?
 *
 * `null` on the ACTIVE tab NO MATTER WHAT ITS COUNT IS — that is the whole rule, and it is the one
 * most likely to regress silently, because every other input to the badge is unchanged. The status
 * filter chips sit directly beneath the strip and already carry the active project's counts with
 * more precision (per band, and togglable); a badge on the active tab is a THIRD rendering of the
 * same number, and the third one is the one that goes stale. An inactive tab has no such
 * chips — its count is not shown anywhere else — so that is exactly where the badge earns its space.
 *
 * Pure and exported so the rule is pinned once, independently of the strip's markup.
 */
export function tabBadgeCount(counts: ProjectTabCounts | undefined, active: boolean): number | null {
  if (active) return null;
  const band = tabBand(counts);
  if (!band) return null;
  const n = counts![band];
  return n > 0 ? n : null;
}

/**
 * ● N — the inactive tab's alarm badge: the band's own dot, then the bare number.
 *
 * NO "Needs you" IS RENDERED. The badge is read at a glance across a strip of tabs, where two words
 * per tab is what pushed the label into an ellipsis; the phrase survives in the accessible name
 * instead (below), so nothing is lost to a screen reader. That split — visual number, spoken
 * sentence — is `BandBadge`'s rule 2, which is why this reuses that component rather than growing a
 * fourth local dot-and-count.
 *
 * `silent` + a labelled wrapper, rather than letting BandBadge announce itself: the wrapper owns the
 * accessible name so a screen reader hears "2 Need you" once, and — deliberately — there is NO
 * `title`. A tooltip is visible chrome, and a hover that spells out "Needs you" over a tab whose
 * badge exists to not say it would put the words back on screen. The tab's own `title` already
 * describes the tab.
 *
 * INK IS `dangerInk`, NOT THE BAND'S RAW RED. The dot is a fill and takes `bandColor` (so it is
 * pixel-identical to the dots it counts), but the numeral is TEXT on `barSurface`, where the brand
 * red measures 4.29:1 in dark and 3.66:1 in light — under AA at both ends. `dangerInk` is the
 * themed twin that exists for exactly this and clears it in both themes. Pinned numerically in
 * ProjectTabs.test.tsx rather than asserted by comment.
 */
function TabCountBadge({
  projectId,
  count,
  band,
}: {
  projectId: string;
  count: number;
  band: StatusBand;
}) {
  return (
    <span
      data-testid={`count-${projectId}`}
      role="img"
      // The spoken name carries the band's own words, so a screen reader hears "2 Questions" rather
      // than the "2 Need you" every tab used to announce regardless of why it was lit.
      aria-label={bandCountLabel(band, count)}
      style={{ display: "inline-flex", alignItems: "center", flex: "none" }}
    >
      <BandBadge band={band} count={count} silent ink={tabBadgeInk(band)} />
    </span>
  );
}

/** The staleness badge's wording, exported so the test pins the SENTENCE rather than a substring —
 *  the number alone ("1696") is meaningless without what it is behind and what to do about it. */
export function staleTitle(projectName: string, s: ProjectTabStaleness): string {
  const n = s.behind.toLocaleString();
  return `${projectName} is ${n} commits behind ${s.base} — this checkout is STALE. Reading files from it returns old code; read from ${s.base} instead.`;
}

/**
 * ⚠ N — this project's own checkout has fallen behind the branch it tracks.
 *
 * WHY IT EXISTS (bead sparkle-cuv2h). The checkout at a canonical-looking path is the one most
 * likely to be read and the least likely to be pulled: the founder's sat 1,694 commits behind on a
 * six-day-old `main` while every agent worktree was current, and answers drawn from it were
 * reported as current code. Agent branches had carried an ahead/behind badge for a long time; the
 * project root — the tree a human actually opens — had nothing.
 *
 * IT SHOWS ON THE ACTIVE TAB TOO, unlike `TabCountBadge` next to it. That badge is an ALARM about
 * a tab you are not looking at, so it hides once you are. This is a PROPERTY of the checkout, and
 * the moment it matters most is while you are working in it — hiding it on focus would hide it
 * exactly when it is doing its job.
 *
 * AND IT KEEPS ITS EXPLANATION, also unlike that badge. There the `title` was dropped so a hover
 * would not put back the words the badge deliberately dropped. Here the words ARE the feature:
 * "1,696" alone tells you nothing, and the tab's own title cannot say what to do instead.
 *
 * ── THE EXPLANATION IS NOT A `title`, AND CANNOT BE (bead sparkle-7h01z) ───────────────────────
 *
 * It used to be one, and it never showed. `disableNativeTooltips()` (wired at `main.tsx`) installs a
 * CAPTURE-PHASE `mouseover` listener that walks the hovered element and every ancestor and STRIPS
 * `title` app-wide, before the webview's tooltip delay elapses. It moves the text to `aria-label`
 * first — but only when the element has no accessible name yet, and this badge has always carried
 * one. So the attribute was removed with no replacement, every hover, forever: a native `title` on
 * this control is not "unreliable", it is dead by construction, and re-adding one is the regression
 * this component's test exists to catch.
 *
 * So the hover explanation is a real element: local hover state and a PORTALED fixed-position card,
 * following `composer/SuggestionRow`, which worked this out first for the same reason. Portaled
 * because the tab strip clips its overflow — a card rendered in-flow would be cut off at the strip's
 * own edge, which for a badge sitting near the right end of the bar means most of the sentence.
 *
 * ── AND IT IS A BUTTON ────────────────────────────────────────────────────────────────────────
 *
 * It was a `role="img"` span inside the tab's own onClick, so the one gesture anybody would try on
 * it — clicking — selected the project and did nothing else. A real `<button>` is what makes the
 * panel reachable by mouse AND keyboard, and it fixes the drag interaction for free: the strip's
 * `onTabPointerDown` already bails on `e.target.closest("button")`, so a press that starts here can
 * no longer drag the tab out from under the badge.
 */
function TabStaleBadge({
  projectId,
  projectName,
  staleness,
  onOpen,
  registerEl,
}: {
  projectId: string;
  projectName: string;
  staleness: ProjectTabStaleness;
  /** Open the remedy panel for this project. */
  onOpen: () => void;
  /** Hand the button element up so the strip can restore focus to it when the panel closes. */
  registerEl: (el: HTMLButtonElement | null) => void;
}) {
  const label = staleTitle(projectName, staleness);
  const ref = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  // Measured in a LAYOUT effect for the same reason the panel is: placed after paint, the card
  // appears at the window's top-left for a frame before snapping under the badge.
  useLayoutEffect(() => {
    if (!hovered) {
      setAt(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Clamped so a badge near the right edge does not push the card off-window. jsdom reports zeros
    // for every rect, which lands the card at the left margin — fine, since what the test asserts is
    // the SENTENCE being on screen, not where.
    const w = typeof window === "undefined" ? 0 : window.innerWidth;
    setAt({
      left: Math.max(TOOLTIP_MARGIN, Math.min(r.left, w - TOOLTIP_MAX_W - TOOLTIP_MARGIN)),
      top: r.bottom + TOOLTIP_GAP,
    });
  }, [hovered]);

  return (
    <>
      <button
        type="button"
        ref={(el) => {
          ref.current = el;
          registerEl(el);
        }}
        data-testid={`stale-${projectId}`}
        data-behind={staleness.behind}
        // The accessible name stays the whole sentence, exactly as it was — the visible card is an
        // addition for sighted users, not a replacement for what a screen reader hears. NO `title`:
        // see the note above.
        aria-label={label}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        // Keyboard parity: the card is the only place the sentence is VISIBLE, so reaching the badge
        // by Tab has to show it too.
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={(e) => {
          // The badge sits inside the tab's own onClick. Without this, opening the panel would also
          // switch projects — which is the defect, not a bonus.
          e.stopPropagation();
          onOpen();
        }}
        // A <button> turns Enter/Space into a click, and BOTH events bubble to the tab's
        // onClick/onKeyDown — so without this, opening the panel from the keyboard would select the
        // tab as well. Same guard, same reason, as the close × below.
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") e.stopPropagation();
        }}
        // …and a double-click on the badge must not open project settings.
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          flex: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          font: "inherit",
          // `dangerInk`, not the brand red: this is TEXT on `barSurface`, where the raw red misses AA
          // in both themes. Same rule (and same reason) as TabCountBadge's ink.
          color: C.dangerInk,
          fontWeight: FONT_WEIGHT.semibold,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {/* An icon from react-icons, never an emoji — this repo renders every icon that way. */}
        <FiAlertTriangle size={11} />
        {staleness.behind.toLocaleString()}
      </button>
      {hovered &&
        at &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-testid={`stale-tip-${projectId}`}
            role="tooltip"
            style={{
              position: "fixed",
              left: at.left,
              top: at.top,
              maxWidth: TOOLTIP_MAX_W,
              zIndex: STALE_TOOLTIP_Z,
              pointerEvents: "none",
              background: C.deepForest,
              color: C.cream,
              border: `1px solid ${C.hairline}`,
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              padding: "6px 8px",
              // `TYPE.small` (12), not a hand-picked 11: this is a hint, which is exactly the
              // register that token names. The scale is a hard-zero ratchet — an off-scale literal
              // here reds `scale.test.ts`, and rightly so.
              fontSize: TYPE.small,
              lineHeight: 1.4,
              animation: "sparkle-tooltip-in .12s ease-out",
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

/** Hover-card geometry. `MAX_W` is also the clamp's width term, so the two cannot disagree. */
const TOOLTIP_MAX_W = 320;
const TOOLTIP_MARGIN = 8;
const TOOLTIP_GAP = 6;
/** Above the remedy panel it explains (`STALE_PANEL_Z`), below the app-modal band at 61 — a tooltip
 *  that lost to the panel would be invisible exactly when the badge is hovered with it open. */
const STALE_TOOLTIP_Z = 54;

/** How wide a tab's project name may get before it ellipsizes. Sized so a typical repo folder name
 *  fits whole and only genuinely long ones truncate — the point is a bar of UNIFORM-height tabs, not
 *  aggressive shortening. */
export const TAB_LABEL_MAX_WIDTH = 160;

/**
 * ── THE FLOOR: HOW NARROW A NAME MAY GET (bead sparkle-z24dl) ─────────────────────────────────
 *
 * There was no floor at all, and the result was a strip nobody could read. The pin, the ⚠ badge,
 * the ● badge and the × are every one of them `flex: none`, so the LABEL is the only shrinkable
 * thing in a tab — under crowding the flex line takes every pixel it needs from the name and from
 * nothing else. The founder's bar showed one tab as "fo...", one as "t..", and the SELECTED tab
 * with no name whatsoever: just ⚠155 and a close ×. The badges survived the squeeze; the identity
 * did not, which is precisely backwards.
 *
 * ~6 characters for an inactive tab, ~14 for the ACTIVE one. The active tab is floored higher for
 * two reasons: it is the tab whose name you most need (you are working in it), and it is the tab
 * that loses its name FIRST, because it carries the widest chrome — an always-visible × plus, in
 * the reported case, a four-glyph ⚠ badge.
 *
 * Past the floor the tabs stop shrinking and the strip SCROLLS instead. That is the deliberate
 * trade: a name you can read on every tab, at the cost of a strip that may not show every tab at
 * once. The selected tab is scrolled into view whenever it changes, so the one you are in is never
 * the one off-screen.
 */
export const TAB_LABEL_MIN_WIDTH = 46;
/** @see TAB_LABEL_MIN_WIDTH — the active tab's higher floor. */
export const TAB_LABEL_MIN_WIDTH_ACTIVE = 104;

/**
 * The floor to actually apply to one label, given the width its text NATURALLY wants.
 *
 * CAPPED BY THE NAME'S OWN WIDTH, and that is the whole subtlety. `min-width` is a floor at every
 * size, not merely under pressure — so a flat 104px on the active tab would pad a project called
 * "atlas" out with ~50px of dead space whenever the bar is roomy, which is a second, quieter way of
 * making the strip hard to read. Capping the floor at the natural width means a short name is never
 * padded and a long one still refuses to vanish.
 *
 * `natural === 0` is "not measured yet" — the first paint, and every rect in jsdom. It yields NO
 * floor, so the component fails open to its pre-floor behaviour rather than pinning every label to
 * the floor width sight-unseen.
 */
export function labelMinWidth(natural: number, active: boolean): number {
  if (natural <= 0) return 0;
  return Math.min(active ? TAB_LABEL_MIN_WIDTH_ACTIVE : TAB_LABEL_MIN_WIDTH, natural);
}

/**
 * The floor as the TAB's own `min-width` — chrome that cannot shrink, plus a readable name.
 *
 * ── WHY THIS IS ON THE TAB AND NOT ON THE LABEL, WHICH IS WHERE IT OBVIOUSLY BELONGS ──────────
 *
 * It WAS on the label — `min-width: 46px` on the name — and that is wrong in a way no unit test
 * in this repo could have caught, because it needs a layout engine to see. `min-width` sets a
 * FLOOR on a box; it does not cap that box's MIN-CONTENT CONTRIBUTION, which for `white-space:
 * nowrap` text is the width of the whole string. So the label kept contributing its full 72px to
 * the tab's automatic minimum size, the tab's minimum became "chrome + the entire name", and the
 * flex line could not shrink ANY tab at all. Measured in Chrome at a 470px strip: six tabs, total
 * 1091px, not one pixel of shrink — every name whole and four tabs parked off the end behind a
 * scroll. That is a different bug from the founder's, and just as bad.
 *
 * (`overflow: hidden` zeroing a flex item's automatic minimum size is a real rule, and it is the
 * one that makes this look like it should work. It applies to `min-width: auto` only — an explicit
 * `min-width` replaces it, and neither has anything to do with min-content contribution.)
 *
 * An explicit `min-width` on the TAB does override the automatic minimum size, which is exactly the
 * lever wanted: shrink this tab until its name is down to `labelMinWidth`, then stop. `chrome` is
 * everything in the tab that is not the name — the pin, the badges, the ×, the padding and the gaps
 * — and it is measurable as `tab.offsetWidth - label.offsetWidth` at ANY moment, because every one
 * of those parts is `flex: none` and so keeps its width no matter how squeezed the tab is.
 *
 * Fails OPEN at zero: an unmeasured tab (first paint, and every element in jsdom) gets no minimum
 * rather than an invented one.
 */
export function tabMinWidth(chrome: number, natural: number, active: boolean): number {
  if (natural <= 0 || chrome <= 0) return 0;
  return chrome + labelMinWidth(natural, active);
}

/**
 * How long the pointer must rest on a tab before it expands.
 *
 * Long enough that sweeping the cursor across the strip on the way somewhere else does not pop
 * every tab in turn; short enough to feel instant when you actually stop on one. Keyboard FOCUS
 * bypasses it — focus is already a deliberate act, so there is no sweep to debounce.
 */
export const TAB_EXPAND_DELAY_MS = 120;

/**
 * The expanded tab's stacking order WITHIN THE STRIP — not a member of the `layers.ts` ladder.
 *
 * That ladder describes surfaces which compete at the ROOT stacking context; this one competes
 * only with its own siblings. Every tab is `position: relative` with `z-index: auto`, so tabs paint
 * in DOM order and a tab expanding leftward would otherwise slide UNDER its left-hand neighbour.
 * Any positive value wins that contest; 2 keeps it obvious that the scope is local.
 */
const TAB_EXPANDED_Z = 2;

/** The tab body's own padding and inter-item gap. Constants rather than literals because the chrome
 *  measurement below has to add back exactly what the layout used — see `measureChrome`. */
export const TAB_BODY_PAD_X = 12;
export const TAB_BODY_GAP = 8;

/**
 * How much of a tab is NOT its name: the padding, the gaps, the pin, the badges and the ×.
 *
 * SUMMED FROM THE UNSHRINKABLE PARTS, not taken as `tab.offsetWidth - label.offsetWidth`. That
 * subtraction is the obvious way and it is wrong in exactly the case the floor exists for. Before a
 * floor is applied a tab can be squeezed NARROWER THAN ITS OWN CHROME — the label goes to zero and
 * the pin and badges then overflow the tab's box — so the subtraction returns the squeezed box,
 * which is smaller than the real chrome. The floor computed from it is correspondingly too small,
 * and the name still disappears. Measured in Chrome at a 520px strip: labels at 0px, 16px and 43px
 * against a 46px floor that was being honoured exactly as written.
 *
 * Every term here is `flex: none`, so each one reports the same width however hard the tab is
 * squeezed, and the total is correct on the very first measuring pass — which is the one that
 * matters, since it is taken before any floor exists.
 */
export function measureChrome(body: Element | undefined, label: Element | undefined): number {
  if (!body || !label) return 0;
  const kids = Array.from(body.children);
  let sum = TAB_BODY_PAD_X * 2 + TAB_BODY_GAP * Math.max(0, kids.length - 1);
  for (const k of kids) {
    if (k === label) continue;
    sum += (k as HTMLElement).offsetWidth ?? 0;
  }
  return sum;
}

// Pin hover-reveal + rotate is driven entirely by CSS (scoped to .concierge-tab so it can't leak to
// other tab widgets) — NOT by inline opacity, which would override the non-!important :hover rule and
// defeat the reveal. Injected ONCE into <head> rather than rendered per instance.
const STYLE_ID = "concierge-tabs-styles";
const TAB_STYLES = `
.concierge-tab-pin { opacity: 0; transition: opacity .13s, transform .13s; }
/* Reveal on hover/focus — but NOT for a pinned pin, which must stay fully visible (the :not()
   also keeps this rule from out-specificity-ing the pinned rule and dimming a pinned pin). */
.concierge-tab:hover .concierge-tab-pin:not([data-pinned="true"]),
.concierge-tab:focus-within .concierge-tab-pin:not([data-pinned="true"]) { opacity: .65; }
.concierge-tab-pin[data-pinned="true"] { opacity: 1; transform: rotate(45deg); }
/* The close ×, same hover-reveal as the pin so an idle bar stays quiet — except on the ACTIVE tab,
   where it is always visible (the tab you're on is the one you're most likely to want to put away,
   and a permanently-hidden control is an undiscoverable one). :focus-within covers the keyboard
   path: tabbing to the button reveals it, so focus is never on something invisible. */
.concierge-tab-close { opacity: 0; transition: opacity .13s; }
.concierge-tab:hover .concierge-tab-close,
.concierge-tab:focus-within .concierge-tab-close { opacity: .65; }
.concierge-tab-close[data-active="true"] { opacity: .8; }
.concierge-tab-close:hover, .concierge-tab-close:focus-visible { opacity: 1 !important; }
/* The strip scrolls once the label floor stops the tabs shrinking (see TAB_LABEL_MIN_WIDTH), but
   NOT with a visible scrollbar: the strip is ~34px tall and a persistent bar (which is what a Mac
   set to "always show scroll bars" renders) would sit across the bottom edge of every tab. The
   trackpad swipe and shift-wheel still work, and the selected tab is scrolled into view on every
   selection change, so the tab you are in is never the one hidden off the end.
   scrollbar-width:none covers Firefox and is set inline; this covers WebKit, which is what
   actually ships here, and has no inline form. */
.concierge-tab-strip::-webkit-scrollbar { display: none; }
`;
function ensureTabStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = TAB_STYLES;
  document.head.appendChild(el);
}

/**
 * THE BAR IS NOW TWO BOXES, and the split is load-bearing rather than cosmetic.
 *
 * The outer box owns the surface, the rule under it, and the chrome that must never scroll away —
 * the "+" and the top-right cluster. The inner box is the `role="tablist"` and is the SCROLL
 * CONTAINER, because the label floor makes the tabs unshrinkable past a point and a crowded strip
 * then has to overflow somewhere; overflowing into a scroll keeps every tab reachable, where
 * overflowing the window does not. Keeping "+" outside that scroller is the reason for the split:
 * inside it, the one control that opens a project scrolls off the end exactly when the bar is full.
 *
 * `role="tablist"` stays on the box that directly contains the `role="tab"` children — that
 * parent/child relationship is required by ARIA, and moving the role outward to the wrapper would
 * quietly break it. `index.css` mirrors both boxes for the left-hand pair (`.concierge-tabbar`).
 */
const barStyle: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "flex-end",
  padding: "0 8px",
  background: C.barSurface,
  borderBottom: `1px solid ${C.muted}`,
};

const stripStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: 3,
  paddingTop: 8,
  // Takes the free space so the top-right cluster still sits flush right without an auto margin.
  flex: "1 1 auto",
  minWidth: 0,
  overflowX: "auto",
  // Without this the box would take `auto` on BOTH axes and a tab's alarm glow could raise a
  // vertical scrollbar in a 34px-tall strip.
  overflowY: "hidden",
  // Firefox's half of the hidden scrollbar; WebKit's is in TAB_STYLES.
  scrollbarWidth: "none",
};

function activateOnKey(e: KeyboardEvent, fn: () => void): void {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

/** The insertion caret shown between tabs during a reorder — a thin accent bar in the gap. */
function DropCaret() {
  return (
    <div
      data-testid="tab-drop-caret"
      aria-hidden
      style={{
        flex: "none",
        alignSelf: "stretch",
        width: 2,
        marginBottom: 2,
        borderRadius: 3,
        background: C.teal,
      }}
    />
  );
}

export function ProjectTabs({
  projects,
  selectedProjectId,
  pinnedProjectId,
  countsByProject,
  onSelect,
  onTogglePin,
  onOpenSettings,
  onClose,
  onAddProject,
  reversed = false,
  topRight,
  onReorder,
  onTearOff,
  tornOutProjectIds,
  stalenessByProject,
}: ProjectTabsProps) {
  useEffect(ensureTabStyles, []);

  const barRef = useRef<HTMLDivElement | null>(null);
  const tabEls = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<TabGesture | null>(null);
  // A real drag must not also fire the tab's onClick. `click` is dispatched after `pointerup`, so
  // the flag is SET on release and consumed by the click that follows — not cleared on pointerup,
  // which would race the very event it exists to suppress.
  const suppressClick = useRef(false);
  // Only what the render needs: which tab is being dragged, and where it would land.
  const [drag, setDrag] = useState<{
    projectId: string;
    kind: "reorder" | "tearoff";
    beforeId: string | null;
  } | null>(null);
  // Which project's stale-checkout panel is open, and the badge elements to hand focus back to when
  // it closes. Kept at the STRIP level rather than inside the badge because the panel lists every
  // stale project, not just the one clicked — see `staleTargetsFor`.
  const [stalePanelFor, setStalePanelFor] = useState<string | null>(null);
  const staleBadgeEls = useRef(new Map<string, HTMLButtonElement>());

  // ── HOVER EXPANSION (bead sparkle-z24dl) ────────────────────────────────────────────────────
  //
  // Which tab is expanded, the in-flow width it had at the moment it expanded, and which edge it
  // grows from. Freezing the width is what makes the expansion cost the strip NOTHING: the tab
  // keeps the exact footprint the flex line already gave it and its chrome goes out of flow, so no
  // sibling can move. A strip that reshuffles under the cursor is worse than truncation.
  const [expanded, setExpanded] = useState<{
    id: string;
    width: number;
    anchor: "left" | "right";
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labelEls = useRef(new Map<string, HTMLSpanElement>());
  const bodyEls = useRef(new Map<string, HTMLDivElement>());
  /** Per tab: what its name naturally wants, and how much of the tab is unshrinkable chrome. */
  const [metrics, setMetrics] = useState<Record<string, { natural: number; chrome: number }>>({});

  function clearHoverTimer(): void {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }
  useEffect(() => clearHoverTimer, []);

  /**
   * WHICH TAB THE POINTER IS ON RIGHT NOW — the thing the delay below settles on.
   *
   * A ref rather than state: it changes on every enter and leave, and re-rendering the strip on
   * each of those would be both wasteful and, during the churn described next, wrong.
   */
  const wantId = useRef<string | null>(null);

  /**
   * Settle on whatever the pointer is on when the delay elapses.
   *
   * ── WHY A SETTLE AND NOT A PLAIN OPEN/CLOSE PAIR (found by the real-browser probe) ───────────
   *
   * The obvious shape — expand on `mouseenter` after a delay, collapse on `mouseleave` — is what
   * this was, and it fails over one specific part of the tab: the ⚠ stale badge. Hovering the badge
   * mounts its portaled explanation card, and the resulting churn dispatches a `mouseleave` on the
   * tab immediately after the `mouseenter`, over and over, without the pointer moving at all.
   * Measured: five enter/leave pairs in a second, cancelling the open timer every time, so the tab
   * NEVER expanded while the pointer rested on its badge. Nothing in jsdom can see this — it needs
   * hit testing and a real pointer.
   *
   * Settling makes the flicker irrelevant instead of trying to suppress it. One timer runs from the
   * first transition; when it fires it reads where the pointer actually IS and applies that. An
   * enter/leave storm that ends on the tab expands it; a genuine sweep across the strip ends
   * somewhere else and collapses it. It also gives moving between two tabs the right answer for
   * free, since `mouseleave` on the old tab and `mouseenter` on the new one collapse into one
   * decision rather than racing.
   */
  function scheduleSettle(delay: number): void {
    // One settle in flight is enough: re-arming it on every transition is what let the churn
    // postpone the decision indefinitely.
    if (hoverTimer.current !== null) return;
    hoverTimer.current = setTimeout(() => settleNow(), delay);
  }

  function settleNow(): void {
    hoverTimer.current = null;
    const id = wantId.current;
    if (!id) {
      setExpanded(null);
      return;
    }
    {
      const el = tabEls.current.get(id);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const b = barRef.current?.getBoundingClientRect();
      // GROW INWARD. A tab in the right half expands leftward and one in the left half expands
      // rightward, so the expansion stays inside the strip instead of being clipped by its own
      // scroll container. Decided from client rects, which means it is correct on the mirrored
      // left-hand strip too — that one is `row-reverse`, so DOM order and visual order disagree
      // and any decision made from the array index would come out backwards there.
      const anchor = b && r.left + r.width / 2 > b.left + b.width / 2 ? "right" : "left";
      setExpanded({ id, width: r.width, anchor });
    }
  }

  /** The pointer is on `id`. `immediate` is the keyboard-focus path: focus is already a deliberate
   *  act, so there is no sweep to debounce and nothing to settle. */
  function beginExpand(id: string, immediate: boolean): void {
    wantId.current = id;
    if (immediate) {
      clearHoverTimer();
      settleNow();
    } else {
      scheduleSettle(TAB_EXPAND_DELAY_MS);
    }
  }

  /** The pointer left `id`. Guarded on identity so a leave arriving AFTER the pointer has already
   *  reached the next tab cannot cancel that one. */
  function endExpand(id: string): void {
    if (wantId.current === id) wantId.current = null;
    scheduleSettle(TAB_EXPAND_DELAY_MS);
  }

  /** Collapse right now, whatever the pointer is doing — the drag path. */
  function cancelExpand(): void {
    clearHoverTimer();
    wantId.current = null;
    setExpanded(null);
  }

  /**
   * Measure each tab's two floor inputs (see `tabMinWidth`).
   *
   *   natural  `scrollWidth` on a `nowrap` span: the full text width, still reported correctly
   *            while the box is clipping it, which is what makes it the right instrument.
   *   chrome   `tab.offsetWidth - label.offsetWidth`: everything in the tab that is not the name.
   *            Valid at any moment, squeezed or not, because every other part of a tab is
   *            `flex: none` and keeps its width however hard the tab is squeezed.
   *
   * RE-RUN ON THE BADGES, not only on a rename. `chrome` changes whenever a stale or count badge
   * appears, disappears or gains a digit ("155" is wider than "5"), and a stale `chrome` is a floor
   * that is quietly wrong for as long as the name happens to stay the same. Not run every render,
   * though: these are forced layout reads and the strip re-renders at pointer rate during a drag.
   *
   * `expanded` is deliberately NOT in the key. An expanded tab's body is out of flow, so a
   * `offsetWidth - offsetWidth` taken across that boundary is not a chrome measurement at all.
   */
  const metricsKey = projects
    .map((p) => {
      const c = countsByProject[p.id];
      const b = tabBand(c);
      return [
        p.id,
        p.name,
        p.id === selectedProjectId ? "a" : "-",
        b ? `${b}${c?.[b] ?? 0}` : "-",
        stalenessByProject?.[p.id]?.behind ?? "-",
        tornOutProjectIds?.has(p.id) ? "t" : "-",
        onClose ? "x" : "-",
      ].join(":");
    })
    .join("|");
  useLayoutEffect(() => {
    const next: Record<string, { natural: number; chrome: number }> = {};
    let changed = Object.keys(metrics).length !== projects.length;
    for (const p of projects) {
      const labelEl = labelEls.current.get(p.id);
      const natural = labelEl?.scrollWidth ?? 0;
      const chrome = measureChrome(bodyEls.current.get(p.id), labelEl);
      next[p.id] = { natural, chrome };
      const was = metrics[p.id];
      if (was?.natural !== natural || was?.chrome !== chrome) changed = true;
    }
    if (changed) setMetrics(next);
    // `metrics` is deliberately NOT a dependency: it is what this effect writes, and reading it
    // here is only the did-anything-change guard that stops the write from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricsKey]);

  /** Keep the selected tab on screen. Once the floor stops tabs shrinking, a crowded strip scrolls —
   *  and the one tab that must never be the one scrolled out of sight is the one you are in. */
  useEffect(() => {
    if (!selectedProjectId) return;
    tabEls.current.get(selectedProjectId)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedProjectId]);

  /**
   * Every stale checkout the panel should account for, THE CLICKED ONE FIRST.
   *
   * A project with no `rootPath` is dropped rather than listed: the panel's whole job is to diagnose
   * and remedy a directory, and a row naming a project it cannot look at is a row that can only say
   * "unknown" forever. It has no badge either (see the render site), so it cannot be the clicked one.
   */
  function staleTargetsFor(primaryId: string): StaleTarget[] {
    const out: StaleTarget[] = [];
    const add = (p: ProjectTabItem) => {
      const s = stalenessByProject?.[p.id];
      if (!s || !p.rootPath) return;
      out.push({ id: p.id, name: p.name, rootPath: p.rootPath, behind: s.behind, base: s.base });
    };
    const primary = projects.find((p) => p.id === primaryId);
    if (primary) add(primary);
    for (const p of projects) if (p.id !== primaryId) add(p);
    return out;
  }

  /** Close the panel and put focus back on the badge that opened it — the keyboard user's way out
   *  lands nowhere otherwise, since the panel is portaled away from the strip. Falls back to the
   *  TAB when the badge is gone, which is exactly the successful-remedy case below. */
  function closeStalePanel(): void {
    const el = stalePanelFor ? staleBadgeEls.current.get(stalePanelFor) : null;
    const tab = stalePanelFor ? tabEls.current.get(stalePanelFor) : null;
    setStalePanelFor(null);
    if (el?.isConnected) el.focus();
    else tab?.focus();
  }

  /**
   * THE PANEL'S ROW LIST IS FROZEN AT OPEN — and that is what keeps it honest.
   *
   * Two bad behaviours are avoided by the same decision, and the second one is why this is a
   * snapshot rather than an auto-close:
   *
   * 1. Deriving rows live meant a successful fast-forward — which drops the project from
   *    `stalenessByProject` and unmounts its badge — left the panel rendering `targets: []`: a
   *    header and a disabled button pinned to a badge that no longer exists (roborev 59437).
   *
   * 2. CLOSING on that absence was worse, and was the first attempt. `stalenessByProject` omits
   *    three different things: `unknown`, not-stale, AND a read that FAILED — `useProjectStaleness`
   *    swallows a failed `repo_root_staleness` deliberately, because it runs on a timer. So a
   *    transient `index.lock` on the 60s poll — exactly the contention `dirty_at` now fails closed
   *    against — was indistinguishable from "the remedy landed", and it tore down the panel. The
   *    user presses Fast-forward on a dirty tree, git refuses, the row shows git's own words, and
   *    one tick later the whole panel vanishes with the refusal unread. A feature built on
   *    fail-closed reads must not treat a MISSING MEASUREMENT as a SUCCESS (roborev 59454).
   *
   * Frozen, the rows persist with their outcomes and skip reasons until the user dismisses the
   * panel, and each row re-diagnoses itself after its own remedy — so what it shows is the result
   * of an action that actually happened, never the absence of a reading.
   */
  const [staleTargets, setStaleTargets] = useState<StaleTarget[]>([]);

  function openStalePanel(projectId: string): void {
    setStaleTargets(staleTargetsFor(projectId));
    setStalePanelFor(projectId);
  }

  /** Measure the strip and every rendered tab in CLIENT space — the space `clientX/clientY` reports,
   *  so the resolver's inputs are all consistent (its header only requires ONE space, not a
   *  particular one). Screen space is used solely for the tear-off's window position. */
  function measure(): { strip: TabRect & { y: number; height: number }; tabs: TabRect[] } | null {
    const bar = barRef.current;
    if (!bar) return null;
    const b = bar.getBoundingClientRect();
    const tabs: TabRect[] = [];
    // Iterate `projects`, not the ref Map: the resolver's insertion rule walks tabs in RENDER order,
    // and a Map's iteration order is insertion order, which after a reorder is no longer the same.
    for (const p of projects) {
      const el = tabEls.current.get(p.id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      tabs.push({ id: p.id, x: r.x, width: r.width });
    }
    return { strip: { id: "strip", x: b.x, y: b.y, width: b.width, height: b.height }, tabs };
  }

  function onTabPointerDown(projectId: string, e: ReactPointerEvent<HTMLDivElement>): void {
    // Left button only, and never from the pin or the × — those are their own controls, and a press
    // that starts on one must not drag the tab out from under it.
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("button")) return;
    if (!onReorder && !onTearOff) return;
    suppressClick.current = false;
    gesture.current = {
      projectId,
      pointerId: e.pointerId,
      origin: { x: e.clientX, y: e.clientY },
      dragging: false,
      last: { kind: "idle" },
      lastScreen: { x: e.screenX, y: e.screenY },
    };
    // Capture so the drag keeps reporting once the pointer leaves the tab — which it does
    // immediately, since leaving is the whole gesture.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom and some synthetic pointers have no capture; the gesture still works from the
      // document-level bubbling, it just stops tracking outside the window.
    }
  }

  function onTabPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    const m = measure();
    if (!m) return;
    const res = resolveTabDrag(
      {
        pointer: { x: e.clientX, y: e.clientY },
        origin: g.origin,
        strip: { x: m.strip.x, y: m.strip.y, width: m.strip.width, height: m.strip.height },
        tabs: m.tabs,
        draggedId: g.projectId,
        dragging: g.dragging,
        reversed,
      },
      { slop: DRAG_SLOP, tearMargin: TEAR_MARGIN },
    );
    g.last = res;
    g.lastScreen = { x: e.screenX, y: e.screenY };
    if (res.kind === "idle") return;
    g.dragging = true;
    // A tab being dragged is its own size. Leaving it expanded would have the user dragging a
    // widened tab whose in-flow slot — the thing the drop resolver measures — is somewhere else.
    cancelExpand();
    setDrag({
      projectId: g.projectId,
      kind: res.kind,
      beforeId: res.kind === "reorder" ? res.beforeId : null,
    });
  }

  function endGesture(e: ReactPointerEvent<HTMLDivElement>, commit: boolean): void {
    const g = gesture.current;
    gesture.current = null;
    setDrag(null);
    try {
      if (g && e.currentTarget.hasPointerCapture(g.pointerId)) {
        e.currentTarget.releasePointerCapture(g.pointerId);
      }
    } catch {
      // Already released (or never captured) — nothing to undo.
    }
    if (!g || !g.dragging) return;
    if (!commit) return;
    // Set ONLY on the commit path. A cancelled pointer (or a lost capture) produces no `click` for
    // the flag to consume, and it is strip-wide and cleared only by the next pointerdown/click — so
    // latching it here would silently swallow the next keyboard-hint activation, which fires a tab's
    // onClick with no pointerdown before it (keyboardHints/hintTargets).
    suppressClick.current = true;
    if (g.last.kind === "tearoff") {
      onTearOff?.(g.projectId, g.lastScreen);
    } else if (g.last.kind === "reorder" && g.last.beforeId !== g.projectId) {
      // beforeId === draggedId means "held over its own slot" — the resolver reports it rather than
      // filtering it (see insertionBefore), and swallowing it here keeps a no-op out of the store.
      onReorder?.(g.projectId, g.last.beforeId);
    }
  }

  return (
    <div className="concierge-tabbar" style={barStyle}>
      <div
        className="concierge-tab-strip"
        style={stripStyle}
        role="tablist"
        aria-label="Projects"
        ref={barRef}
      >
      {projects.map((p) => {
        const active = p.id === selectedProjectId;
        const pinned = p.id === pinnedProjectId;
        const counts = countsByProject[p.id];
        const band = tabBand(counts);
        // The GLOW still lights on the active tab; only the numeric badge is suppressed there. They
        // say different things: the glow is "something in here wants you", which is true of the tab
        // you are on too, while the number is the count the chips below already render.
        // The glow takes the REPORTING band's colour, so a project lit for a question glows blue
        // and one lit for a stopped agent glows red — the distinction survives all the way out to
        // the tab strip, which is the only place a background project is visible at all.
        const glowInk = band ? tabGlowColor(band) : undefined;
        const glow = glowInk ? `0 0 0 1px ${glowInk}73, 0 -2px 14px ${glowInk}29` : undefined;
        const badgeCount = tabBadgeCount(counts, active);
        // Bound once here rather than indexed twice at the render site: under
        // `noUncheckedIndexedAccess` the second lookup is independently `| undefined`.
        const staleness = stalenessByProject?.[p.id];
        const tornOut = tornOutProjectIds?.has(p.id) ?? false;
        const isDragged = drag?.projectId === p.id;
        const caret = drag?.kind === "reorder" && drag.beforeId === p.id;
        const exp = expanded?.id === p.id ? expanded : null;
        // Unmeasured until the layout effect below has run once — which means NO floor, not a
        // guessed one. See `tabMinWidth`.
        const m = metrics[p.id] ?? { natural: 0, chrome: 0 };
        const label = tabTitle(p.name, {
          hasSettings: !!onOpenSettings,
          tornOut,
          canTearOff: !!onTearOff,
        });
        return (
          <Fragment key={p.id}>
          {caret && <DropCaret />}
          <div
            ref={(el) => {
              // A plain Map of live elements. Deleting on unmount matters: a closed project whose
              // node lingered here would contribute a stale rect to `measure` and shift every
              // insertion decision after it.
              if (el) tabEls.current.set(p.id, el);
              else tabEls.current.delete(p.id);
            }}
            className="concierge-tab"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            data-testid={`tab-${p.id}`}
            data-torn-out={tornOut || undefined}
            onPointerDown={(e) => onTabPointerDown(p.id, e)}
            onPointerMove={onTabPointerMove}
            onPointerUp={(e) => endGesture(e, true)}
            // A cancelled pointer (the OS took it, a touch was interrupted) must NOT commit — it
            // would tear a window off at whatever coordinate the gesture died at.
            onPointerCancel={(e) => endGesture(e, false)}
            // …and neither must a capture that simply goes away (the element unmounts mid-drag, or
            // the platform revokes it). Without this the gesture ref and the insertion caret stay
            // set until the next press, leaving a caret painted in the strip over nothing.
            onLostPointerCapture={(e) => endGesture(e, false)}
            // Keyboard-hint target: a clean Ctrl tap badges each tab with a letter, and the overlay
            // activates it by firing this element's own onClick — so hint selection and mouse
            // selection are the same code path (see keyboardHints/hintTargets.ts).
            data-hint={PROJECT_TAB_HINT}
            data-expanded={exp ? true : undefined}
            title={label}
            // THE NAME IS AN `aria-label`, NOT JUST A `title` — and the title alone was never
            // enough. `disableNativeTooltips()` (wired at main.tsx) strips `title` app-wide on a
            // capture-phase `mouseover`, rehoming it to `aria-label` ONLY for an element with no
            // accessible name yet; a tab has visible text, so the attribute was removed with no
            // replacement on every hover. That left the full project name reachable NOWHERE once
            // the label was squeezed — not by tooltip, not by screen reader. Naming the tab
            // explicitly is what gives keyboard and screen-reader users the same information the
            // hover expansion gives the mouse, and it does not depend on the (clipped) text.
            aria-label={label}
            onMouseEnter={() => beginExpand(p.id, false)}
            onMouseLeave={() => endExpand(p.id)}
            // Focus expands with NO delay: reaching a tab by keyboard is already deliberate.
            onFocus={() => beginExpand(p.id, true)}
            onBlur={() => endExpand(p.id)}
            onClick={() => {
              // Consume the click a completed drag generated. Cleared here rather than on pointerup
              // so the very next real click still selects.
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onSelect(p.id);
            }}
            onDoubleClick={() => onOpenSettings?.(p.id)}
            onKeyDown={(e) => activateOnKey(e, () => onSelect(p.id))}
            // THE SLOT — this element is the tab's FOOTPRINT IN THE FLEX LINE and nothing else. It
            // carries no padding, no background and no border; all of that is on the body below,
            // which is the thing that expands. Splitting them is what makes an expansion free: the
            // slot's width is frozen at whatever the line already gave it and the body leaves the
            // flow, so no sibling tab can move.
            style={{
              display: "flex",
              position: "relative",
              top: 1,
              // The tab being dragged fades so the caret (or the empty gap, when the drag has left
              // the strip) is what the eye follows.
              opacity: isDragged ? (drag?.kind === "tearoff" ? 0.35 : 0.55) : tornOut ? 0.6 : 1,
              // Suppress the browser's own text selection + native drag while a tab is being pulled;
              // without it the project name highlights blue under the cursor mid-drag.
              userSelect: "none",
              WebkitUserSelect: "none",
              cursor: "pointer",
              fontSize: 12,
              // THE FREEZE. `0 0 <w>px` — no grow, no shrink, an explicit basis — pins the slot to
              // the width it measured at the instant it expanded, so the flex line's arithmetic is
              // identical before and after. Without it an out-of-flow body would leave the slot
              // with nothing to size itself from and every other tab would slide over to fill it.
              // THE FLOOR. An explicit `min-width` replaces the automatic minimum size, so the tab
              // shrinks under crowding exactly as it always did and then STOPS with a readable name
              // still showing. It has to live here rather than on the label — see `tabMinWidth`,
              // which is also where the measured 0 fallback (no floor at all) is explained.
              minWidth: tabMinWidth(m.chrome, m.natural, active),
              ...(exp ? { flex: `0 0 ${exp.width}px`, zIndex: TAB_EXPANDED_Z } : {}),
            }}
          >
            <div
              data-testid={`tab-body-${p.id}`}
              ref={(el) => {
                // Same delete-on-unmount discipline as `tabEls`; the chrome measurement walks this
                // element's children, so a dead node here would be measured as a live tab.
                if (el) bodyEls.current.set(p.id, el);
                else bodyEls.current.delete(p.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: TAB_BODY_GAP,
                padding: `8px ${TAB_BODY_PAD_X}px`,
                borderRadius: "6px 6px 0 0",
                color: active ? C.cream : C.muted,
                // OPAQUE WHILE EXPANDED. An inactive tab is normally transparent over the bar, which
                // is fine until it is floating over a NEIGHBOUR — then the covered tab's own label
                // and badges read straight through it. `barSurface` is the bar's own colour, so the
                // expansion reads as the tab having grown rather than as a card dropped on top.
                background: active ? C.forest : exp ? C.barSurface : "transparent",
                // Longhand per edge: mixing the `border` shorthand with a `borderBottom` override
                // makes React warn (and can style-bug) when only one of them changes on re-render.
                borderTop: `1px solid ${active || exp ? C.muted : "transparent"}`,
                borderLeft: `1px solid ${active || exp ? C.muted : "transparent"}`,
                borderRight: `1px solid ${active || exp ? C.muted : "transparent"}`,
                borderBottom: "none",
                boxShadow: glow,
                ...(exp
                  ? {
                      // OUT OF FLOW — the half of the freeze that reveals the name. Sized by its
                      // CONTENT (`max-content`) so the label is whole, but never narrower than the
                      // slot it covers.
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      // Grows INWARD, away from the strip's nearer edge — see `beginExpand`.
                      ...(exp.anchor === "right" ? { right: 0 } : { left: 0 }),
                      width: "max-content",
                      minWidth: "100%",
                    }
                  : // `minWidth: 0` so the body follows the slot down: the slot's own `min-width`
                    // is what stops the shrinking, and a body that refused to shrink with it would
                    // simply paint outside the tab and over its neighbour.
                    { flex: "1 1 auto", minWidth: 0 }),
              }}
            >
            <button
              type="button"
              className="concierge-tab-pin"
              data-pinned={pinned}
              title={pinTitle(pinned)}
              aria-label={pinTitle(pinned)}
              data-testid={`pin-${p.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin(p.id);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                lineHeight: 0,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: pinned ? C.accentInk : C.muted,
              }}
            >
              <MdOutlinePushPin size={14} />
            </button>
            <span
              data-testid={`tab-label-${p.id}`}
              ref={(el) => {
                // Same discipline as `tabEls`: delete on unmount, so a closed project cannot leave
                // a dead node behind for the natural-width measurement to read.
                if (el) labelEls.current.set(p.id, el);
                else labelEls.current.delete(p.id);
              }}
              style={{
                // A long folder name must TRUNCATE, never wrap. Wrapping made that one tab two rows
                // tall while its neighbours stayed one row, so the whole bar grew and the tabs no
                // longer lined up — the ragged look the ellipsis exists to prevent. The tab's
                // accessible name carries the full string, and hovering reveals it.
                maxWidth: exp ? "none" : TAB_LABEL_MAX_WIDTH,
                // FREE TO SHRINK TO NOTHING, and that is correct even though the whole point is
                // that it never has to: the thing that stops the squeeze is the SLOT's `min-width`
                // above, and it stops it while there is still room for a readable name. A floor
                // written here instead would not survive contact with a layout engine — see
                // `tabMinWidth` for the measurement that proved it.
                minWidth: 0,
                overflow: exp ? "visible" : "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.name}
            </span>
            {tornOut && (
              // An icon, not a glyph or an emoji — this repo renders every icon from react-icons.
              // It says WHERE the project is, which the dimmed tab alone cannot: the tab is still
              // here (clicking it raises that window), but its columns are on another screen.
              <FiExternalLink
                size={11}
                data-testid={`torn-out-${p.id}`}
                aria-label="Open in its own window"
                style={{ flex: "none", opacity: 0.9 }}
              />
            )}
            {/* ⚠ N — on EVERY tab, including the active one: a stale checkout matters most while
                you are working in it. Absent unless this project is actually stale. */}
            {staleness && p.rootPath && (
              <TabStaleBadge
                projectId={p.id}
                projectName={p.name}
                staleness={staleness}
                onOpen={() => openStalePanel(p.id)}
                registerEl={(el) => {
                  // Same discipline as `tabEls`: delete on unmount, so a closed project's dead node
                  // is never the thing focus is restored to.
                  if (el) staleBadgeEls.current.set(p.id, el);
                  else staleBadgeEls.current.delete(p.id);
                }}
              />
            )}
            {/* ● N, and ONLY on a tab you are not looking at. See `tabBadgeCount`. */}
            {badgeCount !== null && band !== null && (
              <TabCountBadge projectId={p.id} count={badgeCount} band={band} />
            )}
            {/* NO close button while the project is torn out. Closing the tab hides it and nothing
                else — but the tab is also the ONLY doorway to that satellite ("Show that window" /
                "Bring it back here" live behind it), so closing it would leave a live window owning
                a project with no way to reach it, and `reconcileSatellites` would never prune the
                row because the window is genuinely alive. Re-dock first, then close. */}
            {onClose && !tornOut && (
              <button
                type="button"
                className="concierge-tab-close"
                data-active={active}
                title={closeTitle(p.name)}
                aria-label={closeTitle(p.name)}
                data-testid={`close-${p.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(p.id);
                }}
                // Both handlers stop the event reaching the tab. A <button> turns Enter/Space into
                // a click, and BOTH events bubble to the tab's own onClick/onKeyDown — so without
                // this, activating × would also fire onSelect on the tab being closed.
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                }}
                // A double-click on × must not also open project settings (the tab's onDoubleClick).
                onDoubleClick={(e) => e.stopPropagation()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  lineHeight: 0,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  marginLeft: -2,
                  cursor: "pointer",
                  color: active ? C.cream : C.muted,
                }}
              >
                <FiX size={13} />
              </button>
            )}
            </div>
          </div>
          </Fragment>
        );
      })}
      {/* Append-to-end caret. `beforeId === null` means "past every tab", which has no tab to
          precede — so it renders here rather than inside the map. */}
      {drag?.kind === "reorder" && drag.beforeId === null && <DropCaret />}
      </div>
      {/* OUTSIDE THE SCROLLER, deliberately. Inside it, the one control that opens a project would
          scroll off the end exactly when the bar is too full to hold another tab. */}
      {onAddProject && (
        <button
          type="button"
          data-hint="open"
          title="Open another project"
          aria-label="Open another project"
          data-testid="tab-add"
          onClick={onAddProject}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "8px 10px",
            color: C.muted,
            cursor: "pointer",
            background: "transparent",
            border: "none",
            position: "relative",
            top: 1,
          }}
        >
          <FiPlus size={14} />
        </button>
      )}
      {topRight && (
        <div
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingBottom: 6,
          }}
        >
          {topRight}
        </div>
      )}
      {/* The remedy panel for whichever badge was clicked. Rendered once at the strip level (it
          lists every stale project, not just that one) and portaled to root by `ModalLayer`. */}
      {stalePanelFor && (
        <StaleCheckoutPanel
          anchorEl={staleBadgeEls.current.get(stalePanelFor) ?? null}
          targets={staleTargets}
          onClose={closeStalePanel}
        />
      )}
    </div>
  );
}
