import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C } from "../theme/colors";
import { getAppVersion, getLogDir, revealLogs, log } from "../logger";

const CHANGELOG_URL = "https://sparkle.ai/changelog";

/**
 * Bottom-left footer: a clickable app version + a "Changelog" link. The version opens a
 * small popover with "Open logs in Finder →", which reveals the OS log folder so the user
 * can drag a log file straight into the composer (the Composer accepts native file drops)
 * to hand it to their agent for debugging. The Changelog link opens sparkle.ai/changelog in
 * the system browser.
 */
export function StatusBar() {
  const [version, setVersion] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const versionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getLogDir()
      .then(setLogDir)
      .catch(() => {});
  }, []);

  // Dismiss the version popover on outside-click and on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!versionRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const onShowLogs = () => {
    log.info("statusbar", "open logs in finder clicked");
    setMenuOpen(false);
    void revealLogs().catch((e) => log.error("statusbar", "reveal logs failed", e));
  };

  const onChangelog = () => {
    log.info("statusbar", "changelog clicked");
    void openUrl(CHANGELOG_URL).catch((e) => log.error("statusbar", "open changelog failed", e));
  };

  return (
    <div
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 14px",
        borderTop: `1px solid ${C.forest}`,
        fontSize: 11,
        color: C.muted,
        fontFamily: '"IBM Plex Sans", sans-serif',
        userSelect: "none",
      }}
    >
      <div ref={versionRef} style={{ position: "relative" }}>
        <button
          // Only actionable once the version has resolved — an empty label renders
          // zero-width, so guard the toggle so a stray click can't open an empty popover.
          onClick={() => version && setMenuOpen((o) => !o)}
          title="Sparkle version"
          aria-haspopup={version ? "true" : undefined}
          aria-expanded={version ? menuOpen : undefined}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            margin: 0,
            color: C.muted,
            fontSize: 11,
            fontFamily: '"IBM Plex Sans", sans-serif',
            cursor: version ? "pointer" : "default",
          }}
        >
          {version ? `v${version}` : ""}
        </button>
        {menuOpen && (
          <div
            // A single-action disclosure popover revealed by the version button's
            // aria-expanded — no role (it's not a menu or a focus-trapping dialog).
            style={{
              position: "absolute",
              bottom: "calc(100% + 6px)",
              left: 0,
              minWidth: 180,
              padding: 4,
              background: C.deepForest,
              border: `1px solid ${C.forest}`,
              borderRadius: 6,
              boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
              zIndex: 1000,
            }}
          >
            <button
              onClick={onShowLogs}
              title={logDir ? `Open ${logDir} in Finder` : "Open the log folder in Finder"}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "6px 8px",
                borderRadius: 4,
                color: C.cream,
                fontSize: 11,
                fontFamily: '"IBM Plex Sans", sans-serif',
                cursor: "pointer",
              }}
            >
              Open logs in Finder →
            </button>
          </div>
        )}
      </div>
      <span aria-hidden>·</span>
      <button
        data-hint="changelog"
        onClick={onChangelog}
        title="Open the Sparkle changelog"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          color: C.accentInk,
          fontSize: 11,
          fontFamily: '"IBM Plex Sans", sans-serif',
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Changelog
      </button>
    </div>
  );
}
