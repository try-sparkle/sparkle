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
  useRef,
  useState,
} from "react";
import { MdOutlinePushPin } from "react-icons/md";
import { FiPlus, FiX, FiExternalLink } from "react-icons/fi";
import type { StatusBand } from "../engine/buildSections";
import { bandColor, bandCountLabel } from "../engine/statusBandLabels";
import { C } from "../theme/colors";
import { PROJECT_TAB_HINT } from "../keyboardHints/hintTargets";
import { resolveTabDrag, type TabDragResult, type TabRect } from "./tabDrag";

export interface ProjectTabItem {
  id: string;
  name: string;
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
 *  otherwise nothing.
 *
 *  There is exactly ONE alarm treatment now. The old two-tier version also lit a YELLOW glow for the
 *  "wants you eventually" tier, so a bar of tabs carried two competing alarm colors for a
 *  distinction the user never acted on differently — both meant "go look". `running` and `done`
 *  deliberately do NOT badge: a tab that glows whenever any agent is working glows permanently, and
 *  a signal that is always on is not a signal. */
export function tabBand(counts: ProjectTabCounts | undefined): StatusBand | null {
  if (!counts) return null;
  return counts.needs_you > 0 ? "needs_you" : null;
}

// The one alarm color, taken from the band itself so the tab, the dots it counts, and the sidebar's
// filter chips can't drift apart.
const RED = bandColor("needs_you");

/** How wide a tab's project name may get before it ellipsizes. Sized so a typical repo folder name
 *  fits whole and only genuinely long ones truncate — the point is a bar of UNIFORM-height tabs, not
 *  aggressive shortening. */
export const TAB_LABEL_MAX_WIDTH = 160;

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
`;
function ensureTabStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = TAB_STYLES;
  document.head.appendChild(el);
}

const barStyle: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "flex-end",
  gap: 3,
  padding: "8px 8px 0",
  background: C.barSurface,
  borderBottom: `1px solid ${C.muted}`,
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
        borderRadius: 1,
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
  topRight,
  onReorder,
  onTearOff,
  tornOutProjectIds,
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
      },
      { slop: DRAG_SLOP, tearMargin: TEAR_MARGIN },
    );
    g.last = res;
    g.lastScreen = { x: e.screenX, y: e.screenY };
    if (res.kind === "idle") return;
    g.dragging = true;
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
    <div style={barStyle} role="tablist" aria-label="Projects" ref={barRef}>
      {projects.map((p) => {
        const active = p.id === selectedProjectId;
        const pinned = p.id === pinnedProjectId;
        const counts = countsByProject[p.id];
        const band = tabBand(counts);
        const glow = band ? `0 0 0 1px ${RED}73, 0 -2px 14px ${RED}29` : undefined;
        const tornOut = tornOutProjectIds?.has(p.id) ?? false;
        const isDragged = drag?.projectId === p.id;
        const caret = drag?.kind === "reorder" && drag.beforeId === p.id;
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
            title={tabTitle(p.name, { hasSettings: !!onOpenSettings, tornOut, canTearOff: !!onTearOff })}
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
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              // The tab being dragged fades so the caret (or the empty gap, when the drag has left
              // the strip) is what the eye follows.
              opacity: isDragged ? (drag?.kind === "tearoff" ? 0.35 : 0.55) : tornOut ? 0.6 : 1,
              // Suppress the browser's own text selection + native drag while a tab is being pulled;
              // without it the project name highlights blue under the cursor mid-drag.
              userSelect: "none",
              WebkitUserSelect: "none",
              // A flex item defaults to `min-width: auto`, which floors it at its content's
              // min-content width. With the label now `nowrap`, that floor is the WHOLE label —
              // so a bar full of long names would push past its container and squeeze the "+" and
              // the top-right cluster instead of ellipsizing. `minWidth: 0` lets the tab shrink so
              // the label's own `text-overflow` actually gets to do its job under crowding.
              minWidth: 0,
              borderRadius: "9px 9px 0 0",
              cursor: "pointer",
              fontSize: 12,
              position: "relative",
              top: 1,
              color: active ? C.cream : C.muted,
              background: active ? C.forest : "transparent",
              // Longhand per edge: mixing the `border` shorthand with a `borderBottom` override
              // makes React warn (and can style-bug) when only one of them changes on re-render.
              borderTop: `1px solid ${active ? C.muted : "transparent"}`,
              borderLeft: `1px solid ${active ? C.muted : "transparent"}`,
              borderRight: `1px solid ${active ? C.muted : "transparent"}`,
              borderBottom: "none",
              boxShadow: glow,
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
              style={{
                // A long folder name must TRUNCATE, never wrap. Wrapping made that one tab two rows
                // tall while its neighbours stayed one row, so the whole bar grew and the tabs no
                // longer lined up — the ragged look the ellipsis exists to prevent. The tab's
                // `title` already carries the full name, so nothing is lost to the truncation.
                maxWidth: TAB_LABEL_MAX_WIDTH,
                overflow: "hidden",
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
            {band && (
              <span
                data-testid={`count-${p.id}`}
                style={{
                  fontWeight: 700,
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 5,
                  color: "#ff9a9a",
                  border: `1px solid ${RED}99`,
                }}
              >
                {/* "1 Needs you" / "3 Need you" — the shared helper owns the agreement. */}
                {bandCountLabel(band, counts![band])}
              </span>
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
          </Fragment>
        );
      })}
      {/* Append-to-end caret. `beforeId === null` means "past every tab", which has no tab to
          precede — so it renders here rather than inside the map. */}
      {drag?.kind === "reorder" && drag.beforeId === null && <DropCaret />}
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
    </div>
  );
}
