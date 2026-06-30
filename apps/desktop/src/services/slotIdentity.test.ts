import { describe, it, expect } from "vitest";
import { shouldResetReusedSlotIdentity } from "./slotIdentity";

// A reused worktree slot sheds the prior occupant's identity (auto-name + workflow progress) ONLY on
// a confident fresh start. The subtle, safety-critical case: a *failed* session probe must NOT count
// as "fresh" — otherwise a transient IPC blip would wipe a historied agent's name + "shipped ✓"
// watermark (roborev 16238).
describe("shouldResetReusedSlotIdentity", () => {
  it("does not reset when a session exists (resume true)", () => {
    expect(shouldResetReusedSlotIdentity(true, true)).toBe(false);
  });

  it("resets on a CONFIDENT no-session result (a genuine fresh/reused slot)", () => {
    expect(shouldResetReusedSlotIdentity(false, true)).toBe(true);
  });

  it("does NOT reset when session detection failed (blip) — preserves displayed identity", () => {
    expect(shouldResetReusedSlotIdentity(false, false)).toBe(false);
  });
});
