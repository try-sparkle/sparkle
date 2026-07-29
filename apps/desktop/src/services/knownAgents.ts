// ONE answer to "does this window know an agent with this id?", for every surface that gates on it.
//
// WHY THIS EXISTS. The concierge's terminal ops (services/conciergeTools/terminal) and the dispatch
// predicates (services/conciergeDispatch) both resolved an agent by scanning
// `projectStore.projects[].agents`. That array is the roster of the USER'S build agents, and it is
// not the set of agents the app runs: the Sparkle self-improvement agent ("Improve Sparkle") is an
// app-owned singleton pinned to the Agents Bar, working in an app-owned clone of the OSS client, and
// it is DELIBERATELY never a member of any project's `agents` array (see services/sparkleAgent —
// the `__sparkle_self__` namespace exists precisely so it cannot collide with a real agent UUID).
//
// The consequence was that the concierge had no route to it AT ALL. `get_agent_status` answered
//
//     { known: false, canAcceptInput: false, observed: true, status: "working", liveness: "local" }
//
// — a self-contradiction on its face: the same call reported that this window was reading a live
// "working" status for an agent it also reported as not existing. `send_to_agent_terminal` refused
// with `unknown-agent`, which is the gate that exists to catch a MODEL-INVENTED id, applied to the
// one agent id the app itself defines. And none of it was a mounting race: selecting the row could
// not fix it, because the roster scan can never find a row that is not in the roster.
//
// So resolution is a function, not an array scan, and it has three arms. They are ordered from most
// to least specific, and each one is a different KIND of knowledge:
//
//   (1) roster    — a real row in `projectStore`. Carries the full `AgentTab`, so callers that need
//                   `kind`, `runtime`, `terminalBriefedAt` etc. still get them.
//   (2) sparkle   — an id in the app-owned `__sparkle_self__` namespace that this window can see
//                   (a live status entry, or an open pane in some window). There is no `AgentTab`
//                   and there never will be; what the caller gets is the small set of facts that
//                   are true by construction — it is local, it is a build-ish agent with a PTY
//                   keyed by this id, and it is called "Sparkle".
//   (3) observed  — ANY id this window currently has a runtime status entry for. This arm is the
//                   invariant, not a convenience: a surface must never be able to say "I am reading
//                   this agent's live status" and "no such agent" in the same breath. It covers the
//                   ordinary races too — an agent closed a moment ago, a row that has not landed in
//                   the store yet — which used to produce the same contradiction on a smaller scale.
//
// Arm (2) is what makes `__sparkle_self__` a DOCUMENTED, STABLE address rather than an accident of
// arm (3): the Sparkle agent stays resolvable while its pane is open in another window, which is
// exactly when the concierge is most likely to be asked about it and least likely to have a local
// status entry for it.
//
// WHAT THIS DOES NOT DO. It does not admit the Sparkle agent into the roster. `projectStore` stays
// the user's project structure — persistence, reaping, worker rollups and the sidebar's ordering all
// iterate it, and quietly adding an app-owned singleton to that array would change all of them at
// once. Only the surfaces that ask "can I address this id?" go through here.
import { useProjectStore } from "../stores/projectStore";
import {
  useRuntimeStore,
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
} from "../stores/runtimeStore";
import { livenessOf, type AgentLiveness } from "./agentLiveness";
import { SPARKLE_AGENT_NAME, isSparkleAgentId } from "./sparkleAgent";
import type { AgentTab } from "../types";

/** WHICH arm resolved the agent — see the header. Reported so a caller can explain what kind of
 *  "known" it is holding rather than flattening three different facts into one boolean. */
export type KnownAgentSource = "roster" | "sparkle" | "observed";

export interface KnownAgent {
  id: string;
  source: KnownAgentSource;
  /** A display name. From the roster row where there is one; the app-owned constant for Sparkle;
   *  absent for an `observed`-only id, which by definition has no record to name it. */
  name?: string;
  /** `unknown` ONLY for the `observed` arm, where there is no record saying which runtime it is.
   *  Callers must not read `unknown` as `cloud` — see `isCloudAgent` in conciergeDispatch, which
   *  refuses only on evidence. */
  runtime: "local" | "cloud" | "unknown";
  /** The project-store row, when the roster arm resolved it. Absent for the other two arms — there
   *  is no `AgentTab` for the Sparkle agent, and inventing a synthetic one would put a fake row in
   *  front of every helper that takes an `AgentTab` and expects a real one. */
  tab?: AgentTab;
}

/** The open-pane set, built EXACTLY as `handleGetState` and `getAgentStatus` build it: in-memory
 *  merged with the persisted set on every call. `runtimeStore.openAgentIds` is merged with disk only
 *  at open()/close() time, so a window's in-memory copy goes stale in between; re-reading the
 *  persisted set each call is what keeps two surfaces from disagreeing about the same agent
 *  (roborev 53406 / , then 54546 when the second surface skipped it). */
export function openAgentIdSet(): Set<string> {
  const rt = useRuntimeStore.getState();
  return new Set(mergeOpenAgentIds(rt.openAgentIds ?? [], readPersistedOpenAgentIds()));
}

/** The roster row for an agent, or undefined. The arm-(1) lookup, exported because two callers
 *  legitimately want ONLY a real row (the ones that need `AgentTab` fields). */
export function findRosterAgent(agentId: string): AgentTab | undefined {
  return useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents)
    .find((a) => a.id === agentId);
}

/**
 * Resolve `agentId` to something addressable, or `undefined` if this window knows nothing about it.
 *
 * `undefined` still means what it always meant — an id that is stale, closed, or invented — which is
 * what keeps the `unknown-agent` refusal on the write path doing its job. What changed is that the
 * app's OWN agent, and any agent this window is actively observing, no longer land there.
 */
export function findKnownAgent(agentId: string): KnownAgent | undefined {
  const tab = findRosterAgent(agentId);
  if (tab) {
    return {
      id: agentId,
      source: "roster",
      name: tab.name,
      runtime: tab.runtime === "cloud" ? "cloud" : "local",
      tab,
    };
  }
  const rt = useRuntimeStore.getState();
  const liveness = livenessOf(agentId, rt.status, openAgentIdSet());
  if (isSparkleAgentId(agentId) && liveness !== "unknown") {
    // Local by construction: the Sparkle agent runs `claude` in an app-owned worktree on THIS
    // machine (components/SparkleAgentPane, services/improvementPass). There is no cloud variant.
    return { id: agentId, source: "sparkle", name: SPARKLE_AGENT_NAME, runtime: "local" };
  }
  // Arm (3). Narrower than arm (2) on purpose: a live status entry proves this window is watching
  // SOMETHING, but not what runtime it is, so `runtime` stays "unknown" rather than guessing local.
  if (liveness === "local") return { id: agentId, source: "observed", runtime: "unknown" };
  return undefined;
}

/** The liveness of an id, using the same open-set construction as everything else here. Exported so
 *  a caller that already resolved a `KnownAgent` does not rebuild the merged set a second time. */
export function knownAgentLiveness(agentId: string): AgentLiveness {
  return livenessOf(agentId, useRuntimeStore.getState().status, openAgentIdSet());
}
