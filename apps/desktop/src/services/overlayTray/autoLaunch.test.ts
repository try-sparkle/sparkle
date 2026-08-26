// Opt-in auto-launch (bead sparkle-uz87.9). The interesting cases are all about ABSENCE.
import { describe, expect, it, vi } from "vitest";
import {
  autoLaunchEnabled,
  parseAutoLaunchPreference,
  setAutoLaunch,
  type AutoLaunchStore,
} from "./autoLaunch";

function store(initial: string | null | undefined): AutoLaunchStore & {
  calls: string[];
  value: string | null | undefined;
} {
  const s = {
    value: initial,
    calls: [] as string[],
    read: async () => s.value,
    write: async (v: string) => void (s.calls.push(`write:${v}`), (s.value = v)),
    enable: async () => void s.calls.push("enable"),
    disable: async () => void s.calls.push("disable"),
  };
  return s;
}

describe("opt-in means opt-in", () => {
  it("a user who was never asked does NOT launch at login", () => {
    expect(parseAutoLaunchPreference(null)).toBe("unknown");
    expect(parseAutoLaunchPreference(undefined)).toBe("unknown");
    expect(autoLaunchEnabled("unknown")).toBe(false);
  });

  it("a corrupted value is unknown, not a silent off", () => {
    // The distinction matters: reporting "off" for a value we could not read invites the caller to
    // "fix" it by writing one, overwriting a real choice.
    expect(parseAutoLaunchPreference("garbage")).toBe("unknown");
    expect(parseAutoLaunchPreference("")).toBe("unknown");
  });

  it("reads the forms a preference actually gets stored in", () => {
    for (const on of ["on", "true", "1"]) expect(parseAutoLaunchPreference(on)).toBe("on");
    for (const off of ["off", "false", "0"]) expect(parseAutoLaunchPreference(off)).toBe("off");
  });
});

describe("setAutoLaunch", () => {
  it("registers with the OS BEFORE persisting, so a stored 'on' is never a lie", async () => {
    const s = store(null);
    await setAutoLaunch(s, true);
    expect(s.calls).toEqual(["enable", "write:on"]);
  });

  it("does not persist when the OS registration fails", async () => {
    const s = store(null);
    s.enable = vi.fn(async () => {
      throw new Error("launchd refused");
    });
    await expect(setAutoLaunch(s, true)).rejects.toThrow("launchd refused");
    // The preference must still read unknown — a setting that claims to be on while nothing is
    // registered is worse than no setting at all.
    expect(parseAutoLaunchPreference(await s.read())).toBe("unknown");
  });

  it("is idempotent for a preference already set the same way", async () => {
    const s = store("on");
    const r = await setAutoLaunch(s, true);
    expect(r.changed).toBe(false);
    expect(s.calls).toEqual([]);
  });

  it("still WRITES when the stored value was unknown, even if the wanted state matches the default", async () => {
    // unknown + wanted:false is the case that looks like a no-op and is not: it converts "never
    // asked" into a recorded "no", which is what stops the next read being ambiguous.
    const s = store(null);
    const r = await setAutoLaunch(s, false);
    expect(r.changed).toBe(true);
    expect(s.calls).toEqual(["disable", "write:off"]);
  });

  it("turns it back off through the OS as well as the store", async () => {
    const s = store("on");
    await setAutoLaunch(s, false);
    expect(s.calls).toEqual(["disable", "write:off"]);
  });
});
