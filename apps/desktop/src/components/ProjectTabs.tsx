// Project tabs for Concierge Mode (bead sparkle-qd80 / CM-U7). In the single-window concierge shell,
// each open project is a TAB across the top of the workspace (replacing multi-window). The Sparkle
// concierge column is NOT part of the tabs — it is persistent across all projects. Pinning a project
// scopes the concierge to it ("disregard all other project alerts so you can focus").
//
// Presentational + prop-driven so it's decoupled from the stores and unit-testable: the integration
// (Workspace) supplies the projects, selection, pin state, and per-project P0/P1 counts (from the
// concierge feed), plus the callbacks.

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect } from "react";
import { MdOutlinePushPin } from "react-icons/md";
import { FiPlus } from "react-icons/fi";
import { C } from "../theme/colors";

export interface ProjectTabItem {
  id: string;
  name: string;
}
/** Per-project attention counts (from the concierge feed) that drive the tab glow + count badge. */
export interface ProjectTabCounts {
  p0: number;
  p1: number;
}

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
  onAddProject?: () => void;
  /** Top-right cluster (kebab menu + avatar) rendered flush-right in the tab bar. */
  topRight?: ReactNode;
}

/** The pin tooltip describes what pinning DOES — asymmetric copy for pin vs unpin. */
export function pinTitle(isPinned: boolean): string {
  return isPinned
    ? "Unpin — Sparkle will watch alerts across all projects again"
    : "Pin this project and Sparkle will disregard all other project alerts so you can focus";
}

/** The priority a tab's glow/badge should reflect: "p0" (red) beats "p1" (yellow) beats null. */
export function tabPriority(counts: ProjectTabCounts | undefined): "p0" | "p1" | null {
  if (!counts) return null;
  if (counts.p0 > 0) return "p0";
  if (counts.p1 > 0) return "p1";
  return null;
}

const RED = "#e0533f";
const YELLOW = "#ffd76a";

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

export function ProjectTabs({
  projects,
  selectedProjectId,
  pinnedProjectId,
  countsByProject,
  onSelect,
  onTogglePin,
  onOpenSettings,
  onAddProject,
  topRight,
}: ProjectTabsProps) {
  useEffect(ensureTabStyles, []);

  return (
    <div style={barStyle} role="tablist" aria-label="Projects">
      {projects.map((p) => {
        const active = p.id === selectedProjectId;
        const pinned = p.id === pinnedProjectId;
        const counts = countsByProject[p.id];
        const prio = tabPriority(counts);
        const glow =
          prio === "p0"
            ? `0 0 0 1px ${RED}73, 0 -2px 14px ${RED}29`
            : prio === "p1"
              ? `0 0 0 1px ${YELLOW}66, 0 -2px 14px ${YELLOW}24`
              : undefined;
        return (
          <div
            key={p.id}
            className="concierge-tab"
            role="tab"
            aria-selected={active}
            tabIndex={0}
            data-testid={`tab-${p.id}`}
            title={`${p.name}${onOpenSettings ? " — double-click for project settings" : ""}`}
            onClick={() => onSelect(p.id)}
            onDoubleClick={() => onOpenSettings?.(p.id)}
            onKeyDown={(e) => activateOnKey(e, () => onSelect(p.id))}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
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
            {prio && (
              <span
                data-testid={`count-${p.id}`}
                style={{
                  fontWeight: 700,
                  fontSize: 9,
                  padding: "1px 5px",
                  borderRadius: 5,
                  color: prio === "p0" ? "#ff9a9a" : YELLOW,
                  border: `1px solid ${prio === "p0" ? `${RED}99` : `${YELLOW}8c`}`,
                }}
              >
                {prio === "p0" ? `${counts!.p0}·P0` : `${counts!.p1}·P1`}
              </span>
            )}
          </div>
        );
      })}
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
