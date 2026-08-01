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
import { resolveSideProject } from "../engine/pairs";

/** Does the pair on `side` have a selected agent? `null` side → nothing is patched, so no.
 *
 *  EVERY INPUT IS SUBSCRIBED. The first cut read `pairAssignment` imperatively through
 *  `getState()` inside the projectStore selector, so the hook joined three stores but only reacted
 *  to two — and `ConciergeHost`, unlike `Workspace` and `AgentSidebar`, subscribes to no pair state
 *  of its own. Move the right pair's only project to the left and the root flips to "off" while the
 *  column, waking on nothing, keeps the stale snapshot and stays flooded: roborev 55386's
 *  contradiction reproduced one store later (roborev 55490). It also made the snapshot depend on
 *  state outside its own subscription, which is what `useSyncExternalStore` forbids.
 *
 *  The far end is resolved through `resolveSideProject` — the same chain `Workspace` renders from —
 *  rather than a `find` over the assignment map. See that function for what the shortcut got wrong. */
function useFarEndHasAgent(side: PairSide | null): boolean {
  const assignment = useUiStore((s) => s.pairAssignment);
  const openProjectIds = useUiStore((s) => s.openProjectIds);
  const leftProjectId = useUiStore((s) => s.leftProjectId);
  // THE PROJECT SELECTOR RETURNS A BOOLEAN, and closes over the SUBSCRIBED ui values above.
  //
  // Subscribing to `s.projects` and doing the work outside is the same code and a much worse
  // subscription: every `set((s) => ({ projects: mapProject(...) }))` in projectStore — agent status,
  // rename, prompt, alerts, reorder, dozens of them — replaces the array identity, so every consumer
  // of these hooks would re-render on any project write anywhere in the app. ConciergeHost has no
  // projectStore subscription of its own and top-level AgentSidebar takes only stable action refs, so
  // both would go from "wakes when this boolean flips" to "wakes on every write", defeating
  // MemoAgentSidebar (roborev 55539). Reading the ui values through `getState()` instead would restore
  // the stale-snapshot bug this hook exists to fix, so it has to be a closure over subscribed values.
  return useProjectStore((s) => {
    if (side === null) return false;
    // The RIGHT pair's selection is `selectedProjectId` — "the current project" to the rest of the
    // app — and the left pair has its own slot. Same asymmetry `Workspace` documents at its own call.
    const selectedForSide = side === "left" ? leftProjectId : s.selectedProjectId;
    const project = resolveSideProject(side, s.projects, openProjectIds, assignment, selectedForSide);
    return (project?.selectedAgentId ?? null) !== null;
  });
}

/** The side the shell should DRAW as wired: the patched side, or `"off"` when nothing is selected in
 *  it. */
export function useEffectiveWired(): WiredSide {
  const wired = useCableStore((s) => s.wired);
  const farEndHasAgent = useFarEndHasAgent(wired === "off" ? null : wired);
  // THE IMPROVE-SPARKLE PANE IS A VALID FAR END EVEN WITH ZERO BUILD AGENTS (bead sparkle-0rf5). The
  // app-owned Sparkle agent is never a `project.agents` member (services/knownAgents), so
  // `useFarEndHasAgent` — which asks `project.selectedAgentId !== null` — reads the patched side as
  // empty and `effectiveWired` darkens the cable on the exact surface whose whole purpose is that
  // connection: the click patches the store, the projection forces the side back to "off", and the
  // mount is a visual no-op. Counting an active sparkle pane as an occupied far end lights it. (This
  // rides the GLOBAL `activeSpecial` — the pane is not yet pair-scoped; see the bead — so with two
  // pairs the patched side is whichever the click chose, which is exactly the side the cable names.)
  const sparkleActive = useUiStore((s) => s.activeSpecial === "sparkle");
  return effectiveWired(wired, farEndHasAgent || sparkleActive);
}

/** Does THIS pair hold a cable that is actually connected? The projected form of `pairIsLive`, for
 *  the row geometry and any other purely visual consumer.
 *
 *  Subscribes to the cable as a BOOLEAN rather than reading the enum through `useEffectiveWired`,
 *  which is what keeps a sidebar from re-rendering on every unrelated cable move — a patch into the
 *  OTHER pair, an overlay floating. Written the short way for one commit, it took the enum and
 *  silently dropped that narrowing while the comment at its call site still promised it. */
export function usePairIsLive(pair: PairSide): boolean {
  const patched = useCableStore((s) => s.wired === pair);
  const farEndHasAgent = useFarEndHasAgent(patched ? pair : null);
  return patched && farEndHasAgent;
}
