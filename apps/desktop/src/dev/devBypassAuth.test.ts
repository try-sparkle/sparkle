// DEV-ONLY: the bypass ships OFF (absent/false env -> disabled) AND is structurally gated on
// import.meta.env.DEV, so it can never activate in a release bundle even with the flag set.
import { describe, expect, it } from "vitest";
import { DEV_BYPASS_AUTH_FLAG, PREVIEW_MODE, devBypassAuthEnabled } from "./devBypassAuth";

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

  it("is ON for vite MODE 'preview' — the agent preview server, which cannot set an env var", () => {
    // `.sparkle/config.toml`'s [preview] block serves this package with `--mode preview`, and its
    // schema is command/args/path only (and the repo .gitignores `.env.*`, so `.env.preview` is
    // not an option either). Keyed on the mode so no env plumbing is needed at all; the same
    // constant vite.config.ts's IPC-shim plugin keys on, so the bypass and the shim switch on
    // together — either alone leaves the preview broken (bead sparkle-bg6868).
    expect(devBypassAuthEnabled({ DEV: true, MODE: PREVIEW_MODE })).toBe(true);
  });

  it("is OFF for the developer's OWN dev serve — the mode branch is not 'any dev serve'", () => {
    // The other direction, and not redundant: widening this to every dev serve would pass the test
    // above while silently bypassing auth in `pnpm dev` and `pnpm tauri dev`, where a real Tauri
    // bridge and a real signed-in user exist.
    expect(devBypassAuthEnabled({ DEV: true, MODE: "development" })).toBe(false);
    expect(devBypassAuthEnabled({ DEV: true, MODE: "production" })).toBe(false);
  });

  it("can NEVER activate in a release bundle: DEV false forces OFF even in mode 'preview'", () => {
    // The single `env.DEV !== true` line governs BOTH ways in. A bundle built with `--mode preview`
    // still has DEV false, so the new branch cannot become a shipped paywall bypass.
    expect(devBypassAuthEnabled({ DEV: false, MODE: PREVIEW_MODE })).toBe(false);
    expect(devBypassAuthEnabled({ MODE: PREVIEW_MODE })).toBe(false);
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
