import { describe, it, expect } from "vitest";
import { teardownBeadWrites, type TeardownBead } from "./beadLifecycle";

// bead sparkle-aoqzzo: closing a build agent closed EVERY bead its workers held, landed or not, so a
// child the merged PR explicitly did not address left the board looking fixed.
const b = (over: Partial<TeardownBead> & { beadId: string }): TeardownBead => ({
  stage: "building_unsaved",
  telemetry: false,
  status: "in_progress",
  ...over,
});

describe("teardownBeadWrites — close what landed, and nothing by association", () => {
  it("closes a landed sibling and RELEASES the unlanded one beside it", () => {
    const w = teardownBeadWrites([
      b({ beadId: "child-A", stage: "merged" }),
      b({ beadId: "child-B" }), // same epic, same teardown, never landed
    ]);
    expect(w.close).toEqual(["child-A"]);
    expect(w.release).toEqual(["child-B"]);
  });

  it("treats shipped as landed too", () => {
    expect(teardownBeadWrites([b({ beadId: "x", stage: "shipped" })]).close).toEqual(["x"]);
  });

  it("still closes unlanded app TELEMETRY, so it cannot strand an epic rollup", () => {
    const w = teardownBeadWrites([b({ beadId: "auto-1", telemetry: true })]);
    expect(w).toEqual({ close: ["auto-1"], release: [] });
  });

  it("never touches an unlanded bead a FRESH read shows open or closed — releasing a closed one would REOPEN it", () => {
    const w = teardownBeadWrites([
      b({ beadId: "closed-1", status: "closed" }),
      b({ beadId: "open-1", status: "open" }),
    ]);
    expect(w).toEqual({ close: [], release: [] });
  });

  // roborev 83346: closing an unreadable bead IS the aoqzzo defect (reads routinely time out under
  // the store lock). Unlanded + unreadable writes nothing; a LANDED unreadable bead still closes.
  it("never closes or releases an unlanded bead whose status could not be read", () => {
    const w = teardownBeadWrites([b({ beadId: "unread-1", status: undefined, telemetry: undefined })]);
    expect(w).toEqual({ close: [], release: [] });
  });

  it("PAIRED — a landed bead is closed even when its read failed", () => {
    const w = teardownBeadWrites([b({ beadId: "unread-2", stage: "merged", status: undefined, telemetry: undefined })]);
    expect(w).toEqual({ close: ["unread-2"], release: [] });
  });

  it("closes, and does not also release, a bead one bound agent landed", () => {
    const w = teardownBeadWrites([b({ beadId: "shared" }), b({ beadId: "shared", stage: "merged" })]);
    expect(w).toEqual({ close: ["shared"], release: [] });
  });
});
