// apps/desktop/src/stores/beadSelectionStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useBeadSelectionStore } from "./beadSelectionStore";

beforeEach(() => {
  useBeadSelectionStore.setState({ selected: {}, selectMode: {} });
});

const s = () => useBeadSelectionStore.getState();

describe("beadSelectionStore", () => {
  it("keeps ticks in click order, because that order is the argv bd is handed", () => {
    s().toggle("p", "");
    s().toggle("p", "");
    s().toggle("p", "");
    expect(s().selectionFor("p")).toEqual(["", "", ""]);
  });

  it("toggling a ticked bead unticks it and leaves the rest in order", () => {
    for (const id of ["a", "b", "c"]) s().toggle("p", id);
    s().toggle("p", "b");
    expect(s().selectionFor("p")).toEqual(["a", "c"]);
    expect(s().isSelected("p", "b")).toBe(false);
  });

  it("cannot hold a duplicate, however many times a bead is ticked", () => {
    s().toggle("p", "a");
    s().toggle("p", "a");
    s().toggle("p", "a");
    expect(s().selectionFor("p")).toEqual(["a"]);
  });

  it("keeps projects apart", () => {
    s().toggle("p1", "a");
    s().toggle("p2", "b");
    expect(s().selectionFor("p1")).toEqual(["a"]);
    expect(s().selectionFor("p2")).toEqual(["b"]);
    s().clear("p1");
    expect(s().selectionFor("p1")).toEqual([]);
    expect(s().selectionFor("p2")).toEqual(["b"]); // untouched
  });

  it("hands back the SAME empty array for every unticked project", () => {
    // Identity, not equality. A zustand selector is identity-compared, so a fresh `[]` per read
    // would re-render every subscriber on every unrelated store write.
    expect(s().selectionFor("p1")).toBe(s().selectionFor("p2"));
    s().toggle("p1", "a");
    s().toggle("p1", "a"); // back to empty
    expect(s().selectionFor("p1")).toBe(s().selectionFor("p2"));
  });

  describe("retain", () => {
    it("forgets ids that have left the board and keeps the rest in order", () => {
      for (const id of ["a", "b", "c"]) s().toggle("p", id);
      s().retain("p", new Set(["a", "c"]));
      expect(s().selectionFor("p")).toEqual(["a", "c"]);
    });

    it("empties the selection when every ticked bead is gone", () => {
      s().toggle("p", "a");
      s().retain("p", new Set(["z"]));
      expect(s().selectionFor("p")).toEqual([]);
    });

    it("writes NOTHING when every ticked bead is still present", () => {
      // THE SIDE EFFECT, not the value. This runs on every poll tick; a write that replaced the
      // array with an equal one would re-render every card several times a minute while reading
      // as correct. Asserted by array IDENTITY, which an equality check would not catch.
      s().toggle("p", "a");
      s().toggle("p", "b");
      const before = s().selectionFor("p");
      s().retain("p", new Set(["a", "b", "c"]));
      expect(s().selectionFor("p")).toBe(before);
    });

    it("is a no-op for a project with nothing ticked", () => {
      const before = useBeadSelectionStore.getState().selected;
      s().retain("p", new Set(["a"]));
      expect(useBeadSelectionStore.getState().selected).toBe(before);
    });
  });

  describe("selectMode", () => {
    it("is off for every project until something turns it on", () => {
      expect(s().selectMode["p"]).toBeUndefined();
    });

    it("turning it OFF drops the selection, so no tick is left invisible and live", () => {
      // THE SIDE EFFECT, not the flag. Asserting only that `selectMode` flipped stays green for a
      // version that hides the checkboxes while keeping what they held — which is the bug: the
      // bar's next move would carry beads the user last ticked minutes ago and cannot review.
      s().setSelectMode("p", true);
      s().toggle("p", "a");
      s().toggle("p", "b");
      s().setSelectMode("p", false);
      expect(s().selectMode["p"]).toBe(false);
      expect(s().selectionFor("p")).toEqual([]);
    });

    it("turning it ON leaves any existing selection alone", () => {
      s().toggle("p", "a");
      s().setSelectMode("p", true);
      expect(s().selectionFor("p")).toEqual(["a"]);
    });

    it("is per project — leaving select mode in one does not clear another", () => {
      s().toggle("p1", "a");
      s().toggle("p2", "b");
      s().setSelectMode("p1", false);
      expect(s().selectionFor("p1")).toEqual([]);
      expect(s().selectionFor("p2")).toEqual(["b"]);
    });
  });

  it("clearing an already-empty project does not churn state identity", () => {
    const before = useBeadSelectionStore.getState().selected;
    s().clear("p");
    expect(useBeadSelectionStore.getState().selected).toBe(before);
  });
});
