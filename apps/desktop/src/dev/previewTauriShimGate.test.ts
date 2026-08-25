// THE PREVIEW'S TAURI IPC SHIM: that it is SERVED where it must be, and UNREACHABLE where it must
// not be. Bead sparkle-bg6868.
//
// WHAT WAS BROKEN. Every agent's preview card showed the auth gate — "We couldn't load your
// free-trial status" — because `.sparkle/config.toml` serves this package's vite dev server to a
// plain headless browser, which has no Tauri IPC, so `invoke("trial_status")` rejects and AuthGate
// paints WelcomeScreen. The fix serves the same `__TAURI_INTERNALS__` shim the visual harness has
// always injected over CDP.
//
// WHY THE ABSENCE CASES ARE THE POINT. This shim fakes the answer to an ENTITLEMENT check. If it
// could be served from a production build it would be a paywall bypass, so "it is present under
// serve+preview" is the cheap half of this file; the three "it is absent" assertions are the
// security property, and each names a different gate so removing any one of them turns this red.
//
// NOT named vite.config.*.test.ts — vitest's default exclude swallows `**/{...,vite,...}.config.*`
// and reports "No test files found" rather than running it. Same trap chiefPatPreviewGate.test.ts
// documents; this file sits beside it for the same reason.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "../../vite.config";
import { PREVIEW_MODE, devBypassAuthEnabled } from "./devBypassAuth";
import { TAURI_SHIM } from "../../scripts/visual/tauriShim.mjs";

interface PluginLike {
  name: string;
  apply?: unknown;
  transformIndexHtml?: unknown;
}

/** `defineConfig` is identity for the function form, so the export is callable. */
async function pluginsFor(mode: string, command: "serve" | "build"): Promise<PluginLike[]> {
  const resolved = await (
    config as unknown as (env: {
      mode: string;
      command: "serve" | "build";
      isSsrBuild: boolean;
      isPreview: boolean;
    }) => Promise<{ plugins: PluginLike[] }> | { plugins: PluginLike[] }
  )({ mode, command, isSsrBuild: false, isPreview: false });
  return resolved.plugins;
}

const SHIM_PLUGIN = "sparkle-preview-tauri-shim";

const find = (plugins: PluginLike[]) => plugins.find((p) => p && p.name === SHIM_PLUGIN);

describe("the preview server serves the Tauri IPC shim", () => {
  it("installs the plugin for `vite --mode preview` serve — the agent preview's command line", async () => {
    expect(find(await pluginsFor(PREVIEW_MODE, "serve"))).toBeDefined();
  });

  it("injects the SAME shim source the visual harness does, head-prepended", async () => {
    const plugin = find(await pluginsFor(PREVIEW_MODE, "serve"));
    const transform = plugin?.transformIndexHtml as () => Array<{
      tag: string;
      children: string;
      injectTo: string;
    }>;
    const tags = transform();
    expect(tags).toHaveLength(1);
    // Byte-for-byte against scripts/visual/tauriShim.mjs. A second, subtly different shim is the
    // outcome this bead set out to avoid, so identity is asserted rather than a substring.
    expect(tags[0]?.children).toBe(TAURI_SHIM);
    expect(tags[0]?.tag).toBe("script");
    // Ordering is load-bearing: `<script type="module" src="/src/main.tsx">` is DEFERRED, so a
    // classic inline script at the top of <head> is in place before the first app module runs and
    // therefore before the first `invoke()`. "head" (appended) would still beat the deferred module
    // today, but "head-prepend" is what states the requirement.
    expect(tags[0]?.injectTo).toBe("head-prepend");
  });

  it("actually installs a bridge when evaluated, and never clobbers a real one", () => {
    // The shim is a STRING until something evaluates it, so a test that only compares strings
    // would stay green against a shim that throws or installs nothing.
    const fresh: Record<string, unknown> = {};
    new Function("window", TAURI_SHIM)(fresh);
    expect(fresh.__TAURI_INTERNALS__).toBeTruthy();
    const real = { __TAURI_INTERNALS__: { marker: "the real Tauri bridge" } };
    new Function("window", TAURI_SHIM)(real);
    expect(real.__TAURI_INTERNALS__.marker).toBe("the real Tauri bridge");
  });
});

describe("the shim is UNREACHABLE outside the preview dev server", () => {
  it("is absent from a BUILD — the command that produces the shipped bundle", async () => {
    // `tauri build` runs `vite build`. The plugin is not even constructed here, so nothing Rollup
    // walks references the shim string.
    expect(find(await pluginsFor(PREVIEW_MODE, "build"))).toBeUndefined();
    expect(find(await pluginsFor("production", "build"))).toBeUndefined();
  });

  it("is absent from an ordinary `pnpm dev` / `pnpm tauri dev` serve", async () => {
    // The other direction, and not redundant: without it, a plugin returned unconditionally under
    // `serve` would pass every assertion above while injecting a fake entitlement bridge into the
    // developer's own dev loop — where a REAL Tauri bridge exists and must win.
    expect(find(await pluginsFor("development", "serve"))).toBeUndefined();
  });
});

describe("the mode the whole mechanism hangs on", () => {
  it("is the mode `.sparkle/config.toml` actually passes to the preview server", () => {
    // The coupling nothing else states: edit `[preview].args` and the shim silently stops being
    // served, putting every preview card back on the auth gate with the suite still green.
    const toml = readFileSync(resolve(__dirname, "../../../../.sparkle/config.toml"), "utf8");
    expect(toml).toContain(`"--mode", "${PREVIEW_MODE}"`);
  });

  it("turns the auth bypass on with it — the shim alone was measured WORSE", () => {
    // PRD/sparkle/preview-usable.md: with the bypass and no shim the app hits its own error
    // boundary (19 DOM nodes) instead of the gate (38). The converse is just as dead — a shim with
    // no bypass mounts a bridge behind a gate nobody gets past. They must switch on together.
    expect(devBypassAuthEnabled({ DEV: true, MODE: PREVIEW_MODE })).toBe(true);
  });
});
