import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TrayDashboard } from "./TrayDashboard";
import { bucketCounts, drawTrayIcon } from "./trayIcon";
import type { TrayRoster } from "./trayRoster";
import { getTrayRoster, onTrayRosterChanged, setTrayImage, emitFocusAgent } from "../services/attention";
import { safeUnlisten } from "../services/safeUnlisten";

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

  return (
    <div style={{ height: "100vh", overflowY: "auto" }}>
      <TrayDashboard
        roster={roster}
        now={now}
        onOpen={(projectId, agentId) => {
          emitFocusAgent({ projectId, agentId });
          void getCurrentWindow().hide();
        }}
      />
    </div>
  );
}
