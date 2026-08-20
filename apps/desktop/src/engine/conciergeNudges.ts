// TURNING AN AGENT INTO A NUDGE CARD — the card's text and the buttons on it.
//
// Moved verbatim out of components/ConciergeHost.
//
// NOT `engine/nudges.ts`, deliberately, despite the name: that module is the BRANCH-STALENESS
// thresholds (`STALE_WARN`, `growNudge`) and shares nothing with this but the English word. Folding
// concierge card construction into it would make one file mean two things, which is the failure this
// whole decomposition is against.
import type { ConciergeAgent } from "../services/conciergeFeed";
import type { AgentTabStatus } from "../types";
import { ASKING_BANDS, bandOfStatus } from "./buildSections";
import type { ConciergeNudge, ConciergeNudgeAction } from "../components/Concierge";
import { findKnownAgent } from "../services/knownAgents";
import { getAgentViewport, type TerminalViewport } from "../services/terminalViewport";
import {
  BLIND_STATUS_LABEL,
  blindAnnotation,
  blindReasonSentence,
  screenReadability,
  statusClaimsScreenContent,
} from "./screenReadability";

/** The LABELLED buttons a card carries — things the AGENT can be told to do, which today is Approve
 *  and only Approve.
 *
 *  "SHOW ME" AND "MUTE" ARE BOTH GONE FROM THIS LIST, for different reasons, and neither is a
 *  deletion (see the header of Concierge/NudgeCard):
 *   • Show me was removed outright. The card now renders the agent as a real `AgentPill` that
 *     navigates, and the whole card remains a click target, so a third copy of the same affordance
 *     was pure width in a column whose scarcest resource is width.
 *   • Mute moved to a CONTROL on the card rather than an action in this list, alongside the new [x].
 *     Both are properties of the ALARM — every card has them regardless of what its agent is doing —
 *     whereas an entry here is a property of the agent's current work. `NudgeCard` fires them
 *     through the same `onNudgeAction` channel under `NUDGE_MUTE_ACTION` / `NUDGE_DISMISS_ACTION`,
 *     so nothing about the wiring changed, only where they are drawn.
 *
 *  Approve stays a labelled button on purpose: it is a one-tap relay into a live terminal, there is
 *  no other place in the app to do it from, and an icon would make an irreversible action ambiguous. */
/** The action id that reveals the agent's own pane instead of relaying anything into it. */
export const NUDGE_OPEN_ACTION = "open";

/** Does this row owe the human something — an on-screen question, an approval prompt, a stall, a
 *  crash? It is what floors a blocker's actions at "Open agent" (see {@link actionsFor}).
 *
 *  ══ BOTH HALVES ARE IMPORTED, NEITHER IS RE-LISTED (roborev 65893 then 65897, both Medium) ═════
 *  This has now been wrong twice, in the same place, for the same reason — worth stating so it is
 *  not wrong a third time:
 *
 *   1. It first hand-listed the STATUSES (`waiting | approval | blocked | errored`), duplicating
 *      `buildSections.bandOfStatus`. It had already drifted inside the commit that introduced it:
 *      the sibling `SCREEN_DERIVED_STATUSES` carried `questions` while this did not.
 *   2. The fix derived the status→band half but then hand-listed the BAND half as a local
 *      `ASKING_BANDS`. That was a THIRD copy of a constant `buildSections` ALREADY EXPORTS (and
 *      which `services/conciergeFeed.isOwedAction` already consumes) — the same duplication one
 *      level up, reintroduced by the change that existed to remove it.
 *
 *  `StatusBand` is a union, so neither copy could ever produce a type error; the failure is silent
 *  in both directions. A band added to `buildSections.ASKING_BANDS` and omitted here would make
 *  `actionsFor` return `[]`, regressing the "a blocker may never offer nothing" guarantee with
 *  nothing to catch it. Both halves now come from the one module that owns them. */
function owesTheHuman(status: string): boolean {
  return ASKING_BANDS.includes(bandOfStatus(status as AgentTabStatus));
}

export function actionsFor(a: ConciergeAgent): ConciergeNudgeAction[] {
  // ══ NO BLOCKER MAY OFFER NOTHING — "Open" IS THE FLOOR (founder, 2026-08-20) ══════════════════
  // This returned `[]` for every status but `approval`, so a row raised by a STALL cause — stalled,
  // stranded, blocked-on-human, un-landed work — was pinned in the blocked strip carrying no button
  // at all. The app's own copy already conceded the gap: `components/agentNotices.ts` ends the
  // `stall:blocked-on-human` message with "Open the agent to see what it needs from you", which is
  // an instruction to perform an action the surface did not offer.
  //
  // A row that says BLOCKED and offers nothing is the concealment `docs/never-hide-actionable-rows.md`
  // forbids: it is visible, it demands attention, and it cannot be acted on. Opening the agent is
  // always possible and never destructive, so it is the correct floor — and it is the SAME action
  // the cloud-agent arm below already substitutes for Approve, reusing `NUDGE_OPEN_ACTION` rather
  // than minting a second id that `services/nudgeActions` would have to learn.
  //
  // IT IS DELIBERATELY NOT "Approve" FOR THESE. Nothing on a stalled agent's screen is a pending
  // question, so relaying an approval into it would press whatever happened to be there — the same
  // hazard `pinnedBlockerRowActivation` was just reversed to remove.
  if (a.status !== "approval") {
    // ══ THE FLOOR IS SCOPED TO ROWS THAT OWE SOMETHING, NOT BLANKET ══════════════════════════════
    // The first cut floored EVERY non-approval status at "Open agent", and that was wrong. It gave a
    // button to `running`, `idle`, `done`, `stopped` and `unmerged` — calm rows that are not asking
    // for anything — and `ConciergeHost.cloudApproval.test.tsx` caught it. That suite exists because
    // this exact guard was once un-pinned and every card in the feed grew a button; its rule is that
    // a card only carries a labelled action when there is something to act on.
    //
    // IT READS THE AGENT'S STATUS, NEVER THE `band` FIELD ON THE AGENT — a distinction worth
    // recording, because `owesTheHuman` below calls `bandOfStatus` and that looks like the same
    // thing. It is not. `a.band` is a field the FEED supplies and it can disagree with the status:
    // `ConciergeHost.cloudApproval.test.tsx`'s fixture hard-codes `band: "needs_you"` while varying
    // the status across `running`/`idle`/`done`/`stopped`/`unmerged`, so testing `a.band` admits
    // every one of them and the wall-of-buttons regression returns. Deriving the band FROM the
    // status is what makes the answer depend on what the agent is actually doing.
    //
    // Derived rather than hand-listed — see `owesTheHuman`, and roborev 65893 for the drift that
    // hand-listing had already produced within one commit.
    return owesTheHuman(a.status)
      ? [{ id: NUDGE_OPEN_ACTION, label: "Open agent", kind: "primary" }]
      : [];
  }
  // A CLOUD AGENT GETS "Open", NOT "Approve". Approve relays the word into that agent's terminal,
  // and `conciergeDispatch.deliverCloudPrompt` refuses every approval gesture aimed at a cloud agent
  // by design — an approval presses a button on the agent's own screen, which the concierge cannot
  // see well enough to press correctly. So the old card offered a button whose only possible outcome
  // was a refusal, discoverable only by pressing it. "Open" is the action the refusal copy already
  // told the user to take. It is a SWAP, never a removal: a control that vanishes on scope reads as
  // a deleted feature (sparkle-lcx8y).
  //
  // Resolved off `knownAgents` rather than by importing `conciergeDispatch.isCloudAgent`, which
  // evaluates this identical expression: 19 suites hand-list a partial mock of that module, and
  // vitest throws on any export a factory omits, so one more import from it turns 143 unrelated
  // tests red. Same record, same polarity — TRUE only on positive evidence, so `runtime: "unknown"`
  // keeps the Approve relay and lets the write attempt report honestly.
  const cloud = findKnownAgent(a.id)?.runtime === "cloud";
  return [
    {
      id: cloud ? NUDGE_OPEN_ACTION : "approve",
      label: cloud ? "Open" : "Approve",
      kind: "primary",
    },
  ];
}

/** How `agentToNudge` learns whether the app can actually SEE this agent's screen. Injectable for
 *  the same reason `services/forceRedraw`'s deps are: the production wiring is the default, so a
 *  test drives the real builder rather than a copy of its branching. */
export interface NudgeReadabilityDeps {
  viewportFor: (agentId: string) => TerminalViewport | null;
}

/** THE ALARM IS NOT WIRED HERE ANY MORE (roborev 65876, Medium). It used to be, and it looked like
 *  the natural home — this is where readability is already computed. But `buildDigest` emits a card
 *  only for a bucket of ONE, so two agents sharing a project+band collapse into a group line and
 *  never reach this function. The alarm fired with one blocked agent per project and went silent
 *  with two: inverted against exactly the saturated fleet that produced the founder's report.
 *
 *  It now sweeps the whole accounted population before digesting — see
 *  `screenReadability.observeFeedReadability`, called from `ConciergeHost` with the FEED so no
 *  caller can narrow it. This function keeps only the LABEL, which is genuinely per-card. */
const REAL_READABILITY: NudgeReadabilityDeps = { viewportFor: getAgentViewport };

export function agentToNudge(
  a: ConciergeAgent,
  deps: NudgeReadabilityDeps = REAL_READABILITY,
): ConciergeNudge {
  // ══ A ROW THE APP CANNOT SEE MUST NOT SAY "NEEDS YOU" ═══════════════════════════════════════
  // "Needs you" and "Approve?" are CLAIMS that a question with a pressable button is on screen.
  // When the app is blind it does not know that — and on the shape the founder hit it was false:
  // the send path was refusing the same screen as `alternate-screen` while this line rendered it
  // as an approval. He opened the pane and found nothing to do.
  //
  // THE BAND IS UNTOUCHED, deliberately. This rewrites only what the row SAYS, never how loud it
  // is: `docs/never-hide-actionable-rows.md` forbids calming a row the app cannot read, because
  // being unable to see a question is not evidence there isn't one. Red dot, honest words — which
  // is what the founder chose when asked.
  const readability = screenReadability(deps.viewportFor(a.id));
  const blind = readability.kind === "blind" && readability.reason === "unrecognized-fullscreen";
  // ══ BLINDNESS REPLACES A SCREEN CLAIM; IT ONLY ANNOTATES ANYTHING ELSE (roborev 65876) ════════
  // `approval`/`waiting` assert a pressable question is drawn on the terminal, so when the app
  // cannot read the terminal those assertions must go. `errored` and `blocked` come from the status
  // engine and stay TRUE whatever the screen shows — and a crashed TUI is precisely what leaves an
  // unrecognised buffer behind, so overwriting there would discard the only accurate account of
  // what happened and offer a redraw that cannot revive a dead process.
  const replacesLabel = blind && statusClaimsScreenContent(a.status);
  const annotates = blind && !replacesLabel;
  const ordinary = `${a.statusLabel} — ${a.name} in ${a.projectName}.`;
  return {
    id: a.id, // the source agent id — resolved back via the feed on click/action
    kind: "nudge",
    band: a.band,
    projectName: a.projectName,
    agentName: a.name,
    text: replacesLabel
      ? blindReasonSentence(a.name, a.projectName)
      : annotates
        ? `${ordinary} ${blindAnnotation()}`
        : ordinary,
    // THE SHORT FORM for the pinned strip, which already draws the pill and "in {project}". See
    // `ConciergeNudge.reason`: rendering `text` there prints the agent name and project TWICE.
    reason: replacesLabel
      ? `${BLIND_STATUS_LABEL} — try Force redraw.`
      : annotates
        ? `${a.statusLabel} ${blindAnnotation()}`
        : a.statusLabel,
    // A BLIND ROW GETS "Open agent", NEVER "Approve" — for BOTH shapes above. Relaying an approval
    // into a screen the app cannot read presses whatever happens to be there, which is the precise
    // hazard the alternate-screen refusal exists for; that is true whether the row's label was
    // replaced or merely annotated, so this keys on `blind` rather than on `replacesLabel`.
    actions: blind
      ? [{ id: NUDGE_OPEN_ACTION, label: "Open agent", kind: "primary" }]
      : actionsFor(a),
  };
}
