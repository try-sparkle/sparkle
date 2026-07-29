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
import { FiFolder, FiGitBranch, FiTerminal, FiUsers } from "react-icons/fi";
import type { IconType } from "react-icons";

import { C } from "../../theme/colors";
import { useConciergeActivityStore } from "../../services/conciergeActivity";
import {
  conciergeActivityLine,
  type ConciergeActivityIcon,
} from "../../engine/conciergeActivityLine";

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

export function ThinkingIndicator({ typing }: { typing: boolean }) {
  const latest = useConciergeActivityStore((s) => s.latest);
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
  const Icon = line ? ICONS[line.icon] : null;

  return (
    <div
      // NOT aria-hidden when it carries a line, unlike the bare pulse it replaces. "…" is decoration
      // a screen reader gains nothing from; "Read Kraken Auth's terminal" is the same information a
      // sighted user is getting, and it changes at most once per tool call rather than per token —
      // so it can be announced without the flooding that kept the thread itself off a live region.
      aria-hidden={line ? undefined : true}
      aria-live={line ? "polite" : undefined}
      // The accessible name is the LINE when there is one, so what gets announced is the same thing
      // the sighted user is reading rather than the generic "typing" underneath it. It falls back to
      // the name this row has always carried, which several suites identify the indicator by.
      aria-label={line ? line.text : "Sparkle is typing"}
      data-testid={THINKING_INDICATOR_TESTID}
      style={{
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 13,
        color: C.conciergeMuted,
        // The column is 360px wide and an agent name can be long, so the line truncates rather than
        // wrapping to three lines and shoving the conversation up on every tool call.
        maxWidth: "92%",
        minWidth: 0,
      }}
    >
      {Icon && <Icon size={12} aria-hidden style={{ flexShrink: 0 }} />}
      {line && (
        <span
          data-testid={THINKING_ACTIVITY_TESTID}
          style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {line.text}
        </span>
      )}
      {/* index.css's existing "working on it" opacity breathe — no motion, reduced-motion safe.
          Kept in BOTH states: with a line beside it it reads as "…and still going", which is the
          part the activity text cannot say on its own once the call has settled. */}
      <span className="sparkle-pulse">…</span>
    </div>
  );
}
