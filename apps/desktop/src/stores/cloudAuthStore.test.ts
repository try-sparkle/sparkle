// The two properties that bound the automatic cloud-auth probe, both added after roborev 58470
// caught an unbounded request loop. They live in the STORE, not in the effect that calls it,
// because a caller can only test the value it captured at render.
//
//   1. `attempted` survives FAILURE. `refresh` deliberately leaves `loaded` false when the GET
//      fails ("a failed probe must not be read as 'we know there's none saved'"), so anything
//      gating a retry on `!loaded` retries forever for a user who is offline or hitting a 5xx.
//   2. `refresh` JOINS a probe that is already in flight, so N consumers mounting in one commit
//      produce one request rather than N — and every one of them still sees the result. Dropping
//      the call instead was its own bug (roborev 58489): `readCloudGate` awaits refresh() to read
//      `method` afterwards, and a dropped call resolves before there is anything to read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getClaudeAuth: vi.fn(),
  putClaudeAuth: vi.fn(),
  deleteClaudeAuth: vi.fn(),
}));
vi.mock("../services/cloudAgents/api", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    cloudApi: {
      ...(real.cloudApi as object),
      getClaudeAuth: h.getClaudeAuth,
      putClaudeAuth: h.putClaudeAuth,
      deleteClaudeAuth: h.deleteClaudeAuth,
    },
  };
});

import { useCloudAuthStore } from "./cloudAuthStore";

const state = () => useCloudAuthStore.getState();

beforeEach(() => {
  h.getClaudeAuth.mockReset();
  h.putClaudeAuth.mockReset();
  h.deleteClaudeAuth.mockReset();
  state().reset();
});

describe("cloudAuthStore.refresh — a FAILED probe is bounded", () => {
  it("marks the probe attempted, while still refusing to claim there is no credential", async () => {
    h.getClaudeAuth.mockRejectedValue(new Error("offline"));

    await state().refresh();

    // The load-bearing pair: we tried (so nothing should try again on its own)…
    expect(state().attempted).toBe(true);
    // …but we did NOT learn anything, so the gate must not read this as "no auth saved".
    expect(state().loaded).toBe(false);
    expect(state().busy).toBe(false);
    expect(state().error).toBeTruthy();
  });

  it("marks it attempted on SUCCESS too, so the bound is the same on both paths", async () => {
    h.getClaudeAuth.mockResolvedValue({ method: "byok" });

    await state().refresh();

    expect(state().attempted).toBe(true);
    expect(state().loaded).toBe(true);
    expect(state().method).toBe("byok");
  });

  it("reset() clears it, so signing back in probes again", async () => {
    h.getClaudeAuth.mockRejectedValue(new Error("offline"));
    await state().refresh();
    expect(state().attempted).toBe(true);

    state().reset();

    expect(state().attempted).toBe(false);
  });
});

describe("cloudAuthStore.refresh — concurrent callers make ONE request", () => {
  it("no-ops while a probe is already in flight", async () => {
    // A probe held open, so the second call lands while the first is genuinely mid-flight — the
    // shape N consumers mounting in one commit produce.
    let settle!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settle = res)));

    const a = state().refresh();
    const b = state().refresh(); // the sibling consumer, same flush
    settle({ method: "byok" });
    await Promise.all([a, b]);

    // Asserted as a COUNT, not as "was called": the defect was two requests racing, and the last to
    // settle winning the store write.
    expect(h.getClaudeAuth).toHaveBeenCalledTimes(1);
    expect(state().method).toBe("byok");
  });

  it("allows a LATER probe once the first has settled (the guard is in-flight, not permanent)", async () => {
    h.getClaudeAuth.mockResolvedValue({ method: "byok" });
    await state().refresh();
    await state().refresh();

    expect(h.getClaudeAuth).toHaveBeenCalledTimes(2);
  });
});

describe("cloudAuthStore.refresh — a concurrent caller JOINS the probe, it is not dropped", () => {
  // roborev 58489. The first version of the guard early-returned, which resolves the second
  // caller's promise IMMEDIATELY. `conciergeTools/lifecycle.readCloudGate` awaits refresh()
  // precisely so it can re-read `method` afterwards — dropped, it re-reads null and refuses the
  // first cloud spawn of every launch with "add your Claude authentication", the exact refusal that
  // probe exists to prevent. A count-only assertion cannot see this, which is why it shipped.
  it("the second caller's promise does NOT resolve until the probe settles", async () => {
    // THE DISCRIMINATOR, and the reason the first version of this test was worthless: settling the
    // probe BEFORE awaiting makes a joined promise and a dropped one look identical, because both
    // are resolved by then. Verified by mutation — the earlier shape passed against the bug. What
    // separates them is whether the second promise is still PENDING while the GET is in flight.
    let settle!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settle = res)));

    const first = state().refresh();
    const second = Promise.resolve(state().refresh()); // tolerate a `void` return under mutation
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    // Drain the microtask queue several times. A DROPPED call resolves here; a joined one cannot.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(secondSettled).toBe(false);
    // …and it has nothing to report yet, which is precisely what `readCloudGate` would misread.
    expect(state().method).toBeNull();

    settle({ method: "byok" });
    await second;

    expect(state().method).toBe("byok");
    expect(state().loaded).toBe(true);
    await first;
    expect(h.getClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("a SAVE in flight does not swallow a probe — the guard is probe-specific, not `busy`", async () => {
    // `busy` is the multi-purpose "load/save/delete in flight" flag. Keying the guard on it meant a
    // save could eat a consumer's only probe — and since `busy` is no longer an effect dependency,
    // nothing would ever re-run it, so that mount's gate stayed un-hydrated for good.
    let finishSave!: () => void;
    h.putClaudeAuth.mockReturnValue(new Promise<void>((res) => (finishSave = res)));
    h.getClaudeAuth.mockResolvedValue({ method: "byok" });

    const saving = state().save("byok", "sk-ant-secret");
    expect(state().busy).toBe(true); // a write really is in flight

    await state().refresh();

    expect(h.getClaudeAuth).toHaveBeenCalledTimes(1);
    expect(state().loaded).toBe(true);

    finishSave();
    await saving;
  });

  it("reset() drops the handle, so the next sign-in cannot join the last session's probe", async () => {
    let settle!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settle = res)));
    const first = state().refresh();

    state().reset(); // sign-out mid-probe
    h.getClaudeAuth.mockResolvedValue({ method: "subscription" });
    await state().refresh();

    // A SECOND request went out — the new account's answer, not the old one's.
    expect(h.getClaudeAuth).toHaveBeenCalledTimes(2);
    expect(state().method).toBe("subscription");
    settle({ method: "byok" });
    await first;
  });
});

describe("cloudAuthStore — a late answer is DISCARDED, never written", () => {
  // roborev 58498. Dropping the handle stops the next caller JOINING a stale probe; it does nothing
  // about that probe's own continuation, which still runs and still writes. These three cover the
  // writes, which is where the damage actually is.

  it("a probe settling AFTER a sign-out cannot stamp the old account onto the new session", async () => {
    let settleOld!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settleOld = res)));
    const stale = state().refresh(); // account A

    state().reset(); // sign-out
    h.getClaudeAuth.mockResolvedValue({ method: "subscription" });
    await state().refresh(); // account B
    expect(state().method).toBe("subscription");

    // A's answer arrives late. The previous version of this test settled it and asserted NOTHING
    // afterwards, so the clobber happened inside the test unchecked.
    settleOld({ method: "byok" });
    await stale;

    expect(state().method).toBe("subscription");
    expect(state().loaded).toBe(true);
    // The nastiest part of the clobber: `attempted` is what bounds hydration, so a stale `true`
    // means account B never re-probes and reads A's credential for the rest of the process.
    expect(state().attempted).toBe(true);
  });

  it("a FAILED stale probe cannot stamp its error, or its attempted flag, on the new session", async () => {
    let failOld!: (e: Error) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((_res, rej) => (failOld = rej)));
    const stale = state().refresh();

    state().reset();
    expect(state().attempted).toBe(false);

    failOld(new Error("belongs to the signed-out session"));
    await stale;

    expect(state().attempted).toBe(false); // still un-probed, so the next mount WILL probe
    expect(state().error).toBeNull();
  });

  it("a stale probe's settlement does not disarm the guard for the CURRENT probe", async () => {
    let settleOld!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValueOnce(new Promise((res) => (settleOld = res)));
    const stale = state().refresh();

    state().reset();
    let settleNew!: (v: { method: "subscription" }) => void;
    h.getClaudeAuth.mockReturnValueOnce(new Promise((res) => (settleNew = res)));
    const current = state().refresh(); // probe 2, still outstanding

    settleOld({ method: "byok" }); // probe 1's `finally` fires while probe 2 is in flight
    await stale;

    // If that `finally` nulled the handle unconditionally, this third call issues a DUPLICATE GET
    // instead of joining probe 2 — the guard silently off in the auth-transition window.
    void state().refresh();
    expect(h.getClaudeAuth).toHaveBeenCalledTimes(2);

    settleNew({ method: "subscription" });
    await current;
  });

  it("a probe that settles after a SAVE does not overwrite the just-saved credential", async () => {
    // The lossy ordering the earlier save test did not cover: the GET is issued BEFORE the save and
    // settles AFTER it, carrying the server's pre-save answer.
    let settleProbe!: (v: { method: null }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settleProbe = res)));
    const probing = state().refresh();

    h.putClaudeAuth.mockResolvedValue(undefined);
    await state().save("byok", "sk-ant-secret");
    expect(state().method).toBe("byok");

    settleProbe({ method: null }); // "no credential saved" — true before the save, false now
    await probing;

    // Without the epoch bump on save this reads null, and `loaded: true` makes it authoritative —
    // so a user who just saved a credential is told none is configured.
    expect(state().method).toBe("byok");
  });
});

describe("cloudAuthStore — a WRITE is as supersedable as a probe", () => {
  // roborev 58510. The epoch was bumped by save/remove but never checked BY them, so the latch the
  // probe was just fixed for was still reachable through the other door. Both buttons live in the
  // same open dialog as Sign out, and nothing disables sign-out while a write is in flight.

  it("a SAVE settling after a sign-out cannot stamp the old credential on the new session", async () => {
    let finishSave!: () => void;
    h.putClaudeAuth.mockReturnValue(new Promise<void>((res) => (finishSave = res)));
    const saving = state().save("byok", "sk-ant-secret");

    state().reset(); // sign-out mid-write

    finishSave();
    expect(await saving).toBe(false); // this session did not complete a save

    expect(state().method).toBeNull();
    // The nastiest half again: `attempted` bounds hydration, so a stale `true` means the new
    // session never probes and reads the previous account's answer for the whole process.
    expect(state().attempted).toBe(false);
    expect(state().loaded).toBe(false);
  });

  it("a FAILED save settling after a sign-out cannot stamp its error either", async () => {
    let failSave!: (e: Error) => void;
    h.putClaudeAuth.mockReturnValue(new Promise<void>((_r, rej) => (failSave = rej)));
    const saving = state().save("byok", "sk-ant-secret");

    state().reset();
    failSave(new Error("belongs to the signed-out session"));

    expect(await saving).toBe(false);
    expect(state().error).toBeNull();
  });

  it("a REMOVE settling after a sign-out does not touch the new session", async () => {
    let finishRemove!: () => void;
    h.deleteClaudeAuth.mockReturnValue(new Promise<void>((res) => (finishRemove = res)));
    const removing = state().remove();

    state().reset();
    finishRemove();

    expect(await removing).toBe(false);
    expect(state().attempted).toBe(false);
    expect(state().loaded).toBe(false);
  });

  it("a FAILED remove settling after a sign-out cannot stamp its error either", async () => {
    // THE FIFTH SITE, AGAIN (roborev 58526). `remove`'s catch-path guard had no test — nothing in
    // this file or CloudAuthPane.test.tsx rejects deleteClaudeAuth — so deleting it stayed green.
    // The uncovered failure mirrors the save-catch case: a DELETE that fails offline and settles
    // after a sign-out writes `error` into the freshly-signed-in account's store, and CloudAuthPane
    // renders `error` unconditionally — so the new user sees a failure they never caused.
    let failRemove!: (e: Error) => void;
    h.deleteClaudeAuth.mockReturnValue(new Promise<void>((_r, rej) => (failRemove = rej)));
    const removing = state().remove();

    state().reset();
    failRemove(new Error("belongs to the signed-out session"));

    expect(await removing).toBe(false);
    expect(state().error).toBeNull();
  });

  it("a probe settling after a REMOVE does not resurrect the deleted credential", async () => {
    // The mirror of the save case, and the reason remove's epoch bump needed its own cover: a GET
    // issued before the DELETE and settling after it re-writes `{ method: "byok", loaded: true }`
    // over the credential the user just removed — so the pane reports one that is gone, and the
    // creation gate waves a cloud spawn through into a guaranteed 400.
    let settleProbe!: (v: { method: "byok" }) => void;
    h.getClaudeAuth.mockReturnValue(new Promise((res) => (settleProbe = res)));
    const probing = state().refresh();

    h.deleteClaudeAuth.mockResolvedValue(undefined);
    expect(await state().remove()).toBe(true);
    expect(state().method).toBeNull();

    settleProbe({ method: "byok" });
    await probing;

    expect(state().method).toBeNull();
  });
});
