// THE LIVE WINDOW WIDTH, for bounds that must not outlive the window they were computed against.
//
// Column maxima are clamped against this (see `engine/columnResize.windowAwareMax`): a ceiling fixed
// at author time lets a column be dragged — or RESTORED from localStorage — wider than the window,
// which puts its own resize handle past the viewport edge with no way back (roborev 55847).
//
// Read once at mount and on `resize`. A Tauri window fires `resize` for the native frame the same way
// a browser does, so no Tauri-specific listener is needed; components that need the CONTAINER rather
// than the window measure their own element instead (AgentSidebar does this for its overlay).
import { useEffect, useState } from "react";

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    // Re-read on mount: the window can have changed between the initializer and the effect (a restored
    // window, a display change), and a stale first value here is a stale CLAMP.
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}
