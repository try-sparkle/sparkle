// DEV-ONLY: the bypass ships OFF (absent/false env -> disabled) AND is structurally gated on
// import.meta.env.DEV, so it can never activate in a release bundle even with the flag set.
import { describe, expect, it } from "vitest";
import { DEV_BYPASS_AUTH_FLAG, devBypassAuthEnabled } from "./devBypassAuth";

describe("devBypassAuthEnabled", () => {
  it("is OFF by default in a dev/test context (no env, empty, explicit false)", () => {
    expect(devBypassAuthEnabled({ DEV: true })).toBe(false);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: undefined })).toBe(false);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: "" })).toBe(false);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: "false" })).toBe(false);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: "0" })).toBe(false);
  });

  it("turns on only for an explicit opt-in WHEN DEV is true", () => {
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: "1" })).toBe(true);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: "true" })).toBe(true);
    expect(devBypassAuthEnabled({ DEV: true, [DEV_BYPASS_AUTH_FLAG]: true })).toBe(true);
  });

  it("can NEVER activate in a release bundle: DEV false forces OFF even with the flag set", () => {
    expect(devBypassAuthEnabled({ DEV: false, [DEV_BYPASS_AUTH_FLAG]: "1" })).toBe(false);
    // DEV absent (undefined) also forces OFF.
    expect(devBypassAuthEnabled({ [DEV_BYPASS_AUTH_FLAG]: "1" })).toBe(false);
    // DEV must be the boolean true, not a truthy string.
    expect(devBypassAuthEnabled({ DEV: "true", [DEV_BYPASS_AUTH_FLAG]: "1" })).toBe(false);
  });

  it("reads the real import.meta.env by default (flag unset in tests -> disabled)", () => {
    expect(devBypassAuthEnabled()).toBe(false);
  });
});
