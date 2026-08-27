import { describe, it, expect } from "vitest";
import {
  argsCarryTauriUnavailableSignature,
  TAURI_UNAVAILABLE_IN_TEST,
  TAURI_LISTEN_UNAVAILABLE_IN_TEST,
} from "./tauriUnavailableSignature";

// This predicate is what test-setup.ts's console filter calls to decide whether a console line is
// the benign jsdom-no-webview Tauri flood (suppress) or a real message (keep). It must match BOTH
// internals Tauri reads off the absent `window.__TAURI_INTERNALS__`: `invoke` (from core) and
// `transformCallback` (from event listen/emit). The transformCallback flood is the one that
// reddened CI coverage shards via the onTaskUpdate RPC timeout (bead sparkle-2sntv2).
describe("argsCarryTauriUnavailableSignature", () => {
  it("matches the invoke() signature as a string, an Error, and an embedded object", () => {
    expect(argsCarryTauriUnavailableSignature([`x: ${TAURI_UNAVAILABLE_IN_TEST}`])).toBe(true);
    expect(argsCarryTauriUnavailableSignature([new Error(TAURI_UNAVAILABLE_IN_TEST)])).toBe(true);
    expect(
      argsCarryTauriUnavailableSignature(["prefix", { error: TAURI_UNAVAILABLE_IN_TEST }]),
    ).toBe(true);
  });

  it("matches the listen()/transformCallback flood — the shape that reddens CI shards (sparkle-2sntv2)", () => {
    // The real call-site shapes, verbatim in spirit:
    //   console.error("[observed-attention] listener failed to start:", e)
    //   log.warn("audioInputs", "subscribe failed", { error: String(e) })
    expect(
      argsCarryTauriUnavailableSignature([
        "[observed-attention] listener failed to start:",
        new Error(TAURI_LISTEN_UNAVAILABLE_IN_TEST),
      ]),
    ).toBe(true);
    expect(argsCarryTauriUnavailableSignature([TAURI_LISTEN_UNAVAILABLE_IN_TEST])).toBe(true);
    expect(
      argsCarryTauriUnavailableSignature([
        { scope: "audioInputs", error: String(new Error(TAURI_LISTEN_UNAVAILABLE_IN_TEST)) },
      ]),
    ).toBe(true);
  });

  it("does NOT match unrelated errors — a real bug must still be logged, never silently swallowed", () => {
    // A different missing-property error is a real defect and must survive the filter.
    expect(
      argsCarryTauriUnavailableSignature(["Cannot read properties of undefined (reading 'foo')"]),
    ).toBe(false);
    expect(argsCarryTauriUnavailableSignature([new Error("some genuine failure")])).toBe(false);
    expect(argsCarryTauriUnavailableSignature(["everything is fine"])).toBe(false);
    expect(argsCarryTauriUnavailableSignature([42, null, undefined])).toBe(false);
  });
});
