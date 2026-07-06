import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { C } from "@sparkle/ui";
import { TrayDashboard } from "./TrayDashboard";
import { TrayHeader, TrayFooter } from "./TrayChrome";
import { bucketCounts, drawTrayIcon } from "./trayIcon";
import type { TrayRoster } from "./trayRoster";
import { getTrayRoster, onTrayRosterChanged, setTrayImage, emitFocusAgent } from "../services/attention";
import { safeUnlisten } from "../services/safeUnlisten";
import { captureScreenRegion, showCaptureWindow } from "../screenshot";

const EMPTY: TrayRoster = { projects: [], counts: { red: 0, grey: 0, green: 0 } };

// Allocates a fresh offscreen canvas per repaint (sized by drawTrayIcon) and sends the result to Tauri.
function paintTrayIcon(roster: TrayRoster): void {
  try {
    const counts = bucketCounts(roster);
    const scale = Math.max(1, Math.round(window.devicePixelRatio || 1) * 2);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawTrayIcon(ctx, counts, scale);
    if (typeof canvas.toDataURL !== "function") return;
    const dataUrl = canvas.toDataURL("image/png");
    setTrayImage(dataUrl.replace(/^data:image\/png;base64,/, ""));
  } catch {
    // Canvas may be unavailable in jsdom / smoke-test environments — silently skip.
  }
}

export function TrayApp() {
  const [roster, setRoster] = useState<TrayRoster>(EMPTY);
  const [now, setNow] = useState(() => Date.now());
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  // Synchronous re-entrancy guard: `captureBusy` state is read from the render closure, so two
  // clicks landing before a re-render could both pass a state-only check. The ref flips
  // immediately; the state only drives the disabled visual.
  const captureBusyRef = useRef(false);

  // Live roster: seed once, then follow the aggregator's pushes. Repaint the menu-bar icon on each.
  useEffect(() => {
    let alive = true;
    void getTrayRoster().then((r) => { if (alive && r) { setRoster(r); paintTrayIcon(r); } });
    const un = onTrayRosterChanged((r) => { setRoster(r); paintTrayIcon(r); });
    return () => { alive = false; safeUnlisten(un); };
  }, []);

  // Shared 1s clock so every elapsed timer ticks together.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Menu-bar-extra behavior: hide the popover when it loses focus.
  useEffect(() => {
    const p = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) void getCurrentWindow().hide();
    });
    return () => { void safeUnlisten(p); };
  }, []);

  const hide = () => void getCurrentWindow().hide();

  // Capture flow (spec §3): hide the popover FIRST so it isn't in the shot, then the native
  // crosshair picker; null = user Esc'd at the crosshairs — silently done. Otherwise hand the
  // shot to the dedicated capture window. The button stays disabled until the whole sequence
  // settles (including invoke failure).
  const capture = async () => {
    if (captureBusyRef.current) return;
    captureBusyRef.current = true;
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      await getCurrentWindow().hide();
      const shot = await captureScreenRegion();
      if (shot) await showCaptureWindow(shot);
    } catch (e) {
      console.error("tray: capture flow failed", e);
      // Spec §9: a failed capture must not be indistinguishable from an Esc — the popover is
      // already hidden, so re-show it with a one-line notice. The copy hedges: any of the
      // three awaits can throw, but TCC Screen Recording denial is the expected first-run one.
      setCaptureError("Capture failed — if this is your first capture, check Screen Recording in System Settings.");
      void getCurrentWindow().show().catch((err) => console.error("tray: failed to re-show popover", err));
    } finally {
      captureBusyRef.current = false;
      setCaptureBusy(false);
    }
  };

  // Pinned header (logo + balance + Recent/Open/New/Capture) and footer (Quit), with the agent
  // dashboard scrolling between them. background on the root so the (deepForest) chrome and
  // (forest) list share one surface with no gaps.
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: C.forest }}>
      <TrayHeader onAction={hide} onCapture={() => void capture()} captureBusy={captureBusy} captureError={captureError} />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <TrayDashboard
          roster={roster}
          now={now}
          onOpen={(projectId, agentId, promptId) => {
            emitFocusAgent({ projectId, agentId, promptId });
            hide();
          }}
        />
      </div>
      <TrayFooter />
    </div>
  );
}
