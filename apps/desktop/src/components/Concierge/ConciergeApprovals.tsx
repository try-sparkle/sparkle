// The container that connects the approval PROMPT to the approval LEDGER.
//
// Split from ApprovalPrompt for the reason every card in this column is split from its wiring: the
// card stays a pure function of props (renderable in a test with three lines of setup), and the
// store subscription, the expiry tick and the config write live here. ConciergeHost mounts this as
// the column's `approvalSlot`, exactly as it mounts CountdownBanner as `countdownSlot`.
//
// THE HUMAN GESTURE PASSES THROUGH HERE AND NOWHERE ELSE. `approveApproval` has one caller in the
// app and it is the click handler below.
//
// APPROVING ALSO RUNS THE CALL. It did not used to, and the gap was invisible: the click recorded a
// grant, the card vanished (it is no longer `pending`), and nothing else happened anywhere. Running
// it depended on the human separately typing "go ahead" within the 5-minute grant window AND the
// model retyping every argument byte-identically — so an approved call routinely expired unspent
// while the concierge went on saying it was waiting for a go-ahead it already had. The replay lives
// in `services/conciergeApprovalResume`; see its header for why this is narrower, not wider, than
// the retry path it replaces.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  describeResumeOutcome,
  resumeApprovedCall,
  type ApprovalResumeOutcome,
} from "../../services/conciergeApprovalResume";
import { setConciergeToolPolicy } from "../../services/configActions";
import {
  approveApproval,
  denyApproval,
  pendingApprovals,
  useConciergeApprovals,
  type ConciergeApproval,
} from "../../stores/conciergeApprovals";
import { setConciergeChat } from "../../stores/conciergeThreadStore";
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

  /**
   * The click: record the grant, RUN the call, then say what happened.
   *
   * Order is load-bearing. `approveApproval` must land first, because the replay is authorised by
   * the ledger through the ordinary policy path (`claimApproval` by tool-call id) — dispatching
   * before the entry is `approved` would be refused, correctly, as still needing approval.
   *
   * A false return means the entry was not live `pending` (already answered, or its window closed
   * while it sat on screen). Nothing is dispatched in that case: an expired question is not consent.
   *
   * That branch STILL OWES A SENTENCE, and it is reachable: `pending` is recomputed only when the
   * ledger changes or on the {@link EXPIRY_TICK_MS} tick, so a lapsed card stays on screen and
   * clickable for up to ten seconds. Returning quietly there would rebuild the exact failure this
   * whole change exists to remove — a click that makes the card vanish and does nothing, with no way
   * to tell that from success.
   */
  const runApproved = useCallback(async (approval: ConciergeApproval) => {
    if (!approveApproval(approval.id)) {
      say(
        approval.id,
        `That request for ${approval.domain}.${approval.op} had already lapsed, so I didn't run it. Ask me again and I'll re-raise it.`,
      );
      return;
    }
    let outcome: ApprovalResumeOutcome;
    try {
      outcome = await resumeApprovedCall(approval);
    } catch {
      // resumeApprovedCall is total; this is belt-and-braces so a click handler can never reject.
      outcome = { kind: "unauthorized" };
    }
    // ALWAYS report, including on success. The silence after a click is what made this bug
    // invisible for so long — "ran" and "quietly expired" looked exactly the same from here.
    say(approval.id, describeResumeOutcome(approval, outcome));
  }, []);

  const onApprove = useCallback(
    (approval: ConciergeApproval) => {
      void runApproved(approval);
    },
    [runApproved],
  );

  const onAlwaysAllow = useCallback(
    (approval: ConciergeApproval) => {
      // Write the SETTINGS override first, so the standing permission exists as a visible, revocable
      // row in Settings → Concierge tools rather than as an invisible session grant. Then answer the
      // call in hand — the human plainly consented to this one, and leaving it pending would make
      // "always allow" the one button that doesn't unblock what you were asked about.
      void setConciergeToolPolicy(approval.op, "allow");
      void runApproved(approval);
    },
    [runApproved],
  );

  return (
    <ApprovalPrompt
      approvals={pending}
      onApprove={onApprove}
      onDecline={denyApproval}
      onAlwaysAllow={onAlwaysAllow}
    />
  );
}

/** Append one Sparkle bubble to the visible thread.
 *
 *  Written straight to the thread store rather than routed through a concierge TURN on purpose:
 *  this is a receipt for something the human just did, not the brain speaking. Spending a `claude -p`
 *  turn to narrate a completed action would cost a round trip to say something already known. */
function say(approvalId: string, text: string): void {
  // Keyed off the approval's own id, which is unique per call and spendable exactly once — so a
  // receipt cannot collide with another, and a double-click cannot produce two identical bubbles.
  setConciergeChat((prev) => [
    ...prev,
    { id: `approval-ran:${approvalId}`, kind: "sparkle" as const, text },
  ]);
}
