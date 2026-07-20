// One-time roborev consent modal. roborev (the per-commit AI code-review daemon) defaults ON, but
// before it reviews anything we ask the user once — the first time a BUILD agent produces a
// reviewable commit (runtimeStore flips settingsStore.roborevConsentOpen). Whichever button they
// press, we set roborev.consent_prompted = true so this never appears again.
//
//   • Enable  → keep roborev on: install the daemon + wire every project's git hooks.
//   • Not now → turn roborev off: it stays dormant behind the Tools toggle until re-enabled.
//
// Mounting is controlled by settingsStore.roborevConsentOpen (App.tsx renders this once, globally).
import { useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import { ModalShell } from "./ModalShell";
import { useSettingsStore } from "../stores/settingsStore";
import { markRoborevConsentPrompted, setRoborevEnabled } from "../services/configActions";

export function RoborevConsentModal() {
  const open = useSettingsStore((s) => s.roborevConsentOpen);
  const setOpen = useSettingsStore((s) => s.setRoborevConsentOpen);
  // Guard against a double-click racing the two async writes: disable both buttons once a choice is
  // in flight. The modal unmounts as soon as `open` flips false, so this only matters mid-await.
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const choose = async (enable: boolean) => {
    if (busy) return;
    setBusy(true);
    // Either choice records that we've prompted (so it never shows again), then applies the toggle.
    await markRoborevConsentPrompted();
    await setRoborevEnabled(enable);
    setOpen(false);
  };

  // Escape / backdrop click is NOT a silent dismissal — treat it as "Not now" so we still record
  // consent_prompted and disable roborev, honoring the locked UX (never prompt again either way).
  const cancel = () => void choose(false);

  return (
    <ModalShell width={440} zIndex={300} onCancel={cancel}>
      <h2 style={{ margin: "0 0 10px", fontSize: 18, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        Turn on roborev code review?
      </h2>
      <p style={{ margin: "0 0 18px", fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>
        roborev runs a quick AI review of each commit your BUILD agents make, using your existing
        Claude login — nothing else is sent anywhere. You can turn it off anytime in Tools.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          style={{
            background: "transparent",
            border: `1px solid ${C.forest}`,
            color: C.muted,
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 13.5,
            fontFamily: '"IBM Plex Sans", sans-serif',
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Not now
        </button>
        <button
          type="button"
          onClick={() => void choose(true)}
          disabled={busy}
          style={{
            background: C.accentInk,
            border: "none",
            color: C.deepForest,
            borderRadius: 8,
            padding: "9px 18px",
            fontSize: 13.5,
            fontWeight: FONT_WEIGHT.semibold,
            fontFamily: '"IBM Plex Sans", sans-serif',
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          Enable
        </button>
      </div>
    </ModalShell>
  );
}
