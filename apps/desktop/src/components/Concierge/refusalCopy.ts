// THE CONCIERGE'S REFUSAL VOCABULARY — deciding that a send did not land, and saying so in words the
// user can act on.
//
// Extracted verbatim from ConciergeHost (which re-exports `TRIAL_SPENT_TEXT`, its one test importer).
// It is the largest wholly-pure region of that file's module scope and it belongs together: every
// symbol here answers one of two questions — WAS this refused (`refusedPath`, `terminalWriteBlocked`)
// and WHAT do we tell the founder (`refusalCopy`, `terminalRefusalLine`, `terminalRefusalText`).
//
// ONE THING MOVED RELATIVE TO ITS NEIGHBOURS, deliberately: `refusalCopy`'s JSDoc used to sit two
// declarations above `refusalCopy` itself (an `asAgent` had been inserted under it at some point, and
// `asAgent` has now gone to ./hostTypes). It is restored to its subject here. No other text changed.
import type {
  ConciergeDispatchPath,
  ConciergeDispatchResult,
} from "../../services/conciergeDispatch";
import { flat, line, ref } from "./conciergeLine";
import type { Line, ReferencableAgent } from "./conciergeLine";
import { terminalWriteRefusal, type TerminalScreenRefusal } from "../../voice/dictationTerminalRoute";
import { getAgentViewport } from "../../services/terminalViewport";

/** What the concierge says when the server has refused the send: the free trial is spent. The
 *  dispatch path gates BEFORE delivery (services/trialMeter.trialSendAllowed), so nothing reached
 *  the agent — say so plainly rather than leaving the user waiting on a reply that isn't coming. */
export const TRIAL_SPENT_TEXT =
  "Your free trial is used up, so that didn't send. Upgrade and I'll pass it straight through.";

/** The two voices a non-delivery is reported in: the nudge card's Approve relay, and the compose
 *  box's user-authored prompt. Same facts, different remedy — "hit Retry" vs "then send again". */
export type RefusalVoice = "approval" | "prompt";

/** The paths that mean NOT DELIVERED. `picker-option`/`free-text` are excluded because they DID
 *  land; `queued` because it means HELD — the callers report that themselves, but only when `ok`,
 *  so an `ok:false` queued result DOES reach `refusedPath` and comes back `null` for the generic
 *  line (roborev 53044). Narrowing the parameter this way means handing a delivered path to
 *  `refusalCopy` is a compile error at the call site rather than a misleading generic
 *  "I couldn't send…" — the very dead end it exists to remove (roborev 52972). */
export type RefusedPath = Exclude<ConciergeDispatchPath, "picker-option" | "free-text" | "queued">;

/**
 * The refusal path of a result that did NOT deliver — or `null` when it did.
 *
 * `ok` stays the ONLY test for delivery. An earlier pass got the narrowing by widening the callers'
 * success branch to `r.ok || r.path === "picker-option" || r.path === "free-text"`, which inverted
 * that: an `{ ok: false, path: "free-text" }` would have reported "Sent to X." and, in
 * `promptAgent`, returned true — DISCARDING the user's draft on a failure that used to restore it
 * (roborev 53018). A cosmetic risk is not worth a real one. This predicate gives the same
 * compile-time proof with `ok` still in charge.
 */
export function refusedPath(r: ConciergeDispatchResult): RefusedPath | null {
  if (r.ok) return null;
  switch (r.path) {
    // ok:false on a path that means "delivered" is a contradiction the type system can't yet rule
    // out (ok and path are independent fields). Treat it as a plain refusal with no bespoke line
    // rather than as a success — the user keeps their draft either way.
    case "picker-option":
    case "free-text":
      return null;
    // `queued` means HELD, not delivered — reachable here precisely BECAUSE the callers gate their
    // held branch on `ok`. An ok:false hold is not a hold, so it takes the generic refusal line.
    case "queued":
      return null;
    default:
      return r.path;
  }
}

/**
 * MAY THIS COMPOSER SEND BE WRITTEN INTO THAT AGENT'S TERMINAL RIGHT NOW?
 *
 * The guard shipped for dictation (`voice/dictationTerminalRoute.terminalWriteRefusal`), reused
 * verbatim rather than reimplemented — its two prompt lists each grew four entries from real misses
 * found in the field, and a private copy would inherit the misses and not the fixes.
 *
 * ══ WHY THE COMPOSER NEEDS IT AT ALL ════════════════════════════════════════════════════════════
 * `dispatchConciergeAnswer` guards exactly one hazard: a live PICKER, which it refuses via
 * `neverPickerAnswer`. It does not look at the screen otherwise. So a send into an agent sitting in
 * `vim` is pasted AND submitted — and vim normal mode does not insert a sentence, it EXECUTES it (`d`
 * deletes, `2` counts, `p` pastes). A send at `[sudo] password for …:` types a sentence into a field
 * that echoes nothing and presses Enter on it. Both are reachable from this box today.
 *
 * ══ `no-viewport` IS FATAL FOR A MOUNT AND NOT FOR AN ADDRESS ═══════════════════════════════════
 * and the asymmetry is about what the two aims can honestly claim to know.
 *
 * A MOUNT points at the agent the cable is patched to — its pair is on screen, its terminal is
 * mounted, its column is the one the founder is looking at. "I cannot read that screen" there is not
 * a normal state; it is the state where a clean prompt and a `vim` session are indistinguishable, and
 * the thing being routed is the founder's ordinary typing with no address on it. Refuse.
 *
 * An ADDRESS may legitimately name an agent in another project whose pane is not mounted in this
 * window at all, and that send has worked since mentions shipped (it queues on `pendingSends` if the
 * PTY is still coming up). Refusing it would break a shipped feature to protect a screen nobody is
 * looking at, and the user named that destination explicitly. So an address is refused only on what
 * the screen POSITIVELY shows — `alternate-screen`, `awaiting-input` — which is strictly more
 * protection than it had, with nothing taken away.
 */
export function terminalWriteBlocked(
  agentId: string,
  via: "address" | "mount",
  read: (id: string) => ReturnType<typeof getAgentViewport> = getAgentViewport,
): TerminalScreenRefusal | null {
  const refusal = terminalWriteRefusal(read(agentId));
  if (!refusal) return null;
  if (refusal === "no-viewport" && via === "address") return null;
  return refusal;
}

/**
 * The same three refusals as PLAIN TEXT, for the mounted notice row.
 *
 * A SECOND RENDERING, not a second decision — exactly like `payload`/`display`/`text` on a send. The
 * thread's version builds a `Line` so the agent draws as a pill; the notice row is one line of text
 * in a banner, where a pill would be chrome nobody can click through to anything. Both take the same
 * `reason`, so they cannot disagree about WHY; only about how the agent is named.
 *
 * Kept adjacent to {@link terminalRefusalLine} so the pair is obvious and a fourth reason has to be
 * added to both or neither.
 */
export function terminalRefusalText(agentName: string, reason: TerminalScreenRefusal): string {
  if (reason === "alternate-screen") {
    return `Not sent — ${agentName} has a full-screen app open, so the keys would have run as commands. Your message is back in the box.`;
  }
  if (reason === "awaiting-input") {
    return `Not sent — ${agentName} is waiting on something on screen. Answer that first; your message is back in the box.`;
  }
  return `Not sent — I can't see ${agentName}'s screen, so I'd be guessing what this would land in. Your message is back in the box.`;
}

/** What the founder is told when a terminal declines the message, per cause.
 *
 *  NAMES THE CAUSE, never a generic "couldn't send". The three causes have three different exits —
 *  leave the full-screen app, answer the prompt on screen, or look at why that pane is not there —
 *  and a message that does not distinguish them leaves the user retyping the same thing into the same
 *  refusal, which is the dead-end this file's copy rules exist against (roborev 54665). The words are
 *  in the composer either way: the caller restores the draft, so nothing is lost while they decide. */
export function terminalRefusalLine(agent: ReferencableAgent, reason: TerminalScreenRefusal): Line {
  if (reason === "alternate-screen") {
    return line`${ref(agent)} has a full-screen app open, so I didn't type that into it — the keys would have run as commands rather than landing as text. Your message is back in the box.`;
  }
  if (reason === "awaiting-input") {
    return line`${ref(agent)} is waiting on something on screen, so I didn't type that into it. Open it and answer the prompt first — your message is back in the box.`;
  }
  return line`I can't see ${ref(agent)}'s screen right now, so I didn't type that into it — I'd be guessing what it would land in. Your message is back in the box.`;
}

/** THE one place a refused dispatch path becomes user-facing copy.
 *
 *  `approve` and `promptAgent` used to carry two near-identical `else if` ladders over the same
 *  paths, and they drifted exactly as you'd expect: the truthful `agent-failed`/`cloud-agent` lines
 *  landed on the prompt side a full commit before the approval side, so approving on a cloud agent
 *  gave the generic "I couldn't send…" dead end for a week. An exhaustive `switch` makes that
 *  impossible — a path added to ConciergeDispatchPath is a TYPE ERROR here (the `never` guard in
 *  `default`) instead of a silent fall-through to the generic line.
 *
 *  Only NON-delivery is handled: the callers report the delivered/held paths themselves, because
 *  what they do there differs (approve returns void; promptAgent returns whether to keep the draft). */
export function refusalCopy(path: RefusedPath | null, agent: ReferencableAgent, voice: RefusalVoice): Line {
  const approving = voice === "approval";
  // ONE slot, reused across the ladder — every arm names the same agent, and building the reference
  // once means no arm can be the one that forgets to.
  const a = ref(agent);
  const generic = approving ? line`I couldn't send the approval to ${a}.` : line`I couldn't send that to ${a}.`;
  if (path === null) return generic; // refused on a delivered-looking path — see refusedPath
  switch (path) {
    case "trial-spent":
      // Names no agent — the trial is the user's, not any one agent's.
      return flat(TRIAL_SPENT_TEXT);
    case "agent-failed":
      return approving
        ? line`${a} couldn't start, so I couldn't send the approval — open its pane and hit Retry.`
        : line`${a} couldn't start, so that didn't send — open its pane and hit Retry (or finish installing Claude Code), then send again.`;
    // NARROWED TO ANSWERS (design 2026-08-01 §Decision 7). Prompting a cloud agent from here IS
    // wired now — the dispatcher relays it to the sandbox's stdin — so the old prompt line ("isn't
    // wired up yet — use its own pane for now") became an instruction to work around a working
    // feature. What still refuses is an ANSWER to a question on the agent's own screen: an approval
    // gesture, or any send made while a picker is live. Both remedies point at the same place, and
    // that place is where the question is actually readable.
    case "cloud-agent":
      return approving
        ? line`${a} runs in the cloud — an approval has to be given where the question is, so open its pane and answer it there.`
        : line`${a} runs in the cloud and it's waiting on something on screen — I can't answer that for it from here. Open its pane and answer it there; your message is back in the box.`;
    // NOT the same fact as `cloud-agent`, and the difference is what the user should do next: the
    // agent is fine and the message is sendable, but this Mac has no live relay connection to hand
    // it over on — so the remedy is to get connected, not to go and type in its pane (which is
    // streamed over the very connection that is missing, and would be just as empty).
    case "cloud-offline":
      return approving
        ? line`I've lost the connection to the cloud, so the approval for ${a} didn't go anywhere. It'll reconnect on its own — try again in a moment.`
        : line`I've lost the connection to the cloud, so that didn't reach ${a}. It'll reconnect on its own — your message is back in the box, try again in a moment.`;
    case "pty-gone":
      return approving
        ? line`${a}'s terminal has closed — I couldn't send the approval.`
        : line`${a}'s terminal has closed — that didn't send. Start it again and I'll pass it along.`;
    case "ambiguous-picker":
      return approving
        ? line`${a} is asking something I can't answer with a plain "approve" — open it to choose.`
        : line`${a} is waiting on a choice I can't map that to — open it and pick, or answer with just the option.`;
    // ITS OWN LINE, not a second use of `ambiguous-picker` above (roborev 54665). That copy says
    // the answer mapped to nothing and offers "answer with just the option", and it is wrong here
    // WHETHER OR NOT the text matched — which is the point, because this path no longer depends on
    // the match at all (roborev 55400: the declared disposition is read before the matcher). The
    // refusal is about what the message IS, not how well it scored:
    //   • an ADDRESSED send matches perfectly and is still refused, because a message is not a
    //     keystroke — and "answer with just the option" is exactly what the user already did;
    //   • an ATTACHMENT-CARRYING redirect matches nothing, because the quoted paths defeat the
    //     anchored matcher — and the thing in their way is the file, not the wording.
    // Sharing `ambiguous-picker` sent the first round a loop whose only exit was guessing the `@`
    // was the problem, and the second one a loop with no exit at all. This line states the real
    // reason and the real exits.
    // ONE exit, not two. This line used to offer a second — "drop the @<name> and send just the
    // option" — and that advice is only safe when the named agent also happens to be the column's
    // current target. `send` resolves an UNADDRESSED message against `targetRef.current`, so with
    // the address removed the bare "yes" is aimed at whatever the column is pointed at. The whole
    // premise of naming an agent is that it is most natural when several are asking at once, which
    // is exactly when the shown target is a DIFFERENT agent — and a terse "yes" landing on that
    // agent's live picker gets framed as `y\r` and presses its button. That is the precise outcome
    // `neverPickerAnswer` exists to prevent, reintroduced by the remedy text. Gating the second
    // exit on `targetRef.current?.agentId === aim.agentId` would also work; it is not worth a
    // branch and a threaded ref to keep an affordance that saves one click. (roborev 54673.)
    case "addressed-at-picker":
      return approving
        ? line`${a} is waiting on a choice on screen — open it and pick.`
        : line`${a} is waiting on a choice on screen, so I didn't send that to it as a message — open ${a} and pick.`;
    // A full-screen app owns the screen, so the write would have been EXECUTED as editor/pager
    // commands. Name the app class rather than the buffer ("alternate screen" means nothing to the
    // person reading), and name the ONE exit — leaving it. Deliberately no "try rephrasing":
    // rewording changes nothing about a screen that executes whatever arrives.
    case "alternate-screen":
      return approving
        ? line`${a} is in a full-screen app right now, so I didn't send the approval — anything typed there would run as commands. Quit it and approve again.`
        : line`${a} is in a full-screen app right now (an editor or pager), so I didn't send that — anything typed there would run as commands. Quit it and send again.`;
    // The agent is at its own prompt (Claude Code, typically) but that prompt is sitting on a
    // CREDENTIAL field, an ssh host-key question, or a `(yes/no)` — and this send would be pasted
    // AND SUBMITTED into it. A different refusal from `alternate-screen` because the exit is
    // different: answer the thing on screen, rather than quit an app. Named without quoting the
    // prompt, since the whole hazard is that some of these echo nothing.
    case "blocked-prompt":
      return approving
        ? line`${a} is waiting on something on screen — a prompt or a credential field — so I didn't send the approval. Answer that first, then approve again.`
        : line`${a} is waiting on something on screen — a prompt or a credential field — so I didn't send that. Answer it in ${a}'s pane first, then send again.`;
    case "unauthorized":
      // Should be unreachable: `authority` is required and non-defaulted, so a call site that omits
      // it does not compile. Reachable only if a malformed authority is built dynamically — a bug,
      // not a user error. Say the honest thing (it did NOT send) without inventing a remedy the
      // user could act on, and let the log line carry the diagnosis.
      return approving
        ? line`Something went wrong on my side, so I didn't send the approval to ${a}.`
        : line`Something went wrong on my side, so I didn't send that to ${a}. Try again.`;
    case "queue-full":
      // A full hold queue is NOT a dead terminal — the agent is starting normally, there are simply
      // already MAX_PER_AGENT prompts waiting on it. Falling through to the generic line (or worse,
      // to the "terminal has closed" one) would send the user to restart something that is coming
      // up fine (roborev 46280). Both voices name the action that was refused, because these
      // ladders otherwise only say what did NOT happen, leaving the user unsure whether theirs
      // went through.
      return approving
        ? line`${a} already has a few prompts waiting to start — let those land first, then approve again.`
        : line`${a} already has a few prompts waiting to start — let those land first, then send again.`;
    // No bespoke line: "empty" is a blank answer the UI already swallows, and "expired"/"abandoned"
    // are DEFERRED outcomes reported by the onDeferredSendOutcome effect below, never returned to a
    // caller synchronously. They are listed rather than folded into `default` on purpose — `default`
    // has to stay unreachable for the exhaustiveness guard to have any teeth.
    case "empty":
    case "expired":
    case "abandoned":
      return generic;
    default: {
      const unhandled: never = path;
      void unhandled;
      return generic;
    }
  }
}
