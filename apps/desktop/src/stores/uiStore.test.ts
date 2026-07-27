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

describe("uiStore statusFilter", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.getState().showAllStatusBands();
  });

  it("defaults to showing all three bands", () => {
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });

  it("toggleStatusBand flips one band without touching the others", () => {
    useUiStore.getState().toggleStatusBand("running");
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: true,
    });
    useUiStore.getState().toggleStatusBand("running");
    expect(useUiStore.getState().statusFilter.running).toBe(true);
  });

  it("allows turning EVERY band off — a filter that refuses its stated state is worse than an empty list", () => {
    for (const b of ["needs_you", "running", "done"] as const) {
      useUiStore.getState().toggleStatusBand(b);
    }
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: false,
      running: false,
      done: false,
    });
  });

  it("showAllStatusBands is the way back from that", () => {
    useUiStore.getState().toggleStatusBand("done");
    useUiStore.getState().showAllStatusBands();
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });

  // Migration v2: a blob from before the filter existed (and carrying the retired agentOrdering)
  // must rehydrate to all-visible rather than leaving bands undefined — an undefined band reads as
  // falsy and would silently hide a third of the user's agents.
  it("rehydrates a pre-filter blob to all bands visible, dropping agentOrdering", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({
        state: { composerHeight: 180, zoom: 1.0, activeSpecial: null, agentOrdering: "manual" },
        version: 1,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
    expect(useUiStore.getState().composerHeight).toBe(180);
    expect((useUiStore.getState() as unknown as Record<string, unknown>).agentOrdering).toBeUndefined();
  });

  it("repairs a PARTIAL persisted filter instead of trusting it", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({
        state: { statusFilter: { needs_you: false } },
        version: 1,
      }),
    );
    await useUiStore.persist.rehydrate();
    // The band the user really did hide is preserved; the missing ones default to VISIBLE.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: false,
      running: true,
      done: true,
    });
  });
});

describe("uiStore workMode", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ workMode: "build" });
  });

  it("defaults workMode to 'build' (Build tab on launch)", () => {
    expect(useUiStore.getState().workMode).toBe("build");
  });

  it("setWorkMode switches between plan/build", () => {
    useUiStore.getState().setWorkMode("plan");
    expect(useUiStore.getState().workMode).toBe("plan");
    useUiStore.getState().setWorkMode("build");
    expect(useUiStore.getState().workMode).toBe("build");
  });

});

describe("uiStore boardFocusBeadId (spec §8 pill → board handoff)", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ boardFocusBeadId: null });
  });

  it("defaults to null", () => {
    expect(useUiStore.getState().boardFocusBeadId).toBeNull();
  });

  it("setBoardFocusBeadId round-trips a bead id and clears back to null", () => {
    useUiStore.getState().setBoardFocusBeadId("epic-42");
    expect(useUiStore.getState().boardFocusBeadId).toBe("epic-42");
    useUiStore.getState().setBoardFocusBeadId(null);
    expect(useUiStore.getState().boardFocusBeadId).toBeNull();
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

// The concierge pin (CM-U7): ONE project at a time, and pinning the pinned one clears it. The pin
// is persisted and load-bearing — it scopes the concierge's surfaced P0/P1 — so its semantics need
// pinning down (roborev 46246-L1).
describe("uiStore pinnedProjectId", () => {
  beforeEach(() => useUiStore.setState({ pinnedProjectId: null }));
  afterEach(() => useUiStore.setState({ pinnedProjectId: null }));

  it("defaults to no pin (following all projects)", () => {
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("toggling an unpinned project pins it", () => {
    useUiStore.getState().togglePinnedProject("p1");
    expect(useUiStore.getState().pinnedProjectId).toBe("p1");
  });

  it("toggling a DIFFERENT project replaces the pin (one at a time, never two)", () => {
    useUiStore.getState().togglePinnedProject("p1");
    useUiStore.getState().togglePinnedProject("p2");
    expect(useUiStore.getState().pinnedProjectId).toBe("p2");
  });

  it("toggling the pinned project clears the pin", () => {
    useUiStore.getState().togglePinnedProject("p1");
    useUiStore.getState().togglePinnedProject("p1");
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });

  it("setPinnedProject(null) clears it outright (the removal-cleanup path)", () => {
    useUiStore.getState().setPinnedProject("p1");
    useUiStore.getState().setPinnedProject(null);
    expect(useUiStore.getState().pinnedProjectId).toBeNull();
  });
});

// The partialize exclusion list is hand-maintained prose plus a hand-maintained destructure, and it
// was this branch's only merge conflict precisely because two branches each appended their own key.
// Nothing fails when those lists drift.
//
// So the assertion runs on the PERSISTED side, not the transient one. A third hand-maintained list
// of transient keys would catch a key being REMOVED from partialize (which is what a mutation test
// exercises) while missing the failure mode that actually happened here: someone adds a tenth
// transient key, forgets the list, and nothing goes red. Pinning the exact set of keys that reach
// the blob inverts that — any newly-persisted key fails, whether or not anyone updates a list.
//
// One limit worth stating rather than over-promising: this reads keys back out of JSON, and
// JSON.stringify omits properties whose value is `undefined` OR A FUNCTION — which is also why the
// nine keys are all that show up, since partialize spreads the actions through too. So a future
// transient key that defaults to undefined, or holds a callback, leaves no blob key until it is
// set. Every field here has a concrete serializable default, so the pin holds today.
//
// What makes this more than hygiene is the pair this merge brought in: persist
// zeroCreditBannerDismissed* by accident and a user who dismisses the $0 banner never sees it again
// on any later launch — still at zero balance, AI extras silently dark — with nothing else red.
describe("uiStore persistence — exactly these keys reach the blob", () => {
  const PERSISTED = [
    "activeSpecial",
    "statusFilter",
    "collapsedOrchestrators",
    "composerHeight",
    "composerMinimized",
    "composerUserSized",
    "pinnedProjectId",
    "themePref",
    "zoom",
  ];

  // Restore everything this block touches, not just themePref: it writes ten transient non-defaults
  // into a module-level singleton, and vitest's per-file isolation does not help a test appended
  // after it.
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({
      workMode: "build",
      buildAgentHover: false,
      boardFocusBeadId: null,
      settingsRequest: null,
      composeFocusSeq: 0,
      newAgentRuntime: "local",
      cloudCreateOpen: false,
      zeroCreditBannerDismissed: false,
      zeroCreditBannerDismissedFor: null,
      themePref: "auto",
    });
  });

  it("drops every transient key, whatever it is, and keeps the real preferences", () => {
    // Non-defaults for each transient key, so none can pass merely by being absent from state.
    // No `as never`: the point of writing them literally is that tsc verifies these names still
    // exist on UiState, so a rename cannot leave a stale string here asserting nothing.
    useUiStore.setState({
      workMode: "plan",
      buildAgentHover: true,
      boardFocusBeadId: "epic-42",
      settingsRequest: "accounts",
      composeFocusSeq: 7,
      newAgentRuntime: "cloud",
      cloudCreateOpen: true,
      zeroCreditBannerDismissed: true,
      zeroCreditBannerDismissedFor: "acct-1",
    });
    useUiStore.getState().setThemePref("dark");

    const blob = JSON.parse(localStorage.getItem("sparkle-ui") ?? "{}");
    // Both sides sorted: nothing enforces the literal's order, and the natural way to add a new
    // preference is to append it, which would otherwise fail as an order mismatch on correct content.
    expect(Object.keys(blob.state).sort()).toEqual([...PERSISTED].sort());
    // Sanity: the write really happened, so the assertion above isn't passing on an empty blob.
    expect(blob.state.themePref).toBe("dark");
  });
});

// partialize governs the WRITE path only. On rehydrate, migratePersistedUi passes unknown keys
// through and zustand shallow-merges the stored object into state — so a blob that already contains
// a transient key (written by any build before it was excluded, or hand-edited) restores it at
// launch. That is the same user-visible harm from the other direction: dismiss the $0 banner once,
// and every later launch starts dismissed at zero balance with AI extras dark.
describe("uiStore rehydrate — a stale transient key in the blob must not be restored", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({
      workMode: "build",
      buildAgentHover: false,
      boardFocusBeadId: null,
      settingsRequest: null,
      composeFocusSeq: 0,
      newAgentRuntime: "local",
      cloudCreateOpen: false,
      zeroCreditBannerDismissed: false,
      zeroCreditBannerDismissedFor: null,
      themePref: "auto",
    });
  });

  it("ignores every transient key present in a stored blob", async () => {
    // All ten, mirroring the write-path block: a key stripped on write but forgotten in `merge`
    // would otherwise stay green here for the six the earlier version didn't name.
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({
        version: 1,
        state: {
          themePref: "dark",
          workMode: "plan",
          buildAgentHover: true,
          boardFocusBeadId: "epic-42",
          settingsRequest: "accounts",
          composeFocusSeq: 7,
          newAgentRuntime: "cloud",
          cloudCreateOpen: true,
          zeroCreditBannerDismissed: true,
          zeroCreditBannerDismissedFor: "acct-1",
        },
      }),
    );

    await useUiStore.persist.rehydrate();

    // The real preference in the same blob survives — so the rehydrate genuinely happened.
    expect(useUiStore.getState().themePref).toBe("dark");
    // ...and every transient one comes back at its store default instead.
    const s = useUiStore.getState();
    expect(s.workMode).toBe("build");
    expect(s.buildAgentHover).toBe(false);
    expect(s.boardFocusBeadId).toBeNull();
    expect(s.settingsRequest).toBeNull();
    expect(s.composeFocusSeq).toBe(0);
    expect(s.newAgentRuntime).toBe("local");
    expect(s.cloudCreateOpen).toBe(false);
    expect(s.zeroCreditBannerDismissed).toBe(false);
    expect(s.zeroCreditBannerDismissedFor).toBeNull();
  });
});
