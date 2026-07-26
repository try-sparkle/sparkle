// The ONE rule for "what do we call this agent" (bead sparkle-qd80).
//
// Claude Code's own session title wins (it's derived from the real conversation), then the
// auto-namer's title, then the fallback name the agent was created with. This had been written out
// four separate times — the concierge feed, the roster publisher, the cross-window attention
// publish, and the concierge compose box's send target — which is four places to drift.
//
// Pure and DOM-free so it's unit-testable under the node env.
import type { AgentTab } from "../types";

/** The name every surface shows for an agent. */
export function agentDisplayName(a: Pick<AgentTab, "aiTitle" | "autoNameVariants" | "name">): string {
  return a.aiTitle || a.autoNameVariants?.title || a.name;
}
