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
//    THE LINE IS UNCONDITIONAL; ITS TAIL IS NOT. Every refusal still posts a row — that half is
//    absolute, and it is what keeps a receipt able to contradict a turn claiming the action
//    succeeded. What varies is the REASON TEXT: a refusal addressed to the concierge (a review gate,
//    running checks, no free agent slot) shows a short gist instead of the tool's paragraphs, which
//    the founder read as a wall of red about work that was fine. Anything unrecognised, anything
//    with no reason, and anything only he can clear keeps its words verbatim. See
//    ./refusalAudience, which owns that split and defaults to showing.
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
import { refusalGist } from "./refusalAudience";
import type { ConciergeActionReceipt } from "../../services/conciergeReceipts";
import type { ConciergeReceiptMark } from "./types";

/** The agent lookup the host supplies — the FEED's view, so a pill's id is one the app can open.
 *  Returning null means unresolved, and unresolved must degrade to words rather than to a guess. */
export type ResolveReceiptAgent = (
  id: string,
) => { id: string; name: string } | null;

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
 * What the posted line REMEMBERS about the receipt behind it — the mark that lets a run of identical
 * receipts fold to one row (./receiptRuns).
 *
 * ══ WHY IT LIVES HERE, BESIDE THE SENTENCE ══════════════════════════════════════════════════════
 * Because the subject must be the SAME subject. `who()` above decides whether the sentence gets a
 * clickable pill or degrades to words, and the folded row has to make the identical call — a fold
 * that named an agent its unfolded rows could not, or minted a pill where they showed plain text,
 * would be a reference the reader can click to nowhere. Sharing the module means sharing `resolve`
 * and the one rule, rather than restating it somewhere it can drift.
 *
 * ══ EVERY FIELD IS COPIED, NONE IS DERIVED ══════════════════════════════════════════════════════
 * `ok`, `failed`, `fanout` and `viaPicker` come straight off the receipt, because the fold rule
 * turns on them: a mark that inferred `ok` from the wording could fold a REFUSAL into a success
 * count, which is the single outcome folding must never produce.
 */
export function receiptMark(
  receipt: ConciergeActionReceipt,
  resolve: ResolveReceiptAgent,
): ConciergeReceiptMark {
  const found = receipt.agentId ? resolve(receipt.agentId) : null;
  return {
    kind: receipt.kind,
    ok: receipt.ok === true,
    channel: receipt.channel,
    fanout: receipt.fanout,
    viaPicker: receipt.viaPicker,
    failed: receipt.failed,
    // A SUCCESS CAN STILL CARRY SOMETHING THE READER HAS TO ACT ON. `reason` on an `ok` receipt is
    // the spawn shortfall — the agent is up but unbriefed — and the success arm below renders it as
    // a second sentence. Marked here so `foldKeyOf` can refuse the row: a count cannot say it, so
    // folding would delete it. Read off the SAME field that arm reads, so the two cannot disagree
    // about whether this line says more than its standard wording.
    ...(receipt.ok === true && receipt.reason?.trim()
      ? { hasDetail: true as const }
      : {}),
    // ONLY WHEN THE LOOKUP HIT. A `subjectId` present means the sentence drew a real pill, so the
    // fold may draw one too; absent means it did not, and the fold shows the same words it did.
    subjectId: found ? found.id : undefined,
    subjectName: found ? found.name : receipt.agentName?.trim() || undefined,
  };
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
  const hasCounts =
    typeof receipt.queued === "number" && typeof receipt.failed === "number";

  // ══ THE REFUSAL ARM, FIRST ════════════════════════════════════════════════════════════════════
  // Checked before the success wording below, exactly as `receiptText` checks `refused` before its
  // target line: the receipt still names a subject, and running that name through "Spawned X" would
  // report an action that did not happen.
  if (!receipt.ok) {
    // ══ AN INTERNAL GATE IS NOT THREAD MATERIAL (the founder's 2026-08-12 question) ═════════════
    //
    // "This didn't merge refuse stuff is about, and why am I seeing it? Do I need to be seeing
    // that?" He was reading whole paragraphs of roborev state, check rollups and agent-slot
    // arithmetic — every one of them a gate addressed to the CONCIERGE, which read it and took
    // another route, usually completing the merge a minute later. A healthy self-correcting system
    // rendered as a wall of red.
    //
    // THIS DOES NOT WEAKEN RULE 1 ABOVE, and the distinction is the whole design. Rule 1 forbids
    // claiming more than the tool reported — the "Merged PR #753" for a refused merge failure — and
    // posting NOTHING claims nothing. What it does forbid is silence about a refusal the founder
    // has to act on, so `refusalAudience` defaults every unrecognised reason to `"founder"` and
    // checks the human-must-act signals FIRST. Only a positively-recognised internal gate is
    // withheld; see that module for why the allowlist points this way and not the other.
    //
    // THE ROW SURVIVES; ONLY THE PARAGRAPH GOES (roborev 63249, Medium). Returning `null` here was
    // the first cut and it went too far: the receipt is the ONLY surface that can contradict the
    // concierge's own prose, and `services/conciergeReceipts.ts` records why that is load-bearing —
    // 32 of 145 measured past-tense claims had no matching tool call, and a settle once reported a
    // REFUSED merge as "Merged PR #753". Delete the row and such a claim renders with nothing
    // beneath it. His complaint was the WALL OF TEXT, not the line, so the gist replaces the tool's
    // words and the refusal itself still shows.
    const gist = refusalGist(receipt.reason);
    const why = gist ?? receipt.reason?.trim();
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
    case "spawned": {
      // A spawn that could not brief the agent still made the row, so the line still says "Spawned"
      // — and then says what did not happen. An agent that starts unbriefed sits there doing nothing
      // ("every agent I spawn starts dead until I go type into it"), and this is the only place the
      // founder would learn it without opening the terminal (roborev 57862).
      // A SEPARATE SENTENCE, not a spliced clause (roborev 57951). `briefFailure` is a
      // multi-sentence, capitalised, first-person paragraph — "I created the agent, but its
      // terminal didn't start — … Its brief is still attached, so \"Start again\" … will send it."
      // Splicing that after "— but " produced "Spawned X — but I created the agent, but …", which is
      // broken copy in the one module whose output is meant to be trusted at a glance.
      const shortfall = receipt.reason?.trim();
      return shortfall
        ? line`Spawned ${subject}. ${plain(shortfall)}`
        : line`Spawned ${subject}.`;
    }

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
      // A PICKER PRESS IS NOT A MESSAGE. It really did write to the PTY, so it gets a receipt — but
      // "Sent to X's terminal" would describe something the concierge did not do.
      if (receipt.viaPicker) {
        return line`Answered ${subject}'s prompt.`;
      }
      // HELD, not delivered: the PTY was not up, so the message is queued and will go in when the
      // agent is ready — or expire. Saying "Sent to X's terminal" here is the sent-versus-visible
      // ambiguity the channel field exists to remove (roborev 57862).
      if (receipt.channel === "held") {
        return line`Holding a message for ${subject} — it goes in when its terminal is ready.`;
      }
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
      return Number.isFinite(n)
        ? line`Merged PR #${plain(String(n))}.`
        : line`Merged.`;
    }

    default:
      // An unrecognized kind posts NOTHING rather than a line the app cannot phrase. Silence is the
      // safe failure here: this module's whole contract is that a line means the thing happened.
      return null;
  }
}
