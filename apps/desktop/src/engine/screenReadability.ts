// CAN THE APP READ THIS AGENT'S SCREEN AT ALL? — and if not, say THAT, rather than "Needs you".
//
// ══ THE LIE THIS EXISTS TO STOP ═════════════════════════════════════════════════════════════════
// The founder, on a red row: *"You're showing it as blocked ... But there's nothing that it says it
// needs from me. And in fact, I can't even see anywhere to type."*
//
// "Needs you" and "Approve?" are CLAIMS. They assert there is a question on screen with a button the
// human can press. When the app cannot read the screen it does not know that — and on the shape that
// produced the founder's report it was actively false: `read_picker_options` answered
// `{ options: [], present: false, blind: 'no-menu' }` and `send_to_agent_terminal` refused with
// `alternate-screen`. The app knew it was blind, and rendered blindness as an approval.
//
// A row that promises a button and delivers nothing is worse than a plain red, for the reason
// `statusEngine`'s own `offersPressableOptions` note already gives: the human taps it, finds
// nothing, and stops trusting the dot.
//
// ══ WHY THIS IS *NOT* A LICENCE TO GO QUIET ═════════════════════════════════════════════════════
// `docs/never-hide-actionable-rows.md`: nothing that needs the founder may be hidden, and a row the
// app cannot read is the LEAST safe thing to calm — being unable to see a question is not evidence
// there isn't one. So blind is RED and it still pages him (the founder's own choice when asked:
// "Red dot, Can't read screen"). What changes is only WHAT IT SAYS. It stops claiming a button
// exists and starts naming the real state, which is also the state that has a real remedy: Force
// redraw (`services/forceRedraw`).
import {
  claudeCodeMarkerFamilies,
  hasClaudeCodeComposerBox,
  isClaudeCodeScreen,
} from "./claudeCodeScreen";
import { getAgentViewport, type TerminalViewport } from "../services/terminalViewport";
import { recordConciergeEvent } from "../stores/conciergeEventLog";
import { accountedAgents, type ConciergeFeed } from "../services/conciergeFeed";

export type ScreenReadability =
  /** The app can read this screen — either it is not a full-screen program at all, or it is
   *  recognisably Claude Code. Every existing status derivation applies unchanged. */
  | { kind: "readable" }
  /** A full-screen program the detector does not recognise. The app can neither read its picker nor
   *  safely type into it, so any claim about what is on screen is a guess. */
  | { kind: "blind"; reason: "unrecognized-fullscreen" }
  /** No terminal is mounted in this window. NOT the same fact as the one above, and deliberately
   *  distinct: an agent whose pane simply is not open here is not broken, and `terminalViewport`'s
   *  own rule is that null must never be reported as a clear screen either. */
  | { kind: "blind"; reason: "no-viewport" };

/**
 * Can the app read this screen?
 *
 * PURE, over the same `TerminalViewport` the write guards read, so the answer is testable without a
 * PTY — and, more importantly, so it is THE SAME EVIDENCE `voice/dictationTerminalRoute`'s
 * `terminalWriteRefusal` acts on. That is the point of routing both through `isClaudeCodeScreen`:
 * the row must not be able to say "Needs you" on a screen the send path is simultaneously refusing
 * as `alternate-screen`. Those two answering differently is precisely the founder's bug.
 */
export function screenReadability(viewport: TerminalViewport | null): ScreenReadability {
  if (!viewport) return { kind: "blind", reason: "no-viewport" };
  // THE ALTERNATE BUFFER ALONE IS NOT BLINDNESS — bead sparkle-v7k3y, and the reason
  // `claudeCodeScreen` exists at all. Claude Code holds that buffer for its ordinary busy state, so
  // treating the flag as the answer would call the single most common state in the app unreadable.
  if (!viewport.alternateBuffer) return { kind: "readable" };
  if (isClaudeCodeScreen(viewport.text)) return { kind: "readable" };
  return { kind: "blind", reason: "unrecognized-fullscreen" };
}

/** Is this agent's screen one the app cannot read? The boolean form, for callers that only branch. */
export function isScreenBlind(viewport: TerminalViewport | null): boolean {
  return screenReadability(viewport).kind === "blind";
}

/** What the row says instead of "Needs you" / "Approve?".
 *
 *  IT NAMES THE APP AS THE THING THAT FAILED, not the agent. "Can't read screen" is a statement
 *  about Sparkle's own vision; a label like "Agent unresponsive" would blame a process that may be
 *  working perfectly and would send the founder to debug the wrong thing. The remedy that follows
 *  from it (Force redraw) is Sparkle's too. */
export const BLIND_STATUS_LABEL = "Can't read screen";

/** The sentence the pinned strip renders for a blind row.
 *
 *  It states the failure AND the remedy in the same breath, because a row that says only "I can't
 *  read this" is the same dead end wearing more honest words — `never-hide-actionable-rows` asks for
 *  an action, not just an accurate label. */
export function blindReasonSentence(agentName: string, projectName: string): string {
  return `${BLIND_STATUS_LABEL} — Sparkle can't read ${agentName}'s screen in ${projectName}. Try Force redraw.`;
}

/** The statuses whose LABEL is a claim about what is on screen — the only ones blindness may
 *  overwrite.
 *
 *  ══ WHY THIS IS A LIST AND NOT "EVERY RED STATUS" (roborev 65876, Medium) ══════════════════════
 *  `approval` ("Approve?") and `waiting` ("Needs you") assert that a question with a pressable
 *  button is drawn on the terminal. When the app cannot read the terminal, those assertions are
 *  unfounded and replacing them is the entire point of this module.
 *
 *  `errored` and `blocked` are NOT screen-derived. They come from the status engine — a PTY that
 *  exited, or an agent that went quiet — and they remain TRUE whatever the screen looks like. Worse,
 *  a crashed TUI is exactly the case most likely to leave an unrecognised alternate buffer behind,
 *  so overwriting on blindness alone would take the one accurate account of what happened
 *  ("Errored — X in sparkle.") and replace it with "Sparkle can't read X's screen … Try Force
 *  redraw" — a remedy that cannot help a dead process, offered instead of the diagnosis.
 *
 *  So blindness REPLACES a screen-derived claim and merely ANNOTATES everything else. */
const SCREEN_DERIVED_STATUSES: ReadonlySet<string> = new Set(["approval", "waiting", "questions"]);

/** Is this status's label a claim about the screen, and therefore something blindness may replace? */
export function statusClaimsScreenContent(status: string): boolean {
  return SCREEN_DERIVED_STATUSES.has(status);
}

/** The note appended to a status whose truth does NOT depend on reading the screen. Additive, so no
 *  true fact is discarded — see {@link SCREEN_DERIVED_STATUSES}. */
export function blindAnnotation(): string {
  return `(${BLIND_STATUS_LABEL} — try Force redraw.)`;
}

// ══ SWEEPING THE WHOLE ACCOUNTED FLEET ══════════════════════════════════════════════════════════
// The alarm used to be raised inside the nudge builder, which looked like the natural home: it is
// where readability is already computed. It was WRONG, and wrong in the loudest case (roborev 65876,
// Medium).
//
// `buildDigest` emits a card only for a bucket of ONE — two or more agents sharing a project+band
// collapse into a single group line, and those agents never reach `agentToNudge` at all. So the
// alarm fired with one blocked agent per project and went SILENT with two: exactly inverted against
// the saturated fleet that produced the founder's report in the first place.
//
// The label and the alarm are therefore separated. The label belongs to the card (only cards carry
// text); the alarm belongs to the POPULATION, and is swept over `accountedAgents` — surfaced ∪
// rowless ∪ stranded — before digesting throws most of them away.
//
// NOT `surfacedAgents` (roborev 65998). This paragraph used to say "every surfaced agent", which is
// the `topLevel`-filtered narrow set `observeFeedReadability`'s docblock below spends twenty lines
// explaining must never be the population. A reader hits this header first, so it was stating the
// defect as the design.

/** THE PRODUCTION WIRING, exported so a test can drive the REAL one.
 *
 *  ══ WHY THIS IS EXPORTED RATHER THAN INLINED AT THE CALL SITE (roborev 65876, Medium) ══════════
 *  An earlier cut built this object inline inside the module that used it, which made it a DEFAULTED
 *  SEAM WITH ZERO COVERAGE — the exact shape `AGENTS.md` names as bead `sparkle-lgbwf`. Every test
 *  injected its own fakes, so the one line that supplies the real `recordConciergeEvent` was covered
 *  by nothing: delete it and the whole suite stays green while the announced alarm is inert in
 *  production. Which is the same class of silent failure the alarm exists to prevent.
 *
 *  Exporting it makes the production wiring itself a thing a test can execute — see
 *  `screenReadability.test.ts`, which drives this object against a really-registered viewport and
 *  asserts an event lands in the real log. */
export const REAL_FLEET_READABILITY: FleetReadabilityDeps = {
  viewportFor: getAgentViewport,
  families: claudeCodeMarkerFamilies,
  hasComposerBox: hasClaudeCodeComposerBox,
  record: recordConciergeEvent,
};

/**
 * THE ONLY THING PRODUCTION CALLS — it takes the FEED, so no caller can pick a population.
 *
 * ══ WHY THE POPULATION IS NOT A PARAMETER HERE (roborev 65893 → 65897 → 65920, three rounds) ════
 * The same seam regressed and stayed unguarded across three attempts, which is the argument for
 * removing it rather than testing it harder:
 *
 *   1. The alarm was raised per-CARD, so `buildDigest` collapsing two same-band agents into a group
 *      line made it silent on exactly the busy fleets it exists for.
 *   2. The fix swept `surfacedAgents(feed)` — `topLevel`-filtered — which dropped rowless and
 *      stranded workers: the same blindness, from the other side.
 *   3. The fix for THAT named the union as a helper, but the CHOICE stayed at the call site, so
 *      editing one line back to `surfacedAgents(feed)` still left every test green. Twice the
 *      "proof" mutated the helper's body rather than the caller, which is not the seam that broke.
 *
 * A parameter a caller can get wrong, guarded by a test that has to remember to assert on the
 * caller, is a bug waiting to recur. Taking the feed removes the choice — and the list form below
 * is MODULE-PRIVATE, which is the half that makes that true rather than merely stated.
 *
 * An earlier cut kept the list form exported "for tests" and claimed in this docblock that the bug
 * was already unrepresentable. It was not (roborev 65956): the one-line regression — a caller
 * reaching for `observeFleetReadability(surfacedAgents(feed), …)` — still compiled and still left
 * the suite green, so the comment promised a guarantee the code did not provide. Un-exporting it is
 * what closes the seam; the tests drive the feed entry point like production does.
 *
 * `accountedAgents` IS the set, not a union of three (roborev 65920): `surfacedAgents` and
 * `unrepresentedAgents` partition it on `topLevel`, and `nestedRowlessAgents`/`strandedAgents`
 * partition the latter on `parentRowId`. Spelling the union out was a fourth derivation of a set
 * that already had a name — and it would silently NARROW if any sub-population later gained a
 * filter, which is the exact failure this is meant to prevent.
 */
export function observeFeedReadability(feed: ConciergeFeed, deps: FleetReadabilityDeps): number {
  return observeFleetReadability(accountedAgents(feed), deps);
}

/** The deps both entry points take. Named so the production object below and the tests agree. */
export type FleetReadabilityDeps = ReadabilityAlarmDeps & {
  viewportFor: (agentId: string) => TerminalViewport | null;
};

/** Raise the regression alarm across a whole population of agents.
 *
 *  Returns how many agents alarmed, so a caller — or a test — can assert the sweep reached them
 *  rather than trusting that it ran. */
function observeFleetReadability(
  agents: readonly { id: string }[],
  deps: FleetReadabilityDeps,
): number {
  let raised = 0;
  for (const a of agents) {
    const viewport = deps.viewportFor(a.id);
    const readability = screenReadability(viewport);
    if (noteScreenReadability(a.id, readability, viewport?.text ?? "", deps)) raised += 1;
  }
  return raised;
}

// ══ THE REGRESSION ALARM ════════════════════════════════════════════════════════════════════════
// Silent lexical rot is what cost the founder a night. The detector's markers can stop matching on
// any Claude Code release, every consequence of that is fail-CLOSED (refuse the write, blind the
// picker, keep the red), and nothing anywhere said so. So an unrecognised screen on a LIVE agent
// now announces itself into the concierge event log, where a turn can drain it.
//
// EDGE-TRIGGERED PER AGENT. The readability check runs on every feed tick, and a permanently
// unreadable pane would otherwise mint an event per tick and evict the entire ring — turning the
// alarm into the thing that destroys the log it writes to. One event per agent per transition INTO
// blindness; re-arms when that agent reads clean again, so a flapping pane is still visible as
// repeated events rather than one forgotten record.

/** Agents currently known to be blind. Module state, matching the event log's own store-free shape
 *  — nothing renders this and both writers are hot paths. */
const blindAgents = new Set<string>();

/** Injectable seams, for the same reason `forceRedraw` has them: the production wiring IS the
 *  default, so a test drives the real function rather than a copy of its logic. */
export interface ReadabilityAlarmDeps {
  families: (screen: string) => number;
  hasComposerBox: (screen: string) => boolean;
  record: (payload: {
    kind: "screen_unrecognized";
    agentId: string;
    families: number;
    composerBox: boolean;
  }) => unknown;
}

/**
 * Observe one agent's readability, raising the alarm on the transition into blindness.
 *
 * ONLY `unrecognized-fullscreen` ALARMS. `no-viewport` is the ordinary state of every agent whose
 * pane is not open in this window — alarming on it would fire constantly and for a reason that is
 * not a defect, drowning the signal this exists to carry.
 *
 * Returns whether an event was recorded, so a test asserts the EDGE rather than the call.
 */
export function noteScreenReadability(
  agentId: string,
  readability: ScreenReadability,
  screen: string,
  deps: ReadabilityAlarmDeps,
): boolean {
  if (readability.kind !== "blind" || readability.reason !== "unrecognized-fullscreen") {
    // RE-ARM on any non-alarming state, including `no-viewport`: a pane that closed and reopened
    // still unreadable is a fresh sighting worth recording.
    blindAgents.delete(agentId);
    return false;
  }
  if (blindAgents.has(agentId)) return false;
  blindAgents.add(agentId);
  deps.record({
    kind: "screen_unrecognized",
    agentId,
    families: deps.families(screen),
    composerBox: deps.hasComposerBox(screen),
  });
  return true;
}

/** Test seam — forget every latched agent, so one test's edge cannot suppress the next test's. */
export function resetReadabilityAlarm(): void {
  blindAgents.clear();
}
