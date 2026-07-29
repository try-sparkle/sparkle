// staleBuildService tests — node env. We mock the Tauri core invoke + process plugin and drive the
// pure predicate (isStaleBuild / compareVersions) plus the store-updating checkStaleBuild directly;
// the dev/packaged guard in startStaleBuildWatch is not exercised here (it no-ops outside Tauri).
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...a: unknown[]) => relaunch(...a),
}));

import {
  isStaleBuild,
  compareVersions,
  checkStaleBuild,
  probeStaleBuild,
  restartToFinishUpdate,
  useStaleBuildStore,
  UNKNOWN_SHA,
  type StaleBuildProbe,
} from "./staleBuildService";

function makeProbe(over: Partial<StaleBuildProbe> = {}): StaleBuildProbe {
  return {
    runningVersion: "0.59.0",
    runningSha: "aaaaaaa",
    installedVersion: "0.59.0",
    installedSha: null,
    installedMtimeMs: null,
    runningStartedMs: null,
    installedPath: "/Applications/Sparkle.app",
    ...over,
  };
}

beforeEach(() => {
  invoke.mockReset();
  relaunch.mockReset();
  useStaleBuildStore.setState({ stale: false, installedVersion: null, dismissed: false });
});

describe("compareVersions", () => {
  it("orders by numeric dotted segments", () => {
    expect(compareVersions("0.59.0", "0.60.0")).toBe(-1);
    expect(compareVersions("0.60.0", "0.59.0")).toBe(1);
    expect(compareVersions("0.59.0", "0.59.0")).toBe(0);
  });

  it("compares numerically, not lexically (10 > 9)", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("ignores a pre-release / build suffix", () => {
    expect(compareVersions("0.59.0-rc.1", "0.59.0")).toBe(0);
    expect(compareVersions("0.59.0+meta", "0.59.0")).toBe(0);
  });

  it("treats missing trailing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });
});

describe("isStaleBuild", () => {
  it("is TRUE when the installed version is strictly newer than the running one", () => {
    expect(isStaleBuild(makeProbe({ runningVersion: "0.59.0", installedVersion: "0.60.0" }))).toBe(true);
  });

  it("is FALSE when the installed version is OLDER (we're ahead — never nag)", () => {
    expect(isStaleBuild(makeProbe({ runningVersion: "0.60.0", installedVersion: "0.59.0" }))).toBe(false);
  });

  it("an OLDER installed version wins even when the SHAs differ (never nag on a downgrade)", () => {
    // The version verdict must SHORT-CIRCUIT before the SHA fallback: without the older-version
    // guard, differing SHAs here would (wrongly) flag stale. This pins that precedence.
    expect(
      isStaleBuild(
        makeProbe({
          runningVersion: "0.60.0",
          installedVersion: "0.59.0",
          runningSha: "aaaaaaa",
          installedSha: "bbbbbbb",
        }),
      ),
    ).toBe(false);
  });

  it("is FALSE when versions are equal and no comparable SHAs", () => {
    expect(isStaleBuild(makeProbe({ installedSha: null }))).toBe(false);
  });

  it("is FALSE when the installed version is unknown (never nag on incomplete info)", () => {
    expect(isStaleBuild(makeProbe({ installedVersion: null }))).toBe(false);
  });

  it("falls back to SHA when versions are EQUAL: different real SHAs ⇒ stale", () => {
    expect(
      isStaleBuild(makeProbe({ runningSha: "aaaaaaa", installedSha: "bbbbbbb" })),
    ).toBe(true);
  });

  it("does NOT treat the 'unknown' SHA sentinel as a mismatch", () => {
    expect(
      isStaleBuild(makeProbe({ runningSha: UNKNOWN_SHA, installedSha: "bbbbbbb" })),
    ).toBe(false);
    expect(
      isStaleBuild(makeProbe({ runningSha: "aaaaaaa", installedSha: UNKNOWN_SHA })),
    ).toBe(false);
  });

  it("does NOT flag equal SHAs", () => {
    expect(
      isStaleBuild(makeProbe({ runningSha: "aaaaaaa", installedSha: "aaaaaaa" })),
    ).toBe(false);
  });

  it("prefers the version verdict over SHA: newer installed version wins even with equal SHAs", () => {
    expect(
      isStaleBuild(
        makeProbe({
          runningVersion: "0.59.0",
          installedVersion: "0.60.0",
          runningSha: "aaaaaaa",
          installedSha: "aaaaaaa",
        }),
      ),
    ).toBe(true);
  });
});

describe("checkStaleBuild", () => {
  it("marks the store stale (with installed version) when the probe is stale", async () => {
    invoke.mockResolvedValue(makeProbe({ runningVersion: "0.59.0", installedVersion: "0.60.0" }));
    const stale = await checkStaleBuild();
    expect(stale).toBe(true);
    const st = useStaleBuildStore.getState();
    expect(st.stale).toBe(true);
    expect(st.installedVersion).toBe("0.60.0");
    expect(invoke).toHaveBeenCalledWith("stale_build_probe");
  });

  it("clears the store when the probe is NOT stale", async () => {
    useStaleBuildStore.setState({ stale: true, installedVersion: "0.60.0", dismissed: true });
    invoke.mockResolvedValue(makeProbe()); // equal versions, no SHA
    const stale = await checkStaleBuild();
    expect(stale).toBe(false);
    expect(useStaleBuildStore.getState()).toMatchObject({ stale: false, installedVersion: null, dismissed: false });
  });

  it("keeps a dismissal while the installed version is UNCHANGED", async () => {
    invoke.mockResolvedValue(makeProbe({ runningVersion: "0.59.0", installedVersion: "0.60.0" }));
    await checkStaleBuild();
    useStaleBuildStore.getState().dismiss();
    expect(useStaleBuildStore.getState().dismissed).toBe(true);
    // Re-probe, same installed version → stays dismissed.
    await checkStaleBuild();
    expect(useStaleBuildStore.getState().dismissed).toBe(true);
  });

  it("RE-SHOWS (un-dismisses) when a still-newer build appears", async () => {
    invoke.mockResolvedValue(makeProbe({ runningVersion: "0.59.0", installedVersion: "0.60.0" }));
    await checkStaleBuild();
    useStaleBuildStore.getState().dismiss();
    expect(useStaleBuildStore.getState().dismissed).toBe(true);
    invoke.mockResolvedValue(makeProbe({ runningVersion: "0.59.0", installedVersion: "0.61.0" }));
    await checkStaleBuild();
    expect(useStaleBuildStore.getState().dismissed).toBe(false);
    expect(useStaleBuildStore.getState().installedVersion).toBe("0.61.0");
  });

  it("returns false and does not throw when the command is unavailable", async () => {
    invoke.mockRejectedValue(new Error("no such command"));
    await expect(checkStaleBuild()).resolves.toBe(false);
    expect(useStaleBuildStore.getState().stale).toBe(false);
  });
});

describe("probeStaleBuild", () => {
  it("returns the raw probe on success", async () => {
    const p = makeProbe({ installedMtimeMs: 123, runningStartedMs: 100 });
    invoke.mockResolvedValue(p);
    await expect(probeStaleBuild()).resolves.toEqual(p);
  });

  it("returns null (never throws) on failure", async () => {
    invoke.mockRejectedValue(new Error("boom"));
    await expect(probeStaleBuild()).resolves.toBeNull();
  });
});

describe("restartToFinishUpdate", () => {
  it("relaunches the app", async () => {
    relaunch.mockResolvedValue(undefined);
    await restartToFinishUpdate();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("swallows a relaunch failure", async () => {
    relaunch.mockRejectedValue(new Error("cannot relaunch"));
    await expect(restartToFinishUpdate()).resolves.toBeUndefined();
  });
});
