// @vitest-environment jsdom
//
// ONE KEBAB, ONE AVATAR — asserted with BOTH surfaces mounted and NEITHER stubbed.
//
// `ConciergeTopRight` (the kebab + the signed-in avatar) moved from the project tabs bar into the
// concierge's own header when that header consolidated to one row. For one commit only the ADDITION
// half landed: the bar kept its mount, so the shipped shell painted two buttons named "Sparkle
// menu" and two auth controls driving the same `uiStore.openSettings` seam (roborev 54712).
//
// NOTHING CAUGHT IT, AND THAT IS THE POINT OF THIS FILE. Every whole-shell suite stubs
// `ConciergeTopRight` (ProjectTabsBar.test.tsx, Workspace.tabs.test.tsx) because the real one
// self-fetches over Tauri, and each component's own tests render only itself — where a single match
// is unambiguous precisely because the other surface is absent. The duplicate lived in the one gap
// between them. So this file deliberately does the expensive thing: mounts both, stubs neither, and
// counts.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// The two concierge-header pieces that drive a rAF audio loop / an entitlement fetch. Stubbed for
// the same reason every other concierge test stubs them; NEITHER is `ConciergeTopRight`, which is
// the whole subject here and is deliberately real.
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./TrialChrome", () => ({ TrialIndicator: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));

import { ProjectTabsBar } from "./ProjectTabsBar";
import { ConciergeColumn } from "./Concierge";
import type { ConciergeController, ConciergeViewModel } from "./Concierge";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { ConciergeFeed } from "../services/conciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

const feed = { projects: [], agents: [], scopedCounts: {} } as unknown as ConciergeFeed;

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  messages: [],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

beforeEach(() => {
  enableAiEnhancementsForTests();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useUiStore.setState({ openProjectIds: null, pinnedProjectId: null } as never);
});
afterEach(cleanup);

function mountBoth() {
  render(
    <>
      <ProjectTabsBar feed={feed} onOpenProjectSettings={vi.fn()} />
      <ConciergeColumn model={model} controller={controller()} />
    </>,
  );
}

// QUERIED BY THE SLOT, NOT BY THE ACCESSIBLE NAME.
//
// These rows say "the shell mounts this control exactly once", and that claim has to be about THIS
// control. `"Sparkle menu"` was a name only the kebab had; when it became a Settings button the
// queries followed the new name — and `"Settings"` is generic. Any sibling that names itself Settings
// (a gear in the tabs bar, a project-settings control — `onOpenProjectSettings` is right there in
// these very renders) breaks the count, or worse satisfies `contains` for the wrong element and the
// uniqueness claim silently becomes a claim about something else (roborev 55477).
//
// `data-hint="menu"` is the stable identifier for the shell slot, which is exactly what "mounted
// once" is a statement about, and it survives the next rename of the button's label.
const kebabs = () => document.querySelectorAll('[data-hint="menu"]');

describe("the shell mounts the top-right cluster exactly ONCE", () => {
  it("renders one kebab with both the tabs bar and the concierge column up", () => {
    mountBoth();
    expect(kebabs()).toHaveLength(1);
  });

  it("…and it is the CONCIERGE's copy, not the tab bar's", () => {
    mountBoth();
    expect(screen.getByTestId("concierge-header").contains(kebabs()[0]!)).toBe(true);
  });

  it("renders no kebab at all when the tabs bar is mounted alone", () => {
    render(<ProjectTabsBar feed={feed} onOpenProjectSettings={vi.fn()} />);
    expect(kebabs()).toHaveLength(0);
  });
});
