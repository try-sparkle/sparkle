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

    // Two clicks — the panel's bulk run and a per-row press, overlapping.
    const first = remedyStale("/repos/sparkle");
    const second = remedyStale("/repos/sparkle");

    expect(invoke).toHaveBeenCalledTimes(1);

    settle(OK);
    // The late caller gets the WINNER'S real outcome, not a silent skip — a skip would leave the
    // panel's row spinning forever with nothing to render.
    await expect(first).resolves.toEqual(OK);
    await expect(second).resolves.toEqual(OK);
  });

  // ── SHARING IS NOT SYMMETRIC ──────────────────────────────────────────────────────────────────
  //
  // Coalescing two callers onto one invocation also merges their POLICIES, and the two policies are
  // not interchangeable: an unattended run refuses anything that is not still `auto_safe`. So the
  // direction matters, and each direction is wrong in a different way if collapsed.
  it("lets the POLL ride on a click's run — a click is strictly more permissive", async () => {
    let settle!: (v: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (settle = r)));

    const fromClick = remedyStale("/repos/sparkle");
    const fromPoll = remedyStale("/repos/sparkle", { unattended: true });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("repo_stale_remedy", {
      root: "/repos/sparkle",
      unattended: false,
    });

    settle(OK);
    await expect(fromClick).resolves.toEqual(OK);
    // A real answer to "is this checkout advanced now", which is all the poll wanted.
    await expect(fromPoll).resolves.toEqual(OK);
  });

  // …AND THE OTHER ORDERING OF THE SAME RACE. The asymmetry is about the poll's REFUSAL, not about
  // the poll's run: when the poll SUCCEEDED there is nothing left for the click to do, and making
  // it take its own turn anyway is how the original bug comes back.
  it("lets a click ride on a poll that SUCCEEDED — the checkout is advanced, which is the answer", async () => {
    let settle!: (v: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (settle = r)));

    const fromPoll = remedyStale("/repos/sparkle", { unattended: true });
    const fromClick = remedyStale("/repos/sparkle");

    settle(OK);
    await expect(fromPoll).resolves.toEqual(OK);
    await expect(fromClick).resolves.toEqual(OK);
    // THE POINT, and it is the call COUNT that carries it. A second `repo_stale_remedy` would
    // re-diagnose a checkout the poll had just brought up to date, come back `remedy: None` →
    // `ok:false` "up to date with origin/main", and the panel renders every `!ok` outcome in its
    // danger colour: a red refusal for a fast-forward that worked (roborev 59437).
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does NOT let a click ride on the poll's REFUSAL — it would report their press as a failure", async () => {
    // The poll's invocation refuses: by the time it reached the backend the tree was dirty, which
    // is exactly the case the unattended policy exists to stop.
    const REFUSED = { ok: false, reason: "dirty", action: "", beforeBehind: 3, afterBehind: 3 };
    invoke.mockResolvedValueOnce(REFUSED).mockResolvedValueOnce(OK);

    const fromPoll = remedyStale("/repos/sparkle", { unattended: true });
    const fromClick = remedyStale("/repos/sparkle");

    await expect(fromPoll).resolves.toEqual(REFUSED);
    // The user pressed a button the panel had just offered them. Handing them the poll's refusal
    // would report their own deliberate act as a failure of a remedy that is theirs to take.
    await expect(fromClick).resolves.toEqual(OK);
    expect(invoke).toHaveBeenCalledTimes(2);
    // …and it waited rather than racing: two `merge --ff-only` on one root is what this map exists
    // to prevent, so the click's call is issued only after the poll's has settled.
    expect(invoke.mock.calls[1]).toEqual([
      "repo_stale_remedy",
      { root: "/repos/sparkle", unattended: false },
    ]);
  });

  // …AND THE THIRD ARM OF THE SAME BRANCH. The wait decides three ways — the poll RESOLVED ok, the
  // poll RESOLVED a refusal, the poll REJECTED — and an IPC rejection is not the click's answer any
  // more than a refusal is. Without the rejection handler the click's promise rejects with the
  // POLL's error, which `runRemedy` stores as `{ ok: false, reason: String(e) }` and the panel
  // paints in its danger colour: a red failure for a press that never reached the backend at all.
  it("does NOT let a click inherit the poll's IPC REJECTION either — it takes its own turn", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc died")).mockResolvedValueOnce(OK);

    const fromPoll = remedyStale("/repos/sparkle", { unattended: true });
    const fromClick = remedyStale("/repos/sparkle");

    await expect(fromPoll).rejects.toThrow("ipc died");
    // The press is answered by ITS OWN run, not by the poll's transport failure.
    await expect(fromClick).resolves.toEqual(OK);
    expect(invoke).toHaveBeenCalledTimes(2);
    // …and it still waited rather than racing: the click's call is issued only after the poll's
    // has settled, under the click's own policy.
    expect(invoke.mock.calls[1]).toEqual([
      "repo_stale_remedy",
      { root: "/repos/sparkle", unattended: false },
    ]);
  });

  it("carries the unattended flag to the backend, since that is where it is enforced", async () => {
    invoke.mockResolvedValue(OK);
    await remedyStale("/repos/sparkle", { unattended: true });
    expect(invoke).toHaveBeenCalledWith("repo_stale_remedy", {
      root: "/repos/sparkle",
      unattended: true,
    });
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
