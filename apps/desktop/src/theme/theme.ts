// Theme resolution + apply. Read/apply are split so there is exactly ONE writer of the
// <html data-theme> attribute (useApplyTheme); useResolvedTheme is read-only and safe to
// call from any number of components (e.g. Terminal, which needs concrete hex).
import { useEffect, useState } from "react";
import { useUiStore, type ThemePref } from "../stores/uiStore";

export type ResolvedTheme = "light" | "dark";

const MEDIA = "(prefers-color-scheme: dark)";

// Whether the OS asks for a dark appearance. The shipping WKWebView always has matchMedia, so
// the `return true` branch is effectively a non-DOM/test-env guard (node tests, SSR), not a
// runtime path — it defaults to dark, the app's historical default, when appearance is
// undetectable rather than flipping to white.
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(MEDIA).matches;
}

// The shared resolution step: (pref, prefersDark) → concrete theme. Pure. This is the only
// piece common to the bootstrap path and the read hook — envelope parsing is bootstrap-only.
export function resolveTheme(pref: ThemePref, prefersDark: boolean): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return prefersDark ? "dark" : "light";
}

// Parse the zustand `persist` envelope (`{ state: { themePref }, version }`) tolerantly:
// a missing key, null, unparseable JSON, or an unknown value all fall back to "auto".
export function parseThemePref(raw: string | null): ThemePref {
  try {
    const pref = (JSON.parse(raw ?? "")?.state?.themePref) as unknown;
    return pref === "light" || pref === "dark" || pref === "auto" ? pref : "auto";
  } catch {
    return "auto";
  }
}

// Bootstrap resolver used synchronously in main.tsx before React mounts (avoids a FOUC of
// the wrong theme). NOT pure: resolves "auto" via systemPrefersDark()/matchMedia, so its
// unit test must stub window.matchMedia. Shared with the apply effect's initial resolve;
// the read hook (useResolvedTheme) reads the hydrated store and never runs this parse.
export function resolveThemeFromStorage(raw: string | null): ResolvedTheme {
  return resolveTheme(parseThemePref(raw), systemPrefersDark());
}

// Subscribe to OS appearance changes. Calls `notify` immediately with the current value and
// again on every change; returns an unsubscribe. No-op when matchMedia is unavailable.
// Extracted from the hook so the subscription wiring (the live OS-flip path the Terminal
// depends on) is unit-testable in the repo's node test env without a DOM harness.
export function watchSystemTheme(notify: (prefersDark: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(MEDIA);
  const onChange = () => notify(mq.matches);
  onChange();
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

// Write the resolved theme onto a document root's dataset. Extracted from useApplyTheme so
// the single-writer behavior is testable without a DOM framework.
export function applyThemeAttr(root: { dataset: { theme?: string } }, resolved: ResolvedTheme): void {
  root.dataset.theme = resolved;
}

// Read-only selector: themePref from the store, reflecting live OS changes for "auto".
// No side effects, no attribute writes — safe to call from N components.
export function useResolvedTheme(): ResolvedTheme {
  const pref = useUiStore((s) => s.themePref);
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  useEffect(() => watchSystemTheme(setPrefersDark), []);
  return resolveTheme(pref, prefersDark);
}

// The single writer of <html data-theme>. Mount exactly once at the root (App). Flipping the
// attribute re-themes the whole app through CSS variables with no React re-render of the tree.
export function useApplyTheme(): void {
  const resolved = useResolvedTheme();
  useEffect(() => {
    applyThemeAttr(document.documentElement, resolved);
  }, [resolved]);
}
