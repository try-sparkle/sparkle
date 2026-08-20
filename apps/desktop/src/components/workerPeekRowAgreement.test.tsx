// @vitest-environment jsdom
//
// THE PEEK AND THE ROW MUST TELL THE SAME STORY ABOUT THE SAME WORKER.
//
// The founder caught this with two screenshots of one worker. Collapsed, the peek under its parent
// showed a RED dot and the words "needs you". Expanded, that same worker's own row showed a GREY dot
// and hovered "Needs merge". At most one of those can be true, and the grey one was.
//
// The cause was two surfaces deriving attention two different ways. `attentionWorkersOf` SELECTS a
// deliberately MIXED-BAND list — `unmerged` (grey, band `done`) rides in beside the reds, and the
// blue `questions` band rides in beside them too — and `WorkerPeek` then painted every entry with a
// hardcoded `bandColor("needs_you")` and wrote the literal words "needs you" for all of them. The
// expanded row, meanwhile, passes no `color` override at all, so its disc falls through to
// `StatusDot`'s default `AGENT_STATUS[status].color`. Selection was band-aware; rendering was not.
//
// WHAT THESE TESTS PIN, and why it is two tests rather than one:
//
//   1. SAME PREDICATE (below). For every status the peek will show at all, the peek's dot ink EQUALS
//      the expanded row's dot ink. This is the structural guarantee — the two surfaces cannot
//      disagree about COLOUR — and it is taken over the WHOLE `AgentTabStatus` taxonomy read out of
//      `AGENT_STATUS`, never a hand-written subset. A subset is how a status added next year gets a
//      red peek and a grey row with every test still green.
//
//   2. "SAVED" IS NOT "NEEDS YOU". Colour agreement alone would still permit a grey-dotted line that
//      says "needs you" in words, which is the half of the bug the founder actually read. So the
//      WORDS are pinned separately, in both the visible marker and the `aria-label`.
//
// Both go through the REAL sidebar rather than rendering `WorkerPeek` in isolation, because the
// disagreement lives at the two CALL SITES — what the sidebar hands each surface — and a
// component-only test cannot see whether the sidebar ever hands it anything (AGENTS.md's
// defaulted-seam trap).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { AGENT_STATUS } from "@sparkle/ui";
import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { asRgb, dotInk } from "./statusDotTestUtils";
import { bandColor } from "../engine/statusBandLabels";
import { subtreeDomIdFor } from "./subtreeTestUtils";
import type { AgentTab, AgentTabStatus, Project } from "../types";
// NOT from `../types` — `WorkflowStageId` lives in the engine module that owns the stage ladder.
import type { WorkflowStageId } from "../engine/workflowStage";

const HEAD_ID = "a1";
const WORKER_ID = "w1";
const WORKER_NAME = "Fix The Parser";

function mkAgent(id: string, name: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, ...over,
  };
}

/** SEEDING A STATUS THE SIDEBAR WILL ACTUALLY PRESENT, which for one status is not the status.
 *
 *  `unmerged` cannot be seeded directly: it is in `stallEscalation.ESCALATABLE`, and `agentStall`
 *  treats the status itself as the evidence of unlanded work — so a LIVE `unmerged` worker is
 *  escalated to amber `lapsed` before it ever reaches a dot, and nothing peeks. Measured, not
 *  guessed: seeding `unmerged` renders "Unfinished, not yours" in amber.
 *
 *  Its real shape is the persisted tab the peek exists for — `stopped` (which
 *  `goalContinuationRunner.DEAD` contains, so the escalation refuses it) plus a workflow stage
 *  holding committed-but-unlanded work, which `unmergedAttention.withUnmergedWork` rewrites to
 *  `unmerged`. That is the same worker the founder screenshotted: finished, PR not landed, no live
 *  pane. Every other status is seeded as itself. */
function fixtureFor(status: AgentTabStatus): { raw: AgentTabStatus; stage?: WorkflowStageId } {
  return status === "unmerged" ? { raw: "stopped", stage: "building_saved" } : { raw: status };
}

/** Orchestrator "Alpha" with ONE worker in `workerStatus`.
 *
 *  The worker is OPEN and carries a live status entry, because `attentionWorkersOf` gates its red and
 *  blue arms on a live PTY reading — a worker seeded without one is inert for the peek, and every
 *  "no peek appeared" result below would be meaningless. */
function seed(workerStatus: AgentTabStatus, collapsed: boolean): Project {
  const { raw, stage } = fixtureFor(workerStatus);
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [
      mkAgent(HEAD_ID, "Alpha", { namePinned: true }),
      mkAgent(WORKER_ID, WORKER_NAME, {
        kind: "worker", parentId: HEAD_ID, baseBranch: "main",
        worktreePath: `/wt/${WORKER_ID}`, createdAt: 1,
      }),
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {},
    workflowStage: stage ? { [WORKER_ID]: stage } : {},
    // The HEAD is left `working` throughout so nothing about it can wander into the assertions: a
    // green head neither peeks on its own account nor borrows a colour the worker didn't earn.
    status: { [HEAD_ID]: "working", [WORKER_ID]: raw } as Record<string, AgentTabStatus>,
    openAgentIds: [HEAD_ID, WORKER_ID],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  // Collapse is USER state and the peek only renders under a CLOSED head, so it is seeded rather
  // than clicked — the gesture path is pinned in AgentSidebar.disclosure.test.tsx and re-driving it
  // here would only add a way for these tests to fail for an unrelated reason.
  useUiStore.setState({
    collapsedOrchestrators: { [HEAD_ID]: collapsed },
    activeSpecial: null,
  } as never);
  return project;
}

/** The disc inside `root`, located by SHAPE (a full circle) rather than by tooltip — the peek's dot
 *  and the row's dot deliberately hover as different things, and this asks only about colour. */
function discIn(root: Element, where: string): HTMLElement {
  const disc = Array.from(root.querySelectorAll("span")).find(
    (el) => (el as HTMLElement).style.borderRadius === "50%",
  );
  if (!disc) throw new Error(`no status disc found in ${where}`);
  return disc as HTMLElement;
}

/** The COLLAPSED head's peek line, or null when no peek rendered for this status. */
function peekLine(): HTMLElement | null {
  return screen.queryByTestId("worker-peek");
}

/** The EXPANDED worker's own row — scoped to the head's subtree `group`, so the peek (a sibling of
 *  the head row, outside that group) can never be mistaken for it. */
function workerRow(): HTMLElement {
  const row = document
    .querySelector(`#${subtreeDomIdFor(HEAD_ID)}`)
    ?.querySelector('[data-hint="agent"]');
  if (!row) throw new Error("the worker's own row is not rendered — did the subtree fail to open?");
  return row as HTMLElement;
}

/** The ink of the peek's dot for `status`, or null when that status never reaches the peek.
 *  Renders and tears down its own fixture, so the two halves of a comparison can't share a DOM. */
function peekInkFor(status: AgentTabStatus): string | null {
  render(<AgentSidebar project={seed(status, true)} />);
  const line = peekLine();
  const ink = line ? dotInk(discIn(line, `the peek for "${status}"`)) : null;
  cleanup();
  return ink;
}

/** The ink of the EXPANDED worker row's dot for `status`. */
function rowInkFor(status: AgentTabStatus): string {
  render(<AgentSidebar project={seed(status, false)} />);
  const ink = dotInk(discIn(workerRow(), `the expanded row for "${status}"`));
  cleanup();
  return ink;
}

/** Every status in the taxonomy, READ OUT OF THE TABLE rather than listed. A hand-written subset
 *  silently exempts whatever status is added next, which is exactly the drift this file exists to
 *  make impossible. */
const ALL_STATUSES = Object.keys(AGENT_STATUS) as AgentTabStatus[];

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
});
afterEach(cleanup);

describe("the peek's dot and the expanded row's dot are the same expression", () => {
  it("agrees on ink for EVERY status the peek shows", () => {
    // The taxonomy really is being walked — a `for` loop over an empty array passes silently.
    expect(ALL_STATUSES.length).toBeGreaterThan(5);

    const disagreements: string[] = [];
    const peeked: AgentTabStatus[] = [];

    for (const status of ALL_STATUSES) {
      const peekInk = peekInkFor(status);
      if (peekInk === null) continue; // a calm status: it never reaches the peek at all.
      peeked.push(status);

      const rowInk = rowInkFor(status);
      if (peekInk !== rowInk) {
        disagreements.push(`${status}: peek ${peekInk} vs row ${rowInk}`);
      }
    }

    // Named in the failure rather than asserted one-by-one, so a regression says WHICH statuses
    // drifted and to what, instead of stopping at the first.
    expect(disagreements).toEqual([]);

    // THE POSITIVE CONTROL. Every assertion above is skipped for a status that does not peek, so a
    // peek that rendered for NOTHING would pass this test while showing the user nothing at all.
    // These are the three shapes the peek exists to carry — a red, the blue question, and the grey
    // owed merge — and they are exactly the cases where the two surfaces used to disagree.
    expect(peeked).toContain("errored"); // band needs_you — agreed even before the fix
    expect(peeked).toContain("questions"); // band questions — BLUE, painted red before the fix
    expect(peeked).toContain("unmerged"); // band done — GREY, painted red before the fix
  });
});

describe('a worker that is "Needs merge" does not claim to need you', () => {
  // THE FOUNDER'S SCREENSHOT, as an assertion. `unmerged` is a grey LANDING state — an ask he can
  // act on, which is why it peeks at all (see engine/workerExpansion.isOwedAsk) — but it is not an
  // alarm, and the peek used to announce it as one in both the visible marker and the label a screen
  // reader speaks.
  it("says neither 'needs you' nor 'need you', in the marker or the aria-label", () => {
    render(<AgentSidebar project={seed("unmerged", true)} />);
    const line = peekLine();
    expect(line).toBeTruthy(); // it MUST still peek — silence here would be a different bug

    expect(line!.textContent).toContain(WORKER_NAME);
    expect(line!.textContent?.toLowerCase()).not.toContain("needs you");
    expect(line!.textContent?.toLowerCase()).not.toContain("need you");

    const label = line!.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).not.toContain("needs you");
    expect(label.toLowerCase()).not.toContain("need you");

    // And it says the true thing instead — in the SAME words in both places, so what a sighted user
    // reads and what a screen reader speaks cannot drift apart.
    expect(line!.textContent).toContain("needs merge");
    expect(label).toContain("needs merge");

    // The dot is the ROW's colour — not the alarm red. Since the founder's 2026-08-19 terminal-gray
    // rule this fixture's worker sits at a pre-terminal stage, so BOTH discs are amber rather than
    // gray; what this pins is that they still AGREE, which is the property the file exists for.
    const peekInk = dotInk(discIn(line!, "the unmerged peek"));
    // THE MARKER IS A BAND LEGEND, and what that buys is ONE thing: a "needs merge" can never
    // arrive wearing the alarm colour. So THAT is what is asserted.
    //
    // ⚠️ AN EARLIER VERSION ASSERTED `marker.color !== dot.color`, WHICH WAS THE WRONG PROPERTY in
    // both directions (roborev 65723). It would stay green if the marker were changed to
    // `bandColor("needs_you")` — alarm red is also "not the amber disc", so the one regression the
    // comment names went unguarded — and it would go RED for an `unmerged` worker at a TERMINAL
    // section, where the disc is legitimately the same gray as the marker and every colour on the
    // line is exactly what was intended. That is the "expectation encodes the incidental collision
    // instead of the capability" shape in AGENTS.md; mutation grip does not judge an expected value.
    const marker = Array.from(line!.querySelectorAll("span")).find((el) =>
      (el.textContent ?? "").includes("needs merge"),
    ) as HTMLElement | undefined;
    expect(marker, "no marker span found on the unmerged peek line").toBeTruthy();
    // ⚠️ `asRgb`, NOT the raw token. jsdom normalises `style.color` to `rgb(...)` while `bandColor`
    // returns a hex, so comparing them directly can NEVER be equal and the assertion is vacuous —
    // caught by mutation-checking this very line: painting the marker `bandColor("needs_you")` left
    // it green. The sibling assertions in this file already go through `asRgb`/`dotInk` for exactly
    // this reason.
    expect(marker!.style.color, "a 'needs merge' must never wear the alarm colour").not.toBe(
      asRgb(bandColor("needs_you")),
    );
    cleanup();
    expect(peekInk).toBe(rowInkFor("unmerged"));
  });

  // A red worker still says "needs you" — the fix must not calm the case the peek was built for.
  it("still says 'needs you' for a genuinely red worker", () => {
    render(<AgentSidebar project={seed("errored", true)} />);
    const line = peekLine();
    expect(line).toBeTruthy();
    expect(line!.textContent).toContain("needs you");
    expect(line!.getAttribute("aria-label")).toContain("needs you");
  });

  // And a BLUE question says "question" — its own word, in its own colour. Grouped here rather than
  // with the ink test because this is the vocabulary half: `questions` shares the peek's "an ask you
  // can answer" purpose but is deliberately NOT an alarm (packages/ui/tokens.ts).
  it("says 'question' for a worker with an open question", () => {
    render(<AgentSidebar project={seed("questions", true)} />);
    const line = peekLine();
    expect(line).toBeTruthy();
    expect(line!.textContent).toContain("question");
    expect(line!.textContent?.toLowerCase()).not.toContain("needs you");
    expect(line!.getAttribute("aria-label")).toContain("question");
  });
});
