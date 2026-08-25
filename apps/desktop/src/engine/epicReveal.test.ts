// WHERE DOES THIS BEAD SIT? — the four outcomes of `revealFor`, pinned.
//
// ══ WHY THIS FILE EXISTS AT ALL ════════════════════════════════════════════════════════════════
// The worker that built `engine/epicReveal.ts` and its 276-line column wiring for `sparkle-huw924.7`
// died before it wrote a single test, so 489 lines of the founder's "show me where it sits" shipped
// into the merge with nothing asserting any of it. These are those tests, written after the fact
// against the module as merged.
//
// ══ WHAT IS ASSERTED, AND WHY THE ORDERING CASE IS THE ONE THAT MATTERS ════════════════════════
// `revealFor` resolves a union of three shapes plus `null`, and the interesting rule is the
// PRECEDENCE between two of them: a bead can be BOTH an epic itself AND the child of an epic, and
// the founder's ask ("show me where it SITS") means the container wins. A test that only fed it
// unambiguous beads would pass with that precedence inverted, which is the defect that would
// actually reach him — clicking a sub-epic would open the sub-epic rather than revealing it in its
// parent.
//
// The standalone case is deliberately NOT treated as an edge case here. When this was measured, 45
// of 46 agent-linked beads were parentless, so it is the shape the feature runs in most often; the
// founder explicitly rejected an explanatory message for it, which makes "returns a real reveal
// rather than null" a behavioural requirement rather than a defensive default.
import { describe, expect, it } from "vitest";

import { flashTargetId, revealFor, revealedEpicId } from "./epicReveal";
import type { Bead } from "../services/beads";

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", labels: [], type: "task", ...over } as Bead;
}

const EPIC = bead("ep-1", { type: "epic", title: "The epic" });
const CHILD = bead("ep-1.a", { parent: "ep-1", title: "A task inside it" });
const LONE = bead("lone-1", { title: "A parentless, childless task" });

describe("revealFor", () => {
  it("reveals a task INSIDE its parent epic — the epic's row, the task's own id to flash", () => {
    const r = revealFor([EPIC, CHILD, LONE], CHILD.id);
    expect(r).toEqual({ kind: "child", epicId: EPIC.id, childId: CHILD.id });
    // The two derived readings come apart on exactly this case, which is why both are asserted:
    // the ROW to open is the parent's, the thing to FLASH is the task the user clicked. Swapping
    // them scrolls the reader to the right card and highlights the wrong line in it.
    expect(revealedEpicId(r)).toBe(EPIC.id);
    expect(flashTargetId(r)).toBe(CHILD.id);
  });

  it("reveals an epic as its OWN row", () => {
    const r = revealFor([EPIC, CHILD], EPIC.id);
    expect(r).toEqual({ kind: "epic", epicId: EPIC.id });
    expect(revealedEpicId(r)).toBe(EPIC.id);
    expect(flashTargetId(r)).toBe(EPIC.id);
  });

  it("PREFERS THE CONTAINER when a bead is both an epic and a child of one", () => {
    // A mid-tree epic: typed `epic`, and parented to another epic. Both branches of `revealFor`
    // match it, so this is the case that pins the ORDER rather than the outcomes — and it is the
    // founder's own words that settle it: "I would just want you to show me where it SITS inside
    // of the Epic." The container, not the thing itself.
    const parent = bead("ep-top", { type: "epic" });
    const mid = bead("ep-top.sub", { type: "epic", parent: "ep-top" });
    const r = revealFor([parent, mid], mid.id);
    expect(r).toEqual({ kind: "child", epicId: parent.id, childId: mid.id });
  });

  it("reveals a parentless, childless task as ITS OWN row — never nothing, never a message", () => {
    // THE COMMON CASE, not an edge case: 45 of 46 agent-linked beads were parentless when this was
    // measured. Returning `null` here would leave the column doing nothing, which is the silence
    // the founder rejected an explanation for — he wanted the position shown either way.
    const r = revealFor([EPIC, CHILD, LONE], LONE.id);
    expect(r).toEqual({ kind: "standalone", beadId: LONE.id });
    // No epic row exists for it, and that null is load-bearing: the column branches on it to render
    // the bead above the ladder instead of inside a stage.
    expect(revealedEpicId(r)).toBeNull();
    // It still flashes. "Where it sits" is answered positionally even when the answer is "alone".
    expect(flashTargetId(r)).toBe(LONE.id);
  });

  it("returns null for an id that names no bead in this snapshot", () => {
    // A stale reference or a bead from another project. Distinct from `standalone`: there is no row
    // to move to at all, so the column must do NOTHING rather than invent a row for an unknown id.
    expect(revealFor([EPIC, CHILD], "no-such-bead")).toBeNull();
    expect(revealedEpicId(null)).toBeNull();
    expect(flashTargetId(null)).toBeNull();
  });

  it("treats a bead with children as an epic even when its type says otherwise", () => {
    // Epic-ness is STRUCTURAL here — `services/beads.isEpic` is "typed epic OR has children" — and
    // several real epics carry `type: "task"` because nobody set the field. A reveal that trusted
    // the type field would refuse to open those, which is the same class of bug that made a P0
    // linkage bead invisible on the epic surface (sparkle-xelans).
    const untypedParent = bead("par-1", { type: "task" });
    const kid = bead("par-1.a", { parent: "par-1" });
    expect(revealFor([untypedParent, kid], untypedParent.id)).toEqual({
      kind: "epic",
      epicId: untypedParent.id,
    });
  });
});
