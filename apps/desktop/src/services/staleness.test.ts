// The remedy call has TWO independent callers — the staleness poll's unattended `autoSafe`
// fast-forward and the panel's click — and neither can see the other. `remedyStale` is where they
// meet, so the in-flight coalescing lives there and is pinned here (roborev 59437).
//
// Why this matters concretely: two overlapping `git merge --ff-only` in one checkout means the
// second dies on `index.lock`, or lands "already current" as a red `ok:false`. Either way the user
// is shown a scary refusal for a remedy that actually succeeded.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { remedyStale, diagnoseStale } from "./staleness";

const OK = { ok: true, reason: "", action: "merge --ff-only origin/main", beforeBehind: 3, afterBehind: 0 };

beforeEach(() => {
  invoke.mockReset();
});

describe("remedyStale coalesces per checkout", () => {
  it("issues ONE backend call when both callers fire for the same root", async () => {
    let settle!: (v: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (settle = r)));

    // The poll's auto-fix and the panel's click, overlapping — the real race.
    const fromPoll = remedyStale("/repos/sparkle");
    const fromClick = remedyStale("/repos/sparkle");

    expect(invoke).toHaveBeenCalledTimes(1);

    settle(OK);
    // The late caller gets the WINNER'S real outcome, not a silent skip — a skip would leave the
    // panel's row spinning forever with nothing to render.
    await expect(fromPoll).resolves.toEqual(OK);
    await expect(fromClick).resolves.toEqual(OK);
  });

  it("does NOT coalesce across different checkouts", async () => {
    invoke.mockResolvedValue(OK);
    await Promise.all([remedyStale("/repos/a"), remedyStale("/repos/b")]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("releases the root after it settles, so a second remedy still runs", async () => {
    invoke.mockResolvedValue(OK);
    await remedyStale("/repos/sparkle");
    await remedyStale("/repos/sparkle");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // A root left in the in-flight map after a rejection would be permanently unfixable for the rest
  // of the session — the `.finally` is what prevents that, and this is what proves it.
  it("releases the root after a REJECTION too", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc died"));
    await expect(remedyStale("/repos/sparkle")).rejects.toThrow("ipc died");

    invoke.mockResolvedValueOnce(OK);
    await expect(remedyStale("/repos/sparkle")).resolves.toEqual(OK);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  // Diagnosis is a pure read and deliberately NOT coalesced — the panel wants a fresh answer per
  // open, and two reads cannot corrupt anything.
  it("leaves the read path alone", async () => {
    invoke.mockResolvedValue({ behind: 1 });
    await Promise.all([diagnoseStale("/repos/sparkle"), diagnoseStale("/repos/sparkle")]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
