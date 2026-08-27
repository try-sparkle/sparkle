// The PURE half of bead sparkle-qg71dl. These are cheap and they prove the RULE; they cannot prove
// the SEAM, which is the defect the bead was actually filed on — a producer and a consumer on
// opposite sides of the IPC boundary, each with a green suite, carrying nothing between them. The
// test that spans it is `Concierge/MountedAgentNotices.test.tsx`'s login-expired block, which drives
// a real flag through the real poll into a real mounted component.
import { describe, expect, it } from "vitest";

import { loginStanddownOf, type LoginStanddownFlag } from "./loginStanddown";

const flag = (over: Partial<LoginStanddownFlag> = {}): LoginStanddownFlag => ({
  target: "founder",
  standdown: "login-expired",
  account: "work",
  raisedAtMs: 1_000,
  ...over,
});

describe("loginStanddownOf", () => {
  it("relays a founder-level login-expired stand-down, with the login named", () => {
    expect(loginStanddownOf(flag())).toEqual({ account: "work", raisedAtMs: 1_000 });
  });

  it("still raises when Rust could not identify the login — and says null, never a default", () => {
    // ⚠️ THE DIRECTION MATTERS. `nudger::stamp_account` can fail for reasons that have nothing to do
    // with the agent (the `claude` process exited so its PTY session is gone, `accounts.json` is
    // unreadable). Suppressing the whole escalation on that would let an unrelated IO failure
    // silence the one row a person has to act on. `null` is rendered as "unknown login".
    expect(loginStanddownOf(flag({ account: null }))).toEqual({ account: null, raisedAtMs: 1_000 });
    expect(loginStanddownOf(flag({ account: undefined }))).toEqual({
      account: null,
      raisedAtMs: 1_000,
    });
  });

  it("is undefined for every uncertain case", () => {
    expect(loginStanddownOf(undefined)).toBeUndefined();
    // A concierge-level flag: `Standdown::flag()` routes several blocked-shaped stand-downs away
    // from the founder on purpose, and reading the stand-down alone would re-open that false-alarm
    // class one layer up.
    expect(loginStanddownOf(flag({ target: "concierge" }))).toBeUndefined();
    // Any other stand-down, and the climbing-ladder case where there is none yet.
    expect(loginStanddownOf(flag({ standdown: "blocked-on-quota" }))).toBeUndefined();
    expect(loginStanddownOf(flag({ standdown: null }))).toBeUndefined();
    expect(loginStanddownOf(flag({ standdown: undefined }))).toBeUndefined();
  });

  it("reads the STAND-DOWN, not the reply — the field that survives a session that cannot speak", () => {
    // The population this exists for answers NOTHING, by construction: replying costs the API call
    // that is failing. A rule keyed on `reply` would be permanently blind to it, which is how the
    // founder watched four consecutive nudges produce silence.
    expect(loginStanddownOf({ ...flag(), reply: null } as LoginStanddownFlag)).toEqual({
      account: "work",
      raisedAtMs: 1_000,
    });
  });
});
