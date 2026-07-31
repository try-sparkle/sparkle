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
// A colour cannot be read by a screen reader, so the state is carried as text that never renders.
// That is not a loophole in "no text label": the complaint was visual noise, and dropping the
// announcement would have left a non-sighted user with the bare "…" this feature exists to improve
// on.
//
// It is carried TWO ways, and the redundancy is the point (roborev 56112-M1). A live region is
// announced from a CONTENT mutation in its subtree; an attribute-only change to `aria-label` on the
// region node is not reliably announced by NVDA/JAWS/VoiceOver. The first draft of this retune moved
// the state into `aria-label` alone and so most likely announced nothing at all at 30s or 60s —
// silently losing the very fallback it claimed to preserve, with a test that asserted the attribute
// rather than the announcement and could not catch it. So the state is now a clip-rect `<span>`
// (a real subtree mutation) AND appended to the label. Whichever an AT reads, it hears the same
// thing, and neither path can be the only one that works.
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
import { useState, type CSSProperties } from "react";
import { FiFolder, FiGitBranch, FiTerminal, FiUsers } from "react-icons/fi";
import type { IconType } from "react-icons";

import { C } from "../../theme/colors";
import { useConciergeActivityStore } from "../../services/conciergeActivity";
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import type { ConciergeLiveness } from "../../engine/conciergeLiveness";
import {
  conciergeActivityLine,
  type ConciergeActivityIcon,
} from "../../engine/conciergeActivityLine";
import { AgentPill } from "./AgentPill";

/** Feather glyphs, one per tool domain (no emoji as icons — house rule). Small and monochrome: this
 *  is a status line in a 360px column, not a badge. */
const ICONS: Record<ConciergeActivityIcon, IconType> = {
  agents: FiUsers,
  terminal: FiTerminal,
  workflow: FiGitBranch,
  workspace: FiFolder,
};

export const THINKING_INDICATOR_TESTID = "concierge-thinking";
export const THINKING_ACTIVITY_TESTID = "concierge-thinking-activity";
/** The clip-rect node carrying the state. Named so tests can subtract it when asking what is
 *  actually VISIBLE — the founder's constraint is about pixels, not about `textContent`. */
export const THINKING_STATE_TESTID = "concierge-thinking-state";

/** Same clip-rect shape as the column's announcer and RecapCard — this codebase has no sr-only
 *  utility, and inventing a second one would be the thing that drifts. */
const OFF_SCREEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

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

/**
 * What a screen reader is told, since it cannot be told a colour.
 *
 * Kept out of the DOM as an `aria-label`, never rendered — the founder's objection was to visual
 * noise, and a non-sighted user who lost this would be back to the bare "…" this whole feature
 * exists to improve on. The wording still reports what we have NOT received rather than diagnosing
 * the brain: 26% of turns are still running at 60s, so "your concierge is offline" would be a claim
 * the app cannot support.
 */
const SPOKEN_STATE: Record<ConciergeLiveness, string | null> = {
  idle: null,
  waiting: null,
  slow: "Still waiting",
  stalled: "Still waiting — nothing has come back",
};

export function ThinkingIndicator({ typing }: { typing: boolean }) {
  const latest = useConciergeActivityStore((s) => s.latest);
  const { liveness } = useConciergeLiveness();
  /** The turn boundary: `floor` is the activity counter as it stood when this turn began, so
   *  anything at or below it belongs to an earlier one. -1 rather than 0 so the very first call of
   *  an app run (seq 1) still clears it.
   *
   *  DERIVED DURING RENDER, not in an effect. An effect runs after the commit, so the false→true
   *  render — the very first frame of a new turn — would paint with the PREVIOUS turn's floor and
   *  show its last line as this turn's activity, and nothing would re-render to correct it until the
   *  next store write. Setting state during render is React's sanctioned answer to exactly this
   *  ("adjusting state when a prop changes"): the component re-runs before anything is committed, so
   *  the stale frame is never shown. */
  // The initializer covers a MOUNT that lands mid-turn (the column is remounted, the webview
  // reloads): the floor has to be taken then too, or the previous turn's last call would be shown
  // as this one's.
  const [turn, setTurn] = useState(() => ({
    typing,
    floor: typing ? (useConciergeActivityStore.getState().latest?.seq ?? 0) : -1,
  }));
  if (turn.typing !== typing) {
    setTurn({
      typing,
      // Only a STARTING turn moves the floor. Keeping it on the way down costs nothing and means the
      // floor is only ever read while typing anyway.
      floor: typing ? (useConciergeActivityStore.getState().latest?.seq ?? 0) : turn.floor,
    });
  }

  if (!typing) return null;

  const fresh = latest && latest.seq > turn.floor ? latest : null;
  const line = fresh ? conciergeActivityLine(fresh) : null;
  // NO SUBSTITUTION, only a tint. The previous version swapped the tool glyph for an alert icon and
  // suppressed the activity line once it judged us silent, on the reasoning that a stale "Reading
  // Kraken Auth's terminal" reads as work still in progress. That reasoning survives, but the icon
  // swap and the disappearing line were exactly the reflow the founder objected to — and the pulse
  // beside the line already says "still going" without claiming the call is still running. So the
  // line stays put in every state and only its ink moves.
  const Icon = line ? ICONS[line.icon] : null;
  // What a screen reader is given, in the same order of preference a sighted user reads it. The
  // state is APPENDED rather than substituted, so the announcement gains the waiting news without
  // losing the activity the sighted user can still see.
  const state = SPOKEN_STATE[liveness];
  const base =
    line?.text ??
    // The name this row has always carried, kept EXACTLY when there is nothing else to say —
    // several suites outside this file identify the indicator by it.
    "Sparkle is typing";
  const spoken = state ? `${base} · ${state}` : base;

  return (
    <div
      // NOT aria-hidden when it carries a line, unlike the bare pulse it replaces. "…" is decoration
      // a screen reader gains nothing from; "Read Kraken Auth's terminal" is the same information a
      // sighted user is getting, and it changes at most once per tool call rather than per token —
      // so it can be announced without the flooding that kept the thread itself off a live region.
      //
      // The WAITING state is announced for the same reason and a stronger one: it changes at most
      // twice in a turn, and it is the only notice a non-sighted user gets that their question has
      // gone nowhere. The old per-second counter was NOT announced — it changed every second, which
      // is exactly the flooding the thread itself is kept off a live region to avoid; it no longer
      // exists in either channel.
      aria-hidden={line || state ? undefined : true}
      aria-live={line || state ? "polite" : undefined}
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
      {/* THE ANNOUNCEMENT, and zero pixels. Clipped rather than `display: none` or `hidden`, both of
          which remove a node from the accessibility tree entirely — the point is that it IS read.
          Appearing and disappearing here is a subtree mutation in a live region, which is the thing
          an AT actually announces (see the header). */}
      {state && (
        <span data-testid={THINKING_STATE_TESTID} style={OFF_SCREEN}>
          {state}
        </span>
      )}
      {line && (
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
          {line.agentRef ? (
            <>
              {line.agentRef.before}
              <AgentPill agentId={line.agentRef.agentId} fallbackName={line.agentRef.name} />
              {line.agentRef.after}
            </>
          ) : (
            line.text
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
