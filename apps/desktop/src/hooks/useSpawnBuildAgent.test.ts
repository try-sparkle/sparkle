import { describe, it, expect } from "vitest";
import { isBeadsUnavailable } from "./useSpawnBuildAgent";

// The exact rejection bd surfaces for a project that never ran `bd init`. createBeadFull rethrows
// the bd error string verbatim (services/tasks.ts), so this is the message the .catch sees.
const NO_DB = new Error("no beads database found");

describe("isBeadsUnavailable", () => {
  it("matches the expected 'no beads database' bd rejection (→ quiet debug, not WARN)", () => {
    expect(isBeadsUnavailable(NO_DB)).toBe(true);
  });

  it("matches when the substring is wrapped in a larger message", () => {
    expect(isBeadsUnavailable(new Error("bd: no beads database found in /some/path"))).toBe(true);
  });

  it("matches non-Error rejection values by stringifying them", () => {
    expect(isBeadsUnavailable("no beads database found")).toBe(true);
  });

  it("is case-insensitive so a bd casing tweak can't regress it to WARN", () => {
    expect(isBeadsUnavailable(new Error("No beads database found"))).toBe(true);
  });

  it("does NOT match genuine failures — those must stay loud at WARN", () => {
    expect(isBeadsUnavailable(new Error("bd returned no id: {}"))).toBe(false);
    expect(isBeadsUnavailable(new Error("Unexpected bd output: panic"))).toBe(false);
    expect(isBeadsUnavailable(new Error("permission denied"))).toBe(false);
    expect(isBeadsUnavailable(undefined)).toBe(false);
  });
});
