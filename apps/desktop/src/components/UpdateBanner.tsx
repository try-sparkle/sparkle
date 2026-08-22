import { type CSSProperties } from "react";
import { FiDownload, FiRefreshCw, FiX } from "react-icons/fi";
import { C, ON_BRAND_FILL, FONT_WEIGHT } from "../theme/colors";
import { useUpdaterStore, applyUpdateAndRestart } from "../services/updaterService";
import { FONT_UI } from "../theme/scale";

// Non-intrusive top-of-app banner for the auto-updater (see updaterService). Renders nothing
// unless an update is pending and the user hasn't dismissed it:
//   - phase "ready"     (auto-apply on):  the update has been DOWNLOADED into memory and nothing on
//                                         disk has changed yet — "Restart now" installs it and
//                                         relaunches.
//   - phase "available" (auto-apply off): the update is found but not downloaded — "Restart to
//                                         apply" downloads + installs + relaunches.
// Pinned to the top via position:fixed so it overlays without reflowing the workspace layout.
//
// THE COPY IS PART OF THE FIX, NOT DECORATION (bead sparkle-1ueh3). This banner used to say the
// update was "ready — restart to apply now, or it'll apply on next launch", and label the dismiss
// button "On next launch". Both described the OLD design, where downloadAndInstall() had ALREADY
// replaced /Applications/Sparkle.app under the running process — which is precisely the bug: that
// swap silently kills the running process's microphone for the rest of its life. Now nothing is
// installed until the user restarts (or the app is asked to exit through a path the quit hook
// covers — ⌘Q included since the app menu's Quit item routes through `AppHandle::exit`, but NOT a
// last-window-destroyed quit or a Force Quit; see updaterService's header). So the banner makes
// exactly ONE claim, the only one the implementation can keep: the bytes are downloaded, and
// restarting installs them. "Later" promises nothing, because promising an automatic apply would be
// false for any user who force-quits.
//
// THE QUIT-TIME BAR IS A SAFETY FEATURE (roborev, bead sparkle-1ueh3). Installing on the way out
// takes multiple SECONDS with the window still on screen, and it used to produce no UI at all —
// only log lines. A user pressing ⌘Q into an apparently frozen app presses it again, and that
// second press used to kill the process between the updater's `remove_dir_all` and its final
// rename, leaving /Applications/Sparkle.app DELETED. Rust now refuses that second exit; this bar is
// the half that stops the user reaching for it. It renders THROUGH a dismissal and outranks every
// other state here, because "Later" was about a notification, not consent to a silent freeze.
//
// DISMISSAL DECAYS. It used to be permanent for the session, and the updater's phase guard stops
// `setReady` from ever firing again once something is staged — so one click silenced the update
// entirely, with no second event able to bring it back. The store now records WHEN it was dismissed
// and the updater's next poll clears it (updaterService: DISMISS_TTL_MS / expireDismissal).

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
  fontFamily: FONT_UI,
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
  fontFamily: FONT_UI,
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
  fontFamily: FONT_UI,
  cursor: "pointer",
};

export function UpdateBanner() {
  const phase = useUpdaterStore((s) => s.phase);
  const version = useUpdaterStore((s) => s.version);
  const dismissedAt = useUpdaterStore((s) => s.dismissedAt);
  const busy = useUpdaterStore((s) => s.busy);
  const quitInstalling = useUpdaterStore((s) => s.quitInstalling);
  const dismiss = useUpdaterStore((s) => s.dismiss);

  // FIRST, and past every other guard including the dismissal: the app is quitting and the bundle
  // on disk is being replaced right now. No buttons — there is nothing left to choose, and the one
  // gesture we must not invite is another quit.
  if (quitInstalling) {
    return (
      <div role="status" aria-live="assertive" style={bar}>
        <FiRefreshCw aria-hidden size={16} style={{ color: C.accentInk, flex: "0 0 auto" }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          {version ? `Installing update ${version}…` : "Installing update…"} Sparkle will quit on
          its own — please don't force it.
        </span>
      </div>
    );
  }

  if (dismissedAt !== null || (phase !== "available" && phase !== "ready")) return null;

  const ready = phase === "ready";
  const message = ready
    ? `Update ${version} downloaded — restart to install it now.`
    : `Update ${version} available.`;
  const applyLabel = ready ? "Restart now" : "Restart to apply";
  const dismissLabel = "Later";

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
