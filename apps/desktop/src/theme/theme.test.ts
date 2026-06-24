import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveTheme,
  parseThemePref,
  resolveThemeFromStorage,
  applyThemeAttr,
  watchSystemTheme,
} from "./theme";
import { THEME_HEX, xtermTheme } from "./colors";

// Stub window.matchMedia for the env-dependent paths (node test env has no window).
function stubPrefersDark(matches: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches, media: query }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveTheme (pure: pref + prefersDark → concrete)", () => {
  it("forces light/dark regardless of OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
  });

  it("follows the OS for 'auto'", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});

describe("parseThemePref (zustand envelope → pref, tolerant)", () => {
  it("reads themePref from the persist envelope", () => {
    expect(parseThemePref(JSON.stringify({ state: { themePref: "light" }, version: 0 }))).toBe("light");
    expect(parseThemePref(JSON.stringify({ state: { themePref: "dark" }, version: 1 }))).toBe("dark");
  });

  it("falls back to 'auto' for a missing key, null, or garbage", () => {
    expect(parseThemePref(JSON.stringify({ state: { zoom: 1.2 }, version: 0 }))).toBe("auto");
    expect(parseThemePref(null)).toBe("auto");
    expect(parseThemePref("not json {{{")).toBe("auto");
    expect(parseThemePref(JSON.stringify({ state: { themePref: "weird" } }))).toBe("auto");
  });
});

describe("resolveThemeFromStorage (bootstrap path, matchMedia-dependent)", () => {
  it("(a) resolves an explicit preference straight through", () => {
    stubPrefersDark(false); // ignored for an explicit pref
    expect(resolveThemeFromStorage(JSON.stringify({ state: { themePref: "light" }, version: 0 }))).toBe("light");
  });

  it("(b) resolves an old-shape blob (no themePref) via auto/matchMedia", () => {
    stubPrefersDark(true);
    expect(resolveThemeFromStorage(JSON.stringify({ state: { zoom: 1 }, version: 0 }))).toBe("dark");
  });

  it("(c) resolves null/garbage via the auto fallback + matchMedia", () => {
    stubPrefersDark(false);
    expect(resolveThemeFromStorage(null)).toBe("light");
    expect(resolveThemeFromStorage("garbage")).toBe("light");
  });
});

describe("applyThemeAttr (the single data-theme write, extracted from useApplyTheme)", () => {
  it("writes the resolved theme onto the root's dataset", () => {
    const root = { dataset: {} as { theme?: string } };
    applyThemeAttr(root, "light");
    expect(root.dataset.theme).toBe("light");
    applyThemeAttr(root, "dark");
    expect(root.dataset.theme).toBe("dark");
  });
});

describe("watchSystemTheme (matchMedia subscription, extracted from useResolvedTheme)", () => {
  // Build a controllable matchMedia whose "change" listeners we can fire by hand.
  function fakeMatchMedia(initial: boolean) {
    const listeners = new Set<() => void>();
    const mq = {
      matches: initial,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    };
    const fire = (next: boolean) => {
      mq.matches = next;
      for (const cb of listeners) cb();
    };
    return { mq, fire, listenerCount: () => listeners.size };
  }

  it("notifies immediately with the current preference, then on every change", () => {
    const mm = fakeMatchMedia(true);
    vi.stubGlobal("window", { matchMedia: () => mm.mq });
    const seen: boolean[] = [];
    watchSystemTheme((d) => seen.push(d));
    expect(seen).toEqual([true]); // immediate
    mm.fire(false);
    mm.fire(true);
    expect(seen).toEqual([true, false, true]);
  });

  it("unsubscribes on cleanup", () => {
    const mm = fakeMatchMedia(false);
    vi.stubGlobal("window", { matchMedia: () => mm.mq });
    const stop = watchSystemTheme(() => {});
    expect(mm.listenerCount()).toBe(1);
    stop();
    expect(mm.listenerCount()).toBe(0);
  });

  it("is a no-op (returns cleanly) when matchMedia is unavailable", () => {
    vi.stubGlobal("window", undefined);
    const seen: boolean[] = [];
    const stop = watchSystemTheme((d) => seen.push(d));
    expect(seen).toEqual([]);
    expect(() => stop()).not.toThrow();
  });
});

describe("xtermTheme (concrete hex only — no CSS var())", () => {
  it("uses literal hex for both resolved themes", () => {
    for (const resolved of ["light", "dark"] as const) {
      const theme = xtermTheme(resolved);
      for (const value of Object.values(theme)) {
        expect(value).not.toContain("var(");
        expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("maps background/foreground/selection from THEME_HEX for the resolved theme", () => {
    expect(xtermTheme("light").background).toBe(THEME_HEX.light.forest);
    expect(xtermTheme("light").foreground).toBe(THEME_HEX.light.cream);
    expect(xtermTheme("light").selectionBackground).toBe(THEME_HEX.light.chatBubble);
    expect(xtermTheme("dark").background).toBe(THEME_HEX.dark.forest);
  });
});
