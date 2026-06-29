import { type CSSProperties } from "react";
import { FiDownload, FiRefreshCw, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL, FONT_WEIGHT } from "../theme/colors";
import { useUpdaterStore, applyUpdateAndRestart } from "../services/updaterService";

// Non-intrusive top-of-app banner for the auto-updater (see updaterService). Renders nothing
// unless an update is pending and the user hasn't dismissed it:
//   - phase "ready"     (auto-apply on):  the update is already installed and applies on the next
//                                         restart — offer an optional "Restart now".
//   - phase "available" (auto-apply off): the update is found but not installed — "Restart to
//                                         apply" installs + relaunches; "Later" dismisses.
// Pinned to the top via position:fixed so it overlays without reflowing the workspace layout.

const bar: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 14px",
  background: C.deepForest,
  borderBottom: `1px solid ${C.accent}`,
  color: C.cream,
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
};

const primaryBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 6,
  padding: "5px 12px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const dismissBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  background: "transparent",
  color: C.muted,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

export function UpdateBanner() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const dismissed = useUpdaterStore((s) => s.dismissed);
  const busy = useUpdaterStore((s) => s.busy);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  if (dismissed || (phase !== "available" && phase !== "ready")) return null;

  const ready = phase === "ready";
  const message = ready
    ? `Update ${version} ready — restart to apply now, or it'll apply on next launch.`
    : `Update ${version} available.`;
  const applyLabel = ready ? "Restart now" : "Restart to apply";
  const dismissLabel = ready ? "On next launch" : "Later";

  return (
    <div role="status" aria-live="polite" style={bar}>
      <FiDownload aria-hidden size={16} style={{ color: C.accentInk, flex: "0 0 auto" }} />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        type="button"
        style={{ ...primaryBtn, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
        disabled={busy}
        onClick={() => void applyUpdateAndRestart()}
      >
        <FiRefreshCw aria-hidden size={14} />
        {busy ? "Restarting…" : applyLabel}
      </button>
      <button type="button" style={dismissBtn} onClick={dismiss} aria-label={dismissLabel}>
        <FiX aria-hidden size={14} />
        {dismissLabel}
      </button>
    </div>
  );
}
