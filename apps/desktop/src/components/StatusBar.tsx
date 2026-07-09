import { type CSSProperties, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FiAlertTriangle, FiCheck, FiRefreshCw } from "react-icons/fi";
import { C } from "../theme/colors";
import { getAppVersion, getLogDir, revealLogs, log } from "../logger";
import { checkForUpdates, type CheckOutcome } from "../services/updaterService";
import { SupportModal } from "./SupportModal";

const CHANGELOG_URL = "https://sparkle.ai/changelog";

/** Shared style for the version-popover rows, so "Check for updates" and "Open logs" match. */
const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
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
};

/** Manual "Check for updates" feedback, shown inline in the popover (not the global updater store,
 *  which stays focused on update availability / the banner). */
type CheckState = "idle" | "checking" | "uptodate" | "error";

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
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [supportOpen, setSupportOpen] = useState(false);
  const versionRef = useRef<HTMLDivElement>(null);
  // Bumped on every popover open/close so an in-flight manual check whose promise resolves in a
  // DIFFERENT session (popover closed, or closed and reopened) can't write its stale result.
  const checkGenRef = useRef(0);

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

  // Each open/close is a new session: invalidate any in-flight check's result and start every
  // OPEN fresh ("Check for updates"), so a prior check's outcome never lingers on reopen.
  useEffect(() => {
    checkGenRef.current += 1;
    if (menuOpen) setCheckState("idle");
  }, [menuOpen]);

  const onShowLogs = () => {
    log.info("statusbar", "open logs in finder clicked");
    setMenuOpen(false);
    void revealLogs().catch((e) => log.error("statusbar", "reveal logs failed", e));
  };

  const onCheckForUpdates = async () => {
    if (checkState === "checking") return; // guard double-clicks / re-entry
    log.info("statusbar", "check for updates clicked");
    setCheckState("checking");
    const gen = checkGenRef.current; // this check belongs to the current open session
    let outcome: CheckOutcome;
    try {
      outcome = await checkForUpdates();
    } catch {
      outcome = "error"; // checkForUpdates never throws, but belt-and-suspenders
    }
    // The popover closed (and maybe reopened) since this check started — its result is stale for
    // the current session, so don't write it (it would show without a fresh check having run).
    if (checkGenRef.current !== gen) return;
    if (outcome === "update-available") {
      // The update banner now surfaces it — close the popover so it isn't covered.
      setCheckState("idle");
      setMenuOpen(false);
    } else {
      setCheckState(outcome === "up-to-date" ? "uptodate" : "error");
    }
  };

  const onChangelog = () => {
    log.info("statusbar", "changelog clicked");
    void openUrl(CHANGELOG_URL).catch((e) => log.error("statusbar", "open changelog failed", e));
  };

  const onSupport = () => {
    log.info("statusbar", "support clicked");
    setSupportOpen(true);
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
            // A small disclosure popover revealed by the version button's aria-expanded — no role
            // (it's not a menu or a focus-trapping dialog).
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
              onClick={() => void onCheckForUpdates()}
              disabled={checkState === "checking"}
              title="Check for a newer Sparkle version"
              style={{
                ...menuItemStyle,
                cursor: checkState === "checking" ? "default" : "pointer",
              }}
            >
              {checkState === "uptodate" ? (
                <FiCheck aria-hidden size={13} style={{ flex: "0 0 auto" }} />
              ) : checkState === "error" ? (
                <FiAlertTriangle aria-hidden size={13} style={{ flex: "0 0 auto" }} />
              ) : (
                <FiRefreshCw aria-hidden size={13} style={{ flex: "0 0 auto" }} />
              )}
              {checkState === "checking"
                ? "Checking for updates…"
                : checkState === "uptodate"
                  ? "You're up to date"
                  : checkState === "error"
                    ? "Check failed — retry"
                    : "Check for updates"}
            </button>
            <button
              onClick={onShowLogs}
              title={logDir ? `Open ${logDir} in Finder` : "Open the log folder in Finder"}
              style={menuItemStyle}
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
      <span aria-hidden>·</span>
      <button
        data-hint="support"
        onClick={onSupport}
        title="Get help or open a support ticket"
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
        Support
      </button>
      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}
    </div>
  );
}
