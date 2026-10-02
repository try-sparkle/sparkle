// THE ONE STRING A ROW'S STATUS DISC HOVERS AS.
//
// ── WHY THIS FILE EXISTS (bead sparkle-uklivz) ─────────────────────────────────────────────────
// The disc renders exactly ONE `title`, and until this module it was picked by an override chain
// spread across THREE files: `AgentSidebar` decides whether a rollup label overrides the row
// (`dotLabel`), `AgentRow` folds in the founder-ask (`dotLabel ?? FOUNDER_ASK_LABEL[askFor(st)]`),
// and `StatusDot` supplies the taxonomy fallback (`label ?? AGENT_STATUS[status].label`). Nothing
// in any one of those files states what the other two will do.
//
// That is a rendering detail with a testing consequence, and the consequence is the defect. A test
// asserting a row is NOT in some state queries `queryByTitle(SOME_LABEL)` and gets `null` — but
// `null` is ALSO what it gets when the row IS in that state and the chain happened to paint the
// OTHER string. Two measured instances, both green over a check that could not fail:
//   * `queryByTitle(AGENT_STATUS.blocked.label)` — a build row NEVER hovers as "Blocked", because
//     `askFor("blocked")` is `unstick`, so the disc says "Needs unsticking".
//   * `queryByTitle(AGENT_STATUS.waiting.label)` — same shape: `askFor("waiting")` is `answer`, so
//     the disc says "Answer a question ›" and "Needs you" appears nowhere.
// Five separate review findings on one branch traced back to this single property.
//
// So the chain is resolved HERE, once, and every painter and every test reads it through this
// function. A test that hardcodes one of the candidate strings is re-creating the defect; use
// `expectedDotTitle` in `statusDotTestUtils`, which is this function with the test's own spelling.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { askFor, FOUNDER_ASK_LABEL } from "../engine/founderAsk";

export interface StatusDotTitleInput {
  /** The row's EFFECTIVE status — after every overlay, i.e. what it actually renders. */
  status: AgentTabStatus;
  /** The caller's override, where there is one. Today's only source is an orchestrator head whose
   *  disc summarizes its folded workers rather than its own PTY state (`AgentSidebar`'s
   *  `dotLabel={rollupOverrides ? rollupLabel(rollup) : undefined}`). It wins because it describes a
   *  SUBTREE, which neither the row's ask nor its status does. */
  dotLabel?: string;
  /** Does THIS SURFACE overlay the founder-ask?
   *
   *  ⚠️ NOT EVERY DISC DOES, and the flag is here because folding the ask in unconditionally is a
   *  silent behaviour change to three other surfaces. A BUILD ROW (`AgentRow`) names the founder's
   *  next action — "Needs unsticking" rather than "Blocked" — because the founder's complaint was
   *  that he could not tell what a red row wanted without opening it. The Sparkle row, the concierge
   *  row and the TopBar cluster report a MACHINE's condition and stay on the taxonomy label; the
   *  sparkle disc hovering as "Errored" is pinned by `AgentSidebar.sparkleDot.test.tsx`.
   *
   *  It is a flag rather than a caller-supplied ask so `askFor` is still called in exactly one
   *  place: the caller says WHICH SURFACE it is, never which STRING that implies. */
  withFounderAsk?: boolean;
  /** `half` is a worker's sub-disc in the TopBar cluster and carries the nesting in its title. */
  shape?: "dot" | "half";
}

/**
 * The title the disc for `status` is painted with — the full override chain, resolved.
 *
 * Precedence, highest first:
 *   1. `dotLabel` — the caller speaking about something the row's own status cannot (the rollup).
 *   2. The FOUNDER-ASK, on a surface that carries one (`withFounderAsk`) and for a status that
 *      raises one. `AGENT_STATUS[st].label` names the AGENT's condition ("Blocked"); the ask names
 *      the FOUNDER's next action ("Needs unsticking"), which is what he was missing. All four
 *      red-tier statuses raise one, so on a build row the taxonomy label is NEVER what a red disc
 *      paints — which is exactly why a by-title absence query written from that table cannot fail.
 *   3. The taxonomy label, for every calm row — where there is no ask and the condition is the only
 *      thing to say.
 */
export function statusDotTitle({
  status,
  dotLabel,
  withFounderAsk = false,
  shape = "dot",
}: StatusDotTitleInput): string {
  // WRITTEN AS THREE ASSIGNMENTS RATHER THAN ONE `??` CHAIN, on purpose: each level of the
  // precedence is then a line a mutation check can take away on its own, so "the ask outranks the
  // taxonomy label" is a claim some test has to grip rather than a sentence in this comment. Folded
  // into one expression, the whole chain is a single candidate and a test can pin it by accident.
  const ask = withFounderAsk ? askFor({ status }) : null;
  // `: string` and not the inferred literal union — `AGENT_STATUS[...].label` narrows to the
  // twelve taxonomy phrases, and neither an ask label nor a caller's rollup label is one of them.
  let text: string = AGENT_STATUS[status].label;
  if (ask !== null) text = FOUNDER_ASK_LABEL[ask];
  if (dotLabel !== undefined) text = dotLabel;
  return shape === "half" ? `${text} (sub-agent)` : text;
}
