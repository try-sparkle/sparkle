import { type CSSProperties } from "react";
import { FiAlertTriangle, FiRefreshCw, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL, FONT_WEIGHT } from "../theme/colors";
import { useStaleBuildStore, restartToFinishUpdate } from "../services/staleBuildService";

// "Restart to finish updating" banner (bead sparkle-jeen). Shows when the build INSTALLED on disk
// differs from the one this process is RUNNING — i.e. an update landed but the old process is still
// up. Distinct from UpdateBanner (which only knows about updates IT staged this session); this
// catches the stale process however it got that way. Pinned to the top via position:fixed so it
// overlays without reflowing the workspace. Amber, to read as "attention" rather than the updater's
// "new thing available".

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
  borderBottom: `1px solid ${C.amberInk}`,
  color: C.cream,
  fontSize: 13,
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
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
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
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
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  cursor: "pointer",
};

export function StaleBuildBanner() {
  const stale = useStaleBuildStore((s) => s.stale);
  const dismissed = useStaleBuildStore((s) => s.dismissed);
  const installedVersion = useStaleBuildStore((s) => s.installedVersion);
  const dismiss = useStaleBuildStore((s) => s.dismiss);

  if (!stale || dismissed) return null;

  const message = installedVersion
    ? `You're running an older version than the one installed (${installedVersion}). Restart to finish updating.`
    : "You're running an older build than the one installed. Restart to finish updating.";

  return (
    <div role="status" aria-live="polite" style={bar}>
      <FiAlertTriangle aria-hidden size={16} style={{ color: C.amberInk, flex: "0 0 auto" }} />
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button type="button" style={primaryBtn} onClick={() => void restartToFinishUpdate()}>
        <FiRefreshCw aria-hidden size={14} />
        Restart now
      </button>
      <button type="button" style={dismissBtn} onClick={dismiss} aria-label="Later">
        <FiX aria-hidden size={14} />
        Later
      </button>
    </div>
  );
}
