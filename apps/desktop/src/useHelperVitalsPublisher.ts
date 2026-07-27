// Publishes the authoritative P0/P1 counts to the floating helper island (spec §4.5).
//
// The island CANNOT compute these itself: useConciergeFeed depends on useRuntimeStore, which is
// per-window and not persisted, so a separate webview would start empty and render numbers that
// disagree with the app. The main window computes them once and pushes.
//
// Mounted in App.tsx beside useRosterPublisher — NOT in ConciergeHost, which lives inside
// Workspace and unmounts when no project is open. The island must keep showing correct counts
// regardless of what the main window happens to be displaying.
import { useEffect, useRef } from "react";
import { useConciergeFeed } from "./useConciergeFeed";
import { publishHelperVitals } from "./services/helper";

export function useHelperVitalsPublisher(): void {
  const feed = useConciergeFeed();
  // The island follows the WHOLE fleet, so this is `counts`, not `scopedCounts` — the concierge
  // column uses the scoped variant because it respects the pinned tab; the island does not.
  const { p0, p1 } = feed.counts;
  // Only push on CHANGE. The feed memo recomputes on many inputs that don't move the counts, and
  // each publish is a main-thread Tauri IPC.
  const last = useRef<{ p0: number; p1: number } | null>(null);

  useEffect(() => {
    if (last.current && last.current.p0 === p0 && last.current.p1 === p1) return;
    last.current = { p0, p1 };
    publishHelperVitals(p0, p1);
  }, [p0, p1]);
}
