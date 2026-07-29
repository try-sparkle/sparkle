// The ONE rule for "what do we call this agent" (bead sparkle-qd80).
//
// Claude Code's own session title wins (it's derived from the real conversation), then the
// auto-namer's title, then the fallback name the agent was created with. This had been written out
// four separate times — the concierge feed, the roster publisher, the cross-window attention
// publish, and the concierge compose box's send target — which is four places to drift.
//
// ...EXCEPT WHEN THE NAME IS AUTHORITATIVE, which is the correction below and the reason this
// comment is longer than the function.
//
// `namePinned` (the human renamed it) and `selfNamed` (the agent named itself through the
// sparkle-control `rename_agent` op) both mean "this name is chosen, stop auto-naming". Both setters
// clear `autoNameVariants` for exactly that reason — the sidebar prefers variants over `name`, so a
// stale variant would keep winning — but NEITHER clears `aiTitle`, and `aiTitle` sat at the FRONT of
// the chain above. So an agent that renamed itself kept answering with the title Claude Code had
// derived from its first turn, on every surface that asked this function, while every surface that
// read `agent.name` answered with the chosen name.
//
// That is not a cosmetic split. One agent had two names in two places the user reads at the same
// time: "Concierge Issue Triage" in the get_state roster and the build column, "Debug Sparkle
// concierge agent control and capacity issues" in the needs-you feed the concierge receives. The
// user clicked a row labelled one thing while the concierge referred to it by the other and
// concluded, reasonably, that something was broken. Neither string was a task/goal title
// deliberately shown beside the name — they were two answers to the same question.
//
// Clearing `aiTitle` at the two setters would have been the other fix, and it is the wrong one:
// `aiTitle` is not display state, it is the RACE ANCHOR the auto-namer compares against
// (`autoRenameAgent`'s `seenAiTitle` argument, and `applyAiTitle`'s own no-op check). Blanking it
// would make a stale Haiku result look current. The title is still worth recording; it just does not
// get to outrank a chosen name.
//
// Pure and DOM-free so it's unit-testable under the node env.
import type { AgentTab } from "../types";

/** The fields the rule reads. A `Pick`, not the whole `AgentTab`, so a caller holding a projection
 *  (the roster publisher's rows, the feed's) can ask without materializing one. */
export type NameableAgent = Pick<
  AgentTab,
  "aiTitle" | "autoNameVariants" | "name" | "namePinned" | "selfNamed"
>;

/** The name every surface shows for an agent. */
export function agentDisplayName(a: NameableAgent): string {
  // A chosen name is the answer, full stop — see the header. `name` is where both setters put it.
  if (a.namePinned || a.selfNamed) return a.name;
  // THE AUTO-NAME OUTRANKS THE SESSION TITLE, and the order used to be the other way round — which
  // was the same defect as above, one branch over. `aiTitle` is deliberately allowed to GO STALE:
  // `autoRenameAgent` renames past an existing title whenever the caller's `seenAiTitle` still
  // matches (that check exists to reject a Haiku result the title overtook mid-flight, not to freeze
  // the name), and it updates `name` and `autoNameVariants` while leaving `aiTitle` untouched — so
  // an agent whose work moved on from its first turn carries a superseded title. The sidebar reads
  // `autoNameVariants?.title || name` and never looks at `aiTitle`, so leading with the title showed
  // the first-turn name everywhere the shared rule was asked and the current one on the row itself.
  //
  // Nothing is lost by the reorder: `applyAiTitle` sets `autoNameVariants = nameFromTitle(t)`, which
  // is `{ title: t.trim() }` — byte-identical to the title it just applied. So a LIVE title still
  // wins (it is sitting in both fields); only a SUPERSEDED one loses, which is the whole point.
  // The reverse staleness cannot occur: if a title lands while a Haiku call is in flight, the
  // `seenAiTitle` mismatch makes `autoRenameAgent` bail, so `autoNameVariants` is never the older of
  // the two.
  return a.autoNameVariants?.title || a.aiTitle || a.name;
}
