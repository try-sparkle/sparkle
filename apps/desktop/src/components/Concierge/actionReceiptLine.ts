// The SENTENCE a concierge action receipt reads as, in the thread (bead sparkle-kr2jz part B).
//
// ══ WHY IT IS PURE AND LIVES APART FROM THE HOST ════════════════════════════════════════════════
// Same reason `RoutingReceipt.receiptText` is: the wording is a CORRECTNESS concern, not styling.
// A receipt exists so the founder can check a claim rather than believe it, so a line that
// overstates what happened defeats the feature more thoroughly than having no line at all. Pure
// means it is pinned by unit tests instead of by good intentions.
//
// ══ THE RULES THE WORDING MUST HOLD ═════════════════════════════════════════════════════════════
//
// 1. NEVER CLAIM MORE THAN THE TOOL REPORTED. `ok` comes from the dispatch reply's own flag, and a
//    refused call still gets a line. "I couldn't" is the answer to "why didn't it do the thing I
//    asked" — the question the founder kept having to ask — so suppressing a refusal would rebuild
//    the silence this feature exists to end. There is precedent for the opposite failure: a settle
//    that assumed success once reported a REFUSED merge as "Merged PR #753".
//
// 2. AN INBOX SEND IS NOT A TERMINAL SEND, AND THE LINE MUST SAY WHICH. A terminal write lands in
//    the agent's PTY now; an inbox message sits queued and is invisible everywhere until that agent
//    reaches its next turn boundary (bead sparkle-zm0c8). The founder has already been burned by
//    exactly this ambiguity — "You said there was a message in the inbox … but I didn't see any
//    sort of new output" — and he was right both times: the message WAS sent, and there WAS nothing
//    to see. So the inbox line states the delay as part of the claim rather than leaving him to
//    discover it.
//
// 3. NAME THE SUBJECT AS A PILL WHENEVER THERE IS AN ID. "You said it's up. But I can't actually
//    click on it" is a recorded complaint about this exact gap. `ref()` degrades to plain words on
//    its own when the id is unusable, so this module never has to guess — and never invents a
//    reference, because a pill carrying a wrong id opens the wrong agent and the reader cannot tell.

import { bead, line, plain, ref, type Line } from "./conciergeLine";
import type { ConciergeActionReceipt } from "../../services/conciergeReceipts";

/** The agent lookup the host supplies — the FEED's view, so a pill's id is one the app can open.
 *  Returning null means unresolved, and unresolved must degrade to words rather than to a guess. */
export type ResolveReceiptAgent = (id: string) => { id: string; name: string } | null;

/** The subject slot: a pill when the agent resolves, the words the app used before pills otherwise. */
function who(receipt: ConciergeActionReceipt, resolve: ResolveReceiptAgent) {
  const found = receipt.agentId ? resolve(receipt.agentId) : null;
  if (found) return ref(found);
  // `agentName` is what the TOOL CALL said, so it is worth showing even with no id to open — it is
  // still more useful than "that agent". It just cannot be a pill.
  const named = receipt.agentName?.trim();
  return plain(named ? named : "that agent");
}

/**
 * The receipt's sentence, or `null` when this receipt should not post a line at all.
 *
 * Returns a {@link Line} so the thread gets pills and the live region gets a flat sentence, both
 * built from the same slots and therefore unable to drift.
 */
export function actionReceiptLine(
  receipt: ConciergeActionReceipt,
  resolve: ResolveReceiptAgent,
): Line | null {
  if (!receipt || typeof receipt.kind !== "string") return null;
  const subject = who(receipt, resolve);
  // A FAN-OUT, decided by the CLASSIFIER (which sees domain/op) and merely read here.
  //
  // roborev 57888 (Medium). The first version inferred this from "no resolvable subject", which is
  // not the same question: `send_to_agent_terminal` is the ONLY producer of a terminal `sent`
  // receipt and always carries an `agentId`, so a subject-less terminal send can only be a SINGLE
  // send whose id failed to parse — and calling that "several agents" overstates, inverting rule 1,
  // the very failure this module exists to prevent. Plurality is now carried, not guessed, and the
  // terminal fan-out branch is gone because no producer can generate one.
  const fanout = receipt.fanout === true;
  const hasCounts = typeof receipt.queued === "number" && typeof receipt.failed === "number";

  // ══ THE REFUSAL ARM, FIRST ════════════════════════════════════════════════════════════════════
  // Checked before the success wording below, exactly as `receiptText` checks `refused` before its
  // target line: the receipt still names a subject, and running that name through "Spawned X" would
  // report an action that did not happen.
  if (!receipt.ok) {
    const why = receipt.reason?.trim();
    const tail = why ? plain(` — ${why}`) : plain("");
    switch (receipt.kind) {
      case "spawned":
        return line`Couldn't spawn that agent${tail}`;
      case "sent":
        // THE REFUSAL ARM NEEDS THE PLURAL TOO (roborev 57888). `inboxBroadcast` refuses with
        // `no-recipients` and `broadcast-failed`, both subject-less — so this rendered "Not sent to
        // that agent", the identical misstatement the success arm was fixed for, still live on the
        // path where the message did NOT go out.
        return fanout
          ? line`Not sent to those agents${tail}`
          : line`Not sent to ${subject}${tail}`;
      case "closed":
        return line`Couldn't close ${subject}${tail}`;
      case "goal":
        return line`Couldn't set a goal on ${subject}${tail}`;
      case "filed":
        return line`Couldn't file that${tail}`;
      case "merged":
        return line`Didn't merge${tail}`;
      default:
        return null;
    }
  }

  switch (receipt.kind) {
    case "spawned":
      return line`Spawned ${subject}.`;

    case "sent": {
      // A BROADCAST HAS NO SINGLE RECIPIENT, and must not be described as though it did.
      //
      // roborev 57866: `fleet.inbox_broadcast` carries `agentIds`, not `agentId`, so `subject`
      // degraded to "that agent" and a message sent to N agents read as one. Understating a fan-out
      // is as untrue as overstating a single send.
      if (fanout && hasCounts) {
        const queued = receipt.queued ?? 0;
        const failed = receipt.failed ?? 0;
        // A PARTIAL FAILURE IS NOT A DELIVERY (roborev 57888). `inboxBroadcast` returns an OK reply
        // holding `{queued, failed}` even when some inboxes rejected the message, so keying only on
        // `ok` claimed delivery the tool never reported — the "Merged PR #753" shape again.
        if (failed > 0) {
          return line`Left a message for ${plain(String(queued))} agent${plain(queued === 1 ? "" : "s")} — ${plain(String(failed))} couldn't be reached.`;
        }
        return line`Left a message for ${plain(String(queued))} agent${plain(queued === 1 ? "" : "s")} — it delivers at each one's next turn.`;
      }
      // A broadcast with NO counts — its refusal arms carry no data — still reads plural, because
      // `fanout` came from the op rather than from the absent subject. A single `inbox_send` whose
      // args were refused is subject-less too, and it correctly stays singular (roborev 57905).
      if (receipt.channel === "inbox") {
        // RULE 2. The inbox arm states the DELAY, because the delay is the whole reason the founder
        // could not find the message he had been told about.
        return fanout
          ? line`Left a message for several agents — it delivers at each one's next turn.`
          : line`Left ${subject} a message — it delivers at their next turn.`;
      }
      return line`Sent to ${subject}'s terminal.`;
    }

    case "closed":
      return line`Closed ${subject}.`;

    case "goal":
      return line`Set a goal on ${subject}.`;

    case "filed": {
      // `bead()` degrades to plain text on a malformed id, so an unusable id costs the pill and not
      // the line — the receipt still records that something was filed.
      const id = receipt.beadId?.trim();
      return id ? line`Filed ${bead({ id })}.` : line`Filed a task.`;
    }

    case "merged": {
      const n = receipt.prNumber;
      return Number.isFinite(n) ? line`Merged PR #${plain(String(n))}.` : line`Merged.`;
    }

    default:
      // An unrecognized kind posts NOTHING rather than a line the app cannot phrase. Silence is the
      // safe failure here: this module's whole contract is that a line means the thing happened.
      return null;
  }
}
