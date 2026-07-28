// useDisplayRespan — re-apply the window span when displays are plugged in or unplugged.
//
// Lives at the App level rather than in the Settings pane on purpose: the pane is usually closed
// when a cable moves, and that is exactly when this matters. Unplugging a monitor while spanned
// otherwise leaves the window at a geometry no remaining display can show, sometimes with its
// title bar off-screen entirely.
import { useEffect } from "react";
import { onDisplaysChanged, spanWindow } from "../services/displaySpan";
import { safeUnlisten } from "../services/safeUnlisten";
import { useSettingsStore } from "../stores/settingsStore";

export function useDisplayRespan(): void {
  useEffect(() => {
    // Read the store inside the handler, not as hook deps: re-subscribing on every settings change
    // would drop and recreate the listener, and the values are only needed at fire time anyway.
    const pending = onDisplaysChanged(() => {
      const { windowAutoRespan, windowIsSpanned, windowSpanMode } = useSettingsStore.getState();
      // BOTH gates are required. `windowAutoRespan` is the user's preference; `windowIsSpanned`
      // keeps this from stretching a window they never spanned — attaching a monitor must not
      // resize a deliberately small window.
      if (!windowAutoRespan || !windowIsSpanned) return;
      // Best-effort: a failed re-span leaves the window where it is, which is recoverable via
      // Appearance → Window → Reset to default size.
      void spanWindow(windowSpanMode).catch(() => {});
      // The trailing `.catch` is load-bearing: `listen` REJECTS when there is no Tauri IPC (a jsdom
      // render, a window mid-teardown), and this promise is not awaited until cleanup runs — so
      // without it the rejection escapes as an app-level unhandled error.
    }).catch(() => undefined);
    return () => void safeUnlisten(pending);
  }, []);
}
