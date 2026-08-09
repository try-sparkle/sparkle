// @vitest-environment jsdom
//
// THE PREVIEW SLOT COVERS ITS PAIR — geometry, survival, and the iframe's security attributes.
//
// The mock preamble is `Workspace.planBoardSpansPair.test.tsx`'s, deliberately, including its one
// important omission: **PlanBuildToggle is NOT stubbed.** The way back to Build is one of the
// properties under test, and a stubbed toggle would make that assertion a fixture of itself.
//
// What each group is for, and what would have to break for it to go red:
//
//   1. GEOMETRY. The slot is a descendant of the pair's `paircols` box and NOT of the terminal
//      stage. Those two are mutually exclusive by construction (the stage is a child of the box),
//      so the pair of assertions cannot both pass by accident — a slot rendered inside the stage
//      satisfies the first and fails the second.
//   2. COVER, NEVER UNMOUNT. Node IDENTITY across the flip. This is jsdom's only honest proxy for
//      "the PTY survived", and it is a real one: React re-creating the stage element is exactly the
//      thing that would tear a Terminal down, and it is invisible to any value-based assertion.
//   3. NO IN-FLOW CHILD. The obvious wrong implementation — give the slot a flex slot in the row —
//      looks right in a screenshot while silently squeezing both columns. Counting the non-absolute
//      children before and after is what sees it.
//   4. THE IFRAME'S ATTRIBUTES. The sandbox token SET (not a substring), the absence of
//      `allow-top-navigation`, and `allow` being PRESENT AND EMPTY. A test that checked only
//      `sandbox` would not notice the permissions hole, which is the one whose deletion has no
//      visible symptom.
//   5. THE LOOPBACK REFUSAL, on this side of the bridge, with words rather than a blank frame.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentPane", () => ({
  AgentPane: ({ agent }: { agent: { id: string } }) => <div data-testid={`pane-${agent.id}`} />,
}));
// Same stub as the plan-board file: it reproduces the two things the covered-column assertions need
// from the real column (its own `data-hint` toggle, and honouring `covered` the way the real root
// does) without re-implementing the treatment.
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: ({ slotSide = "right", covered = false }: { slotSide?: string; covered?: boolean }) => (
    <div
      data-testid={`sidebar-${slotSide}`}
      data-slot-side={slotSide}
      data-covered={String(covered)}
      style={covered ? { visibility: "hidden", pointerEvents: "none" } : undefined}
    >
      <button data-hint="build">Build</button>
      <button data-hint="plan">Plan</button>
    </div>
  ),
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({
  BoardView: ({ project }: { project: { id: string } }) => (
    <div data-testid={`board-${project.id}`} />
  ),
}));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { PREVIEW_SANDBOX_TOKENS } from "./PreviewSlot";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { usePreviewStore, type PreviewUpdate } from "../stores/previewStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import { buildWidthKey } from "../engine/columnResize";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: `/tmp/wt/${id}`, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, name: string, agents: AgentTab[], selectedAgentId: string): Project {
  return {
    id, name, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId, agents,
  };
}

const SERVING: PreviewUpdate = {
  id: "srv-1",
  status: "serving",
  url: "http://127.0.0.1:5199/",
  port: 5199,
  error: null,
};

// TWO PAIRS, TWO PROJECTS: p1 on the right, p2 on the left — same fixture as the plan-board file.
beforeEach(() => {
  useProjectStore.setState({
    projects: [
      mkProject("p1", "Alpha", [mkAgent("a1")], "a1"),
      mkProject("p2", "Beta", [mkAgent("a2")], "a2"),
    ],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: ["a1", "a2"], status: {} } as never);
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null, openProjectIds: null,
    pairAssignment: { p2: "left" }, leftProjectId: "p2",
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  usePreviewStore.setState({
    byAgent: { a2: { ...SERVING, startedAt: 0, reloadNonce: 0 } },
    capability: { p1: { previewable: true }, p2: { previewable: true } },
  });
  resetVisitedProjects();
  markProjectVisited("p1");
  markProjectVisited("p2");
  resetCable();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  resetCable();
});

const previewOn = (side: "left" | "right") => act(() => useUiStore.getState().openPreview(side));

/** The slot overlay for a side — the element carrying the geometry under test. */
function previewColumn(side: "left" | "right"): HTMLElement {
  const cols = screen.getByTestId(`pair-cols-${side}`);
  const el = cols.querySelector<HTMLElement>("[data-testid='preview-column']");
  if (!el) throw new Error(`no preview column in the ${side} pair`);
  return el;
}

describe("the preview slot covers its pair", () => {
  // ── 1 ── GEOMETRY.
  it("spans both columns of its pair rather than occupying the terminal slot", () => {
    render(<Workspace />);
    previewOn("left");

    const cols = screen.getByTestId("pair-cols-left");
    const stage = screen.getByTestId("terminal-stage-left");
    const slot = previewColumn("left");

    expect(cols.contains(slot)).toBe(true);
    // ...and NOT inside the terminal. The stage is a child of the column box, so these two cannot
    // both hold for a stage-confined slot.
    expect(stage.contains(slot)).toBe(false);

    expect(slot.style.position).toBe("absolute");
    // React writes the unitless `0` straight through — read the shorthand, not a normalised "0px".
    expect(slot.style.inset).toBe("0");
    expect(cols.style.position).toBe("relative");
  });

  // ── 2 ── COVER, NEVER UNMOUNT. Identity, both directions of the flip.
  it("leaves both columns mounted and their stored widths untouched across a Preview round trip", () => {
    localStorage.setItem(buildWidthKey("left"), "480");
    render(<Workspace />);

    const sidebarBefore = screen.getByTestId("sidebar-left");
    const stageBefore = screen.getByTestId("terminal-stage-left");

    previewOn("left");
    // THE SAME NODE OBJECTS. Not "a sidebar is present" — the same element, which is what says the
    // terminal beneath was never torn down and re-created.
    expect(screen.getByTestId("sidebar-left")).toBe(sidebarBefore);
    expect(screen.getByTestId("terminal-stage-left")).toBe(stageBefore);
    expect(localStorage.getItem(buildWidthKey("left"))).toBe("480");

    act(() => useUiStore.getState().showBuildStage("left"));
    expect(screen.getByTestId("sidebar-left")).toBe(sidebarBefore);
    expect(screen.getByTestId("terminal-stage-left")).toBe(stageBefore);
    expect(localStorage.getItem(buildWidthKey("left"))).toBe("480");
  });

  // ── 3 ── NO IN-FLOW CHILD.
  it("adds no in-flow column to the pair, so neither existing column is squeezed", () => {
    render(<Workspace />);
    const cols = screen.getByTestId("pair-cols-left");
    const inFlow = () =>
      Array.from(cols.children).filter((c) => (c as HTMLElement).style.position !== "absolute");

    expect(inFlow()).toHaveLength(2); // the Build column and the terminal stage

    previewOn("left");
    expect(cols.querySelector("[data-testid='preview-column']")).toBeTruthy();
    expect(inFlow()).toHaveLength(2);
  });

  // THE WAY BACK. Covering the Build column takes the sidebar's toggle off screen with it.
  it("carries a reachable mini toggle, and Build returns the pair to Build", () => {
    render(<Workspace />);
    previewOn("left");

    const slot = previewColumn("left");
    // The REAL PlanBuildToggle, `mini` variant — its own testid, not a stub's.
    expect(slot.querySelector("[data-testid='plan-build-mini']")).toBeTruthy();
    const build = slot.querySelector<HTMLButtonElement>("button[data-hint='build']");
    expect(build).toBeTruthy();

    fireEvent.click(build!);

    expect(useUiStore.getState().workModeBySide.left).toBe("build");
    expect(screen.queryByTestId("preview-column")).toBe(null);
    expect(screen.getByTestId("sidebar-left")).toBeTruthy();
    expect(screen.getByTestId("terminal-stage-left")).toBeTruthy();
  });

  // COVERED IS NOT THE SAME AS GONE (roborev 57292, reproduced exactly by this slot because it
  // carries its own toggle): the hidden column's controls must be unreachable, or Tab walks them
  // and the ⌃-hint overlay's chiclet fires the FIRST match in DOM order — the invisible one.
  it("makes the covered Build column unreachable", () => {
    render(<Workspace />);
    const sidebar = screen.getByTestId("sidebar-left");
    expect(sidebar.dataset.covered).toBe("false");

    previewOn("left");
    expect(sidebar.dataset.covered).toBe("true");
    expect(sidebar.style.visibility).toBe("hidden");
    expect(sidebar.style.pointerEvents).toBe("none");

    const reachable = Array.from(
      screen.getByTestId("pair-cols-left").querySelectorAll<HTMLElement>("button[data-hint='build']"),
    ).filter((b) => !b.closest("[style*='visibility: hidden']"));
    expect(reachable).toHaveLength(1);
    expect(previewColumn("left").contains(reachable[0] ?? null)).toBe(true);

    // Per-pair, like every other mode: the right pair is untouched.
    expect(screen.getByTestId("sidebar-right").dataset.covered).toBe("false");
  });

  // ── 4 ── THE IFRAME. The security surface, and the reason this file exists at all.
  describe("the frame's attributes", () => {
    function frame(): HTMLIFrameElement {
      render(<Workspace />);
      previewOn("left");
      const el = previewColumn("left").querySelector<HTMLIFrameElement>(
        "[data-testid='preview-frame']",
      );
      if (!el) throw new Error("no preview frame");
      return el;
    }

    it("points at the loopback url from the store", () => {
      expect(frame().getAttribute("src")).toBe("http://127.0.0.1:5199/");
    });

    // THE SET, not a substring. `toContain` on the joined string would pass for a sandbox that
    // ALSO granted `allow-top-navigation`, which is the one token that would let an agent-authored
    // page navigate the whole Sparkle webview away from the app.
    it("sandboxes with exactly the five agreed tokens", () => {
      const tokens = (frame().getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
      expect(new Set(tokens)).toEqual(new Set(PREVIEW_SANDBOX_TOKENS));
      expect(tokens).toHaveLength(5);
    });

    it("never grants allow-top-navigation", () => {
      expect(frame().getAttribute("sandbox")).not.toContain("allow-top-navigation");
    });

    // ── THE ONE WHOSE DELETION HAS NO VISIBLE SYMPTOM ────────────────────────────────────────────
    // A loopback origin is "potentially trustworthy" per the Secure Contexts spec, so the FRAMED
    // WHY NOT `allow=""`. An empty container policy DECLARES NOTHING, and the inherited-policy
    // algorithm only consults the container policy for features that appear in it — an absent
    // feature falls back to its own default allowlist. For a `*`-default feature (picture-in-
    // picture, gamepad, sync-xhr, unload, the ad-tech set) that default is "inherit the parent",
    // so an empty attribute leaves them ENABLED in the cross-origin child. Only an explicit
    // `<feature> 'none'` removes them. An earlier version of this test pinned `allow=""` and so
    // actively enforced the hole.
    //
    // Asserted by CLASS rather than by restating the whole string: a literal comparison would have
    // to be edited every time the list grows, and the thing worth guarding is that both classes
    // are named at all.
    it("denies every powerful feature by name, not with an empty policy", () => {
      const f = frame();
      expect(f.hasAttribute("allow")).toBe(true);
      const allow = f.getAttribute("allow") ?? "";
      expect(allow).not.toBe("");

      // PARSE, then assert the SET — the way the sibling sandbox test does.
      //
      // Two mutations defeat a `toContain` check and both restore the hole this file exists to
      // close. (a) Deleting a feature: `toContain` over the exported array is a derivation asserted
      // against itself, since the policy string IS that array mapped and joined. (b) THE SEPARATOR:
      // change `join("; ")` to `join(", ")` and the attribute becomes ONE malformed directive —
      // every feature after the first is an unparseable allowlist token and therefore silently
      // UNDECLARED, which restores the `*`-default grants (gamepad, sync-xhr, unload,
      // browsing-topics…) in the cross-origin child. `picture-in-picture 'none'` is still a
      // substring, so a `toContain` test reports green on exactly that hole.
      //
      // Splitting on ";" is what makes the separator mutation red.
      const entries = allow
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean);

      // EVERY ENTRY DENIES — asserted on the RAW parse, and ordered AHEAD of the set comparison
      // deliberately. After it this check cannot fail: the set assertion has already forced every
      // member of `entries` to be one of the `'none'` literals below, and when it does fail it
      // throws, so a line after it never runs. Here it is independent — a delegation to a concrete
      // origin for a feature that is not in EXPECTED at all (`camera 'src'`, `gyroscope 'self'`)
      // is a shape violation this names, rather than a set difference to read off a diff.
      for (const entry of entries) expect(entry).toMatch(/^[a-z-]+ 'none'$/);

      // Written out as literals so a list edit has to be mirrored here deliberately — the same
      // argument the Rust lockfile test's docblock makes.
      const EXPECTED = [
        // `*`-default: inherited by a cross-origin child, so these are the ones `'none'` removes.
        "picture-in-picture 'none'",
        "gamepad 'none'",
        "sync-xhr 'none'",
        "unload 'none'",
        "document-domain 'none'",
        "storage-access 'none'",
        "browsing-topics 'none'",
        "attribution-reporting 'none'",
        "join-ad-interest-group 'none'",
        "run-ad-auction 'none'",
        "shared-storage 'none'",
        "shared-storage-select-url 'none'",
        "private-aggregation 'none'",
        // `self`-default: already denied cross-origin, named for depth.
        "camera 'none'",
        "microphone 'none'",
        "geolocation 'none'",
        "clipboard-read 'none'",
        "clipboard-write 'none'",
        "display-capture 'none'",
        "fullscreen 'none'",
        "autoplay 'none'",
        "midi 'none'",
        "usb 'none'",
        "serial 'none'",
        "hid 'none'",
        "bluetooth 'none'",
        "payment 'none'",
        "screen-wake-lock 'none'",
        "idle-detection 'none'",
        "local-fonts 'none'",
        "window-management 'none'",
      ];
      expect(new Set(entries)).toEqual(new Set(EXPECTED));
    });

    it("sends no referrer", () => {
      expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
    });

    // THE RELOAD BUTTON'S ONLY POSSIBLE MECHANISM. The nonce is the element's `key`; React leaves an
    // element with an unchanged key alone however many times its parent re-renders, so a reload that
    // does not change it is a control that looks fine and re-fetches nothing. Object identity is the
    // assertion — the attributes are unchanged either way, so nothing else can see the difference.
    it("recreates the frame element when Reload is pressed", () => {
      render(<Workspace />);
      previewOn("left");
      const before = screen.getByTestId("preview-frame");

      fireEvent.click(screen.getByTestId("preview-reload"));

      const after = screen.getByTestId("preview-frame");
      expect(after).not.toBe(before);
      expect(after.getAttribute("src")).toBe(before.getAttribute("src"));
    });
  });

  // ── 5 ── THE REFUSAL. This side re-checks the url because it is the side that renders it.
  it("refuses a non-loopback url with words instead of framing it", () => {
    usePreviewStore.setState({
      byAgent: {
        a2: {
          id: "srv-1", status: "serving", url: "http://evil.com/", port: 80,
          error: null, startedAt: 0, reloadNonce: 0,
        },
      },
    });
    render(<Workspace />);
    previewOn("left");

    expect(previewColumn("left").querySelector("[data-testid='preview-frame']")).toBe(null);
    expect(screen.getByTestId("preview-refused")).toBeTruthy();
    // The address is NAMED, so a refusal is diagnosable rather than mysterious.
    expect(screen.getByTestId("preview-refused-detail").textContent).toContain("http://evil.com/");
  });

  // A SERVER THAT DIED BEFORE IT LISTENED gets the stderr tail, not a blank white frame — which is
  // what a bare iframe with no src looks like, and which reads as "the feature is broken".
  it("shows the failure text instead of an empty frame", () => {
    usePreviewStore.setState({
      byAgent: {
        a2: {
          id: "srv-1", status: "failed", url: null, port: null,
          error: "Error: Cannot find module 'vite'", startedAt: 0, reloadNonce: 0,
        },
      },
    });
    render(<Workspace />);
    previewOn("left");

    expect(previewColumn("left").querySelector("[data-testid='preview-frame']")).toBe(null);
    expect(screen.getByTestId("preview-failed-detail").textContent).toContain("Cannot find module");
  });

  it("says so plainly when the agent has no preview at all", () => {
    usePreviewStore.setState({ byAgent: {} });
    render(<Workspace />);
    previewOn("left");

    expect(previewColumn("left").querySelector("[data-testid='preview-frame']")).toBe(null);
    expect(screen.getByTestId("preview-empty")).toBeTruthy();
  });

  // MUTUALLY EXCLUSIVE BY CONSTRUCTION — one mode per side — which is the argument for both slots
  // sharing PLAN_COLUMN_Z. If this ever failed, that shared constant would need re-examining.
  it("is never on screen at the same time as the plan board", () => {
    render(<Workspace />);
    previewOn("left");
    expect(screen.queryByTestId("board-p2")).toBe(null);

    act(() => useUiStore.getState().openPlanBoard("left"));
    expect(screen.queryByTestId("preview-column")).toBe(null);
    expect(screen.getByTestId("board-p2")).toBeTruthy();
  });

  // The other pair keeps its two columns while this one is covered.
  it("keeps the other pair intact", () => {
    render(<Workspace />);
    previewOn("left");

    expect(screen.getByTestId("pair-cols-right").querySelector("[data-testid='preview-column']"))
      .toBe(null);
    expect(screen.getByTestId("sidebar-right")).toBeTruthy();
    expect(screen.getByTestId("terminal-stage")).toBeTruthy();
  });
});
