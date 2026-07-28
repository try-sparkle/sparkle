// The container that connects the approval PROMPT to the approval LEDGER.
//
// Split from ApprovalPrompt for the reason every card in this column is split from its wiring: the
// card stays a pure function of props (renderable in a test with three lines of setup), and the
// store subscription, the expiry tick and the config write live here. ConciergeHost mounts this as
// the column's `approvalSlot`, exactly as it mounts CountdownBanner as `countdownSlot`.
//
// THE HUMAN GESTURE PASSES THROUGH HERE AND NOWHERE ELSE. `approveApproval` has one caller in the
// app and it is the click handler below.
import { useEffect, useMemo, useState } from "react";

import { setConciergeToolPolicy } from "../../services/configActions";
import {
  approveApproval,
  denyApproval,
  pendingApprovals,
  useConciergeApprovals,
  type ConciergeApproval,
} from "../../stores/conciergeApprovals";
import { ApprovalPrompt } from "./ApprovalPrompt";

/**
 * How often the list re-checks its own deadlines.
 *
 * A request LAPSES on a wall-clock deadline, and nothing writes to the store when that moment
 * arrives — so without a tick a card whose window has closed would sit on screen looking answerable
 * until the next unrelated store write. Ten seconds is far finer than the ten-minute window and
 * costs one render only while something is actually pending.
 */
const EXPIRY_TICK_MS = 10_000;

export function ConciergeApprovals() {
  // Subscribe to the STABLE array and filter in a memo. Selecting a filtered array directly would
  // return a fresh reference on every store read, which is how a zustand selector turns into a
  // render loop.
  const entries = useConciergeApprovals((s) => s.entries);
  const [tick, setTick] = useState(0);
  const anyPending = entries.some((e) => e.outcome === "pending");

  useEffect(() => {
    // No timer when there is nothing to expire — this component stays mounted for the life of the
    // column, and an unconditional interval would re-render it forever for nothing.
    if (!anyPending) return;
    const h = setInterval(() => setTick((t) => t + 1), EXPIRY_TICK_MS);
    return () => clearInterval(h);
  }, [anyPending]);

  const pending = useMemo(
    () => pendingApprovals(entries),
    // `tick` is a deliberate dependency: it is the only thing that changes when a deadline passes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, tick],
  );

  const onAlwaysAllow = (approval: ConciergeApproval) => {
    // Write the SETTINGS override first, so the standing permission exists as a visible, revocable
    // row in Settings → Concierge tools rather than as an invisible session grant. Then answer the
    // call in hand — the human plainly consented to this one, and leaving it pending would make
    // "always allow" the one button that doesn't unblock what you were asked about.
    void setConciergeToolPolicy(approval.op, "allow");
    approveApproval(approval.id);
  };

  return (
    <ApprovalPrompt
      approvals={pending}
      onApprove={approveApproval}
      onDecline={denyApproval}
      onAlwaysAllow={onAlwaysAllow}
    />
  );
}
