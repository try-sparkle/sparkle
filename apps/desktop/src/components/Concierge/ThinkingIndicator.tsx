// "Sparkle is thinking" — but saying WHAT it is thinking about, when it can.
//
// THE COMPLAINT: "the concierge only gives a little '…' to show that it received and is thinking. I
// want it to show more than that … make it more alive and responsive than just three dots that give
// me no information."
//
// WHAT THIS SHOWS, and why it is trustworthy. The concierge drives this app through `concierge_tool`
// calls, every one of which passes through services/controlListener, which records it
// (services/conciergeActivity) and phrases it (engine/conciergeActivityLine). So the line is a
// report of a call that ACTUALLY HAPPENED — "Reading Kraken Auth's terminal…", "Checking PR #753's
// checks" — not a typewriter animation and not a guess at what the brain is probably up to. A
// fabricated preview of the model's thoughts would look livelier and be worth nothing; this is the
// one signal the app can vouch for.
//
// WHAT IT ALSO SHOWS NOW: HOW LONG YOU HAVE BEEN WAITING — as a COLOUR, and nothing else
// (engine/conciergeLiveness). The pulse alone could not distinguish "thinking hard" from "this turn
// died twelve seconds ago and nothing will ever arrive", and on 2026-07-29 the second case happened
// 149 times without the column ever changing. The row now tints gray → yellow (30s) → red (60s).
//
// NO WORDS, ON PURPOSE (2026-07-30). This row used to carry a seconds counter from 5s and the words
// "No answer yet" from 20s. The founder's verdict after living with it: *"don't have it say no
// answer yet, just have the color change from gray to yellow to then red"* — and going red at 30s
// was too distracting for what is usually just a slow turn. So the ONLY thing that changes here is
// the colour: same icon, same line, same pulse, same layout, in a different ink. Nothing reflows, so
// a slow turn costs a glance rather than a sentence. See the engine header for the thresholds.
//
// A COLOUR CANNOT BE READ ALOUD, and this component does not solve that — ConciergeHost does, by
// speaking the step through the column's ONE announcer (`announce`). Nothing here carries the state
// in text, and that is the third answer to the question after two wrong ones:
//
//   1. `aria-label` ALONE announces nothing (roborev 56112-M1). A live region is announced from a
//      CONTENT mutation in its subtree; an attribute-only change on the region node is not reliably
//      announced by NVDA/JAWS/VoiceOver. A test asserting the attribute cannot catch that.
//   2. A clip-rect region of this component's OWN (roborev 56122-M2) fixes the mutation problem and
//      breaks something else: the thread deliberately owns no announcer, because a second live
//      region double-announces (ConciergeThread.roleLabels asserts exactly this, and caught it).
//      Nesting it inside the row is worse still — with no activity line the row is `aria-hidden`,
//      which removes its entire subtree from the accessibility tree, so it would have been silent in
//      the very case it existed for: a turn that thinks for a minute and calls nothing.
//
// Both dead ends were reaching for a stable live region. The column already HAS one, mounted with it
// and keyed on a write counter so identical consecutive lines still speak. The state belongs there,
// like every other thing this column says.
//
// THREE RULES IT DEGRADES BY:
//
//   1. NO ACTIVITY, NO CLAIM. A turn that thinks for thirty seconds and calls nothing shows exactly
//      the pulse it always did. The fallback is the honest state, not a failure state.
//   2. ONLY THIS TURN'S ACTIVITY. Every recorded call carries a monotonic `seq`; the indicator
//      snapshots the counter when `typing` goes true and ignores anything at or below it. Without
//      that, the line left over from the previous turn — or from a PROACTIVE push, which calls tools
//      with no typing indicator of its own — would be presented as what the concierge is doing about
//      the message the user just sent.
//   3. THE TENSE FOLLOWS THE CALL. In flight it reads "Reading …"; once dispatch replies it reads
//      "Read …" beside the pulse, i.e. "did that, still thinking". A single present-tense phrase
//      would leave the column claiming to be doing something it finished seconds ago.
//
// It reads a store, which this directory's header says presentational components don't. That rule
// has been the exception rather than the rule here for a while (ComposeBox, ConciergeSuggestions,
// PresenceSlider all read stores); the alternative was a prop threaded through ConciergeHost, which
// buys nothing — the host would only forward what this subscribes to — and would collide with the
// @-mention work landing in that file.
//
// That reasoning still holds for the COLOUR, which is all this component reads the store for. It is
// no longer the whole story: the spoken half deliberately does live in the host, via a leaf that
// renders nothing (`LivenessAnnouncer`). Not because a prop would have been better, but because the
// announcement has to go through the column's single live region, which only the host can feed —
// and because subscribing the host itself to this 1 Hz ticker would reconcile the entire column
// once a second for the length of every turn (roborev 56177-M2).
//
// ══ IT YIELDS THE WORDS WHEN A BUBBLE IS CARRYING THEM (sparkle-9ciay) ══════════════════════════
// The founder: *"You're doing a new thing where you're giving me an update in the left side of the
// chat window but then ALSO below the message itself… I don't need to see it twice."* Two surfaces
// render `conciergeActivityLine` — this row, and `services/conciergeMessageStatuses`, which pins the
// same global entry onto the awaited bubble — so for the whole of every turn with a bubble the
// SAME sentence was on screen twice.
//
// The rule he stated: this rail is for updates about the concierge AS A WHOLE; anything specific to
// one message goes under that message and NOWHERE ELSE. An observed line always describes the turn
// running for one bubble, so when a bubble is showing it, `activityClaimed` is true here and the row
// falls back to exactly the bare pulse it degrades to anyway — the honest general statement that
// something is in flight. The line still lives here for a turn with NO bubble to attach to
// (`relayFollowUp` and friends), which is genuinely a fact about the column.
//
// THE GLYPH STAYS IN BOTH PLACES, deliberately: *"I like how on the left side it gives me a little
// icon, I'd like to see that icon on the right side as well."* It is a domain mark, not the status
// string, and both surfaces now draw it from ./activityIcons.
//
// ══ AND THE YIELDED LINE IS NOT RE-ANNOUNCED ANYWHERE — A FOURTH DEAD END, MEASURED ═════════════
// When this row carries the line it is a `polite` region of its OWN, so per-tool-call changes never
// touched anything else. Yielding the line therefore drops it out of the audio channel, and the
// obvious repair — speak it from `ConciergeHost` through the column's one announcer, exactly as the
// list above concludes for the LIVENESS step — was built and REVERTED. The two cases are not alike:
// liveness changes at most twice a turn, the activity line changes once per TOOL CALL, and the
// column's announcer is a single region that every write CLOBBERS. It reddened
// ConciergeHost.liveness's "writes the region exactly ONCE across the drain and the reply" with
// extra writes inside the window that case guards — which is to say the concierge's actual ANSWER
// would have been overwritten by "Reading an agent's terminal" on its way past. (That case is
// separately flaky under load, so treat the count it printed as indicative and the mechanism as the
// reason.) A per-call narration is exactly the flooding the thread itself is kept off a live region
// for.
//
// So the line is announced by whichever surface is SHOWING it, and when that is a bubble it is
// announced by neither — it is ordinary readable text in the transcript, reached the way every other
// sentence in the column is. What still speaks is what was always general: the liveness step, the
// reply, the receipts. Do not re-add an announcer here or in the host without a way to write the
// region that does not overwrite a pending answer.
import { C } from "../../theme/colors";
import { useConciergeActivityStore } from "../../services/conciergeActivity";
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import type { ConciergeLiveness } from "../../engine/conciergeLiveness";
import { conciergeActivityLine } from "../../engine/conciergeActivityLine";
import { ACTIVITY_ICONS } from "./activityIcons";
import { AgentPill } from "./AgentPill";

export const THINKING_INDICATOR_TESTID = "concierge-thinking";
export const THINKING_ACTIVITY_TESTID = "concierge-thinking-activity";

/**
 * The whole signal: one ink per step, and NOTHING else changes.
 *
 * `waiting` is the SAME gray the row has always been, which is the point — a concierge taking a few
 * seconds is normal and should look normal, so for the first 30s there is nothing to notice. Yellow
 * then red are the app's existing two alarm inks (`--c-amber-ink`, sienna); no third alarm colour is
 * invented here, per PRD/sparkle/concierge-status-bands.
 *
 * There is no fourth entry because there is no fourth state — see the engine header on why red at
 * 60s subsumes the old 90-second terminal step.
 */
const INK: Record<ConciergeLiveness, string> = {
  idle: C.conciergeMuted,
  waiting: C.conciergeMuted,
  slow: C.amberInk,
  stalled: C.sienna,
};

export function ThinkingIndicator({
  typing,
  floor,
  activityClaimed = false,
}: {
  typing: boolean;
  floor: number;
  /**
   * Is a MESSAGE already showing the observed line? Then this row must not repeat it.
   *
   * Decided by `ConciergeThread`, which is the one component that renders both surfaces and is
   * therefore the only place the "never in both" invariant can actually be guaranteed rather than
   * agreed on by two files. See this file's header for the founder's rule, and
   * ConciergeThread.statusOwnership.test.tsx for it asserted across the pair.
   *
   * DEFAULTS TO FALSE, i.e. to the behaviour this row has always had. An unwired caller keeps its
   * line, which is the safe direction: the failure is a line shown where nothing else shows it, not
   * a turn that goes silent everywhere.
   */
  activityClaimed?: boolean;
}) {
  const latest = useConciergeActivityStore((s) => s.latest);
  const { liveness } = useConciergeLiveness();
  /**
   * THE TURN BOUNDARY IS NOW HANDED IN — ONE boundary for the whole column (roborev 57933).
   *
   * This used to derive its own, keyed on the `typing` transition alone. That is the defect shape
   * fixed elsewhere as roborev 57889-M1 and it was still live HERE: a supersede leaves `typing`
   * true, so this floor never moved and the row went on narrating the DEAD turn — "Reading Kraken
   * Auth's terminal" — beside the brand-new bubble, while the per-message status for the very same
   * frame had already gone quiet. Two surfaces reporting the same turn, disagreeing.
   *
   * `services/conciergeTurnFloor` owns it now, keyed on an unconditional per-send counter and
   * snapshotted during render, and both surfaces read that one value. The reason its header can
   * claim to fix this component is that it now feeds it.
   */
  if (!typing) return null;

  const fresh = latest && latest.seq > floor ? latest : null;
  const line = fresh ? conciergeActivityLine(fresh) : null;
  // NO SUBSTITUTION, only a tint. The previous version swapped the tool glyph for an alert icon and
  // suppressed the activity line once it judged us silent, on the reasoning that a stale "Reading
  // Kraken Auth's terminal" reads as work still in progress. That reasoning survives, but the icon
  // swap and the disappearing line were exactly the reflow the founder objected to — and the pulse
  // beside the line already says "still going" without claiming the call is still running. So the
  // line stays put in every state and only its ink moves.
  // THE GLYPH SURVIVES A CLAIM, the words do not — see the header. `line` still drives it, because
  // the mark says which KIND of work is running and that is a general fact about the column; the
  // sentence saying what it is doing about one message is the message's to tell.
  const Icon = line ? ACTIVITY_ICONS[line.icon] : null;
  // The words this row is entitled to. Null when a bubble is carrying them, which puts the row back
  // in exactly the shape it degrades to with no activity at all: pulse, glyph, and no claim.
  const words = activityClaimed ? null : line;
  // What a screen reader is given for the ROW: the line, or the name the row has always carried.
  // Driven by `words` rather than `line`, so a row that has yielded its sentence does not go on
  // announcing it — that would put the duplication back in the one channel where it is worse, since
  // the bubble's copy is read from the transcript a moment later. The waiting state is NOT appended
  // either — the host speaks it through the column's announcer, and saying it here as well produced
  // a duplicated "Sparkle is typing · Still waiting … Still waiting" on any AT that read both
  // (roborev 56122-M2).
  const spoken =
    words?.text ??
    // Several suites outside this file identify the indicator by this exact string.
    "Sparkle is typing";

  return (
    <div
      // NOT aria-hidden when it carries a line, unlike the bare pulse it replaces. "…" is decoration
      // a screen reader gains nothing from; "Read Kraken Auth's terminal" is the same information a
      // sighted user is getting, and it changes at most once per tool call rather than per token —
      // so it can be announced without the flooding that kept the thread itself off a live region.
      //
      // DRIVEN BY THE LINE ALONE, exactly as before this retune. The waiting state is spoken by the
      // host through the column's announcer instead — letting it flip these attributes would create
      // a live region in the same commit as its own first announcement, which is the failure mode a
      // stable region exists to avoid. (The old per-second counter was never announced either: it
      // changed every second, which is the flooding the thread is kept off a live region for. It no
      // longer exists in any channel.)
      aria-hidden={words ? undefined : true}
      aria-live={words ? "polite" : undefined}
      // The accessible name is the LINE when there is one, so what gets announced is the same thing
      // the sighted user is reading rather than the generic "typing" underneath it. It falls back to
      // the name this row has always carried, which several suites identify the indicator by.
      aria-label={spoken}
      data-testid={THINKING_INDICATOR_TESTID}
      data-liveness={liveness}
      style={{
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        // THE ENTIRE SIGNAL. Every other property here is identical in all three states on purpose:
        // no size, weight, icon or layout change, so nothing reflows and a slow turn costs a glance
        // rather than a sentence.
        color: INK[liveness],
        // The column is 360px wide and an agent name can be long, so the line truncates rather than
        // wrapping to three lines and shoving the conversation up on every tool call.
        maxWidth: "92%",
        minWidth: 0,
      }}
    >
      {Icon && <Icon size={12} aria-hidden style={{ flexShrink: 0 }} />}
      {words && (
        <span
          data-testid={THINKING_ACTIVITY_TESTID}
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {/* THE SUBJECT IS A LIVE CONTROL WHEN IT IS AN AGENT, not just words.
              The founder's ask for a spawn: *"once you have the agent ID … that would render as a
              pill so I would see it as Build 17 or whatever. And then as it renames, I would see it
              rename."* `AgentPill` binds to the ID and re-reads the roster on every render, so the
              rename lands IN PLACE here — no remount, nothing rewritten, the same pill changing its
              own words. That works because this component already sits inside `AgentPillProvider`
              (ConciergeColumn wraps ConciergeThread, which renders this): the roster arrives by
              CONTEXT, and a context update reaches a consumer regardless of any memo above it.
              Without a ref — an unresolved agent, or a subject that is a project or a PR — the line
              renders exactly as it always did, as plain words. */}
          {words.agentRef ? (
            <>
              {words.agentRef.before}
              <AgentPill agentId={words.agentRef.agentId} fallbackName={words.agentRef.name} />
              {words.agentRef.after}
            </>
          ) : (
            words.text
          )}
        </span>
      )}
      {/* index.css's existing "working on it" opacity breathe — no motion, reduced-motion safe.
          Kept in ALL states: with a line beside it it reads as "…and still going", which is the
          part the activity text cannot say on its own once the call has settled. */}
      <span className="sparkle-pulse">…</span>
    </div>
  );
}
