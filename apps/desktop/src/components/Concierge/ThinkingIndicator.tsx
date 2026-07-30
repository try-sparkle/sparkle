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
// WHAT IT ALSO SHOWS NOW: HOW LONG YOU HAVE BEEN WAITING (engine/conciergeLiveness). The pulse
// alone could not distinguish "thinking hard" from "this turn died twelve seconds ago and nothing
// will ever arrive" — and on 2026-07-29 the second case happened 149 times without the column ever
// changing. So from 5s the line states the elapsed time, and from 20s it says plainly that nothing
// has come back. Both are OBSERVED facts, which is why they are allowed here at all: rule 1 below
// forbids inventing a status, and a clock is not an invention.
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
import { useState } from "react";
import { FiAlertCircle, FiFolder, FiGitBranch, FiTerminal, FiUsers } from "react-icons/fi";
import type { IconType } from "react-icons";

import { C } from "../../theme/colors";
import { useConciergeActivityStore } from "../../services/conciergeActivity";
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import { elapsedLabel } from "../../engine/conciergeLiveness";
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
export const THINKING_ELAPSED_TESTID = "concierge-thinking-elapsed";

/** What the row says once nothing has come back for {@link OFFLINE_AFTER_MS}.
 *
 *  "yet" is doing real work: this is a report of what we have NOT received, not a diagnosis of the
 *  brain. The turn may still be alive and about to answer — 26% of turns are still running at 60s —
 *  and a line that said "your concierge is offline" would be a claim the app cannot support. What it
 *  CAN support, and what the human needs at exactly this moment, is "I asked 24 seconds ago and
 *  nothing has arrived". */
export const NO_ANSWER_YET_LABEL = "No answer yet";

export function ThinkingIndicator({ typing }: { typing: boolean }) {
  const latest = useConciergeActivityStore((s) => s.latest);
  const { liveness, silentMs, showsElapsed } = useConciergeLiveness();
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
  // SILENT, not merely slow. `offline` and `unavailable` both mean nothing has come back; the
  // stronger of the two is stated by the sticky strip above the compose box (ConciergeUnavailable),
  // so this row says the same modest thing in both — it is the *waiting* surface, not the verdict.
  const silent = liveness === "offline" || liveness === "unavailable";
  // The elapsed time rides on whichever line is showing. It is the one thing the column can always
  // say truthfully, so it survives when there is no tool activity to report.
  const elapsed = showsElapsed && silentMs !== null ? elapsedLabel(silentMs) : null;
  const Icon = silent ? FiAlertCircle : line ? ICONS[line.icon] : null;
  // What a screen reader is given, in the same order of preference a sighted user reads it.
  const spoken = silent
    ? `${NO_ANSWER_YET_LABEL}${elapsed ? ` · ${elapsed}` : ""}`
    : line
      ? `${line.text}${elapsed ? ` · ${elapsed}` : ""}`
      : // The name this row has always carried, kept EXACTLY when there is nothing else to say —
        // several suites outside this file identify the indicator by it.
        elapsed
        ? `Sparkle is typing · ${elapsed}`
        : "Sparkle is typing";

  return (
    <div
      // NOT aria-hidden when it carries a line, unlike the bare pulse it replaces. "…" is decoration
      // a screen reader gains nothing from; "Read Kraken Auth's terminal" is the same information a
      // sighted user is getting, and it changes at most once per tool call rather than per token —
      // so it can be announced without the flooding that kept the thread itself off a live region.
      //
      // The SILENT state is announced for the same reason and a stronger one: it changes at most
      // twice in a turn, and it is the only notice a non-sighted user gets that their question has
      // gone nowhere. The bare elapsed counter is NOT — it changes every second, which is exactly
      // the flooding the thread itself is kept off a live region to avoid.
      aria-hidden={line || silent ? undefined : true}
      aria-live={line || silent ? "polite" : undefined}
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
        // The alarm colour is the app's ONE red (see PRD/sparkle/concierge-status-bands — the second
        // alarm colour was deleted because a gold card and a red card both meant "go look").
        color: silent ? C.sienna : C.conciergeMuted,
        // The column is 360px wide and an agent name can be long, so the line truncates rather than
        // wrapping to three lines and shoving the conversation up on every tool call.
        maxWidth: "92%",
        minWidth: 0,
      }}
    >
      {Icon && <Icon size={12} aria-hidden style={{ flexShrink: 0 }} />}
      {silent && (
        <span style={{ whiteSpace: "nowrap" }}>{NO_ANSWER_YET_LABEL}</span>
      )}
      {/* SUPPRESSED WHILE SILENT, deliberately. A tool call resets the silence clock, so if we have
          gone quiet for 20s the newest activity line is at least that stale — and "Reading Kraken
          Auth's terminal" beside "No answer yet" reads as work still in progress, which is the one
          thing we have just established we cannot vouch for. */}
      {!silent && line && (
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
      {elapsed && (
        <span
          data-testid={THINKING_ELAPSED_TESTID}
          // Tabular figures so a counter ticking 9s → 10s does not shove the pulse sideways.
          style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums", opacity: silent ? 1 : 0.75 }}
        >
          · {elapsed}
        </span>
      )}
      {/* index.css's existing "working on it" opacity breathe — no motion, reduced-motion safe.
          Kept in BOTH states: with a line beside it it reads as "…and still going", which is the
          part the activity text cannot say on its own once the call has settled. */}
      <span className="sparkle-pulse">…</span>
    </div>
  );
}
