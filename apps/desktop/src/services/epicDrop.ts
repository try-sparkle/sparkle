// WHAT A DROP ON A LADDER RUNG WRITES — the whole rule for dragging an epic between stages, as a
// pure function. No React, no stores, no `invoke`: exactly the split `services/epicBoard` makes
// beside it, and for the same reason — the rule is unit-testable with no GUI, no roster and no
// mocked Tauri.
//
// ── THE QUESTION THIS FILE EXISTS TO ANSWER ───────────────────────────────────────────────────
// The founder: *"for any epics, I should be able to drag them in the epic column. Into different
// stages."* The obvious implementation writes "the stage" — and there is no stage to write. A
// rung is DERIVED, per render, in three layers:
//
//   1. `beads.columnFor`      — the bead's own `status` + labels.
//   2. `epicBoard.openEpicStage` — an OPEN epic re-split by its CHILDREN's roll-up.
//   3. `epicBoard.bucketEpics`'s `buildRungFor` — anything landing on a build rung re-filed by the
//      LIVE FLEET COLOUR (`engine/epicHealth.rungForEpicHealth`).
//
// `epicBoard.ts` says it outright: *"BOTH ARE DERIVED HERE AND NEITHER IS EVER WRITTEN TO A BEAD."*
//
// So a drop writes BEAD STATE and nothing else, and the ladder re-derives exactly as it does today.
// Inventing an `epic.stage` field to make the gesture literal would create a SECOND source of truth
// for a question three existing layers already answer — the drift this codebase's own comments
// record as having shipped twice.
//
// ── WHY THE LANDING RUNG IS PREDICTED BY CALLING THE REAL BUCKETING ───────────────────────────
// A write and the rung it produces are different facts, and they can differ: an `in_progress` epic
// dropped on Backlog goes to `open`, and then layer 2 immediately re-files it to PLANNING because
// its children are all open. To know that, this module does not restate the ladder's rules — it
// applies the writes to a COPY of the bead and asks `bucketBeads` + `bucketEpics` + `ladderKeyOf`
// where the result lands. One rule, consulted twice, so a prediction cannot drift from the render.
import {
  ARCHIVED_LABEL,
  DELIVERED_LABEL,
  STALLED_LABEL,
  bucketBeads,
  type Bead,
} from "./beads";
import { STAGE_LABELS, bucketEpics, ladderKeyOf, type EpicLadderKey } from "./epicBoard";

/** One bead mutation a drop performs, named rather than executed.
 *
 *  A DESCRIPTION, not a call. Keeping the rule's output inert is what lets every case below be
 *  asserted with no mocked `invoke`, no jsdom and no store — and it is what keeps the ONE place
 *  that talks to `bd` (`applyEpicDrop`) free of any opinion about the ladder. */
export type EpicDropWrite =
  /** `claimBead` — status → `in_progress` (and takes the lease). */
  | { kind: "claim" }
  /** `unclaimBead` — status → `open`, lease cleared. */
  | { kind: "unclaim" }
  /** `closeBead` — status → `closed`. */
  | { kind: "close" }
  | { kind: "label-add"; label: string }
  | { kind: "label-remove"; label: string }
  /** `sendToBuild` — bind an orchestrator and start it. The ONLY write here that is not a bead
   *  mutation, and the one that answers the P1 staffing gap this feature exists for. */
  | { kind: "send-to-build" };

/** An accepted drop: what to write, and where the card will actually come to rest. */
export interface EpicDropAccepted {
  ok: true;
  target: EpicLadderKey;
  writes: readonly EpicDropWrite[];
  /** Where the ladder will put the card once the writes land — NOT always `target`; see
   *  {@link epicDropPlan}. */
  landsOn: EpicLadderKey;
}

/** A refused drop, with the sentence to show the user. */
export interface EpicDropRefused {
  ok: false;
  target: EpicLadderKey;
  reason: string;
}

export type EpicDropPlan = EpicDropAccepted | EpicDropRefused;

/** The rungs a drop can be AIMED at. Planning is deliberately absent — see {@link epicDropPlan}. */
export const DROPPABLE_RUNGS: readonly EpicLadderKey[] = [
  "backlog",
  "blocked",
  "unstaffed",
  "inProgress",
  "done",
  "delivered",
  "archived",
];

/**
 * The writes that MAKE a bead sit on `target`, before any re-derivation.
 *
 * Each list is chosen so the bead's own state genuinely produces the rung through
 * `beads.columnFor`, rather than relying on a derived layer that this app does not control. Two
 * consequences are easy to get wrong and are handled here:
 *
 *  • BLOCKED NEEDS `unclaim` AS WELL AS THE LABEL. `columnFor` only consults the blocked sources
 *    for a bead whose status is `open`, so labelling an `in_progress` epic `stalled` and stopping
 *    there leaves it exactly where it was — a drop that writes something and moves nothing.
 *  • THE TERMINAL RUNGS MUST CLEAR EACH OTHER'S LABELS. `columnFor` ranks `delivered` above
 *    `archived` above plain closed, so closing an already-`delivered` bead to "move it to Done"
 *    leaves it under Shipped. Dropping on Done or Archived therefore REMOVES the labels that
 *    outrank the target.
 */
function writesFor(target: EpicLadderKey, bead: Bead): readonly EpicDropWrite[] {
  const has = (label: string) => bead.labels.includes(label);
  const clearStalled: EpicDropWrite[] = has(STALLED_LABEL)
    ? [{ kind: "label-remove", label: STALLED_LABEL }]
    : [];

  switch (target) {
    case "backlog":
      return [
        ...(bead.status === "open" ? [] : ([{ kind: "unclaim" }] as EpicDropWrite[])),
        ...clearStalled,
      ];
    case "blocked":
      return [
        ...(bead.status === "open" ? [] : ([{ kind: "unclaim" }] as EpicDropWrite[])),
        ...(has(STALLED_LABEL) ? [] : ([{ kind: "label-add", label: STALLED_LABEL }] as EpicDropWrite[])),
      ];
    // THE TWO BUILD RUNGS WRITE THE SAME STATUS AND DIFFER ONLY IN WHETHER AN AGENT IS STARTED.
    // That is not a shortcut — it is the distinction the founder already draws. Nothing writes the
    // word "unstaffed" anywhere: a claimed epic with no live agent is filed there BY DERIVATION,
    // because its fleet reads gray, and it slides one rung right by itself the moment one binds.
    case "unstaffed":
      return [...clearStalled, ...(bead.status === "in_progress" ? [] : ([{ kind: "claim" }] as EpicDropWrite[]))];
    case "inProgress":
      return [
        ...clearStalled,
        ...(bead.status === "in_progress" ? [] : ([{ kind: "claim" }] as EpicDropWrite[])),
        { kind: "send-to-build" },
      ];
    case "done":
      return [
        ...(has(DELIVERED_LABEL) ? [{ kind: "label-remove", label: DELIVERED_LABEL } as EpicDropWrite] : []),
        ...(has(ARCHIVED_LABEL) ? [{ kind: "label-remove", label: ARCHIVED_LABEL } as EpicDropWrite] : []),
        ...(bead.status === "closed" ? [] : ([{ kind: "close" }] as EpicDropWrite[])),
      ];
    case "delivered":
      return [
        ...(has(DELIVERED_LABEL) ? [] : ([{ kind: "label-add", label: DELIVERED_LABEL }] as EpicDropWrite[])),
        ...(bead.status === "closed" ? [] : ([{ kind: "close" }] as EpicDropWrite[])),
      ];
    case "archived":
      return [
        // `delivered` OUTRANKS `archived` in `columnFor`, so it has to come off or the card stays
        // under Shipped.
        ...(has(DELIVERED_LABEL) ? [{ kind: "label-remove", label: DELIVERED_LABEL } as EpicDropWrite] : []),
        ...(has(ARCHIVED_LABEL) ? [] : ([{ kind: "label-add", label: ARCHIVED_LABEL }] as EpicDropWrite[])),
        ...(bead.status === "closed" ? [] : ([{ kind: "close" }] as EpicDropWrite[])),
      ];
    case "planning":
      return [];
  }
}

/** The bead as it will be once `writes` have landed — the input to the landing prediction.
 *
 *  `send-to-build` is deliberately inert here. It binds an orchestrator and starts it; the only
 *  bead write it makes is a `promoted-to-build` label, which no bucketing layer reads. Modelling it
 *  as a status change would predict a rung the writes do not produce. */
export function beadAfterWrites(bead: Bead, writes: readonly EpicDropWrite[]): Bead {
  let status = bead.status;
  let labels = [...bead.labels];
  for (const w of writes) {
    switch (w.kind) {
      case "claim":
        status = "in_progress";
        break;
      case "unclaim":
        status = "open";
        break;
      case "close":
        status = "closed";
        break;
      case "label-add":
        if (!labels.includes(w.label)) labels.push(w.label);
        break;
      case "label-remove":
        labels = labels.filter((l) => l !== w.label);
        break;
      case "send-to-build":
        break;
    }
  }
  return { ...bead, status, labels };
}

/**
 * WHERE THE CARD WILL COME TO REST once `after` replaces its old self in the store.
 *
 * Runs the REAL bucketing — `bucketBeads` → `bucketEpics` → `ladderKeyOf` — over a store in which
 * this one bead has been swapped for its post-write copy. Nothing about the ladder is restated
 * here, so a prediction cannot disagree with what the column renders a poll later.
 *
 * `blocked` is bd's dependency-blocked set, which the caller reads the same way the board does.
 * `fleetRung` is the caller's `(id) => rungForEpicHealth(healthOf(id))` — the SAME predicate the
 * column already passes to `bucketEpics`, never a second staffing rule.
 */
export function predictLanding(
  after: Bead,
  allBeads: readonly Bead[],
  blocked: ReadonlySet<string>,
  fleetRung?: (epicId: string) => "blocked" | "unstaffed" | "inProgress",
): EpicLadderKey | null {
  const next = allBeads.map((b) => (b.id === after.id ? after : b));
  if (!next.some((b) => b.id === after.id)) next.push(after);
  const ladder = bucketEpics(bucketBeads(next, blocked), next, fleetRung);
  return ladderKeyOf(ladder, after.id);
}

/**
 * THE WHOLE RULE: what a drop of `bead` onto `target` does.
 *
 * ══ THE TWO REFUSALS, AND WHY THEY ARE THE ONLY TWO ════════════════════════════════════════════
 *
 * 1. PLANNING CANNOT BE WRITTEN AT ALL. It means *"this OPEN epic's children are all open"* — a
 *    statement about the CHILDREN, not about the epic. No mutation of the epic bead produces it,
 *    and the honest alternatives are both worse: writing a fake marker invents the second source of
 *    truth this file exists to avoid, and silently landing the card in Backlog instead makes the
 *    ladder lie about where the user put it.
 *
 * 2. A DROP THAT WOULD CHANGE NOTHING. If the card would come to rest on the rung it is already
 *    sitting on, the gesture is a no-op — the user drags, lets go, and watches the card return to
 *    where it started with no explanation. Refusing states the reason instead.
 *
 * ══ WHY A LANDING THAT DIFFERS FROM THE TARGET IS STILL ACCEPTED ═══════════════════════════════
 * This was written as "refuse any mismatch" first, and that was wrong: it removes the ability to
 * UN-START an epic. An `in_progress` epic with open children dropped on Backlog lands in Planning,
 * because that is what it now IS — not-started work with a written plan. The write is exactly what
 * the user asked for and the card visibly moves; refusing it would block a legitimate gesture to
 * protect a distinction (Backlog vs Planning) that both rungs already agree on: not started.
 *
 * The same holds for the build pair in the other direction. A drop on Build: Active can rest one
 * rung left, in Build: Unstaffed, until the orchestrator goes green — which `epicBoard.ts` names as
 * the DESIGNED behaviour: *"what makes a card slide back to 'Being built' BY ITSELF the moment an
 * agent binds."*
 */
export function epicDropPlan(
  target: EpicLadderKey,
  bead: Bead,
  allBeads: readonly Bead[],
  blocked: ReadonlySet<string>,
  fleetRung?: (epicId: string) => "blocked" | "unstaffed" | "inProgress",
): EpicDropPlan {
  if (target === "planning") {
    return {
      ok: false,
      target,
      reason:
        "Planning isn’t something an epic can be moved into — it means this epic’s child tasks are all still open.",
    };
  }

  const from = ladderKeyOf(
    bucketEpics(bucketBeads([...allBeads], blocked), allBeads, fleetRung),
    bead.id,
  );
  const writes = writesFor(target, bead);
  const landsOn = predictLanding(beadAfterWrites(bead, writes), allBeads, blocked, fleetRung) ?? target;

  // ══ THE NO-OP TEST IS ABOUT THE PLAN, NOT ABOUT THE CARD MOVING ══════════════════════════════
  // This was first written as `landsOn === from`, and that swallowed the feature's headline
  // gesture. An epic already `in_progress` with a gray fleet sits under Build: Unstaffed; dropping
  // it on Build: Active is the STAFFING request this module exists to serve. Its plan is
  // `[send-to-build]` alone — the bead is already claimed — and `send-to-build` is deliberately
  // invisible to `beadAfterWrites`, so the predicted landing is the rung it started on. Keyed on
  // the landing, the one drop that matters was refused with "this epic is already in Build:
  // Unstaffed", and no orchestrator was ever bound.
  //
  // So the question is whether the plan is INERT — whether it writes anything at all. A plan with
  // no writes really does change nothing, and refusing it is honest. A plan whose only write is
  // invisible to the ladder still DOES something; the card simply stays where it is until the
  // agent goes green, which `epicBoard.ts` names as the designed slide.
  if (writes.length === 0 && from !== null && landsOn === from) {
    return {
      ok: false,
      target,
      reason: `This epic is already in ${STAGE_LABELS[from]}.`,
    };
  }

  return { ok: true, target, writes, landsOn };
}
