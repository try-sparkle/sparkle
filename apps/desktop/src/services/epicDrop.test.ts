// THE DROP RULE, with no GUI, no roster and no mocked `invoke` — the same posture
// `epicBoard.test.ts` takes one file over, and for the same reason: every case here is a statement
// about WHAT A DROP WRITES, and none of them needs a rendered column to be true.
//
// ══ WHAT THESE ASSERT, AND WHAT WOULD MAKE THEM VACUOUS ════════════════════════════════════════
// The trap `AGENTS.md` names is a test that passes against the code as it was BEFORE the change.
// Here that shape would be "assert the plan is accepted" — true for almost every rung under almost
// any implementation. So every accepting case asserts the WRITES, and — more importantly — the
// LANDING: where the ladder actually comes to rest once those writes are applied. That is the fact
// the feature is about, and it is the one that fails if the write list is wrong in any way that
// matters.
import { describe, expect, it } from "vitest";

import { epicDropPlan, beadAfterWrites, type EpicDropWrite } from "./epicDrop";
import { ARCHIVED_LABEL, DELIVERED_LABEL, STALLED_LABEL, type Bead, type BeadStatus } from "./beads";

/** A typed epic. Written out in full rather than cast — a partial behind `as Bead` is a compile
 *  error under this repo's settings, and casting through `unknown` would let a field the bucketing
 *  reads go missing silently. */
function epic(id: string, status: BeadStatus, labels: string[] = []): Bead {
  return {
    id,
    title: id,
    description: "",
    status,
    labels,
    parent: null,
    commentCount: 0,
    type: "epic",
  };
}

/** A child task under `parent` — what gives an epic its child roll-up. */
function child(id: string, parent: string, status: BeadStatus): Bead {
  return {
    id,
    title: id,
    description: "",
    status,
    labels: [],
    parent,
    commentCount: 0,
    type: "task",
  };
}

const NOTHING_BLOCKED: ReadonlySet<string> = new Set<string>();

/** A childless epic is the simplest fixture that is still a real epic: `type: "epic"` makes it
 *  epic-indexed with no children to re-file it, so `columnFor` alone decides its rung. */
function loneEpic(status: BeadStatus, labels: string[] = []) {
  const e = epic("e1", status, labels);
  return { e, all: [e] as Bead[] };
}

function kinds(writes: readonly EpicDropWrite[]): string[] {
  return writes.map((w) => ("label" in w ? `${w.kind}:${w.label}` : w.kind));
}

describe("epicDropPlan — where the card actually comes to rest", () => {
  // THE HEADLINE CASE, and the one the founder asked for: an epic sitting in a build rung, dragged
  // back to Backlog. The assertion is the LANDING, not the call.
  it("moves an in-progress epic to Backlog by unclaiming it", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("backlog", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual(["unclaim"]);
    expect(plan.landsOn).toBe("backlog");
  });

  it("claims an open epic onto Build: Unstaffed WITHOUT starting an agent", () => {
    const { e, all } = loneEpic("open");
    const plan = epicDropPlan("unstaffed", e, all, NOTHING_BLOCKED, () => "unstaffed");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The whole point of the rung: the status moves, and nothing is spawned.
    expect(kinds(plan.writes)).toEqual(["claim"]);
    expect(kinds(plan.writes)).not.toContain("send-to-build");
    expect(plan.landsOn).toBe("unstaffed");
  });

  // THE P1 FIX. `spawn_build_agent` has no epic parameter, so an agent started from chat never
  // binds; `sendToBuild` is the one binder. A drop on Build: Active must go through it.
  it("claims AND starts an orchestrator on a drop onto Build: Active", () => {
    const { e, all } = loneEpic("open");
    const plan = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "inProgress");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual(["claim", "send-to-build"]);
    expect(plan.landsOn).toBe("inProgress");
  });

  // The two build rungs are ONE status apart plus an agent — the distinction is intent, and it must
  // be visible in the writes rather than implied.
  it("separates the two build rungs by exactly the send-to-build write", () => {
    const { e, all } = loneEpic("open");
    const staffed = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "inProgress");
    const unstaffed = epicDropPlan("unstaffed", e, all, NOTHING_BLOCKED, () => "unstaffed");
    expect(staffed.ok && unstaffed.ok).toBe(true);
    if (!staffed.ok || !unstaffed.ok) return;
    expect(kinds(staffed.writes).filter((k) => k !== "send-to-build")).toEqual(
      kinds(unstaffed.writes),
    );
  });

  // BLOCKED NEEDS THE STATUS AS WELL AS THE LABEL. `columnFor` only consults the blocked sources
  // for an OPEN bead, so a label-only write would move nothing at all.
  it("unclaims as well as labelling when blocking an in-progress epic", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("blocked", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual(["unclaim", `label-add:${STALLED_LABEL}`]);
    expect(plan.landsOn).toBe("blocked");
  });

  it("clears the stalled label on the way out of Blocked", () => {
    const e = epic("e1", "open", [STALLED_LABEL]);
    const plan = epicDropPlan("unstaffed", e, [e], NOTHING_BLOCKED, () => "unstaffed");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual([`label-remove:${STALLED_LABEL}`, "claim"]);
    expect(plan.landsOn).toBe("unstaffed");
  });

  it("ships an epic by adding the delivered label and closing it", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("delivered", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual([`label-add:${DELIVERED_LABEL}`, "close"]);
    expect(plan.landsOn).toBe("delivered");
  });

  // `columnFor` ranks delivered ABOVE archived ABOVE plain-closed. Closing an already-shipped bead
  // to "move it to Done" leaves it under Shipped unless the label comes off — the exact silent
  // no-move this case pins.
  it("strips the delivered label when moving a shipped epic to Done", () => {
    const e = epic("e1", "closed", [DELIVERED_LABEL]);
    const plan = epicDropPlan("done", e, [e], NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual([`label-remove:${DELIVERED_LABEL}`]);
    expect(plan.landsOn).toBe("done");
  });

  it("strips the delivered label when archiving a shipped epic, since delivered outranks archived", () => {
    const e = epic("e1", "closed", [DELIVERED_LABEL]);
    const plan = epicDropPlan("archived", e, [e], NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual([
      `label-remove:${DELIVERED_LABEL}`,
      `label-add:${ARCHIVED_LABEL}`,
    ]);
    expect(plan.landsOn).toBe("archived");
  });

  it("reopens a closed epic dropped back on Backlog", () => {
    const e = epic("e1", "closed", [ARCHIVED_LABEL]);
    const plan = epicDropPlan("backlog", e, [e], NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toEqual(["unclaim"]);
    expect(plan.landsOn).toBe("backlog");
  });
});

describe("epicDropPlan — the landing is predicted, not assumed", () => {
  // THE SNAP-BACK CASE. The write is right and the target is not where the card ends up, because
  // layer 2 re-files an OPEN epic by its children. The plan must SAY so rather than promise the
  // target — a caller that trusted `target` would paint the card into the wrong rung for a poll.
  it("reports Planning as the landing when un-starting an epic whose children are all open", () => {
    const e = epic("e1", "in_progress");
    const all = [e, child("t1", "e1", "open"), child("t2", "e1", "open")];
    const plan = epicDropPlan("backlog", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.writes.length).toBeGreaterThan(0);
    // Accepted — un-starting must stay possible — but honest about where it goes.
    expect(plan.landsOn).toBe("planning");
    expect(plan.landsOn).not.toBe(plan.target);
  });

  // The designed slide: dropping on Build: Active with a fleet that has not gone green yet rests
  // one rung left until an agent binds. `epicBoard.ts` names this as intended behaviour.
  it("reports Unstaffed as the landing for a Build: Active drop whose fleet is still gray", () => {
    const { e, all } = loneEpic("open");
    const plan = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "unstaffed");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toContain("send-to-build");
    expect(plan.landsOn).toBe("unstaffed");
  });

  // The fleet predicate is the COLUMN's, never a second staffing rule invented here. An all-red
  // fleet files a claimed epic under Blocked, and the prediction has to follow it there.
  it("follows the caller's fleet rule to Blocked for an all-red fleet", () => {
    const { e, all } = loneEpic("open");
    const plan = epicDropPlan("unstaffed", e, all, NOTHING_BLOCKED, () => "blocked");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.landsOn).toBe("blocked");
  });
});

describe("epicDropPlan — refusals", () => {
  // Planning is a statement about the CHILDREN. No mutation of the epic produces it.
  it("refuses a drop on Planning and says why", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("planning", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/Planning/i);
  });

  it("carries no writes at all when it refuses", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("planning", e, all, NOTHING_BLOCKED);
    // A refused plan has no `writes` key to execute — the type makes an accidental apply impossible.
    expect("writes" in plan).toBe(false);
  });

  // A drop that changes nothing is worse than no affordance: the user drags, releases, and the card
  // returns to where it started with no explanation.
  it("refuses a drop onto the rung the epic already sits in", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("unstaffed", e, all, NOTHING_BLOCKED, () => "unstaffed");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already/i);
  });

  // The no-op refusal must be about the LANDING, not about the target — an epic that would bounce
  // straight back to its own rung is just as much a no-op even though the target differs.
  it("refuses a Backlog drop on an already-planning epic, which would bounce straight back", () => {
    const e = epic("e1", "open");
    const all = [e, child("t1", "e1", "open")];
    const plan = epicDropPlan("backlog", e, all, NOTHING_BLOCKED);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already/i);
  });
});

describe("beadAfterWrites", () => {
  it("applies status and label writes in order", () => {
    const e = epic("e1", "open", [STALLED_LABEL]);
    const after = beadAfterWrites(e, [
      { kind: "label-remove", label: STALLED_LABEL },
      { kind: "claim" },
    ]);
    expect(after.status).toBe("in_progress");
    expect(after.labels).toEqual([]);
  });

  // `send-to-build` binds an orchestrator; the only bead write it makes is a label no bucketing
  // layer reads. Modelling it as a status change would predict a rung the writes do not produce.
  it("leaves the bead untouched for send-to-build", () => {
    const e = epic("e1", "in_progress");
    const after = beadAfterWrites(e, [{ kind: "send-to-build" }]);
    expect(after.status).toBe("in_progress");
    expect(after.labels).toEqual([]);
  });

  it("does not mutate the input bead", () => {
    const e = epic("e1", "open", [STALLED_LABEL]);
    beadAfterWrites(e, [{ kind: "close" }, { kind: "label-add", label: DELIVERED_LABEL }]);
    expect(e.status).toBe("open");
    expect(e.labels).toEqual([STALLED_LABEL]);
  });
});

describe("epicDropPlan — staffing an epic that is ALREADY claimed", () => {
  // ══ THE GESTURE THE WHOLE FEATURE EXISTS FOR, AND THE ONE THE FIRST CUT REFUSED ══════════════
  // An epic is `in_progress` with no live agent: the status is stamped, the fleet reads gray, so
  // the ladder files it under Build: Unstaffed. Dragging it onto Build: Active is a request to
  // STAFF it — the P1 staffing gap this module was written to close.
  //
  // Nothing about that drop changes the BEAD: it is already claimed, so `writesFor` correctly emits
  // `send-to-build` alone, and `send-to-build` is invisible to `beadAfterWrites` by design. So the
  // predicted landing is the rung it started on, and a refusal keyed on "the card would not move"
  // swallows the one drop that matters. The rule is therefore keyed on whether the plan is INERT —
  // whether it writes anything at all — not on whether the card visibly travels.
  it("accepts Build: Active for a claimed epic whose fleet is still gray", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "unstaffed");

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The orchestrator binding is the whole point of the drop...
    expect(kinds(plan.writes)).toEqual(["send-to-build"]);
    // ...and the card honestly stays put until that agent goes green, which `epicBoard` documents
    // as the designed slide. Asserting the landing is what stops this becoming "accepted, somehow".
    expect(plan.landsOn).toBe("unstaffed");
  });

  // The same shape one rung further left: an all-red fleet files a claimed epic under Blocked, and
  // re-staffing it is exactly what a user does about that.
  it("accepts Build: Active for a claimed epic whose fleet reads red", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "blocked");

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(kinds(plan.writes)).toContain("send-to-build");
  });

  // ══ AND THE IN-PLACE DROP IS STILL REFUSED, WHICH THE INERT TEST ALONE DOES NOT COVER ════════
  // "Picked the card up, changed my mind, let go where it was" is the commonest drag gesture there
  // is, and on Build: Active it is NOT harmless: `writesFor` emits `send-to-build` for an epic that
  // is already claimed, so an inert-only guard would accept it and re-hand a RUNNING orchestrator a
  // fresh mission — `prepareHandoff` appends the seed prompt to the live agent and the reveal drags
  // the user off the board into its pane. So a drop onto the rung the card is ALREADY SHOWN IN is
  // refused on its own terms, regardless of what the plan would write.
  it("refuses an in-place drop on Build: Active rather than re-prompting the running agent", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("inProgress", e, all, NOTHING_BLOCKED, () => "inProgress");

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already/i);
  });

  // The same in-place rule one rung left, where the plan is NOT send-to-build: an epic filed under
  // Blocked by a red fleet, dropped back on Blocked, would otherwise un-claim it — a real write
  // nobody asked for from a gesture that means "put it back".
  it("refuses an in-place drop on Blocked even though the plan would write", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("blocked", e, all, NOTHING_BLOCKED, () => "blocked");

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already/i);
  });

  // THE OTHER HALF OF THE PAIR, and what keeps the refusal from being deleted outright: a plan that
  // writes NOTHING is still refused, because that gesture really does change nothing. Without this
  // the fix above would read as "accept every drop".
  it("still refuses a drop that would write nothing at all", () => {
    const { e, all } = loneEpic("in_progress");
    const plan = epicDropPlan("unstaffed", e, all, NOTHING_BLOCKED, () => "unstaffed");

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/already/i);
  });
});
