// apps/desktop/src/services/beadReparent.test.ts
//
// WHAT THESE ASSERT, AND WHY IT IS THE SIDE EFFECT RATHER THAN THE PRECONDITION.
// The thing `beads_reparent` exists to guarantee is that N beads move in ONE `bd update`, so the
// load-bearing assertion here is the CALL COUNT together with the exact argument object — not "the
// promise resolved" and not "an invoke happened". A test that only checked `invoke` was called
// stays green for a per-id loop, which is the precise defect `build_reparent_args`' doc says makes
// the board paint an epic mid-assembly. Every refusal test likewise asserts `invoke` did NOT
// happen: a client-side guard that rejects AFTER shelling out has not guarded anything.
import { describe, it, expect, vi, afterEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { reparentBeads, unparentBeads, isValidBeadId } from "./beadReparent";
import { isBeadsError, type BeadsError } from "./beadsCommands";

afterEach(() => {
  invokeMock.mockReset();
});

/** The rejection value, typed. Every path in this module rejects with a `BeadsError`. */
async function rejection(p: Promise<unknown>): Promise<BeadsError> {
  try {
    await p;
  } catch (e) {
    expect(isBeadsError(e)).toBe(true);
    return e as BeadsError;
  }
  throw new Error("expected a rejection, got a resolved promise");
}

describe("reparentBeads", () => {
  it("sends ONE invoke carrying the whole selection — not one per bead", async () => {
    invokeMock.mockResolvedValue(undefined);
    await reparentBeads("/p", ["", "", ""], "sparkle-epic");

    // THE BATCHING CONTRACT. Three beads, one call.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("beads_reparent", {
      projectPath: "/p",
      ids: ["", "", ""],
      parent: "sparkle-epic",
    });
  });

  it("preserves selection order in the ids it sends", async () => {
    invokeMock.mockResolvedValue(undefined);
    await reparentBeads("/p", ["", ""], "sparkle-epic");
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({
      ids: ["", ""],
    });
  });

  it("trims the parent before sending it", async () => {
    invokeMock.mockResolvedValue(undefined);
    await reparentBeads("/p", [""], "  sparkle-epic  ");
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ parent: "sparkle-epic" });
  });

  it("REFUSES a blank parent instead of silently unparenting the selection", async () => {
    // The whole reason `unparentBeads` is a separate function: on the wire a blank parent means
    // "remove parent", so an empty epic picker would detach the beads under a label that says
    // "move to epic". This must never reach bd.
    for (const blank of ["", "   "]) {
      const err = await rejection(reparentBeads("/p", [""], blank));
      expect(err.kind).toBe("invalidInput");
      expect(err.message).toMatch(/choose an epic/i);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses an empty selection without shelling out", async () => {
    const err = await rejection(reparentBeads("/p", [], "sparkle-epic"));
    expect(err.kind).toBe("invalidInput");
    expect(err.message).toMatch(/no beads selected/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a flag-shaped id anywhere in the batch, before anything is sent", async () => {
    // MID-LIST, deliberately: `reparent_beads` validates every id up front precisely so a bad one
    // in the middle is not discovered after bd already has the batch. A guard that checked as it
    // went would pass this test only if it also sent nothing, which is what the count asserts.
    const err = await rejection(
      reparentBeads("/p", ["", "--force", ""], "sparkle-epic"),
    );
    expect(err.kind).toBe("invalidInput");
    expect(err.message).toContain("--force");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a flag-shaped parent", async () => {
    const err = await rejection(reparentBeads("/p", [""], "-s"));
    expect(err.kind).toBe("invalidInput");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a bead named as its own parent", async () => {
    const err = await rejection(
      reparentBeads("/p", ["", "sparkle-epic"], "sparkle-epic"),
    );
    expect(err.kind).toBe("invalidInput");
    expect(err.message).toContain("sparkle-epic");
    expect(err.message).toMatch(/own parent/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("normalizes a bd failure into a BeadsError", async () => {
    invokeMock.mockRejectedValue("bd exploded");
    const err = await rejection(reparentBeads("/p", [""], "sparkle-epic"));
    expect(err.kind).toBe("bdFailed");
    expect(err.message).toContain("bd exploded");
  });

  it("passes a structured Rust rejection through unchanged", async () => {
    invokeMock.mockRejectedValue({ kind: "storeBusy", message: "locked", exitCode: 1 });
    const err = await rejection(reparentBeads("/p", [""], "sparkle-epic"));
    expect(err).toEqual({ kind: "storeBusy", message: "locked", exitCode: 1 });
  });
});

describe("unparentBeads", () => {
  it("sends ONE invoke with the empty-string parent bd reads as 'remove parent'", async () => {
    invokeMock.mockResolvedValue(undefined);
    await unparentBeads("/p", ["", ""]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("beads_reparent", {
      projectPath: "/p",
      ids: ["", ""],
      parent: "",
    });
  });

  it("refuses an empty selection without shelling out", async () => {
    const err = await rejection(unparentBeads("/p", []));
    expect(err.kind).toBe("invalidInput");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("still refuses a flag-shaped id", async () => {
    const err = await rejection(unparentBeads("/p", ["-s"]));
    expect(err.kind).toBe("invalidInput");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("isValidBeadId", () => {
  it("agrees with the Rust charset, case for case", () => {
    // The same ids `notes.rs::valid_bead_id_forbids_flag_like_and_exotic_ids` names, so a drift on
    // either side shows up as a disagreement here rather than as a rejected promise in the UI.
    expect(isValidBeadId("")).toBe(true);
    expect(isValidBeadId("bd-1.2_x")).toBe(true);
    expect(isValidBeadId("")).toBe(false);
    expect(isValidBeadId("-s")).toBe(false);
    expect(isValidBeadId("--force")).toBe(false);
    expect(isValidBeadId("a b")).toBe(false);
    expect(isValidBeadId("a;b")).toBe(false);
  });
});
