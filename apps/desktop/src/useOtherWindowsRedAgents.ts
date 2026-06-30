// Selector hook for the cross-window red-agents sidebar section. Subscribes to the windowStatus
// channel (Tauri `sparkle://status-changed` + a `storage` listener) and returns this window's view
// of the red agents living in OTHER open windows, sorted by attention rank. Returns [] when none.
import { useCallback, useSyncExternalStore } from "react";
import { parseWindowLabelFromSearch } from "./services/projectWindows.url";
import {
  subscribeWindowStatus,
  getOtherWindowsSnapshot,
  type OtherWindowAgent,
} from "./services/windowStatus";

/** This window's opaque label, derived from the URL the same way CurrentProjectProvider does (the
 *  initial window has no `?label=` → "main"). Read directly from the URL rather than the provider
 *  context so the selector works wherever AgentSidebar renders (incl. provider-less unit tests).
 *  INVARIANT: this MUST match the label the publish side (useAttentionNotifications, via the provider's
 *  useCurrentWindowLabel) writes — both route through `parseWindowLabelFromSearch(...) ?? "main"`, so
 *  they cannot drift; otherwise this window's own entry wouldn't be excluded from the block. */
function selfWindowLabel(): string {
  const search = typeof window !== "undefined" ? window.location.search : "";
  return parseWindowLabelFromSearch(search) ?? "main";
}

/** Parameterized form (explicit self label) — exported for tests that drive a known label. */
export function useOtherWindowsRedAgentsFor(selfLabel: string): OtherWindowAgent[] {
  const getSnapshot = useCallback(() => getOtherWindowsSnapshot(selfLabel), [selfLabel]);
  return useSyncExternalStore(subscribeWindowStatus, getSnapshot, getSnapshot);
}

/** The public selector: red agents from other open windows, for THIS window. */
export function useOtherWindowsRedAgents(): OtherWindowAgent[] {
  return useOtherWindowsRedAgentsFor(selfWindowLabel());
}
