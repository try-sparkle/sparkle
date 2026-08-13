// @vitest-environment jsdom
//
// THE SHELL'S COLUMNS ARE LAYOUT ROOTS — the caret half of the 2026-08-13 3-10s input lag.
//
// ══ THE DEFECT ══════════════════════════════════════════════════════════════════════════════════
// A `sample` of the v0.103.0 WebKit renderer, taken while the founder watched typed characters
// arrive 3-10 seconds late, put its main thread 98.9% busy and 15.1% of it (1162 of 7694 samples)
// in ONE chain:
//
//     OpacityCaretAnimator::updateAnimationProperties
//       → FrameSelection::recomputeCaretRect
//         → VisiblePosition::canonicalPosition
//           → Document::updateLayout          ← 12.9%, a SYNCHRONOUS DOCUMENT-WIDE layout
//             → RenderView::layout            ← ~50 nested levels, bottoming out in
//                                               TextUtil::width() measuring glyphs one at a time
//
// WebKit recomputes the caret's rect on every caret animation frame, and that recomputation flushes
// layout for the WHOLE document. The blinking caret is therefore not a passive decoration — it is a
// per-frame `updateLayout()` call sited in the compose box.
//
// ══ WHY CONTAINMENT IS THE FIX, AND NOT "MAKE THE CARET CHEAPER" ════════════════════════════════
// `updateLayout()` is nearly free when layout is CLEAN. It cost 12.9% because something else in the
// shell dirties layout every frame — 65 live agent rows with ticking elapsed timers, panes
// streaming PTY output. Without containment a dirty box marks its containing blocks all the way up
// to the `RenderView`, so dirt ANYWHERE makes the caret's next flush re-lay-out EVERY column,
// including re-measuring the intrinsic width of every text run it passes. `contain: layout` makes
// each column its own layout root, so that propagation stops at the column boundary.
//
// This is the complement of `content-visibility: auto` on the rows (AgentRow.tsx, commit
// c0a76998c), which shipped IN v0.103.0 — the exact build this capture came from — and did not
// close it. That fix stops OFF-SCREEN rows laying out; this one stops the on-screen ones' churn
// escaping the column. Both are needed and neither subsumes the other.
//
// ══ WHAT THESE TESTS GUARD ══════════════════════════════════════════════════════════════════════
// Not the speed — jsdom implements neither containment nor layout, so a timing assertion here would
// be theatre. What is guarded is the DECLARATION plus the three invariants that make it safe to
// apply to two of the most heavily-commented elements in this repo. Layout containment does exactly
// four things, and both columns already had three of them before this change:
//
//   • an independent formatting context   — already, both are `display: flex`
//   • a stacking context                  — already, both are `position: relative` + a `z-index`
//   • a containing block for ABSOLUTELY positioned descendants — already, `position: relative`
//   • a containing block for FIXED positioned descendants      — THE ONE REAL CHANGE
//
// So the whole risk surface is the fourth line: a `position: fixed` descendant would be re-anchored
// from the viewport to a ~360px column. Today there is none — the palette is mounted by `Workspace`
// rather than inside the concierge section, and `QuoteChiclet`, `ConciergeSuggestions` and the
// agent hover card are all `createPortal`'d out of the tree — but that is exactly the kind of fact
// a later change breaks silently, so it is asserted rather than trusted.
//
// The other guarded direction is STRENGTH. `paint`, `content` and `strict` all clip descendants to
// the border box, which would square off the active row's concave fillets and its bleed through the
// column seam (the regression the `filletEnds` gate in AgentRow.tsx spends 20 lines preventing) and
// would clip the concierge column's lift shadow. Someone "strengthening" this declaration is the
// most likely future break, so `layout` is pinned exactly.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { ConciergeColumn } from "./Concierge/ConciergeColumn";
import type { ConciergeController, ConciergeViewModel } from "./Concierge/types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: `/tmp/demo/.worktrees/${id}`,
    branch: `sparkle/agent-${id}`,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: { title: name, description: `desc ${id}` },
    shellCommand: null,
  };
}

function mkProject(agents: AgentTab[], selectedAgentId: string | null): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId,
    agents,
  };
}

const conciergeModel: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 1, questions: 0, running: 2, done: 0 },
  messages: [
    { id: "m1", kind: "sparkle", text: "Morning — I'm watching every open project." },
    { id: "m2", kind: "you", text: "Thanks, keep me posted." },
  ],
};

function conciergeController(): ConciergeController {
  return { onSend: vi.fn(), onAttach: vi.fn(), onNudgeClick: vi.fn(), onNudgeAction: vi.fn() };
}

/** Read declarations from the style ATTRIBUTE, not from `el.style.*`: jsdom's CSSStyleDeclaration
 *  silently drops properties it does not implement, and the containment family is among them (see
 *  docs/jsdom-test-caveats.md, and AgentRow.containment.test.tsx which reads `content-visibility`
 *  the same way). The attribute is the string React actually wrote, so it survives that gap. */
function styleOf(el: Element): string {
  return el.getAttribute("style") ?? "";
}

/** The `contain` value this element declares, or null. Anchored to a declaration boundary so it
 *  cannot match `contain-intrinsic-size`, which the agent ROWS carry for a different reason. */
function containValue(el: Element): string | null {
  const m = /(?:^|;)\s*contain:\s*([^;]+)/.exec(styleOf(el));
  return m ? m[1]!.trim() : null;
}

/** Every `position: fixed` element inside this subtree. A portalled node is not a DOM descendant,
 *  so this cannot see one — which is the point: portalled overlays are exempt from containment by
 *  construction, and only an INLINE fixed descendant is the hazard. */
function fixedDescendants(root: Element): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((el) =>
    /(?:^|;)\s*position:\s*fixed/.test(styleOf(el)),
  );
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" } });
  resetCable();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  resetCable();
});

/** The two column roots, each rendered from its real component, paired with a label for failure
 *  output. Every test below runs over both — the fix is only a fix if BOTH boundaries hold: a
 *  single uncontained column re-admits the propagation to the `RenderView` that the other one's
 *  containment was bought to stop. */
function renderColumns(): Array<{ label: string; root: HTMLElement }> {
  const sidebar = render(
    <AgentSidebar
      project={mkProject([mkAgent("a1", "One"), mkAgent("a2", "Two"), mkAgent("a3", "Three")], null)}
    />,
  );
  const concierge = render(
    <ConciergeColumn model={conciergeModel} controller={conciergeController()} />,
  );
  return [
    { label: "agent sidebar column", root: sidebar.getByTestId("agent-sidebar-column") },
    {
      label: "concierge column",
      root: concierge.getByRole("region", { name: "Sparkle concierge" }) as HTMLElement,
    },
  ];
}

describe("shell columns — layout containment", () => {
  it("makes every shell column its own layout root", () => {
    // THE DEFECT ITSELF. Against the pre-fix code this is 0 of 2: neither column declared any
    // containment (`contain:` appeared nowhere in apps/desktop/src before this change), so a dirty
    // box in the agent column marked containing blocks up to the RenderView and the concierge
    // caret's next per-frame `Document::updateLayout()` re-laid-out the entire shell.
    for (const { label, root } of renderColumns()) {
      expect(containValue(root), `${label} must be a layout root`).toBe("layout");
    }
  });

  it("does not clip: containment stays at `layout`, never paint/content/strict", () => {
    // The active agent row's concave fillets and its bleed through the column seam paint OUTSIDE
    // the column's border box on purpose, and the concierge column's lift shadow does too. Paint
    // containment clips exactly that. `content` (= layout paint style) and `strict` (= + size) both
    // include paint, so all three are the same regression, and "strengthening" this declaration is
    // the most plausible way a future change reintroduces the squared-off fillets that
    // AgentRow.tsx's `filletEnds` gate exists to prevent.
    //
    // Deliberately vacuous when the declaration is ABSENT — `String(null)` matches none of the
    // three keywords. Presence is the test above's job, and duplicating it here would make this one
    // go red for a reason it does not name, which is what it did on the first pass: with the fix
    // reverted it failed on `expect(null).not.toMatch(...)` rather than on any clipping.
    for (const { label, root } of renderColumns()) {
      expect(String(containValue(root)), `${label} must not clip its descendants`).not.toMatch(
        /\b(paint|content|strict)\b/,
      );
    }
  });

  it("introduces no NEW stacking context — both columns already had one", () => {
    // This is what makes the change behaviourally inert rather than merely small. Layout containment
    // FORCES a stacking context; if a column did not already have one, adding it would silently
    // reorder paint — and paint order here is load-bearing in both directions (the sidebar's active
    // row must paint OVER the later terminal pane via BUILD_COLUMN_Z; the concierge column must
    // paint over the pairs but under the pull tab's rail via CONCIERGE_LIFT_Z). Both already carry
    // `position: relative` + an explicit `z-index`, so containment changes nothing. Lose either
    // half and the containment above stops being free.
    for (const { label, root } of renderColumns()) {
      const style = styleOf(root);
      expect(style, `${label} must already be positioned`).toMatch(/(?:^|;)\s*position:\s*relative/);
      expect(style, `${label} must already carry an explicit z-index`).toMatch(
        /(?:^|;)\s*z-index:\s*-?\d+/,
      );
    }
  });

  it("holds no inline `position: fixed` descendant, which containment would re-anchor", () => {
    // THE ONE REAL BEHAVIOURAL CHANGE layout containment makes: a contained element becomes the
    // containing block for FIXED positioned descendants, so a fixed overlay inside one of these
    // columns stops being viewport-anchored and gets trapped in a ~360px box.
    //
    // Nothing violates this today, and each of the near misses is a deliberate decision that this
    // test now holds in place: the command palette is mounted by `Workspace` rather than inside the
    // concierge section, and `QuoteChiclet`, `ConciergeSuggestions` and the agent hover card are
    // `createPortal`'d to document.body (AgentRow.tsx says the same about `content-visibility`,
    // which cannot reach them either). Un-portal any one of them, or add a new fixed overlay
    // inline, and the overlay silently mis-positions in the running app while every other test in
    // this repo stays green — so this is the assertion that has to catch it.
    for (const { label, root } of renderColumns()) {
      const trapped = fixedDescendants(root).map((el) => el.getAttribute("data-testid") ?? el.tagName);
      expect(trapped, `${label} would trap these fixed descendants`).toEqual([]);
    }
  });
});
