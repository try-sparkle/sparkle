// The recommended-action row for the actively-shown build agent, as a CONNECTED component.
//
// WHY THIS IS ITS OWN COMPONENT, AND WHY IT IS STILL KEYED BY agentId.
// `useSuggestions` was written on the assumption that one hook instance owns ONE agent for its
// lifetime — its own comments say so ("Per-agent (this hook instance owns one agent)" on
// handledSigs). It reset on the agent leaving your-turn, NOT on the agent id changing. Calling it
// once in ConciergeHost with a changing id broke every one of those assumptions at once, and the
// worst consequence was not cosmetic: `idle` is in YOUR_TURN, so switching from agent A to agent B
// kept A's buttons on screen until a compute for B committed (a round trip, or up to
// SETTLE_TICK_MS) — and the click handler resolves the target at click time, so clicking A's stale
// pill wrote A's keystroke into B's PTY. That is irreversible.
//
// Mounting this with `key={agentId}` gives each agent a genuinely fresh hook instance, which is
// what the hook was always written to expect.
//
// THE KEY IS NO LONGER THE ONLY THING STANDING BETWEEN A RE-AIM AND A MISDELIVERED PROMPT.
// useSuggestions now resets its own state on an agentId change — during RENDER, so no committed
// frame carries the previous agent's buttons — and its refs (plus the phone copy) in an effect
// cleanup. See the "RE-POINTING THIS INSTANCE AT A DIFFERENT AGENT" block there, and
// useSuggestions.reaim.test.tsx, which re-points a single un-keyed instance precisely because
// `key=` is what makes that case unreachable from here.
//
// The key stays anyway: it is free, it is the clearer expression of the ownership model, and
// belt-and-braces is the right posture for an irreversible PTY write. What CHANGED is that
// removing it would now be a performance regression rather than a correctness one.
//
// ---------------------------------------------------------------------------
// TWO "HONESTY RULES" THAT DO NOT APPLY HERE — do not re-derive them
// ---------------------------------------------------------------------------
// An earlier design for this row started from "the concierge box is cross-project and its only
// channel into an agent is TEXT (onSend → dispatchConciergeAnswer)", and drew two rules from it:
// drop `kind:"control"` buttons as un-routable, and send a `kind:"terminal"` button's LABEL
// ("2 · Yes") rather than its raw keystroke ("2\n"). Both are sound FROM THAT PREMISE, and the
// premise is false here — this row does not go through the compose box's text path at all, it goes
// through `applySuggestion`:
//   • control → executed as an APP action (closeBuildAgent). It touches no PTY, so it is not
//     "silently dead" in a text-only host; dropping it would remove a working Close Build Agent.
//   • terminal → the raw keystroke straight to the PTY, which is what a raw-mode Ink picker takes,
//     with nothing re-matching it. Sending the label as text instead would hand a live picker a
//     string to re-match — strictly more ways to mis-select. The readable label already IS what
//     reaches prompt history (`recordPickerTurn`), which is the concern that rule was reaching for.
//   • prompt → the host's own delivery (`onDeliverPrompt`), so it gets the same outcome reporting
//     and the same queue a typed message does.
// Pinned by services/suggestions/applySuggestion.test.ts, so re-deriving the rules fails there.
//
// Likewise `composerEmpty: true` below is NOT an oversight of the original row's "hide while the
// user is typing" term. That term exists because the build Composer's pill is an ABSOLUTE OVERLAY
// sitting on top of the textarea. This row is `layout="row"` — a static strip in its own box above
// the compose box — so it never covers anything the user is writing, and hiding it the moment they
// start typing would take the recommendation away exactly when they are deciding whether to type it
// out by hand. See also ComposeBox's placeholder overlay, which reserves no pill room for the same
// reason: at the 360px column the pill zone is wider than the whole textarea text column.
import { useCallback } from "react";
import { SuggestionRow } from "../composer/SuggestionRow";
import { applySuggestion } from "../../services/suggestions/applySuggestion";
import { useSuggestions } from "../../services/suggestions/useSuggestions";
import { useRuntimeStore } from "../../stores/runtimeStore";
import type { SuggestionButton } from "../../services/suggestions/types";
import type { AgentTabStatus } from "../../types";

/** Statuses where the agent has no live PTY to write into. A terminal-kind suggestion clicked in
 *  one of these would be a keystroke into nothing — writePty swallows "no such pty", so without
 *  this gate the row would clear and a learning event would be recorded for a click that never
 *  landed. The composer host gates exactly this; the concierge now does too.
 *
 *  TYPED, and that is the point. The first version was `new Set(["stopped", "failed",
 *  "preparing"])` — "failed" and "preparing" are paneState values, not AgentTabStatus members, so
 *  two of the three entries were dead and the gate quietly collapsed to "stopped". `errored` (the
 *  process crashed or exited) sailed through it, which is precisely the dead-terminal case the
 *  gate exists for. `Set<string>` let tsc say nothing; the annotation makes a wrong entry a
 *  compile error. */
const NO_PTY: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["stopped", "errored"]);

export function ConciergeSuggestions({
  agentId,
  agentName,
  /** Whether the ROW is rendered. The hook keeps running either way — auto-approve, auto-resume
   *  and the phone push live inside it and must not stop because the user is looking at the Plan
   *  board (roborev 53074). Only the pills are hidden. */
  visible = true,
  /** Deliver a prompt-kind suggestion. The host supplies its own relay so a prompt suggestion gets
   *  the same outcome reporting a typed message would. Resolve FALSE to veto. */
  onDeliverPrompt,
  /** Runs the whole click through the host's delivery queue. Wrapping only onDeliverPrompt left
   *  TERMINAL-kind buttons — the y/n and numbered picker pills, i.e. the common case — writing to
   *  the PTY outside the queue entirely, so tapping "2" during a still-routing send landed ahead of
   *  the earlier message (roborev 53119). The whole action queues now, not just its prompt branch. */
  onApply,
  /** Report a failure into the thread — every other concierge delivery path reports its outcome,
   *  and a click that threw should not be the one silent exception. */
  onFailure,
}: {
  agentId: string;
  agentName: string;
  visible?: boolean;
  onDeliverPrompt: (text: string) => Promise<boolean>;
  onApply: (run: () => Promise<boolean>) => Promise<boolean>;
  onFailure: (message: string) => void;
}) {
  // `composerEmpty` is TRUE unconditionally: this is a chat compose, not the terminal's, and hiding
  // the recommended action the moment the user starts typing would take it away exactly when they
  // are deciding whether to type it out themselves.
  const { buttons, dismiss, clear } = useSuggestions(agentId, true);
  const status = useRuntimeStore((s) => s.status[agentId]);
  const disabled = status !== undefined && NO_PTY.has(status);

  const onClick = useCallback(
    (b: SuggestionButton) => {
      void (async () => {
        try {
          if (
            await onApply(() =>
              applySuggestion(agentId, b, { disabled, deliverPrompt: onDeliverPrompt }),
            )
          ) {
            clear();
          } else if (disabled) {
            // A vetoed click was a completely silent no-op: nothing delivered, nothing cleared,
            // nothing said — on the one surface whose contract is that every delivery path reports
            // its outcome (roborev 53074). Say why instead.
            onFailure(`${agentName} isn't running, so I couldn't do that.`);
          }
        } catch {
          onFailure(`I couldn't run that on ${agentName}.`);
        }
      })();
    },
    [agentId, agentName, disabled, onDeliverPrompt, onApply, onFailure, clear],
  );

  return (
    <SuggestionRow
      layout="row"
      buttons={buttons}
      visible={visible}
      onClick={onClick}
      onDismiss={dismiss}
    />
  );
}
