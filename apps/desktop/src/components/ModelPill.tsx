// The per-agent Claude model pill (bead sparkle-i6rw): a small "Opus ▾" chip that opens a
// dropdown of the curated model list (services/models.ts). Rendered on the agent card's hover
// overlay (and anywhere else a per-agent model needs picking). Pattern cloned from AgentPane's
// AccountBadge: pill button + dark popover, outside-click backdrop + Escape to dismiss.
//
// BOTH the backdrop AND the menu are portaled to document.body: the hover card is its own
// stacking context (position:fixed + zIndex + drop-shadow filter), so anything left inside it
// can never paint above a body-level backdrop — a menu inside the card gets covered and its
// clicks swallowed (roborev 24831/24832), and a fixed backdrop inside the card is re-contained
// by the filter and shrinks to the card's box (roborev 23560). In the root context the layers
// order plainly: backdrop below menu. React's enter/leave events traverse the fiber tree
// through portals, so the hover card's mouseenter/mouseleave liveness survives both portals.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C, FONT } from "../theme/colors";
import {
  CLAUDE_MODELS,
  isDefaultModel,
  modelShortLabel,
  refreshModelCatalog,
  useModelCatalog,
} from "../services/models";

// Root-context layer order: the menu must paint (and hit-test) above its own backdrop.
const BACKDROP_Z = 60;
const MENU_Z = 61;

export function ModelPill({
  value,
  onChange,
  compact = false,
}: {
  /** The agent's current model id, or undefined/"default" for "inherit Claude Code's default". */
  value: string | undefined;
  onChange: (modelId: string) => void;
  /** Tighter padding/font for dense rows. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The trigger's viewport rect, captured at open time, positions the body-portaled menu
  // (right-aligned under the pill). Captured-once is safe because the menu's OWN scroll/resize
  // listener (the effect below) dismisses it the moment anything could move the trigger — the
  // position can never be observed stale.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The live model catalog: the curated fallback until a dynamic BYOK /v1/models fetch replaces it.
  // Re-renders this pill (via useSyncExternalStore) whenever refreshModelCatalog() lands new models.
  const models = useModelCatalog();

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus(); // hand focus back to the pill (menu items can hold it)
  };
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    setMenuPos(r ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) } : null);
    setOpen(true);
    // Lazily refresh the catalog from the user's BYOK key when the dropdown opens. Fire-and-forget:
    // the menu renders the cached catalog immediately and re-renders in place if newer models land.
    // TTL-guarded inside refreshModelCatalog so repeated opens don't re-hit the network.
    void refreshModelCatalog();
  };

  // Escape dismisses the menu (mirrors the app's other popovers). Consume the key (and honor a
  // prior consumer) so one press peels THIS layer only — not every Escape listener at once
  // (roborev 23561). Any scroll or resize ALSO closes the menu: its position was captured at
  // open time, and the trigger can move under it — e.g. the hover card re-pins (doesn't close)
  // during the sidebar's auto-scroll-to-fit glide (roborev 24987/24988). Capture-phase scroll,
  // like the card's own listener, so the sidebar's inner scroll is caught too — this assumes
  // the menu itself never scrolls internally (5 options, no overflow); a scrollable menu would
  // need to exempt its own scroll events. The scroll/resize path dismisses WITHOUT the focus
  // handoff: close()'s trigger.focus() scrolls the pill into view, which would fight the very
  // scroll that caused the dismissal (roborev 25143).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close();
    };
    const onMove = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  const current = modelShortLabel(value);
  // Guarantee the agent's CURRENT model is always in the menu, even if the dynamic BYOK catalog
  // doesn't include it — no access, deprecated, a partial response, or a curated id the key can't
  // see. Without this the user could neither see nor re-select their active model (the dropdown
  // renders only the dynamic list), a regression from Phase 1 where every curated model was always
  // selectable (roborev 27159). The Default sentinel and ids already present need no union.
  const options =
    isDefaultModel(value) || models.some((m) => m.id === value)
      ? models
      : // `value` is a defined non-default id here (isDefaultModel(undefined) is true, so the
        // union branch is unreachable for undefined) — the `!` just tells TypeScript that. Prefer
        // the curated full label/short for a known-but-unlisted id (e.g. a curated model the BYOK
        // key can't currently see) so its row reads "Opus 4.8" like every other row, not the terse
        // "Opus"; a truly unknown id falls back to its short label (the raw id) for both.
        (() => {
          const curated = CLAUDE_MODELS.find((m) => m.id === value);
          return [
            ...models,
            { id: value!, label: curated?.label ?? current, short: curated?.short ?? current },
          ];
        })();
  // Focus lands on the active option when the menu opens; with the union above a real selected id
  // always matches, so the first-option fallback now only applies to the Default sentinel case.
  const hasActive = options.some((m) => m.id === (value ?? "default"));
  return (
    // stopPropagation keeps the pill's clicks from reaching the agent card's own select/drag
    // handlers underneath it. (Backdrop/menu clicks bubble through the portals' REACT tree back
    // to this wrapper, so they're stopped here too.)
    <div
      data-testid="model-pill"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ flex: "0 0 auto" }}
    >
      <button
        ref={triggerRef}
        type="button"
        title={`Claude model: ${current} — click to change (applies live via /model when running)`}
        // No aria-haspopup: "true" is an ARIA synonym for "menu", which would announce
        // arrow-key navigation this plain-buttons popover doesn't implement (roborev 24987);
        // aria-expanded alone conveys the open/closed state.
        aria-expanded={open}
        onClick={toggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: C.deepForest,
          border: `1px solid ${C.muted}`,
          borderRadius: 5,
          color: C.cream,
          fontFamily: FONT.ui,
          fontSize: compact ? 10 : 11,
          fontWeight: 600,
          lineHeight: 1,
          padding: compact ? "2px 6px" : "3px 8px",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span>{current}</span>
        <span style={{ color: C.muted }}>▾</span>
      </button>
      {open &&
        createPortal(
          <>
            <div
              data-testid="model-pill-backdrop"
              onClick={close}
              style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
            />
            <div
              data-testid="model-pill-menu"
              style={{
                position: "fixed",
                top: menuPos?.top ?? 8,
                right: menuPos?.right ?? 8,
                minWidth: 200,
                background: C.deepForest,
                border: `1px solid ${C.forest}`,
                borderRadius: 8,
                boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                padding: 6,
                zIndex: MENU_Z,
              }}
            >
              {options.map((m, i) => {
                const active = m.id === (value ?? "default");
                return (
                  // Real buttons: Tab-reachable, Enter/Space-activatable. Deliberately NO
                  // role="menu"/"menuitem" — that would announce arrow-key navigation this
                  // simple popover doesn't implement (roborev 24832). The active option (or
                  // the first, when no id matches) takes focus on open so keyboard users land
                  // inside the list.
                  <button
                    key={m.id}
                    type="button"
                    autoFocus={active || (i === 0 && !hasActive)}
                    onClick={() => {
                      close();
                      onChange(m.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 8px",
                      border: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontFamily: FONT.ui,
                      fontSize: 12,
                      color: C.cream,
                      background: active ? C.forest : "transparent",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        background: active ? C.teal : "transparent",
                        border: active ? "none" : `1px solid ${C.muted}`,
                        flex: "0 0 auto",
                      }}
                    />
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
