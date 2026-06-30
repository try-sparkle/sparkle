import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useUiStore, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, ZOOM_DEFAULT, COMPOSER_DEFAULT } from "./uiStore";

describe("uiStore theme", () => {
  // The store is a module-level singleton; the rehydrate test below mutates global fields
  // (composerHeight, etc.). Reset to defaults + clear storage so nothing leaks into later blocks.
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({
      themePref: "auto",
      composerHeight: COMPOSER_DEFAULT,
      zoom: ZOOM_DEFAULT,
      activeSpecial: null,
      agentOrdering: "attention",
    });
  });

  it("defaults themePref to 'auto'", () => {
    expect(useUiStore.getState().themePref).toBe("auto");
  });

  it("setThemePref updates the preference", () => {
    useUiStore.getState().setThemePref("light");
    expect(useUiStore.getState().themePref).toBe("light");
    useUiStore.getState().setThemePref("dark");
    expect(useUiStore.getState().themePref).toBe("dark");
    useUiStore.getState().setThemePref("auto");
  });

  // Load-bearing migration: an existing user's persisted blob predates themePref.
  // Rehydrating it must fall back to the default, not leave themePref undefined.
  it("falls back to 'auto' when the persisted blob has no themePref", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ state: { composerHeight: 200, zoom: 1.2, activeSpecial: null }, version: 0 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePref).toBe("auto");
    // Sanity: a real field from the old blob did hydrate, so this isn't a no-op.
    expect(useUiStore.getState().composerHeight).toBe(200);
  });
});

describe("uiStore agentOrdering", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ agentOrdering: "attention" });
  });

  it("defaults agentOrdering to 'attention' (reordering on by default)", () => {
    expect(useUiStore.getState().agentOrdering).toBe("attention");
  });

  it("setAgentOrdering switches to 'manual' and back", () => {
    useUiStore.getState().setAgentOrdering("manual");
    expect(useUiStore.getState().agentOrdering).toBe("manual");
    useUiStore.getState().setAgentOrdering("attention");
    expect(useUiStore.getState().agentOrdering).toBe("attention");
  });

  // Migration: an existing user's persisted blob predates agentOrdering. Rehydrating it
  // must fall back to the default rather than leaving the field undefined.
  it("falls back to 'attention' when the persisted blob has no agentOrdering", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ state: { composerHeight: 180, zoom: 1.0, activeSpecial: null }, version: 0 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().agentOrdering).toBe("attention");
    expect(useUiStore.getState().composerHeight).toBe(180);
  });
});

describe("uiStore workMode", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ workMode: "build", themePref: "auto" });
  });

  it("defaults workMode to 'build' (Build tab on launch)", () => {
    expect(useUiStore.getState().workMode).toBe("build");
  });

  it("setWorkMode switches between think/plan/build", () => {
    useUiStore.getState().setWorkMode("plan");
    expect(useUiStore.getState().workMode).toBe("plan");
    useUiStore.getState().setWorkMode("think");
    expect(useUiStore.getState().workMode).toBe("think");
    useUiStore.getState().setWorkMode("build");
    expect(useUiStore.getState().workMode).toBe("build");
  });

  // Not persisted (partialize drops it): switching the tab must never write workMode into the
  // `sparkle-ui` blob, so the next launch hydrates the "build" default. Other prefs still persist.
  it("never writes workMode to the persisted blob", () => {
    useUiStore.getState().setWorkMode("plan");
    useUiStore.getState().setThemePref("dark");
    const blob = JSON.parse(localStorage.getItem("sparkle-ui") ?? "{}");
    expect(blob.state).not.toHaveProperty("workMode");
    // Sanity: a genuinely-persisted field from the same write did land in the blob.
    expect(blob.state.themePref).toBe("dark");
  });
});

describe("uiStore orchestrator collapse", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ collapsedOrchestrators: {} });
  });

  it("workers start collapsed (a missing entry reads as collapsed)", () => {
    expect(useUiStore.getState().isOrchestratorCollapsed("build-1")).toBe(true);
  });

  it("toggle expands then re-collapses, scoped per build agent", () => {
    const { toggleOrchestratorCollapsed, isOrchestratorCollapsed } = useUiStore.getState();
    toggleOrchestratorCollapsed("build-1");
    expect(useUiStore.getState().isOrchestratorCollapsed("build-1")).toBe(false);
    // A different orchestrator is unaffected — still collapsed by default.
    expect(useUiStore.getState().isOrchestratorCollapsed("build-2")).toBe(true);
    useUiStore.getState().toggleOrchestratorCollapsed("build-1");
    expect(useUiStore.getState().isOrchestratorCollapsed("build-1")).toBe(true);
    // Reference the destructured selectors so they're not flagged unused.
    expect(typeof toggleOrchestratorCollapsed).toBe("function");
    expect(typeof isOrchestratorCollapsed).toBe("function");
  });
});

describe("uiStore zoom", () => {
  beforeEach(() => useUiStore.getState().resetZoom());

  it("starts at and resets to the default", () => {
    expect(useUiStore.getState().zoom).toBe(ZOOM_DEFAULT);
  });

  it("clamps setZoom above max and below min", () => {
    useUiStore.getState().setZoom(999);
    expect(useUiStore.getState().zoom).toBe(ZOOM_MAX);
    useUiStore.getState().setZoom(-5);
    expect(useUiStore.getState().zoom).toBe(ZOOM_MIN);
  });

  // The clamp keeps each value at a clean 2dp step, so re-rounding is a no-op (idempotent).
  // (Note: zoom * 100 is NOT a safe integer check — 1.1 * 100 === 110.00000000000001.)
  const isClean = (z: number) => z === Math.round(z * 100) / 100;

  it("steps in by one increment, staying at a clean 2dp value", () => {
    useUiStore.getState().zoomIn();
    expect(useUiStore.getState().zoom).toBe(Math.round((ZOOM_DEFAULT + ZOOM_STEP) * 100) / 100);
    expect(isClean(useUiStore.getState().zoom)).toBe(true);
  });

  it("never exceeds max on repeated zoomIn", () => {
    for (let i = 0; i < 50; i++) useUiStore.getState().zoomIn();
    expect(useUiStore.getState().zoom).toBe(ZOOM_MAX);
  });

  it("never drops below min on repeated zoomOut", () => {
    for (let i = 0; i < 50; i++) useUiStore.getState().zoomOut();
    expect(useUiStore.getState().zoom).toBe(ZOOM_MIN);
  });

  it("stays drift-free across many mixed steps", () => {
    for (let i = 0; i < 20; i++) useUiStore.getState().zoomIn();
    for (let i = 0; i < 20; i++) useUiStore.getState().zoomOut();
    expect(isClean(useUiStore.getState().zoom)).toBe(true);
  });
});
