// The mounted column's notice row, as ONE hook instead of three declarations scattered down
// ConciergeHost — the state, the writer every caller uses, and the release effect that retires a
// notice with the mount it describes.
//
// WHY THIS IS A HOOK AND NOT THREE LINES IN THE HOST. The three pieces are a single rule (a notice
// belongs to a mount and dies with it) that was spelled 560 lines apart in the app's highest-churn
// file, so an agent changing one had no reason to see the others. Together they are also testable
// without mounting the host.
//
// ORDERING, WHICH IS LOAD-BEARING IN THAT FILE: the release effect keeps its exact position among
// the host's effects — it is called where the effect used to be declared, not where the state was.
// Nothing between the two positions reads `mountedNotice` or calls `noteMounted`, so no consumer
// moves relative to its producer, and no OTHER effect changes order relative to this one.
import { useCallback, useEffect, useState } from "react";
import type { MountedNoticeModel } from "../components/Concierge/MountedNotice";

export interface MountedNoticeApi {
  mountedNotice: MountedNoticeModel | null;
  noteMounted: (text: string, tone: "warn" | "info") => void;
}

/**
 * @param mountedAgentId The DISPLAY mount's agent id, or null when nothing is mounted.
 */
export function useMountedNotice(mountedAgentId: string | null): MountedNoticeApi {
  // ══ WHAT A MOUNTED COLUMN CAN STILL SHOW (roborev 57360) ════════════════════════════════════════
  // Mounted, the column renders the AGENT's transcript and does not render `ConciergeThread` at all —
  // so `postSparkle` writes into a component that is off screen. This is the sibling row that stays
  // (Concierge/MountedNotice), and it carries the outcomes that would otherwise be invisible in the
  // exact state the mounted-composer feature exists for.
  //
  // `{ seq, text, tone }` and a bump per write, for the same reason `announcement` is not a bare
  // string: refusing TWICE FOR THE SAME REASON is the common case here — the founder retypes and hits
  // the same `vim` — and an `Object.is`-equal setState would render the second refusal as no change.
  const [mountedNotice, setMountedNotice] = useState<MountedNoticeModel | null>(null);
  const noteMounted = useCallback((text: string, tone: "warn" | "info") => {
    setMountedNotice((prev) => ({ seq: (prev?.seq ?? 0) + 1, text, tone }));
  }, []);
  // THE NOTICE DIES WITH THE MOUNT IT DESCRIBES. Left standing after an unmount it asserts a state
  // that is over, which is the same stale signal the unmount hint is gated to avoid. Keyed on the
  // DISPLAY mount for the same reason the writes are — that is when the row is on screen — and on
  // the id rather than a boolean, so moving the cable between agents also clears the previous
  // agent's line rather than attributing it to the new one.
  useEffect(() => {
    setMountedNotice(null);
  }, [mountedAgentId]);

  return { mountedNotice, noteMounted };
}
