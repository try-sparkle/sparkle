import { describe, it, expect } from "vitest";
import { previewSlotUp } from "./previewSlot";

describe("previewSlotUp", () => {
  it("is up only in Preview mode, and only with a project to preview", () => {
    expect(previewSlotUp("preview", true)).toBe(true);
    expect(previewSlotUp("preview", false)).toBe(false);
  });

  // The other two modes own the pair themselves — the board covers it in Plan and the terminal
  // stage fills it in Build. A slot that answered true for either would paint over them.
  it("is down in every other mode", () => {
    expect(previewSlotUp("build", true)).toBe(false);
    expect(previewSlotUp("plan", true)).toBe(false);
  });
});
