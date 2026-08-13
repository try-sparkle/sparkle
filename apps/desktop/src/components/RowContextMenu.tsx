// THE BUILDER ROW'S RIGHT-CLICK MENU. Founder, 2026-08-13: *"Renaming of the builder row should now
// go into right click of the builder row. It should be an option in the right click menu."*
//
// ══ WHY THIS EXISTS AT ALL, RATHER THAN A THIRD BARE GESTURE ═══════════════════════════════════
// A right click on the row had TWO answers before this, and neither was a menu: over the agent name
// it began an inline rename instantly, and anywhere else it threw the detail card across the pane.
// Which one you got depended on hitting a `flex: 1` span whose bounds are not drawn anywhere. A menu
// is one answer everywhere on the row, and it is the only surface that can hold a THIRD verb without
// inventing a fourth gesture nobody would find.
//
// ══ SCOPE: THIS IS NOT A DESIGN SYSTEM ═════════════════════════════════════════════════════════
// There is no reusable ContextMenu in this app and this is not an attempt to become one. It stands
// on the primitives that already exist — `menuSurface`, `menuItemStyle`, `ownedMenuItems` and
// `handleMenuArrows` from `appChrome` — so the row's menu looks and keyboards like the kebab and the
// status strip without a second copy of any of it. If a second caller ever appears, generalise then.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "../theme/colors";
import { handleMenuArrows, menuItemStyle, menuSurface, ownedMenuItems } from "./appChrome";

/** Above the hover card (z 50), level with the app's other popovers (ModelPill, BoardFilterBar). */
const BACKDROP_Z = 60;
const MENU_Z = 61;
/** The gap kept between the menu and the viewport edge when the cursor is near one. */
const EDGE_PAD = 8;
/** What the menu is assumed to measure before it has been laid out — see `clampToViewport`. */
const ASSUMED_W = 200; // `menuSurface.minWidth`
const ASSUMED_H = 120; // three items plus the separator and the surface's own padding

/**
 * THE ONE MENU THAT IS OPEN, so a second right click can close it — and the reason this is a module
 * variable rather than something tidier.
 *
 * Each row owns its own menu state, and every dismissal route below is scoped to one instance: the
 * backdrop belongs to that menu, and the document `pointerdown` listener is how a press elsewhere
 * reaches it. Neither fires for a RIGHT click on a DIFFERENT row, because `openRowMenu` calls
 * `stopPropagation` — React's synthetic `stopPropagation` stops the native event too, and React
 * attaches its listeners at the root container, BELOW `document` — so a document-level `contextmenu`
 * listener can never see a press on a row at all. Two rows could therefore each hold a menu open,
 * which is not a state a context menu is ever in.
 *
 * A document listener that COULD see it would not fix this either: for a second right click on the
 * SAME row it cannot distinguish "another surface claimed this gesture" from "my own row just
 * re-anchored me", so it would close the menu that had only just re-opened.
 *
 * So the invariant is stated where it belongs — at most one row menu exists — and enforced on mount.
 */
let openMenuDismiss: (() => void) | null = null;

export type RowMenuItem = {
  /** Stable identity: the item's `data-testid` is `row-menu-<id>`. */
  id: string;
  label: string;
  onSelect: () => void;
  /** Destructive — painted in the app's danger ink and separated from what precedes it. */
  danger?: boolean;
  /** Draw a rule above this item. */
  separatorBefore?: boolean;
};

/**
 * Keep the menu on screen. A cursor 20px from the right edge would otherwise open a menu that runs
 * off it — the item you were reaching for is the one that disappears.
 *
 * Pure, and exported, for the reason `agentNameFloorFor` next door is: jsdom has no layout engine,
 * so a component that only ever clamps against measured zeroes can never exercise the branch that
 * matters. `w`/`h` are the menu's own measurements where they exist and the assumed size before
 * first paint — never 0, because a zero-size menu clamps to nothing and the first frame would then
 * paint off-screen and jump back.
 */
export function clampToViewport(
  at: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
): { x: number; y: number } {
  // `Math.max(EDGE_PAD, …)` LAST, so a viewport too small to hold the menu pins it to the top-left
  // corner rather than to a negative offset. Its content is scrolled by the surface, not by us.
  return {
    x: Math.max(EDGE_PAD, Math.min(at.x, viewport.w - size.w - EDGE_PAD)),
    y: Math.max(EDGE_PAD, Math.min(at.y, viewport.h - size.h - EDGE_PAD)),
  };
}

export function RowContextMenu({
  at,
  items,
  onDismiss,
  label,
}: {
  /** Where the menu's top-left corner wants to be — the cursor, or the row's own rect for a
   *  keyboard-raised menu (Shift+F10 / the Menu key carry no coordinates). */
  at: { x: number; y: number };
  items: RowMenuItem[];
  onDismiss: () => void;
  /** Announced name of the menu, e.g. the agent it belongs to. */
  label: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => clampToViewport(at, { w: ASSUMED_W, h: ASSUMED_H }, {
    w: window.innerWidth,
    h: window.innerHeight,
  }));

  // Re-clamp against the REAL size once the surface is in the DOM, and again whenever the anchor
  // moves (a second right click re-anchors this same instance rather than mounting a new one). A
  // layout effect, so nothing is ever painted at the pre-measurement position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    setPos(
      clampToViewport(
        at,
        { w: el?.offsetWidth || ASSUMED_W, h: el?.offsetHeight || ASSUMED_H },
        { w: window.innerWidth, h: window.innerHeight },
      ),
    );
  }, [at]);

  // FOCUS LANDS INSIDE THE MENU ON OPEN. This is the app's first keyboard-reachable rename — the row
  // takes `contextmenu` from Shift+F10 and the Menu key — and a menu whose items are never focused
  // is one a keyboard user cannot operate at all. Keyed on the anchor so a re-anchored menu re-homes
  // focus to its first item, matching what a fresh open does.
  useEffect(() => {
    const el = menuRef.current;
    if (el) ownedMenuItems(el)[0]?.focus();
  }, [at]);

  // AT MOST ONE ROW MENU, app-wide — see `openMenuDismiss`. Closing the previous one from here (an
  // effect, so it runs after this menu has mounted and claimed the slot) means the outgoing menu's
  // own cleanup finds the slot already taken and leaves it alone.
  useEffect(() => {
    if (openMenuDismiss && openMenuDismiss !== onDismiss) openMenuDismiss();
    openMenuDismiss = onDismiss;
    return () => {
      if (openMenuDismiss === onDismiss) openMenuDismiss = null;
    };
  }, [onDismiss]);

  // Escape and outside-press dismissal. On `document`, not on the menu: the press that dismisses a
  // menu is by definition one the menu did not receive, and Escape has to work whether or not focus
  // is still inside (an item can steal it). The backdrop below covers the mouse case on its own; the
  // pointerdown listener is what catches a press on a surface that sits ABOVE the backdrop.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // NOT stopped. The cable's own Escape path already declines to unbind while a dismissible
      // surface is on screen, and `[role="menu"]` is in its DISMISSIBLE_SELECTOR — this menu is
      // still in the DOM at the instant that handler asks, because React has not re-rendered yet.
      // Swallowing the key here would be a second, silent copy of that rule.
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  return createPortal(
    <>
      <div
        data-testid="row-context-menu-backdrop"
        // PART OF THE LIVE CIRCUIT (engine/cable). Portalled to document.body, so the cable's "did
        // this press leave the circuit" test — which walks DOM ancestry — cannot tie this back to
        // the row that owns it, and dismissing the menu would drop the cable. Same marker, same
        // reason, as the row's hover card and the model menu (roborev 54821).
        data-circuit
        onClick={onDismiss}
        // A right click on the backdrop dismisses too, and shows no native menu doing it: the
        // gesture that opened this is the gesture most likely to be repeated over it.
        onContextMenu={(e) => {
          e.preventDefault();
          onDismiss();
        }}
        style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
      />
      <div
        ref={menuRef}
        data-testid="row-context-menu"
        data-circuit
        role="menu"
        aria-label={label}
        onKeyDown={handleMenuArrows}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          ...menuSurface,
          position: "fixed",
          left: pos.x,
          top: pos.y,
          zIndex: MENU_Z,
        }}
      >
        {/* A FRAGMENT, not a wrapper div: `role="menu"` owns `menuitem`/`separator` children, and an
            anonymous div between them breaks that ownership for assistive tech. */}
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore && (
              <div
                data-testid="row-context-menu-separator"
                role="separator"
                style={{ height: 1, background: C.hairline, margin: "4px 6px" }}
              />
            )}
            <button
              type="button"
              role="menuitem"
              data-testid={`row-menu-${item.id}`}
              onClick={() => {
                // DISMISS FIRST. The verb may unmount this row outright (Close agent) or mount an
                // input over it (Rename); leaving the menu standing over either is a surface with
                // no owner. Order also matters for the test that asserts the menu is gone —
                // `onSelect` running first would make that depend on the verb.
                onDismiss();
                item.onSelect();
              }}
              style={{
                ...menuItemStyle,
                // `dangerInk`, NOT the `sienna` FILL the helper island's menu uses. Fills are
                // constant across themes by design and must never paint text — theme/linkContrast
                // enforces exactly that, and maps sienna → dangerInk for this case.
                ...(item.danger ? { color: C.dangerInk } : {}),
              }}
            >
              {item.label}
            </button>
          </Fragment>
        ))}
      </div>
    </>,
    document.body,
  );
}
