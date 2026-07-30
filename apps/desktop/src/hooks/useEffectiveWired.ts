// ONE PLACE THAT ANSWERS "IS THE CABLE ACTUALLY CONNECTED", for every surface that draws it.
//
// `engine/cable.effectiveWired` is the rule; this is the subscription. It exists because the rule
// needs three stores to evaluate — the cable's own side, the pair assignment, and the projects — and
// each consumer having its own copy of that join is how the shell came to contradict itself: the
// root said `data-wired="off"` while the concierge column still flooded and the sidebar rows still
// drew their joints open (roborev 55386).
//
// USE THIS FOR VISUAL TREATMENT ONLY. Circuit MEMBERSHIP — `data-wired-pair`, and the
// `unbindsOnPointerDown` gate — keys off the raw store value on purpose; see the note on
// `effectiveWired`.
import { useCableStore } from "../stores/cableStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { effectiveWired, type PairSide, type WiredSide } from "../engine/cable";
import { sideOf } from "../engine/pairs";

/** The side the shell should DRAW as wired: the patched side, or `"off"` when nothing is selected in
 *  it. Subscribes narrowly — a boolean and an enum — so an unrelated projectStore write does not
 *  re-render every consumer. */
export function useEffectiveWired(): WiredSide {
  const wired = useCableStore((s) => s.wired);
  const farEndHasAgent = useProjectStore((s) => {
    if (wired === "off") return false;
    const assignment = useUiStore.getState().pairAssignment;
    // The project the cable names is whichever one sits on that side. `sideOf` defaults to "right",
    // so the single-pair shell resolves exactly as it did before the left pair existed.
    const project = s.projects.find((p) => sideOf(assignment, p.id) === wired);
    return (project?.selectedAgentId ?? null) !== null;
  });
  return effectiveWired(wired, farEndHasAgent);
}

/** Does THIS pair hold a cable that is actually connected? The projected form of `pairIsLive`, for
 *  the row geometry and any other purely visual consumer. */
export function usePairIsLive(pair: PairSide): boolean {
  return useEffectiveWired() === pair;
}
