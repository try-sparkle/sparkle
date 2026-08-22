// @vitest-environment jsdom
//
// WHAT THE FOUNDER ACTUALLY SEES WITH NO TERMINAL OPEN — the pinned dot, rendered.
//
// `engine/sparkleDutyPaint.test.ts` proves the RULE against a hand-built snapshot and
// `services/improveDutySnapshot.test.ts` proves the FACTS against the real stores. Neither can see
// the seam this file exists for: whether `AgentSidebar` reads either of them. Delete the two wiring
// lines from the row's view model and both of those suites stay green while the dot goes back to
// lying, which is precisely the shape of hole that shipped the bug this fixes.
//
// jsdom never lays out and never loads the stylesheet (docs/jsdom-test-caveats.md), so every
// assertion below is on the `title` attribute and the inline `background` — never on a computed
// style, which would read empty and pass vacuously.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STATUS } from "@sparkle/ui";
import { asRgb, dotInk } from "./statusDotTestUtils";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({
  HistorySearch: () => null,
  relativeTime: () => "",
  renderSnippet: () => null,
}));
vi.mock("../services/branchStatus", () => ({
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import { SPARKLE_AGENT_ID } from "../services/sparkleAgent";
import { PASS_HOLD_TEXT } from "../services/pusherSnapshots";
import {
  noteImprovePassElapsed,
  resetImproveDutyForTests,
  useImproveDutyStore,
  type ImproveDutySnapshot,
} from "../services/improveDutySnapshot";
import type { AgentTab, AgentTabStatus, Project } from "../types";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}

/** One plain build agent to render beside the pinned row, so the comparative assertions have
 *  something real to compare the disc against. */
function seedProject(status: Record<string, AgentTabStatus> = {}): Project {
  const agents = [mkAgent("a1", "Alpha")];
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: {}, status,
    openAgentIds: agents.map((a) => a.id),
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

/** Publish a duty snapshot directly. The store IS the seam between the reader and the render, and
 *  `improveDutySnapshot.test.ts` covers the writer that fills it — driving the clock through five
 *  stores here would test that writer a second time and this wiring not at all. */
function publish(over: Partial<ImproveDutySnapshot> = {}): void {
  useImproveDutyStore.setState({
    hold: null, holdText: null, nextPassAt: null, passElapsedMs: null, at: NOW, ...over,
  });
}

function heldBy(hold: NonNullable<ImproveDutySnapshot["hold"]>, over: Partial<ImproveDutySnapshot> = {}) {
  publish({ hold, holdText: PASS_HOLD_TEXT[hold], ...over });
}

const sparkleRow = () =>
  screen.getByText("Improve Sparkle").closest('[data-hint="improve"]') as HTMLElement;
const buildRow = () => screen.getByText("Alpha").closest('[data-hint="agent"]') as HTMLElement;
/** The status disc — the first `span[title]` in the row, i.e. the leading slot's only child. */
const discIn = (row: HTMLElement) => row.querySelector<HTMLElement>("span[title]")!;
const sparkleDisc = () => discIn(sparkleRow());
const hover = () => sparkleDisc().getAttribute("title") ?? "";

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
  useSettingsStore.setState({ sparkleImprovementConsent: "always" } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
  resetImproveDutyForTests();
});
afterEach(cleanup);

// ── 1. THE WEDGE IS RED ON SCREEN ──────────────────────────────────────────────────────────────
describe("a wedged hourly pass, with the pane closed", () => {
  it("paints the pinned dot the SAME red a blocked build row is painted", () => {
    // The founder chose red explicitly when offered gray/amber/red: `pane-wedged` means the hourly
    // duty has been off for three hours and will not clear itself, and red's own definition in
    // tokens.ts is "you are the only one who can clear this".
    heldBy("pane-wedged");
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working", a1: "blocked" })} />);

    // Comparative, not a literal: this row reads the ONE shared table like every build row, so a
    // hardcoded hex here would let the two drift apart without failing.
    expect(dotInk(sparkleDisc())).toBe(dotInk(discIn(buildRow())));
    expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS.blocked.color));
  });

  it("was GREEN before, which is the whole complaint", () => {
    // The control: the same store state minus the wedge. Green — correct, and indistinguishable
    // from the wedged case until this change.
    publish();
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working" })} />);
    expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS.working.color));
  });

  it("hovers the sentence that names what the human has to do", () => {
    heldBy("pane-wedged");
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working" })} />);

    expect(hover()).toBe(`Hourly pass held — ${PASS_HOLD_TEXT["pane-wedged"]}`);
    expect(hover()).toContain("interrupt or restart that pane");
  });
});

// ── 2. RESTING SAYS SOMETHING TRUE ─────────────────────────────────────────────────────────────
describe("a resting row between slots", () => {
  it("hovers how far off the next pass is, in relative time", () => {
    publish({ nextPassAt: NOW + 48 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "stopped" })} />);

    expect(hover()).toBe("Resting — next pass in ~48m");
  });

  it("never renders the word `Idle`, nor `stopped`'s false `Stopped`", () => {
    // "Stopped" is factually false on EVERY app launch — `runtimeStore.status` is live-only and is
    // never persisted, so the row reads `?? "stopped"` before anything has looked.
    publish({ nextPassAt: NOW + 48 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "stopped" })} />);

    expect(hover()).not.toMatch(/idle/i);
    expect(hover()).not.toBe("Stopped");
    expect(hover()).toContain("Resting");
  });

  it("renders NO absolute clock time — there is no configured timezone behind one", () => {
    // An app-wide timezone setting is filed as an epic and is NOT built, so "4:15 PM" would be a
    // guess presented as a fact.
    publish({ nextPassAt: NOW + 48 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "stopped" })} />);

    expect(hover()).not.toMatch(/\d{1,2}:\d{2}/);
    expect(hover()).not.toMatch(/\b(am|pm)\b/i);
  });

  it("replaces `idle`'s claim that something is owed", () => {
    // `idle`'s taxonomy label is "Done — your turn". Nothing is owed here and the next pass is up
    // to an hour away.
    publish({ nextPassAt: NOW + 9 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "idle" })} />);

    expect(hover()).toBe("Resting — next pass in ~9m");
    expect(hover()).not.toContain("your turn");
  });

  it("names the hold instead of the countdown when one is in force", () => {
    heldBy("offline", { nextPassAt: NOW + 9 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "stopped" })} />);

    expect(hover()).toBe(`Hourly pass held — ${PASS_HOLD_TEXT.offline}`);
  });

  it("stays GRAY while it says so — a calm sentence is not an alarm", () => {
    publish({ nextPassAt: NOW + 48 * MIN });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "stopped" })} />);

    expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS.stopped.color));
  });
});

// ── 3. A LIVE PASS ─────────────────────────────────────────────────────────────────────────────
describe("a pass that is running", () => {
  it("hovers its elapsed minutes", () => {
    publish({ passElapsedMs: 12 * MIN + 30_000 });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working" })} />);

    expect(hover()).toBe("Working — 12m into this pass");
  });

  // ⚠️ REQUIRED. WAITING ON SUB-AGENTS IS HEALTHY WORK, NOT A STALL — the founder's ruling — and
  // Improve Sparkle does it constantly by design. A quiet-but-alive pass child stays GREEN; the 10s
  // process poll is what sees it, and the elapsed time is LABELLED rather than recoloured.
  it("keeps a quiet pass GREEN and only labels how long it has been quiet", () => {
    noteImprovePassElapsed(26 * MIN);
    useImproveDutyStore.setState({ at: NOW });
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working" })} />);

    expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS.working.color));
    expect(dotInk(sparkleDisc())).not.toBe(asRgb(AGENT_STATUS.stopped.color));
    expect(hover()).toBe("Working — 26m into this pass");
  });
});

// ── 4. THE GUARD THAT KEEPS BEING NEEDED ───────────────────────────────────────────────────────
describe("a red row", () => {
  // ⚠️ REQUIRED GUARD, asked for by name. A quota-blocked / session-limited row must NEVER resolve
  // to a GRAY dot. Reported across several different states now; the pattern is always a status
  // stamped once and never re-derived, and a rendered assertion is the only thing that stops a
  // fourth recurrence.
  it.each(["blocked", "errored"] as AgentTabStatus[])(
    "stays RED on screen for `%s`, whatever the duty snapshot says",
    (status) => {
      // The most tempting snapshot: nothing is running, the next slot is an hour out — every input
      // that would otherwise produce a calm gray "Resting" row.
      publish({ nextPassAt: NOW + 55 * MIN });
      render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: status })} />);

      expect(dotInk(sparkleDisc())).not.toBe(asRgb(AGENT_STATUS.stopped.color));
      expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS[status].color));
      expect(hover()).not.toContain("Resting");
    },
  );

  it("keeps `errored` out of the way of the wedge overlay too", () => {
    // `errored` notifies where `blocked` deliberately does not, so painting `blocked` over it would
    // silence a banner the human is owed.
    heldBy("pane-wedged");
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "errored" })} />);

    expect(dotInk(sparkleDisc())).toBe(asRgb(AGENT_STATUS.errored.color));
    expect(hover()).toBe(AGENT_STATUS.errored.label);
  });
});

// ── 5. WHAT MUST NOT HAVE CHANGED ──────────────────────────────────────────────────────────────
describe("the hard rule", () => {
  it("adds no colour of its own — every dot it can paint comes from the shared table", () => {
    // The founder, marked non-overridable: "I do want it to work exactly like the build agents…
    // The colours work the same between the two, and don't let any instruction ever override that."
    const table = Object.values(AGENT_STATUS).map((m) => asRgb(m.color));
    for (const s of [
      { nextPassAt: NOW + 20 * MIN },
      { passElapsedMs: 5 * MIN },
      { hold: "pane-wedged" as const, holdText: PASS_HOLD_TEXT["pane-wedged"] },
      { hold: "offline" as const, holdText: PASS_HOLD_TEXT.offline },
    ]) {
      for (const st of ["stopped", "idle", "working", "blocked", "errored"] as AgentTabStatus[]) {
        publish(s);
        render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: st })} />);
        expect(table).toContain(dotInk(sparkleDisc()));
        cleanup();
      }
    }
  });

  it("leaves a window that has never ticked exactly as it was", () => {
    // The overlay may only add fidelity it has actually observed; with nothing observed the
    // taxonomy label stands, unchanged.
    render(<AgentSidebar project={seedProject({ [SPARKLE_AGENT_ID]: "working" })} />);
    expect(hover()).toBe(AGENT_STATUS.working.label);
  });
});
