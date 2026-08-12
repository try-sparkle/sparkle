// @vitest-environment jsdom
//
// `.row`'s CONTENTS, in the mock's order: dot · `.el` elapsed · `.nm` name · `.stg` stage · close.
// (`.spark`, the per-agent sparkline, was CUT by the founder on 2026-07-29 and is deliberately not
// built — it was the one element with no data behind it.)
//
// Two things this pins that nothing else does:
//
//   • THE TWO METADATA MARKS ARE MONO AND MICRO. `.el` was 12px system-ui — the same face and
//     nearly the same size as the NAME beside it, so the row read as one run of text with a number
//     in front rather than as a reading and a title. Mono/10 is what separates the registers, and
//     it is the same treatment the group headers and the stage chip take, which is what makes the
//     column read as one instrument.
//
//   • THE STAGE CHIP IS DRAWN, NOT FILLED. `border` + `--r-sm`, no background. The design's thesis
//     is "structure is drawn, not filled"; a filled chip on every row would put a second wall of
//     colour beside the status dots, which is the treatment this column has already been walked
//     back from twice.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { stageMeta } from "../engine/workflowStage";
import { TERM_HAIRLINE } from "./terminalChrome";

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
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useHelperPrefs } from "../helper/helperPrefs";
import { allBandsVisible } from "../engine/buildSections";
import type { AgentTab, Project } from "../types";
import type { WorkflowStageId } from "../engine/workflowStage";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

function seed(
  stage: Record<string, WorkflowStageId> = {},
  selectedAgentId: string | null = null,
  over: Partial<AgentTab> = {},
): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId,
    agents: [mkAgent("a1", "Alpha", over)],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {}, workflowStage: stage, status: {},
    openAgentIds: ["a1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const rowFor = (name: string) =>
  screen.getByText(name).closest('[data-hint="agent"]') as HTMLElement;

beforeEach(() => {
  useUiStore.setState({
    collapsedOrchestrators: {},
    activeSpecial: null,
    statusFilter: allBandsVisible(),
  } as never);
  useHelperPrefs.setState({ enabled: true } as never);
});
afterEach(cleanup);

describe("`.stg` — the row's stage chip", () => {
  it("shows the stage's SHORT name on the row", () => {
    render(<AgentSidebar project={seed({ a1: "pull_request" })} />);
    const chip = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-stage-chip"]')!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe(stageMeta("pull_request").short); // "In PR"
  });

  it("sits after the name and before the close slot", () => {
    render(<AgentSidebar project={seed({ a1: "building_saved" }, "a1")} />);
    const row = rowFor("Alpha");
    const chip = row.querySelector('[data-testid="row-stage-chip"]')!;
    const name = screen.getByText("Alpha");
    const close = row.querySelector('[aria-label*="Close"], [title*="Close"]')!;

    // DOCUMENT_POSITION_FOLLOWING === 4: the chip comes after the name, the close after the chip.
    expect(name.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is BORDERED and near-square, never a filled pill", () => {
    render(<AgentSidebar project={seed({ a1: "pushed" })} />);
    const chip = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-stage-chip"]')!;

    expect(chip.style.border).toBe(`1px solid ${C.pillFill}`);
    expect(chip.style.borderRadius).toBe(`${RADIUS.sm}px`);
    // No fill, and emphatically not the 999px capsule the app's other chips reach for.
    expect(chip.style.background).toBe("");
    expect(chip.style.borderRadius).not.toBe("999px");
  });

  it("takes the mono micro treatment and the neutral ink", () => {
    render(<AgentSidebar project={seed({ a1: "pushed" })} />);
    const chip = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-stage-chip"]')!;
    expect(chip.style.fontFamily).toBe(FONT_MONO);
    expect(chip.style.fontSize).toBe(`${TYPE.micro}px`);
    // NOT the stage's own colour: status never colours a row's text in this column, and ten stage
    // hues down one column is the wall of colour the rows were stripped to avoid.
    expect(chip.style.color).toBe(C.muted);
    expect(chip.style.color).not.toBe(stageMeta("pushed").color);
  });

  // THE ACTIVE BRANCH, which had no coverage at all and shipped a theme-blind literal
  // (`rgba(125,150,180,.4)`, transcribed from a dark-mode mock and applied in both themes) for one
  // commit. On the selected row the chip is sitting on the TERMINAL plane, not on the build column,
  // so it takes that plane's own edge token. Asserted as a pairing — the idle token is explicitly
  // rejected here — because "it has some border" is what let the literal through.
  it("swaps to the terminal plane's edge token on the selected row", () => {
    render(<AgentSidebar project={seed({ a1: "pushed" }, "a1")} />);
    const chip = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-stage-chip"]')!;
    expect(chip.style.border).toBe(`1px solid ${TERM_HAIRLINE}`);
    expect(chip.style.border).not.toBe(`1px solid ${C.pillFill}`);
    // No literal survives: every colour on this chip has to be sweepable by chromeContrast /
    // blueprintSpec, which cannot see an rgba() typed into a component.
    expect(chip.style.border).not.toContain("rgba(");
  });

  // A shell row has no workflow stage at all; a chip there would be an empty box.
  it("renders no chip when the row has no stage", () => {
    render(<AgentSidebar project={seed({}, null, { kind: "shell", shellCommand: "zsh" })} />);
    expect(rowFor("Alpha").querySelector('[data-testid="row-stage-chip"]')).toBeNull();
  });
});

describe("`.el` — the elapsed reading", () => {
  it("renders mono at the micro step, in the faint tier", () => {
    // The timer needs something to count FROM: the later of the last composer Send
    // (`promptHistory`) and the last terminal keystroke. Without one the row shows no timer at all.
    render(
      <AgentSidebar
        project={seed({ a1: "building_saved" }, null, {
          promptHistory: [{ id: "p-1", text: "go", at: Date.now() - 5_000 }],
        })}
      />,
    );
    const el = rowFor("Alpha").querySelector<HTMLElement>('[data-testid="row-elapsed"]');
    expect(el).toBeTruthy();
    expect(el!.style.fontFamily).toBe(FONT_MONO);
    expect(el!.style.fontSize).toBe(`${TYPE.micro}px`);
    // The mock puts `.el` a tier below the name (`--k-faint`) and this deliberately does not
    // follow it: `agentIdle` measures 3.377:1 in light / 4.353:1 in dark on this column, under AA
    // for 10px text. The mono face and the micro size already separate the reading from the title.
    // Same pairing assertion as the group header's, and for the same reason — nothing else guards
    // `agentIdle` as an ink.
    expect(el!.style.color).toBe(C.muted);
    expect(el!.style.color).not.toBe(C.agentIdle);
    // tabular so the row does not twitch as the digits roll.
    expect(el!.style.fontVariantNumeric).toBe("tabular-nums");
  });
});

// `.spark` was CUT. Asserted rather than merely omitted: it is the one element in the mock with no
// data behind it, so it is exactly the thing a later pass would "finish" by inventing a source.
describe("`.spark` — cut by the founder, and staying cut", () => {
  it("renders no sparkline on the row", () => {
    render(<AgentSidebar project={seed({ a1: "building_saved" })} />);
    expect(rowFor("Alpha").querySelector('[data-testid="row-spark"]')).toBeNull();
    expect(rowFor("Alpha").querySelector("canvas")).toBeNull();
  });
});

// ── STATUS IS TEXT. ACTION IS A BUTTON. ────────────────────────────────────────────────────────
//
// rev4.html states it on the PR sheet: "`ready` shipped as a filled green box beside a filled green
// Merge button — two identical-looking objects, one of which does nothing when clicked. A status
// describes; only the thing that DOES something gets a button's affordance."
//
// That sheet is not built here (nothing in this app renders "checks running" / "checks failed"
// yet), but the same rule governs the ONE place this column already makes the distinction: the
// detail card's Status line. "Up to date with main" describes and must stay a <span>; the
// behind/ahead pills rebase and merge, so they are buttons and stay buttons. Pinned so a future
// pass cannot make the whole line uniform in either direction.
describe("status is text, action is a button", () => {
  const openCard = () => {
    fireEvent.contextMenu(rowFor("Alpha"));
    return screen.getByTestId("agent-hover-card");
  };

  it("renders a settled branch's status as plain text, never as a control", () => {
    render(<AgentSidebar project={seed({ a1: "building_saved" })} />);
    const card = openCard();
    const status = screen.getByText(/Up to date with/i);
    expect(status.tagName).toBe("SPAN");
    expect(status.closest("button")).toBeNull();
    // The card's only pressable objects are its real actions, not its readouts.
    for (const b of Array.from(card.querySelectorAll("button"))) {
      expect(b.textContent).not.toMatch(/Up to date with/i);
    }
  });

  it("keeps the ahead pill a real button — it merges, so it gets the affordance", () => {
    const project = seed({ a1: "building_saved" });
    useRuntimeStore.setState({
      branchStatus: { a1: { ahead: 2, behind: 0 } },
    } as never);
    render(<AgentSidebar project={project} />);
    openCard();
    const merge = screen.getByText(/2 commits ahead of/i);
    expect(merge.closest("button")).toBeTruthy();
  });
});
