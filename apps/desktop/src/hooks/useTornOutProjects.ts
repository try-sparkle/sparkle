// React's view of the satellite ownership map (services/satelliteWindows).
//
// Subscribing rather than polling matters: the main window has to drop a torn-out project's panes
// in the SAME commit the claim lands, because that unmount is what kills the PTYs the satellite is
// about to respawn. A `useEffect`-driven poll would leave a window where both webviews mount the
// same agent.

import { useMemo, useSyncExternalStore } from "react";
import {
  onSatellitesChange,
  parseSnapshot,
  satellitesSnapshot,
  type SatelliteMap,
} from "../services/satelliteWindows";

/** Server snapshot for SSR/prerender — this app never server-renders, but React demands one when
 *  the hook is reached outside the browser (jsdom tests without localStorage included). */
const emptySnapshot = () => "";

/** The ownership map, live. */
export function useSatelliteMap(): SatelliteMap {
  const raw = useSyncExternalStore(onSatellitesChange, satellitesSnapshot, emptySnapshot);
  return useMemo(() => parseSnapshot(raw), [raw]);
}

/** Just the ids — what the pane gate subtracts. Includes projects whose tear-off is still PENDING
 *  (no window yet), which is the point: main must let go before the satellite arrives. */
export function useTornOutProjects(): Set<string> {
  const map = useSatelliteMap();
  return useMemo(() => new Set(Object.keys(map)), [map]);
}
