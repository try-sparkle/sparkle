// WHY A MOUNTED SEND WAS REFUSED — one cause, one sentence, and the two are not the same fact.
//
// Pure. No React, no stores, no Tauri, no DOM — same convention as `composerRoute`, `conciergeRouter`
// and `shellResolve`, and for the same reason: the rule that explains a non-delivery to the founder
// is the last rule in this app that should need a rendered tree to test.
//
// ══ THE PROBLEM THIS EXISTS TO REMOVE (bead sparkle-gyvjyt) ══════════════════════════════════════
// The founder, across several days and several builds: *"I'm still unable to send in the mounted pane
// for Improve-Sparkle. I don't know where we are in that work getting done."*
//
// Every one of those rounds had to begin by GUESSING which gate fired, because the mount refusal said
// the same thing whatever the cause:
//
//     "<Agent> can't take a message right now, so I didn't send that. Your words are back in the box."
//
// That sentence is true of all of them and diagnostic of none. It is reached from two structurally
// different states — see {@link MountRefusalCause} — and for the app-owned Sparkle agent BOTH are
// documented in their own source as TRANSIENT and routine, which is exactly the shape a reader cannot
// tell from a permanent break. The founder could not distinguish them, and neither could the agent
// reading his report; several rounds of work were spent re-deriving from a paraphrase which gate had
// fired. Copy is the only instrument pointed at this, so the copy has to carry the cause.
//
// ══ WHY THIS IS NOT SIMPLY "ADD MORE DETAIL" ════════════════════════════════════════════════════
// Each sentence names the state AND the gesture that clears it, because the two causes have DIFFERENT
// remedies and telling the founder the wrong one costs him the message a second time:
//   • nothing is addressable under the pin  → the mount is what is missing; re-mount the row.
//   • addressable, but no live session yet   → the mount is fine; the pane is still coming up, so
//                                              the remedy is to wait, and re-mounting achieves nothing.
// A single "try again" would be right for one of these and misleading for the other.

/**
 * WHICH gate refused this mounted send.
 *
 * TWO arms, and the count is the finding — this module shipped its first cut with three and its
 * first-first cut with two, and BOTH carried an arm that nothing could produce (roborev 65163, then
 * 65167). Copy the founder can never be shown is not harmless: it hides which arm is really
 * answering, and it makes the module read as more discriminating than it is.
 *
 * ══ WHY THERE IS NO "RESOLVES, BUT HAS NO LIVE SESSION" ARM ═════════════════════════════════════
 * Because the two predicates the caller holds are NESTED, not independent — for every id, not just
 * the app-owned one. `hasAim` is `conciergeFeed.isPromptableTarget`, whose roster arm is
 * `allAgents(feed).some(...)` over `feed.projects`, and `buildConciergeFeed` maps
 * `useProjectStore.projects` straight through with no filtering and no synthesized rows.
 * `canAcceptInput` is `agentCanAcceptPrompt` = `findKnownAgent(id) !== undefined`, whose FIRST arm
 * is `findRosterAgent` over that same store. So a feed member is always a roster member:
 *
 *     hasAim  ⟹  canAcceptInput          (roster arm: nested lookups over one store)
 *     hasAim  ⟹  canAcceptInput          (sparkle arm: `findKnownAgent(id)?.source === "sparkle"`
 *                                         trivially implies `findKnownAgent(id) !== undefined`)
 *
 * — and `hasAim && !canAcceptInput` is therefore unsatisfiable. The single residual path is a STALE
 * feed snapshot naming an agent that was just deleted, and for that one the "give it a moment"
 * remedy is actively wrong: the agent is gone and waiting will not bring it back. `no-target`'s
 * "mount it again and resend" is the correct answer there, so the stale snapshot needs no arm of
 * its own either.
 *
 * The arm and its sentence are therefore DELETED rather than re-derived from a liveness fact. If a
 * genuine resolves-but-dead state ever exists, add it back WITH a test that reaches it through the
 * real predicates — not through a mock that decouples them, which is how it survived twice.
 */
export type MountRefusalCause =
  /**
   * NO USABLE AIM. The pinned id resolves to nothing this window can address: a build agent that
   * left the feed (closed, deleted, project unloaded), or one still named by a stale feed snapshot.
   * Cleared by mounting something that exists.
   */
  | "no-target"
  /**
   * THE APP-OWNED PANE IS NOT OPEN HERE. The self agent's only route to this refusal. Its two
   * predicates collapse harder than the nesting above — for a sparkle id BOTH reduce to the very
   * same `findKnownAgent(id)` call, since that id is never a feed member — so what the refusal
   * actually reports is `livenessOf(...) === "unknown"`: no local status entry AND no open pane in
   * the merged open-set this window can see.
   *
   * ITS REMEDY IS RE-OPENING THE ROW, AND THAT IS DERIVED RATHER THAN CHOSEN: the row's mount half
   * calls `open(sparkleAgentId)` (AgentSidebar), which puts the id INTO that open-set and moves
   * `livenessOf` off `unknown` — so the gesture that refused is literally the gesture that clears
   * it. That is why this is its own arm and not a re-label of `no-target`, whose sentence points at
   * mounting something else.
   */
  | "pane-not-open";

/**
 * Classify the refusal. Total: the caller only reaches this when `addressable` is false.
 *
 * `selfAgent` is the ONLY discriminator, and that is the whole correction. `hasAim` and
 * `canAcceptInput` are deliberately NOT parameters: they nest (see the type's header), so consulting
 * them can only produce an answer that looks derived and is not — which is exactly what the two
 * previous cuts of this function did.
 */
export function mountRefusalCause(i: {
  /** `isSparkleAgentId(target.agentId)` — the app-owned Improve Sparkle agent. */
  selfAgent: boolean;
}): MountRefusalCause {
  return i.selfAgent ? "pane-not-open" : "no-target";
}

/**
 * The sentence the founder reads, naming the cause and the gesture that clears it.
 *
 * The caller interpolates the agent's name itself for the rich-text thread rendering, so this
 * returns the TAIL and {@link mountRefusalText} the whole line. ONE STRING FOR BOTH SURFACES: a
 * mounted send shows the thread line OR the mounted notice row, never both, so nothing on screen
 * could catch them disagreeing — which is how the pair drifted apart the first time this shape was
 * written.
 */
export function mountRefusalTail(cause: MountRefusalCause): string {
  switch (cause) {
    case "pane-not-open":
      return " is mounted, but this window can't see its pane open right now — so I didn't send that, and your words are back in the box. Click the Improve Sparkle row to open it again, then resend.";
    case "no-target":
      return " isn't reachable from this window right now, so I didn't send that — your words are back in the box. Mount it again and resend.";
  }
}

/** The whole line, for the plain-text mounted notice row. Shares {@link mountRefusalTail} with the
 *  thread rendering so the two cannot say different things about one refusal. */
export function mountRefusalText(name: string, cause: MountRefusalCause): string {
  return `${name}${mountRefusalTail(cause)}`;
}
