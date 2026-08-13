// WHAT IS ON AN AGENT'S SCREEN RIGHT NOW — for a reader that is about to TYPE INTO IT.
//
// `services/conciergeTools/terminal` already falls a read through four tiers, and this is the same
// first two tiers with a strictly harder freshness rule, because the consumer is different: that
// chain feeds an LLM a narration, and its worst case is a sentence describing a question the agent
// has moved past. THIS one authorises `maybeAutoApprove` to press a key in a live PTY, and its worst
// case is the keystroke landing in whatever replaced the prompt. So every uncertain path here
// returns NO TEXT, and the caller must treat "no text" as "there is no prompt".
//
// ── THE TWO SOURCES ─────────────────────────────────────────────────────────────────────────────
//   (a) `terminalScrollback` — the live xterm buffer, present only while the agent's terminal is
//       MOUNTED. Present tense by construction, so it asks no freshness question. This is the source
//       today's auto-approve already uses, and for every agent in a project the user has visited
//       this session it is available whether or not that agent is the SELECTED one.
//   (b) `runtimeStore.attentionScreen` — the screen photographed the instant the agent crossed into
//       waiting/approval. It SURVIVES an unmounted pane, and it is a SNAPSHOT, not the present. This
//       is the source that needs the gate below.
//
// ── WHY (b) IS GATED HARDER HERE THAN IN THE CONCIERGE'S `captureFor` ───────────────────────────
// `captureFor` applies two expiries and, where evidence is missing, FAILS TOWARD SERVING the
// capture — right for a read. This function inverts that on the one case where they differ: a
// capture carrying NO WRITE STAMP is refused outright rather than judged episode-relative. An
// unstamped capture predates `attentionScreenAt` (bead sparkle-5wbhn) or was written by a path that
// does not pair the two maps, and in both cases we cannot say how old it is. Absent evidence must
// not become permission to type.
//
// On top of that it applies a hard AGE CEILING that the read chain has no reason to want. The
// mechanism this serves reacts to the capture being WRITTEN — `autoApproveWatch` runs within
// milliseconds of it — so in the intended path the capture is newborn. A capture materially older
// than that reached the decision by some other route (a store rehydration, a late scan, a status
// map that has not moved in a while) and cannot be assumed to still be what the terminal shows.
import { useRuntimeStore } from "../../stores/runtimeStore";
import { getAgentScrollback } from "../terminalScrollback";
// The SAME predicate the concierge feed uses to retract a frozen red from the UI, imported rather
// than restated: if a movement is enough to say "that red is over", it is enough to say "the screen
// that red was raised on is over".
import { movedSinceStamp, windowRetractionLedger } from "../../engine/movementRetraction";

/**
 * How old a captured ask-screen may be and still authorise a keystroke.
 *
 * ONE MINUTE, and the number is chosen from the mechanism rather than from taste. The capture is
 * written by `Terminal`'s status router at the instant the agent goes red, and the watch that reads
 * it is a subscriber on that same store write — so the intended path measures the age in
 * milliseconds. The ceiling exists for every OTHER path, where the ledger may have no reading for
 * this agent at all (no `fleet_digest` tick yet, an agent another window hosts) and so cannot say
 * whether it has moved on. There, age is the only evidence left, and a minute is long enough that a
 * slow tick cannot lose a live prompt while short enough that a forgotten snapshot cannot answer one.
 */
export const CAPTURE_MAX_AGE_MS = 60_000;

/** A screen we are willing to decide on, and where it came from. `source` is not diagnostic
 *  garnish — "live buffer" and "a snapshot up to a minute old" are different licences, and a caller
 *  that cannot tell them apart cannot log honestly about what it just answered. */
export interface ApprovalScreen {
  text: string;
  source: "scrollback" | "capture";
}

/** No screen we will decide on, and the reason — kept in words because every one of these is a
 *  DECLINE TO ACT, and the next person debugging "why didn't it answer" needs to know which. */
export interface NoApprovalScreen {
  text: null;
  why: string;
}

export type ApprovalScreenRead = ApprovalScreen | NoApprovalScreen;

/** The movement-ledger refusal, hoisted so its guard fits on one line — see the note at its use. */
const MOVED_PAST =
  "the agent has been seen working since that screen was captured, so it has moved past it";

/**
 * The screen `agentId` is showing, or `{ text: null, why }` when we cannot be sure it is showing
 * one. Fail-closed on every uncertain path.
 *
 * Reads the clock via `Date.now()` rather than taking an injected one: a defaulted clock parameter
 * that every test overrides leaves the production call site covered by nothing (bead sparkle-lgbwf).
 * Tests drive this with `vi.setSystemTime`, which moves the same clock `setAttentionScreen` stamps
 * with, so the two cannot drift apart.
 */
export function approvalScreenFor(agentId: string): ApprovalScreenRead {
  // (a) The live buffer wins whenever it exists, and asks no further questions.
  const scrollback = getAgentScrollback(agentId);
  if (scrollback !== null && scrollback.trim() !== "") {
    return { text: scrollback, source: "scrollback" };
  }

  // (b) The captured ask-screen. A mounted-but-blank terminal falls through to here on purpose: a
  // pane that just opened has an empty buffer while its capture still holds the question.
  const state = useRuntimeStore.getState();
  const captured = state.attentionScreen[agentId];
  if (!captured || captured.trim() === "") {
    return {
      text: null,
      why:
        scrollback === null
          ? "no terminal is mounted for this agent and it has captured no ask-screen"
          : "the mounted terminal has produced no output yet and there is no captured ask-screen",
    };
  }

  const capturedAt = state.attentionScreenAt[agentId];
  if (capturedAt === undefined) {
    // See the header: the concierge read chain judges an unstamped capture episode-relative and
    // serves it. A write may not.
    return { text: null, why: "the captured ask-screen carries no write time, so its age is unknown" };
  }

  const age = Date.now() - capturedAt;
  // `age < 0` is a clock that moved backwards (NTP step, sleep/wake). Unknown age, same answer.
  if (age < 0 || age > CAPTURE_MAX_AGE_MS) {
    return {
      text: null,
      why: `the captured ask-screen is ${Math.round(age / 1000)}s old, past the ${CAPTURE_MAX_AGE_MS / 1000}s ceiling`,
    };
  }

  // Against the capture's OWN write time, not the red episode's raise time (bead sparkle-5wbhn):
  // `waiting → approval` is one episode, so an agent that asks, is answered, and asks again inside
  // it wrote a capture NEWER than the movement, and judging it episode-relative throws away the
  // freshest evidence there is.
  //
  // Written as a ONE-LINE guard, not an `if` block, on purpose: `scripts/mutation-check.sh` cannot
  // judge a multi-line `if` whose condition is a bare predicate call (there is no comparison to
  // invert, and commenting the header out leaves a dangling block), so the guard with the highest
  // stakes in this file would have been the one line no mutation check could prove was live.
  const movedOn = movedSinceStamp(windowRetractionLedger(), agentId, capturedAt);
  if (movedOn) return { text: null, why: MOVED_PAST };

  return { text: captured, source: "capture" };
}
