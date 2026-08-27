// Reading the menu an agent is offering — the one picker question that is safe to ask from ANYWHERE.
//
// WHY THIS IS ITS OWN LEAF, and not simply a function in `services/conciergeTools/terminal`, where
// it lived and where its siblings (`selectPickerOption`, the writes) still live:
//
//   • `services/conciergeTools/terminal` is a DOMAIN module. Importing it for one read drags in the
//     dispatcher, the history search, the transcript registry and the snapshot machinery — including
//     `SNAPSHOT_MAX_LINES`, which `terminal.ts` reads at module scope. Any test that mocks
//     `../terminalScrollback` without that export then dies at COLLECTION, with zero test failures
//     to point at the cause. That is not hypothetical: it is the same trap the transcript-registry
//     extraction above line 400 of `terminal.ts` was cut to escape, which failed 16 suites the first
//     time, and it failed three more (`useSuggestions.{reaim,hook,settle}`) the moment
//     `suggestions/conciergeHandoff` reached for the reader directly.
//   • `services/improvementPassLatch.test.ts` asserts the composer's module graph cannot reach
//     `services/conciergeTools/terminal` at all. That latch is deliberate and it is the boundary
//     being honoured here, not worked around: the READ is a pure query over what is already on the
//     screen, and it is the WRITES — pressing an option, typing into a pane — that the composer graph
//     has no business reaching. Splitting the module splits exactly along that line.
//
// So the reader lives here, with no dependency of its own beyond the three leaves it genuinely needs,
// and `services/conciergeTools/terminal` re-exports it so its public surface is unchanged.
import { liveOptionsFor } from "./conciergeDispatch";
import { pickerFingerprint } from "./pickerFingerprint";
import { pickerParseDiagnosis, type PickerBlindness } from "./suggestions/heuristics";
import { getAgentScrollback } from "./terminalScrollback";

/** One option as the concierge sees it. `index` is what `select_picker_option` takes. */
export interface PickerOptionView {
  index: number;
  label: string;
}

export interface PickerOptionsRead {
  agentId: string;
  /** Empty when there is no menu on screen — a normal state, not an error. */
  options: PickerOptionView[];
  /** True when the agent has a live prompt with options right now. */
  present: boolean;
  /** Echo this back to `select_picker_option`. It identifies the MENU, so a different question with
   *  the same option labels (every numbered menu) cannot be answered by mistake.
   *
   *  EMPTY MEANS UNANSWERABLE, in either of two ways: there is no menu, or there is one but its
   *  question could not be located — and without the question there is nothing that distinguishes
   *  this ask from any other with the same option shape, which for both shapes that reach here is a
   *  global constant. `select_picker_option` refuses on an empty fingerprint rather than comparing
   *  it, so the two collapse to the same safe outcome and the caller never has to tell them apart. */
  fingerprint: string;
  /** WHY there is nothing to press, when `present` is false. Absent when a menu WAS read.
   *
   *  REPORTING, NOT A DECISION. Nothing branches on this and nothing may: the refusal is unchanged
   *  and does not soften for any value. It exists because an empty read used to be indistinguishable
   *  from an agent that is simply working, so the concierge could not tell the human WHICH agent
   *  needed a click and why — and no occurrence left a trace anyone could count afterwards, which is
   *  why bead sparkle-99o9a took four hand-observed incidents to characterise. */
  blind?: "pane-not-mounted" | PickerBlindness;
}

/** Read the options an agent is offering, so the caller can decide (or relay them to the human). */
export function readPickerOptions(agentId: string): PickerOptionsRead {
  const live = liveOptionsFor(agentId);
  if (live.length > 0) {
    return {
      agentId,
      options: live.map((o, index) => ({ index, label: o.label })),
      present: true,
      fingerprint: pickerFingerprint(agentId, live),
    };
  }
  // Empty. Say WHY — see `pickerParseDiagnosis`. The pane-not-mounted case is answered here rather
  // than by the parser because the parser is handed `""` either way and cannot tell "the agent has
  // no menu" from "this window cannot see that agent's terminal at all".
  const scrollback = getAgentScrollback(agentId);
  return {
    agentId,
    options: [],
    present: false,
    fingerprint: "",
    blind: scrollback === null ? "pane-not-mounted" : pickerParseDiagnosis(scrollback),
  };
}
