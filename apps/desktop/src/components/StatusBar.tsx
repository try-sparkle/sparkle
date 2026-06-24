import { useEffect, useState } from "react";
import { C } from "../theme/colors";
import { getAppVersion, getLogDir, revealLogs, log } from "../logger";

/**
 * Bottom-left footer: the app version + a "Show logs" link. The link opens the OS log
 * folder in Finder so the user can drag a log file straight into the composer (the
 * Composer accepts native file drops) to hand it to their agent for debugging.
 */
export function StatusBar() {
  const [version, setVersion] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getLogDir()
      .then(setLogDir)
      .catch(() => {});
  }, []);

  const onShowLogs = () => {
    log.info("statusbar", "show logs clicked");
    void revealLogs().catch((e) => log.error("statusbar", "reveal logs failed", e));
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
      <span title="Sparkle version">{version ? `v${version}` : ""}</span>
      <span aria-hidden>·</span>
      <button
        onClick={onShowLogs}
        title={logDir ? `Open ${logDir} in Finder` : "Open the log folder in Finder"}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          margin: 0,
          color: C.accent,
          fontSize: 11,
          fontFamily: '"IBM Plex Sans", sans-serif',
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        Show logs
      </button>
    </div>
  );
}
