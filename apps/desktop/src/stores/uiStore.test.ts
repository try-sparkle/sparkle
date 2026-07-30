import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { STATUS_BANDS } from "../engine/buildSections";
import {
  useUiStore,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  ZOOM_DEFAULT,
  COMPOSER_DEFAULT,
  REVEAL_REQUEST_TTL_MS,
} from "./uiStore";

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
    // activeSpecial too: the yield-pairing cases below seed it, and a field left set here is
    // exactly how a phantom pass leaks into a later case in this file.
    useUiStore.setState({ workModeBySide: { left: "build", right: "build" }, activeSpecial: null });
  });

  it("defaults BOTH columns to 'build' (Build tab on launch)", () => {
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "build", right: "build" });
  });

  it("setWorkMode switches between plan/build", () => {
    useUiStore.getState().setWorkMode("right", "plan");
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    useUiStore.getState().setWorkMode("right", "build");
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
  });

  // THE PROPERTY THE OLD SINGLE `workMode` COULD NOT HAVE. Each column's chevron — and therefore
  // its Plan board — is independent: writing one side must carry the other side's value through
  // untouched, in both directions and from either starting point.
  it("writes ONLY the named side, leaving the other column's mode alone", () => {
    useUiStore.getState().setWorkMode("left", "plan");
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "build" });

    useUiStore.getState().setWorkMode("right", "plan");
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "plan" });

    // ...and closing one board does not close the other.
    useUiStore.getState().setWorkMode("right", "build");
    expect(useUiStore.getState().workModeBySide).toEqual({ left: "plan", right: "build" });
  });

  // THE TWO ACTIONS THAT PAIR THE MODE WITH THE YIELD. `setWorkMode` alone only moves the
  // chevron; every entry point meaning "show me this surface" goes through these, which is what
  // stops the chevron and the concierge tool from answering the same request differently. The
  // yield is SCOPED: there is one Improve-Sparkle pane and it sits in the primary pair's stage, so
  // the other column must not reach across the window to close it.
  it("openPlanBoard sets the mode AND yields the shared surface — but only for the pane's own pair", () => {
    useUiStore.setState({ activeSpecial: "sparkle" });
    useUiStore.getState().openPlanBoard("left");
    expect(useUiStore.getState().workModeBySide.left).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");

    useUiStore.getState().openPlanBoard("right");
    expect(useUiStore.getState().workModeBySide.right).toBe("plan");
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // The mirror, and the more common of the two: "build" is the default and selecting Improve
  // Sparkle never touches the mode, so a column sitting in Build with the pane over its terminal
  // is the ordinary case. Without this action that state had no way back.
  it("showBuildStage sets the mode AND yields the shared surface — but only for the pane's own pair", () => {
    useUiStore.setState({
      activeSpecial: "sparkle",
      workModeBySide: { left: "plan", right: "plan" },
    });
    useUiStore.getState().showBuildStage("left");
    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");

    useUiStore.getState().showBuildStage("right");
    expect(useUiStore.getState().workModeBySide.right).toBe("build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
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

// The per-agent feedback filter (feedback-pill-and-filter): a build-agent's FEEDBACK pill sets this
// to its agent id and jumps to the Plan board; BoardView narrows to `agent:<id>` beads. Same
// transient handoff shape as boardFocusBeadId above, so it gets the same set/clear guarantee.
describe("uiStore boardAgentFilter (FEEDBACK pill → board filter handoff)", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ boardAgentFilterBySide: { left: null, right: null } });
  });

  it("defaults to null on BOTH columns", () => {
    expect(useUiStore.getState().boardAgentFilterBySide).toEqual({ left: null, right: null });
  });

  it("setBoardAgentFilter stores an agent id and clears back to null", () => {
    useUiStore.getState().setBoardAgentFilter("right", "agent-7");
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBe("agent-7");
    useUiStore.getState().setBoardAgentFilter("right", null);
    expect(useUiStore.getState().boardAgentFilterBySide.right).toBeNull();
  });

  // Both pairs can hold a board open at once, and both BoardViews read this. A single global string
  // meant a LEFT row's FEEDBACK pill also narrowed the RIGHT column's board — across two projects,
  // to an agent id that board has never heard of, so it simply emptied.
  it("filters ONLY the named column, leaving the other column's board unfiltered", () => {
    useUiStore.getState().setBoardAgentFilter("left", "agent-7");
    expect(useUiStore.getState().boardAgentFilterBySide).toEqual({ left: "agent-7", right: null });

    useUiStore.getState().setBoardAgentFilter("right", "agent-9");
    expect(useUiStore.getState().boardAgentFilterBySide).toEqual({ left: "agent-7", right: "agent-9" });

    useUiStore.getState().setBoardAgentFilter("right", null);
    expect(useUiStore.getState().boardAgentFilterBySide).toEqual({ left: "agent-7", right: null });
  });
});

describe("uiStore orchestrator collapse", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ collapsedOrchestrators: {}, autoExpandedOrchestrators: {} });
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

// The mark that makes auto-collapse safe. `collapsedOrchestrators` records the STATE; this records
// WHO CHOSE IT, which is the only thing standing between "put the subtree away when it goes quiet"
// and "close the subtree the user just opened".
describe("uiStore auto-expanded mark", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ collapsedOrchestrators: {}, autoExpandedOrchestrators: {} });
  });

  it("marks what an AUTO expandOrchestrators actually opened", () => {
    useUiStore.getState().expandOrchestrators(["b1", "b2"], { auto: true });
    expect(useUiStore.getState().collapsedOrchestrators).toEqual({ b1: false, b2: false });
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({ b1: true, b2: true });
  });

  // The default is user-intent, and the concierge's reveal paths rely on it: a "Show me" or a
  // rowless digest line expands exactly the heads the user clicked to see, and a mark would let the
  // sidebar fold all but the selected one away on the next status tick (the 53737 bug).
  it("leaves a plain expandOrchestrators unmarked, so a reveal is not revocable", () => {
    useUiStore.getState().expandOrchestrators(["b1", "b2"]);
    expect(useUiStore.getState().collapsedOrchestrators).toEqual({ b1: false, b2: false });
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({});
  });

  // A reveal of a subtree the app had already opened makes it the user's — including when the
  // collapse state is already `false` and there is nothing to open, which is the case an
  // identity-stable early return is most likely to skip.
  it("a user-intent expand strips a mark the app had left", () => {
    useUiStore.getState().expandOrchestrators(["b1"], { auto: true });
    useUiStore.getState().expandOrchestrators(["b1"]);
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({});
    expect(useUiStore.getState().isOrchestratorCollapsed("b1")).toBe(false);
  });

  it("is identity-stable when an auto expand opens nothing", () => {
    useUiStore.getState().expandOrchestrators(["b1"], { auto: true });
    const before = useUiStore.getState().collapsedOrchestrators;
    useUiStore.getState().expandOrchestrators(["b1"], { auto: true });
    expect(useUiStore.getState().collapsedOrchestrators).toBe(before);
  });

  // Stamping an already-open row would quietly convert someone else's choice — almost always the
  // user's chevron — into something auto-collapse may revoke.
  it("does not mark a row that was already expanded", () => {
    useUiStore.getState().toggleOrchestratorCollapsed("b1"); // the user opens it
    useUiStore.getState().expandOrchestrators(["b1", "b2"], { auto: true });
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({ b2: true });
  });

  it("collapseAutoExpanded closes a marked row and clears its mark", () => {
    useUiStore.getState().expandOrchestrators(["b1"], { auto: true });
    useUiStore.getState().collapseAutoExpanded(["b1"]);
    expect(useUiStore.getState().isOrchestratorCollapsed("b1")).toBe(true);
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({});
  });

  // The store's own veto: even if a caller asks, an unmarked row is not the app's to close.
  it("collapseAutoExpanded refuses a row the user expanded", () => {
    useUiStore.getState().toggleOrchestratorCollapsed("b1");
    useUiStore.getState().collapseAutoExpanded(["b1"]);
    expect(useUiStore.getState().isOrchestratorCollapsed("b1")).toBe(false);
  });

  it("collapseAutoExpanded is identity-stable when nothing is marked", () => {
    const before = useUiStore.getState().collapsedOrchestrators;
    useUiStore.getState().collapseAutoExpanded(["b1", "b2"]);
    expect(useUiStore.getState().collapsedOrchestrators).toBe(before);
  });

  // Touching the chevron transfers ownership in BOTH directions — including the case where the user
  // collapses an auto-expanded row by hand, which must not leave a stale mark behind.
  it("the chevron clears the mark whichever way it moves the row", () => {
    useUiStore.getState().expandOrchestrators(["b1"], { auto: true });
    useUiStore.getState().toggleOrchestratorCollapsed("b1"); // user closes it themselves
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({});
    useUiStore.getState().toggleOrchestratorCollapsed("b1"); // and re-opens it — now theirs
    expect(useUiStore.getState().autoExpandedOrchestrators).toEqual({});
    expect(useUiStore.getState().isOrchestratorCollapsed("b1")).toBe(false);
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
    // Which of those expansions the APP made rather than the user. Persisted deliberately, and it
    // has to travel with collapsedOrchestrators: if the mark were transient, every app-expanded
    // subtree would come back from a relaunch looking like a deliberate user choice, and
    // auto-collapse — which refuses to touch the user's own expansions — would leave it open
    // forever. That is the very stuck-open state the mark exists to clear.
    "autoExpandedOrchestrators",
    // The concierge compose box's dragged height. Persisted on purpose — the user asked for the
    // size to stick across relaunches.
    "conciergeComposeH",
    "composerHeight",
    "composerMinimized",
    "composerUserSized",
    // "Copy on selection" (PRD 1 §1). Persisted DELIBERATELY: a preference someone turned off has
    // to stay off, or the app quietly resumes writing their clipboard on every drag after the next
    // relaunch — a setting that un-sets itself is worse than no setting.
    "conciergeCopyOnSelection",
    // Where the send tray is parked (voice/sendMode). Persisted DELIBERATELY, and note it is the
    // mirror of the line above rather than a copy of it: this one defaults to "send" — microphone
    // off, nothing counting — because a position that makes the app dispatch irreversible
    // instructions on your behalf has to be picked by hand. But once someone HAS picked Speak,
    // silently resetting it every relaunch would be its own broken promise. Persisted either way;
    // only the default differs. (It replaced a boolean `conciergeAutoSend`; composerPersist's v3
    // migration carries an armed blob across rather than dropping the preference.)
    "conciergeSendMode",
    // Opt-in for the background Haiku grader (PRD §4e). Persisted so a deliberate opt-in is not
    // re-asked every launch — and it is a SEPARATE switch from the rail above on purpose: arming
    // auto-send costs nothing, while this spends the user's own Claude subscription quota.
    "conciergeAutoSendTuner",
    // Closable project tabs: which projects have a tab MUST survive a relaunch, or every close
    // would silently undo itself on the next launch. Its default is `null` (never seeded = every
    // project open), which is serializable, so it shows up in the blob from the very first write.
    "openProjectIds",
    "pinnedProjectId",
    // The second pair (engine/pairs). WHICH SIDE of the concierge each project sits on is a
    // deliberate arrangement of the workspace, not a transient view state, so it survives a
    // relaunch — otherwise every launch would silently collapse the cockpit back to one pair and
    // remount the left pair's terminals, killing their PTYs. The map is sparse and left-only, so
    // an install that has never used the left pair persists `{}` and reads as the single-pair
    // layout it had.
    "pairAssignment",
    // …and which project that pair is showing, for the same reason: restoring the pair but not its
    // selection would reopen it on an arbitrary project.
    "leftProjectId",
    "themePref",
    "zoom",
  ];

  // Restore everything this block touches, not just themePref: it writes every transient key as a
  // non-default into a module-level singleton, and vitest's per-file isolation does not help a test
  // appended after it.
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({
      workModeBySide: { left: "build", right: "build" },
      buildAgentHover: false,
      boardFocusBeadId: null,
      boardAgentFilterBySide: { left: null, right: null },
      settingsRequest: null,
      composeFocusSeq: 0,
      revealAgentId: null,
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
      workModeBySide: { left: "build", right: "plan" },
      buildAgentHover: true,
      boardFocusBeadId: "epic-42",
      boardAgentFilterBySide: { left: null, right: "agent-x" },
      settingsRequest: "accounts",
      composeFocusSeq: 7,
      revealAgentId: "a-42",
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
      workModeBySide: { left: "build", right: "build" },
      buildAgentHover: false,
      boardFocusBeadId: null,
      boardAgentFilterBySide: { left: null, right: null },
      settingsRequest: null,
      composeFocusSeq: 0,
      revealAgentId: null,
      newAgentRuntime: "local",
      cloudCreateOpen: false,
      zeroCreditBannerDismissed: false,
      zeroCreditBannerDismissedFor: null,
      themePref: "auto",
    });
  });

  it("ignores every transient key present in a stored blob", async () => {
    // Every transient key, mirroring the write-path block: a key stripped on write but forgotten in
    // `merge` would otherwise stay green here for the six the earlier version didn't name.
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({
        version: 1,
        state: {
          themePref: "dark",
          workModeBySide: { left: "build", right: "plan" },
          buildAgentHover: true,
          boardFocusBeadId: "epic-42",
          boardAgentFilterBySide: { left: null, right: "agent-x" },
          settingsRequest: "accounts",
          composeFocusSeq: 7,
          revealAgentId: "a-42",
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
    expect(s.workModeBySide).toEqual({ left: "build", right: "build" });
    expect(s.buildAgentHover).toBe(false);
    expect(s.boardFocusBeadId).toBeNull();
    expect(s.boardAgentFilterBySide).toEqual({ left: null, right: null });
    expect(s.settingsRequest).toBeNull();
    expect(s.composeFocusSeq).toBe(0);
    expect(s.revealAgentId).toBeNull();
    expect(s.newAgentRuntime).toBe("local");
    expect(s.cloudCreateOpen).toBe(false);
    expect(s.zeroCreditBannerDismissed).toBe(false);
    expect(s.zeroCreditBannerDismissedFor).toBeNull();
  });
});

// Closable project tabs: the open set is only meaningful if it OUTLIVES the process. A close that
// silently undid itself on the next launch would be worse than no close at all, so the round trip
// through the persisted blob gets its own assertions rather than riding on the key inventory above.
describe("uiStore — the open project set survives a relaunch", () => {
  // Restore everything this block touches, not just openProjectIds: the upgrade-path test below
  // rehydrates a blob carrying themePref/composerHeight into a module-level singleton, and vitest's
  // per-file isolation does not help a test appended after this one.
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({
      openProjectIds: null,
      themePref: "auto",
      composerHeight: COMPOSER_DEFAULT,
    });
  });

  it("writes the closed-tab decision to the blob and reads it back", async () => {
    useUiStore.getState().setOpenProjectIds(["p1", "p3"]); // p2 closed
    const written = localStorage.getItem("sparkle-ui") ?? "{}";
    expect(JSON.parse(written).state.openProjectIds).toEqual(["p1", "p3"]);

    // A fresh launch reading that blob. The in-memory reset has to come FIRST and the blob be put
    // back AFTER it, because `setState` itself re-persists — resetting after capturing the blob
    // would overwrite the very thing we are about to rehydrate from, and the test would pass or
    // fail for reasons that have nothing to do with persistence.
    useUiStore.setState({ openProjectIds: null });
    localStorage.setItem("sparkle-ui", written);
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().openProjectIds).toEqual(["p1", "p3"]);
  });

  it("preserves the [] vs null distinction across a rehydrate", async () => {
    // [] ("I closed every tab") and null ("nothing has ever written this") mean opposite things:
    // null must render every tab, [] must render none. Collapsing them on rehydrate would either
    // resurrect every closed tab or blank the bar of someone who never closed anything.
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ version: 2, state: { openProjectIds: [] } }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().openProjectIds).toEqual([]);
    expect(useUiStore.getState().openProjectIds).not.toBeNull();
  });

  it("stays null — never seeded — for an install that predates the feature", async () => {
    // THE upgrade path, and the one outcome nobody may ship: an existing blob has no
    // openProjectIds, and rehydrating it must leave the value null, which engine/openProjects reads
    // as "every project is open". If the migration invented a `[]` here, every existing user's tab
    // bar would come back empty after the update.
    //
    // The store starts at its launch default (null) rather than a planted sentinel on purpose:
    // zustand merges `{...current, ...stored}`, so a key ABSENT from the blob keeps whatever is in
    // memory — planting one would test the merge's passthrough, not the upgrade a real launch does.
    useUiStore.setState({ openProjectIds: null });
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ version: 2, state: { themePref: "dark", composerHeight: 200 } }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().openProjectIds).toBeNull();
    // Sanity: the blob really did rehydrate, so the null above isn't a no-op passing by default.
    expect(useUiStore.getState().themePref).toBe("dark");
    expect(useUiStore.getState().composerHeight).toBe(200);
  });
});

// The reveal request is one-shot and CLEARED BY THE ROW THAT MATCHES IT — but that row is not
// guaranteed to mount (a filtered status band, `mode === "plan"` rendering no list at all, a project
// switched or closed, the agent removed right after spawn). Without a deadline the id sat pending
// for the rest of the session and fired at an arbitrary later moment, yanking the column to a row
// nobody asked to see (roborev 53784). REVEAL_REQUEST_TTL_MS is the policy.
describe("uiStore revealAgentId — the request expires", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ revealAgentId: null });
  });
  afterEach(() => {
    // Drain any armed expiry before handing the timers back, so a pending 5s callback can't fire
    // into a later test's state.
    useUiStore.getState().clearRevealAgent(useUiStore.getState().revealAgentId ?? "");
    useUiStore.setState({ revealAgentId: null });
    vi.useRealTimers();
  });

  it("stays pending for the whole window a row might still mount in", () => {
    useUiStore.getState().requestRevealAgent("a-1");
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS - 1);
    expect(useUiStore.getState().revealAgentId).toBe("a-1");
  });

  it("expires once nothing has consumed it, so it can never fire later", () => {
    useUiStore.getState().requestRevealAgent("a-1");
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("a consumed request disarms its expiry, so it cannot clear a LATER one", () => {
    // The bug this guards: row a-1 mounts and clears, then a second spawn requests a-2 inside the
    // first request's window. A surviving timer would blank a-2 before its row ever mounted.
    useUiStore.getState().requestRevealAgent("a-1");
    vi.advanceTimersByTime(100);
    useUiStore.getState().clearRevealAgent("a-1");
    useUiStore.getState().requestRevealAgent("a-2");
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS - 1);
    expect(useUiStore.getState().revealAgentId).toBe("a-2");
  });

  it("a replacing request restarts the clock rather than inheriting the old deadline", () => {
    useUiStore.getState().requestRevealAgent("a-1");
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS - 1);
    useUiStore.getState().requestRevealAgent("a-2");
    // The first request's deadline passes here; a-2 must be untouched by it.
    vi.advanceTimersByTime(2);
    expect(useUiStore.getState().revealAgentId).toBe("a-2");
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });

  it("clearRevealAgent still refuses to retire a request that names a different row", () => {
    useUiStore.getState().requestRevealAgent("a-1");
    useUiStore.getState().clearRevealAgent("someone-else");
    expect(useUiStore.getState().revealAgentId).toBe("a-1");
    // …and the expiry it did NOT cancel is still armed.
    vi.advanceTimersByTime(REVEAL_REQUEST_TTL_MS);
    expect(useUiStore.getState().revealAgentId).toBeNull();
  });
});

// THE REPAIR HAS TO RUN ON THE BLOBS THAT ACTUALLY EXIST — at the CURRENT version.
//
// This is the integration half of composerPersist's unit tests, and the two are not
// interchangeable: those call `migratePersistedUi` directly, which proves the function works but
// says nothing about whether anything CALLS it. zustand runs `migrate` only when the stored version
// differs from the configured one, so the first shipped attempt at this repair was wired somewhere
// unreachable for every blob already at the current version — i.e. all of them. `version: 2` below
// is the whole point of the test; write `version: 1` and it passes against the broken code.
describe("uiStore rehydrate — a retired persisted value is repaired at the CURRENT version", () => {
  afterEach(() => {
    localStorage.clear();
    useUiStore.setState({ activeSpecial: null });
  });

  it('maps a persisted activeSpecial "board" to null without a version bump', async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ version: 2, state: { themePref: "dark", activeSpecial: "board" } }),
    );

    await useUiStore.persist.rehydrate();

    // The blob really was read (so this isn't passing by rehydrate having been skipped)...
    expect(useUiStore.getState().themePref).toBe("dark");
    // ...and the retired value did not survive it.
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  it('leaves a persisted "sparkle" alone at the current version', async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ version: 2, state: { themePref: "dark", activeSpecial: "sparkle" } }),
    );

    await useUiStore.persist.rehydrate();

    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
  });

  // The same unreachability applied to the pre-existing statusFilter repair, whose comment made the
  // same "runs on EVERY rehydrate" claim. It does now.
  it("completes a short statusFilter at the current version", async () => {
    localStorage.setItem(
      "sparkle-ui",
      JSON.stringify({ version: 2, state: { statusFilter: { needs_you: true } } }),
    );

    await useUiStore.persist.rehydrate();

    const filter = useUiStore.getState().statusFilter as Record<string, boolean>;
    for (const b of STATUS_BANDS) expect(filter[b.id]).toBe(true);
  });
});
