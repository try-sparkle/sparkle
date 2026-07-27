// The bottom-right status strip: Changelog · Support · v{version}.
//
// This restores the persistent chrome the deleted StatusBar used to hold (bottom LEFT), now pinned
// bottom RIGHT and rebuilt on the shared primitives in appChrome.ts. Nothing here is a second copy:
// Support opens the reused SupportModal, Changelog goes through the shared openChangelog helper,
// and the version's popover uses the shared useVersionCheck session guard. The kebab menu no longer
// carries these three — one home each (see Concierge/KebabMenu.tsx).
//
// LAYOUT NOTE: the strip is a real flex ROW at the end of the Workspace shell column, NOT a
// `position: fixed` overlay. That is deliberate — it cannot occlude the terminal stage, the
// composer, or anything else bottom-anchored, because it takes its own 24px of the column and the
// stage lays out above it. It also keeps us clear of the `position: fixed` containing-block trap
// documented on the stage container in Workspace.tsx (roborev 46254): we never rely on the viewport
// as a containing block, so no ancestor's `filter` can shrink us.
import { useEffect, useRef, useState } from "react";
import { C } from "../theme/colors";
import { SupportModal } from "./SupportModal";
import {
  CHANGELOG_URL,
  checkLabel,
  handleMenuArrows,
  menuItemStyle,
  menuSurface,
  openChangelog,
  openLogsInFinder,
  ownedMenuItems,
  useAppInfo,
  useVersionCheck,
} from "./appChrome";

const SCOPE = "statusstrip";

/** Shared look for the two link affordances — quiet, underlined, lifts to full contrast on hover. */
function linkStyle(hover: boolean) {
  return {
    background: "transparent",
    border: "none",
    padding: 0,
    margin: 0,
    color: hover ? C.cream : C.muted,
    fontSize: 11,
    fontFamily: '"IBM Plex Sans", sans-serif',
    textDecoration: "underline",
    textUnderlineOffset: 2,
    cursor: "pointer",
  } as const;
}

export function StatusStrip() {
  const { version, logDir } = useAppInfo();
  const [versionOpen, setVersionOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [hover, setHover] = useState<"changelog" | "support" | "version" | null>(null);
  const { checkState, beginSession, endSession, runCheck } = useVersionCheck(SCOPE);

  const versionRef = useRef<HTMLDivElement>(null);
  const versionButtonRef = useRef<HTMLButtonElement>(null);
  const versionMenuRef = useRef<HTMLDivElement>(null);

  const openVersion = () => {
    beginSession();
    setVersionOpen(true);
  };
  const closeVersion = () => {
    endSession();
    setVersionOpen(false);
  };

  // Dismiss the version popover on outside pointerdown and on Escape (focus back to its trigger).
  useEffect(() => {
    if (!versionOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!versionRef.current?.contains(e.target as Node)) closeVersion();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeVersion();
      versionButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // closeVersion is stable in behavior (setState + a ref bump); versionOpen drives the layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionOpen]);

  // A menu manages focus: opening it focuses its first item.
  useEffect(() => {
    if (versionOpen && versionMenuRef.current) ownedMenuItems(versionMenuRef.current)[0]?.focus();
  }, [versionOpen]);

  const onCheckForUpdates = async () => {
    // An available update is announced by the update banner — get out of its way.
    if (await runCheck()) closeVersion();
  };

  return (
    <>
      <div
        data-testid="status-strip"
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end", // ← the "bottom RIGHT" half of the placement
          gap: 8,
          height: 24,
          padding: "0 12px",
          background: C.deepForest,
          borderTop: `1px solid ${C.barSurface}`,
          color: C.muted,
          fontSize: 11,
          userSelect: "none",
        }}
      >
        {/* A real anchor: focusable and announced as a link for free. href is the changelog URL so
            the accessible name and the destination agree, but the click is intercepted — the webview
            must never navigate away from the app, so it goes to the system browser instead. */}
        <a
          href={CHANGELOG_URL}
          data-hint="changelog"
          title="Open the Sparkle changelog"
          onClick={(e) => {
            e.preventDefault();
            openChangelog(SCOPE);
          }}
          onMouseEnter={() => setHover("changelog")}
          onMouseLeave={() => setHover(null)}
          style={linkStyle(hover === "changelog")}
        >
          Changelog
        </a>
        <span aria-hidden>·</span>
        {/* Support has no URL — it opens the in-app SupportModal — but the user asked for a link, so
            it carries link semantics explicitly (focusable button + role="link" + haspopup dialog). */}
        <button
          type="button"
          role="link"
          aria-haspopup="dialog"
          data-hint="support"
          title="Get help or open a support ticket"
          onClick={() => setSupportOpen(true)}
          onMouseEnter={() => setHover("support")}
          onMouseLeave={() => setHover(null)}
          style={linkStyle(hover === "support")}
        >
          Support
        </button>
        <span aria-hidden>·</span>
        <div ref={versionRef} style={{ position: "relative", display: "inline-flex" }}>
          <button
            ref={versionButtonRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={versionOpen}
            // Only actionable once the version has resolved — nothing useful to show before.
            aria-disabled={!version}
            title="Sparkle version"
            onClick={() => version && (versionOpen ? closeVersion() : openVersion())}
            onMouseEnter={() => setHover("version")}
            onMouseLeave={() => setHover(null)}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              margin: 0,
              color: hover === "version" && version ? C.cream : C.muted,
              fontSize: 11,
              fontFamily: '"IBM Plex Sans", sans-serif',
              cursor: version ? "pointer" : "default",
            }}
          >
            {version ? `v${version}` : "v…"}
          </button>
          {versionOpen && (
            <div
              ref={versionMenuRef}
              role="menu"
              aria-label="Version"
              onKeyDown={handleMenuArrows}
              style={{
                ...menuSurface,
                position: "absolute",
                // The strip hugs the app's bottom-right corner, so the popover opens UP and LEFT.
                bottom: "calc(100% + 6px)",
                right: 0,
              }}
            >
              <button
                type="button"
                role="menuitem"
                // aria-disabled (not disabled) keeps the item focusable mid-check so roving focus
                // doesn't lose its anchor; runCheck re-entry-guards itself.
                aria-disabled={checkState === "checking"}
                title="Check for a newer Sparkle version"
                onClick={() => void onCheckForUpdates()}
                style={{
                  ...menuItemStyle,
                  cursor: checkState === "checking" ? "default" : "pointer",
                }}
              >
                {checkLabel(checkState)}
              </button>
              <button
                type="button"
                role="menuitem"
                title={logDir ? `Open ${logDir} in Finder` : "Open the log folder in Finder"}
                onClick={() => {
                  closeVersion();
                  openLogsInFinder(SCOPE);
                }}
                style={menuItemStyle}
              >
                Open logs in Finder →
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Outside the strip on purpose: the strip is a 24px row with `user-select: none` and 11px
          type, and a modal nested in it would inherit both. */}
      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}
    </>
  );
}
