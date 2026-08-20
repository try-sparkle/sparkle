// HOW A FINISHED ROW LOOKS — one definition, imported by every surface that shows recent work.
//
// The founder, 2026-08-18, after clicking `Concierge Agents +0 · 15 recently` and getting nothing:
// *"I'm trying to click on agents, but it's not doing anything. … But I wanna be able to see the
// recent ones as well as the active ones."*
//
// ⚠️ ONE CONSUMER TODAY, AND THAT IS THE FOUNDER'S EXPLICIT SCOPE — NOT AN OVERSIGHT.
//
// This started life serving two surfaces: the `Concierge Agents` row (research tasks) and the
// build-agent list (retired agents, off the `agent-life` ledger). The founder cut the second one
// while it was being built, in these words: *"we're talking about the concierge agents specifically
// and not regular build agents. I don't need to do anything different with regular build agents."*
// So the ONLY caller is `ConciergeAgentsRow`, and a build-agent row must keep looking exactly as it
// always has. Do not wire this into the agent sidebar on the assumption that it was always meant to
// go there — that is a scope decision a person already made in the other direction.
//
// It stays a module rather than three constants inlined into its one caller because what it actually
// holds is the DECISION below — why the axis is fill and not hue, and the leaf-only rule — which is
// the part that is expensive to rediscover and easy to get wrong the next time a surface wants to
// show finished work. If a second surface ever does adopt it, the contract is already stated once
// rather than reverse-engineered from a component; `ConciergeAgentsRow`'s own header records what a
// second copy of a derivation costs (the Improve Sparkle row "had a private copy of the logic, so a
// fix to the shared pipeline landed on every other row and silently missed it").
//
// ══ THE AXIS IS FILL, NOT HUE — AND THAT WAS A DECISION, NOT A DEFAULT ═════════════════════════
//
// The founder proposed a GREY dot for retired rows, explicitly as a suggestion rather than a spec.
// It was not taken, and the two reasons are worth keeping because they will both come back:
//
//   1. GREY IS ALREADY SPOKEN FOR. `AGENT_STATUS` in packages/ui/tokens.ts spends `C.muted` on
//      `idle` ("Done — your turn") and `new` ("New — not briefed"): rows that are ALIVE and quiet.
//      A retired row painted the same grey makes the column unable to say whether a quiet row is
//      finished forever or merely waiting to be briefed — and on the build-agent surface those two
//      genuinely sit side by side, so the collision is real rather than theoretical.
//
//   2. A FLAT GREY DESTROYS THE OUTCOME. `done`, `failed` and `cancelled` all retire. Flattening
//      them to one ink means a research run that DIED renders identically to one that ANSWERED —
//      in a list whose entire purpose is scanning fleet health. The recent section would be
//      uniformly uninformative, which defeats showing it at all.
//
// So the two facts travel on two INDEPENDENT channels:
//
//      HUE   → what happened   (done vs failed vs cancelled — unchanged, the existing taxonomy)
//      FILL  → is it happening (filled = live, hollow = finished)
//
// Nothing here adds, renames or re-tints a token. That is a hard constraint and not an aesthetic
// preference: `packages/ui/tokens.ts` was under concurrent edit when this landed (PR #2112, moving
// blocked-on-human from amber to red), and a second lane redefining a hue would have raced it. The
// ring is drawn from whatever ink the row's EXISTING status already resolves to.
//
// ══ WHY `ring` IS SAFE HERE, AND THE ONE PLACE IT WOULD NOT BE ════════════════════════════════
//
// `StatusDot`'s `ring` variant already carries a meaning: *a row UNDER this one is in the state the
// colour names* — the rollup disc a collapsed orchestrator draws. That meaning is unreachable on a
// LEAF row, because a leaf has nothing under it, so the channel is free for the rows this module
// governs and the two readings can never be presented at once.
//
// ⚠️ THE COROLLARY IS LOAD-BEARING: do NOT apply this treatment to a row that can own children.
// A retired PARENT would draw a ring that means "finished" beside rings that mean "my child is in
// this state", and a reader has no way to tell which. {@link RETIRED_DOT_VARIANT} is for leaves.
//
// ══ A RETIRED ROW MUST NEVER FEED A ROLLUP ════════════════════════════════════════════════════
//
// Stated here because it is the failure this whole change could reintroduce and it lives in the
// CALLER, not in this module — nothing below can enforce it. `ConciergeAgentsRow`'s header already
// gets this right (`researchRollupStatuses` filters to `isLive` first), and its comment says why:
// "a red that can never be cleared stops being a signal". A retired `failed` row rolled into a
// parent disc paints that parent red forever, for work nobody can act on. Whatever surface adopts
// this treatment must filter retired rows OUT of its rollup, its attention banding, and its badge
// counts, exactly as that row does.

/**
 * Is this row still happening, or is it history?
 *
 * Deliberately NOT a status. Every surface that shows recent work already has its own status
 * vocabulary (`AgentTabStatus`, `ResearchStatus`, the `agent-life` states) and this module refuses
 * to learn any of them — it takes the one bit each caller can answer for itself. A surface maps its
 * own notion of "finished" onto `retired` and keeps its taxonomy private.
 */
export type RowLiveness = "live" | "retired";

/**
 * The dot treatment for a finished row: HOLLOW.
 *
 * Exported as a constant rather than inlined at two call sites so a change is one edit and a drift
 * is impossible. See the header for why `ring` and not a grey fill, and for the leaf-only rule.
 */
export const RETIRED_DOT_VARIANT = "ring" as const;

/** The dot treatment for a row that is still happening: FILLED, exactly as every live row today. */
export const LIVE_DOT_VARIANT = "fill" as const;

/**
 * Which `StatusDot` variant this row draws.
 *
 * The whole of the dot half of the contract. Callers pass the result straight to `StatusDot`'s
 * `variant` and do not branch on liveness themselves — a caller-side ternary is the second copy
 * this module exists to prevent.
 */
export function dotVariantFor(liveness: RowLiveness): typeof LIVE_DOT_VARIANT | typeof RETIRED_DOT_VARIANT {
  return liveness === "retired" ? RETIRED_DOT_VARIANT : LIVE_DOT_VARIANT;
}

/**
 * The row TITLE's ink, given the ink a live row would use.
 *
 * The dot alone is 8px and the founder scans a column of these at speed, so the treatment is carried
 * by the title as well — a retired row's name drops from `cream` to `muted`. Taking the live ink as
 * a PARAMETER rather than importing `C` keeps this module free of the theme layer (it is pure logic,
 * unit-testable without a DOM) and lets a surface whose live ink is not `cream` still opt in.
 *
 * `mutedInk` is passed rather than read for the same reason. Both callers supply `C.cream` /
 * `C.muted`, which are CSS custom properties (`var(--c-cream)`), so the light/dark twin is handled
 * by the theme layer and never by a hardcoded hex here.
 */
export function titleInkFor(liveness: RowLiveness, liveInk: string, mutedInk: string): string {
  return liveness === "retired" ? mutedInk : liveInk;
}

/**
 * Should a row of this liveness be counted by a parent's badge or disc? Never, when retired.
 *
 * A one-line predicate that exists to give the rule in the header a NAME a caller can import, so
 * "retired rows are excluded from the rollup" is a thing the code says rather than a thing a comment
 * asks for. See the header for what a retired row rolled into a parent disc does to it.
 */
export function countsTowardRollup(liveness: RowLiveness): boolean {
  return liveness === "live";
}
