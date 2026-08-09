// The one real WRITE this card makes, and how its failures read.
//
// `beadsUpdate` existed end to end with NO caller at all, so nothing proved the patch it receives is
// the shape `bd` wants. That is what the first row here is for: the assertion is on the CALL and its
// argument, not on anything the pill rendered.
import { describe, expect, it, vi, beforeEach } from "vitest";

const beadsUpdate = vi.fn();
vi.mock("../../services/beadsCommands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/beadsCommands")>();
  return { ...actual, beadsUpdate: (...a: unknown[]) => beadsUpdate(...a) };
});

import { PRIORITY_OPTIONS, isUrgentPriority, priorityFailureSentence, priorityShort, setBeadPriority } from "./beadPriority";

// ══ THE BRACES ARE LOad-BEARING — DO NOT WRITE `beforeEach(() => spy.mockReset())` ══════════════
// `mockReset()` is CHAINABLE: it returns the mock. A concise-body arrow therefore returns a
// FUNCTION from the hook, and vitest treats a function returned by `beforeEach` as a TEARDOWN
// callback — so it CALLS THE MOCK after every test, with whatever implementation that test just
// installed.
//
// For a mock configured with `mockResolvedValue` that is invisible. For one configured to fail it
// is not: the teardown call produces a rejection nobody awaits, which surfaces as three red rows
// reading "Unknown Error: bd timed out" with NO AssertionError and NO stack — indistinguishable
// from the code under test being broken, when in fact every assertion passed. It cost a full
// debugging round here; the braces make the hook return `undefined` and it disappears.
beforeEach(() => {
  beadsUpdate.mockReset();
});

describe("setBeadPriority", () => {
  it("writes the priority through beads_update, as a string", async () => {
    beadsUpdate.mockResolvedValue(undefined);
    await setBeadPriority("/repo", "sparkle-qogah", 1);
    expect(beadsUpdate).toHaveBeenCalledWith("/repo", "sparkle-qogah", { priority: "1" });
  });

  // P0 is the priority most worth setting and the one a `String()` slip would drop: `0` is falsy,
  // and anything that treats an unset flag as "no change" would silently write nothing.
  it("writes P0 as \"0\", not as an omitted field", async () => {
    beadsUpdate.mockResolvedValue(undefined);
    await setBeadPriority("/repo", "sparkle-qogah", 0);
    expect(beadsUpdate).toHaveBeenCalledWith("/repo", "sparkle-qogah", { priority: "0" });
  });

  // Caught explicitly rather than with `rejects.toThrow`: `bd`'s rejection value is a plain object
  // (Tauri rejects with the serialized error, never an `Error`), and the `rejects` matcher reports
  // that raw object as a second, unhandled failure alongside the real assertion — which makes a
  // PASSING behaviour read as three red rows. This form asserts the same thing and says only what
  // happened.
  it("rejects with a reader-facing sentence, not with bd's raw payload", async () => {
    // A plain OBJECT, not an Error — Tauri rejects with the serialized value, which is the whole
    // reason `toBeadsError` exists. (If this row ever reports "Unknown Error: bd timed out" three
    // times with no AssertionError, the cause is not here: see the `beforeEach` note at the top.)
    beadsUpdate.mockRejectedValue({ kind: "timeout", message: "bd timed out", exitCode: null });
    let caught: unknown = null;
    try {
      await setBeadPriority("/repo", "sparkle-qogah", 2);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("bd is busy — priority not saved");
  });
});

describe("priorityFailureSentence", () => {
  // TIMEOUT IS THE LIKELY FAILURE, not an exotic one: `bd` is one embedded database that every
  // worktree shares. Its remedy is "try again in a moment", which a generic message hides.
  it("names a timeout specifically", () => {
    expect(priorityFailureSentence({ kind: "timeout", message: "x", exitCode: null })).toBe(
      "bd is busy — priority not saved",
    );
  });

  it("says the same thing when bd is the one that gave up on the store", () => {
    // `storeBusy` carries bd's own `context canceled`, which used to reach the reader verbatim —
    // a Go runtime phrase describing the mechanism, in the slot reserved for the remedy.
    const sentence = priorityFailureSentence({
      kind: "storeBusy",
      message: "context canceled",
      exitCode: 1,
    });
    expect(sentence).toBe("bd is busy — priority not saved");
    expect(sentence).not.toContain("context canceled");
  });

  it("distinguishes a missing bd from a missing workspace", () => {
    expect(priorityFailureSentence({ kind: "binaryNotFound", message: "", exitCode: null })).toContain(
      "not installed",
    );
    expect(priorityFailureSentence({ kind: "noWorkspace", message: "", exitCode: null })).toContain(
      "no beads workspace",
    );
  });

  it("falls back to bd's own message for anything else", () => {
    expect(priorityFailureSentence({ kind: "bdFailed", message: "boom", exitCode: 1 })).toBe(
      "priority not saved — boom",
    );
  });
});

describe("the priority vocabulary", () => {
  it("offers exactly the four bands, in the founder's words", () => {
    expect(PRIORITY_OPTIONS.map((o) => o.label)).toEqual([
      "P0: Do it now",
      "P1: Do it next",
      "P2: Do it when most efficient",
      "P3: Do it when cycles are available",
    ]);
  });

  // A bead with no priority is the one most worth clicking; rendering it as an absence is how it
  // stays unset forever.
  it("renders an unset priority as something clickable", () => {
    expect(priorityShort(undefined)).toBe("P?");
    expect(priorityShort(0)).toBe("P0");
  });

  // The danger ink marks "this is ahead of other work". Spending it on every band would make a
  // board where every card is red, which says nothing.
  it("bands the urgent priorities", () => {
    expect(isUrgentPriority(0)).toBe(true);
    expect(isUrgentPriority(1)).toBe(true);
    expect(isUrgentPriority(2)).toBe(false);
    expect(isUrgentPriority(undefined)).toBe(false);
  });
});
