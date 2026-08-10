// @vitest-environment jsdom
// Integration coverage for the close-agent Ship / Save / Discard wiring (× → requestClose → modal →
// handler). Ship = push + open a PR (review, not straight-to-main); Save = keep the branch; Discard =
// delete worktree + branch + bead behind an explicit confirm.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/worktree", () => ({ removeAgentWorkspace: vi.fn(() => Promise.resolve()) }));
import { removeAgentWorkspace } from "../services/worktree";
// killPty shells out to a Tauri command that doesn't exist under jsdom; stub it so the teardown's
// background reap is deterministic and never rejects into the test.
vi.mock("../pty", () => ({ killPty: vi.fn(() => Promise.resolve()) }));
// The receipt store crosses the Tauri boundary, which does not exist under jsdom — every write
// would fail, and since knightwatch probe 4 a FAILED override write deliberately keeps the row. So
// the record is stubbed successful here: these rows test the confirm FLOW, and the store's own
// failure behaviour is owned by services/retroReceipts.test.ts.
// `cachedReceipt` is stubbed too, and its DEFAULT is the real jsdom behaviour: the cache is only
// ever filled by `loadRetroReceipts`, which invokes Tauri, so it answers `undefined` for every agent
// in this file today. Routing it through a mock changes nothing about that and buys the one thing
// the real module cannot give a test — a `captured` receipt, i.e. the pill's `ready` state, which
// had no coverage at all while `retro-pending` had two (roborev 59545).
// `recordRetroOverridden` is HOISTED into a named const rather than left inline, because the gap
// note it writes is permanent and undeletable — so whether it fires is itself the assertion (bead
// `sparkle-y2p4f`), and an inline `vi.fn()` in the factory cannot be reset or inspected.
const { cachedReceipt, recordRetroOverridden } = vi.hoisted(() => ({
  cachedReceipt: vi.fn((): import("../engine/retroReceiptTypes").RetroReceipt | undefined => undefined),
  recordRetroOverridden: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("../services/retroReceipts", async (orig) => ({
  ...(await orig<typeof import("../services/retroReceipts")>()),
  recordRetroOverridden,
  cachedReceipt,
}));

const { refreshAgentBranch, landAgentBranch, pushAgentBranch, openAgentPr, deleteAgentBranch } =
  vi.hoisted(() => ({
    refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
    // Typed as the real LandResult union so a test can drive the FAILED arm (`{ ok: false, reason }`)
    // — the inferred literal type from the happy-path default cannot express it.
    landAgentBranch: vi.fn(
      (): Promise<import("../services/branchStatus").LandResult> =>
        Promise.resolve({ ok: true, target: "main" }),
    ),
    pushAgentBranch: vi.fn(() => Promise.resolve("pushed")),
    openAgentPr: vi.fn(() => Promise.resolve("https://pr/1")),
    deleteAgentBranch: vi.fn(() => Promise.resolve()),
  }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch,
  landAgentBranch,
  pushAgentBranch,
  openAgentPr,
  deleteAgentBranch,
}));
// Spy the bead writes Ship/Discard use, keeping every other beads export real (planView/runtimeStore
// import from here too, so a full mock would break them).
const { closeBead, deleteBead, markBeadDelivered } = vi.hoisted(() => ({
  closeBead: vi.fn(() => Promise.resolve()),
  deleteBead: vi.fn(() => Promise.resolve()),
  markBeadDelivered: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/beads", async (orig) => ({
  ...(await orig<typeof import("../services/beads")>()),
  closeBead,
  deleteBead,
  markBeadDelivered,
}));

import { AgentSidebar } from "./AgentSidebar";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useBeadsStore, __setBeadsPolledAtForTest } from "../stores/beadsStore";
import { useUiStore } from "../stores/uiStore";
import type { AgentTab, Project } from "../types";

function buildAgentProject(beadId?: string): Project {
  const agent: AgentTab = {
    id: "a1", name: "Build 1", kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: "main", lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null, autoNameVariants: null,
    shellCommand: null, beadId,
  };
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [agent],
  };
  useProjectStore.setState({ projects: [project] } as never);
  // ahead:1 → resolveStage → building_saved → shouldPromptOnClose() is true → close PROMPTS.
  useRuntimeStore.setState({
    branchStatus: { a1: { ahead: 1, behind: 0, dirty: false, filesChanged: 1, insertions: 1, deletions: 0 } },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

function openClosePrompt() {
  // The × shows persistently on the ACTIVE row (and clicking it stopPropagations, so no card opens);
  // select the agent so the affordance is present, then click it. (Hovering no longer expands a row.)
  const p = useProjectStore.getState().projects[0]!;
  useProjectStore.setState({ projects: [{ ...p, selectedAgentId: "a1" }] } as never);
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
  fireEvent.click(screen.getByLabelText("Close agent"));
}

// A build agent with NO unmerged work at risk (clean tree, 0 commits ahead): shouldPromptOnClose is
// false, so clicking × silently tears it down (no Ship/Save/Discard modal) — the common case for a
// finished agent whose work already landed.
function silentCloseProject(): Project {
  const project = buildAgentProject();
  useRuntimeStore.setState({
    branchStatus: { a1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 } },
    status: {},
    workflowStage: {},
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const agentsNow = () => useProjectStore.getState().projects[0]!.agents.map((a) => a.id);

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {} } as never);
  landAgentBranch.mockReset().mockResolvedValue({ ok: true, target: "main" });
  refreshAgentBranch.mockReset().mockResolvedValue({ ok: true });
  pushAgentBranch.mockReset().mockResolvedValue("pushed");
  openAgentPr.mockReset().mockResolvedValue("https://pr/1");
  deleteAgentBranch.mockReset().mockResolvedValue(undefined);
  vi.mocked(removeAgentWorkspace).mockReset().mockResolvedValue(undefined);
  closeBead.mockClear();
  deleteBead.mockClear();
  // Back to "no receipt on file", the state every test but the `ready` ones assumes. A bare
  // `mockReset()` would do it, but naming the value keeps the default readable — and this is a
  // block body, never an expression, so vitest cannot mistake the chainable mock for a teardown.
  cachedReceipt.mockReset().mockReturnValue(undefined);
  recordRetroOverridden.mockReset().mockResolvedValue(true);
  // ── THE RETIRE DIALOG READS THE BEADS STORE NOW (bead `sparkle-y2p4f`) ──────────────────────
  // "No receipt on file" stopped being sufficient to say an agent reported nothing: the receipt
  // store has no production writer for the success case, so the dialog was telling agents with
  // FEEDBACK pills on their own row that nothing had been recorded about what they learned.
  //
  // Every case below means "this agent filed nothing", which is now a fact that must be READ
  // rather than assumed. Seed it: a successful, fresh, empty backlog. Without this they would all
  // resolve to `unknown` — the correct answer for a backlog we could not read, but not the case
  // these tests are about, and the honest-gap copy they assert would (rightly) not appear.
  useBeadsStore.setState({
    byProject: {
      p1: {
        beads: [],
        board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [] },
        loadedAt: Date.now(),
      },
    },
  } as never);
  // `polledAt` is module-scope and written ONLY inside `refresh`'s success commit, so seeding
  // `byProject` alone still reads as never-successfully-polled.
  __setBeadsPolledAtForTest("p1", Date.now());
});
afterEach(cleanup);

describe("AgentSidebar — persistent close on the active row", () => {
  it("shows the Close button on the ACTIVE (selected) row WITHOUT hovering", () => {
    const project = buildAgentProject();
    // The row the user is looking at — its output fills the main pane — is the selected/active one.
    useProjectStore.setState({ projects: [{ ...project, selectedAgentId: "a1" }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    // No mouseEnter: the active row must expose a persistent close affordance, not a hover-only one.
    expect(screen.getByLabelText("Close agent")).toBeTruthy();
  });

  it("does NOT show the Close button on an inactive, un-interacted row", () => {
    const project = buildAgentProject();
    useProjectStore.setState({ projects: [{ ...project, selectedAgentId: null }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    // The × is reserved for the active row (or the open detail card) — a resting inactive row has none.
    expect(screen.queryByLabelText("Close agent")).toBeNull();
  });
});

describe("AgentSidebar — silent close removes the row without waiting on git", () => {
  it("drops the build-agent row IMMEDIATELY even while worktree removal is still in flight", () => {
    // Regression: closing a build agent used to `await removeAgentWorkspace` (serialized on the shared
    // per-repo lock) BEFORE calling removeAgent, so when a concurrent agent held that lock the closed
    // row lingered in the sidebar — and its pane re-appeared, since it was still selectedAgentId — until
    // the lock drained ("X closes the terminal but the row stays / comes back"). The row removal must be
    // optimistic: gone the instant you click ×, with the git cleanup reaped in the background.
    vi.mocked(removeAgentWorkspace).mockReset().mockReturnValue(new Promise<void>(() => {})); // never resolves
    silentCloseProject();
    const p = useProjectStore.getState().projects[0]!;
    useProjectStore.setState({ projects: [{ ...p, selectedAgentId: "a1" }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    fireEvent.click(screen.getByLabelText("Close agent"));
    // No await, no waitFor: the store must already have dropped the row synchronously with the click,
    // NOT after the hanging removeAgentWorkspace settles.
    expect(agentsNow()).not.toContain("a1");
  });
});

describe("AgentSidebar — close → Ship/Save/Discard", () => {
  it("prompts (does not silently close) when the agent has unmerged work", () => {
    buildAgentProject();
    openClosePrompt();
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(agentsNow()).toContain("a1"); // not torn down yet
  });

  it("Ship: pushes the branch + opens a PR (not a straight-to-main land), then tears down", async () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(openAgentPr).toHaveBeenCalled());
    expect(pushAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1");
    expect(landAgentBranch).not.toHaveBeenCalled(); // remote present → PR, never a local merge
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
  });

  it("Save for later closes the agent, keeps the branch (best-effort push, no land/PR)", async () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Save for later"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(pushAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1"); // remote backup
    expect(landAgentBranch).not.toHaveBeenCalled();
    expect(openAgentPr).not.toHaveBeenCalled();
  });

  // ── roborev 54225-1: the HUMAN path must report the same truth the concierge path does ─────────
  // shipAgent returns a discriminated ShipOutcome; the sidebar used to discard it and tear the agent
  // down unconditionally, so a failed land or a failed `gh` looked exactly like a shipped PR — the
  // tab and worktree vanished with nothing landed, no PR, and the bead untouched.
  it("Ship: a failed local land (no remote) KEEPS the agent and says nothing landed", async () => {
    buildAgentProject();
    pushAgentBranch.mockResolvedValue("no-remote"); // → local land fallback
    landAgentBranch.mockResolvedValue({ ok: false, reason: "conflict", files: ["src/a.ts"] });
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(screen.getByText(/couldn.t ship/i)).toBeTruthy());
    expect(screen.getByText(/conflict/)).toBeTruthy();
    // The whole point: the row is still there, exactly as the concierge's refusal leaves it.
    expect(agentsNow()).toContain("a1");
    expect(removeAgentWorkspace).not.toHaveBeenCalled();
  });

  it("Ship: a pushed branch whose PR failed tears down BUT says no pull request was opened", async () => {
    buildAgentProject();
    openAgentPr.mockRejectedValue(new Error("gh: not authenticated"));
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    // The branch IS safe on the remote, so tearing down loses nothing — but the human must not be
    // left believing a review is open.
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(screen.getByText(/no pull request was opened/i)).toBeTruthy();
    expect(screen.getByText(/not authenticated/)).toBeTruthy();
  });

  it("Ship: a clean PR reports nothing at all — the success path stays silent", async () => {
    buildAgentProject();
    openClosePrompt();
    fireEvent.click(screen.getByText("Ship it"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(screen.queryByText(/couldn.t ship/i)).toBeNull();
    expect(screen.queryByText(/no pull request was opened/i)).toBeNull();
  });

  it("Save: says so when the backup push never reached the remote", async () => {
    buildAgentProject();
    pushAgentBranch.mockRejectedValue(new Error("offline"));
    openClosePrompt();
    fireEvent.click(screen.getByText("Save for later"));
    // Save still succeeds — the branch and bead survive locally — but "backed up" is not claimed.
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(screen.getByText(/wasn.t backed up/i)).toBeTruthy();
    expect(screen.getByText(/offline/)).toBeTruthy();
  });

  it("Discard requires a confirm, then deletes worktree + branch + bead and never lands", async () => {
    buildAgentProject("bd-1");
    openClosePrompt();
    fireEvent.click(screen.getByText("Discard")); // opens the confirm step — nothing destroyed yet
    expect(agentsNow()).toContain("a1");
    fireEvent.click(screen.getByText("Delete permanently"));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(removeAgentWorkspace).toHaveBeenCalled();
    expect(deleteAgentBranch).toHaveBeenCalledWith("/tmp/demo", "a1");
    await waitFor(() => expect(deleteBead).toHaveBeenCalledWith("/tmp/demo", "bd-1"));
    expect(landAgentBranch).not.toHaveBeenCalled();
    expect(openAgentPr).not.toHaveBeenCalled();
  });
});

describe("AgentSidebar — a LANDED agent needs the human's confirm (bead sparkle-0l9xk)", () => {
  /** A build agent whose work reached `merged`. Before this bead these rows were the ONE population
   *  that vanished on a single click: `shouldPromptOnClose` returned false for them and `×` read
   *  that as permission to tear down — no prompt, no retro check, no way to get the row back. */
  function landedProject(opts: { status?: Record<string, string> } = {}): Project {
    const project = buildAgentProject();
    useRuntimeStore.setState({
      branchStatus: {
        a1: { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 },
      },
      // STOPPED by default, but NOT load-bearing for the override any more: probe 8 gated the
      // action on `!canAnswer` and roborev 59423 reversed that — `canAnswer` is not a liveness
      // reading, so the gate left every landed row with no exit. The action is now always offered
      // and `status` selects the WORDING only. Do not re-add the suppression.
      status: opts.status ?? { a1: "stopped" },
      workflowStage: { a1: "merged" },
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    return project;
  }

  function clickClose() {
    const p = useProjectStore.getState().projects[0]!;
    useProjectStore.setState({ projects: [{ ...p, selectedAgentId: "a1" }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
    fireEvent.click(screen.getByLabelText("Close agent"));
  }

  it("does NOT remove the row on the click — it asks first", () => {
    // THE REGRESSION PROOF, at the surface the founder actually clicks. Against the pre-change code
    // this row was already gone by now, synchronously, with nothing on screen.
    landedProject();
    clickClose();
    expect(agentsNow()).toContain("a1");
    // The dialog is up and it names the missing retro — this agent has no receipt, so the ask is a
    // request rather than a recommendation.
    expect(screen.getByText(/without its retro\?$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
  });

  it("keeps the row when the human declines", () => {
    landedProject();
    clickClose();
    fireEvent.click(screen.getByText(/^keep it in the list/));
    expect(agentsNow()).toContain("a1");
  });

  // ── THE RECOMMENDATION HAS A SURFACE ON THE COLLAPSED ROW (roborev 59482) ──────────────────────
  // The merge that brought main in sent the WORDED pill to the expanded hover card, because main
  // had just stripped 18ch text pills off this row for width. Nothing pinned that move, so the
  // feature could have left the list entirely and the suite would have stayed green — which is
  // most of the way to what happened: the recommendation had no scannable surface at all, the very
  // gap the PRD says it exists to close. These two assert the wordless mark, in both directions.
  function renderRows() {
    const p = useProjectStore.getState().projects[0]!;
    useProjectStore.setState({ projects: [{ ...p, selectedAgentId: "a1" }] } as never);
    useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
    render(<AgentSidebar project={useProjectStore.getState().projects[0]!} />);
  }

  it("marks a LANDED row in the list itself — wordless, and it opens the same confirm", () => {
    landedProject();
    renderRows();
    const mark = screen.getByTestId("row-retire-mark");
    // Wordless is the whole reason it may live here: a text pill re-creates the collision main
    // just fixed. The words ride in the accessible name and the tooltip instead.
    expect(mark.textContent).toBe("");
    expect(mark.getAttribute("data-retire-state")).toBe("retro-pending");
    // Same gesture as the × and the pill — the mark's message is "this one is ready to go", so the
    // obvious click must be the thing it recommends.
    fireEvent.click(mark);
    expect(screen.getByText(/without its retro\?$/)).toBeTruthy();
    expect(agentsNow()).toContain("a1");
  });

  it("puts NO mark on a row whose work has not landed", () => {
    // `buildAgentProject` is ahead:1 → building_saved. A mark on every row is chrome, not signal.
    buildAgentProject();
    renderRows();
    expect(screen.queryByTestId("row-retire-mark")).toBeNull();
  });

  it("the mark is OPERABLE from the keyboard, not merely announced as a button", () => {
    // roborev 59545. It carried `role="button"` with an `onClick` and nothing else — no tab stop
    // and no key handler — so a screen-reader or keyboard user heard a control they could not
    // press. That is the whole feature for them: the worded pill lives on the HOVER card, and a
    // hover is not a keyboard gesture. Both sibling marks on this row (goal chip, notice marks)
    // already carry the tabIndex+onKeyDown trio; this one was the odd one out.
    landedProject();
    renderRows();
    const mark = screen.getByTestId("row-retire-mark");
    expect(mark.getAttribute("tabindex")).toBe("0");
    // The SIDE EFFECT, not the attribute: Enter must open the same confirm the click opens.
    fireEvent.keyDown(mark, { key: "Enter" });
    expect(screen.getByText(/without its retro\?$/)).toBeTruthy();
    expect(agentsNow()).toContain("a1");
  });

  it("marks a row whose retro IS on file as ready, in accent ink and in its accessible name", () => {
    // The `ready` half had no coverage at all — both existing mark tests drive `retro-pending`, so
    // the branch that paints the recommendation the founder actually asked for ("done, landed, and
    // logged") was unasserted in either direction.
    cachedReceipt.mockReturnValue({ state: "captured", at: 1, source: "pr-marker", tldr: "did it" });
    landedProject();
    renderRows();
    const mark = screen.getByTestId("row-retire-mark");
    expect(mark.getAttribute("data-retire-state")).toBe("ready");
    // The words the wordless glyph drops have to survive SOMEWHERE, and this is the only place they
    // can: `RETIRE_COPY` is the single source both surfaces read, so a drifted edit fails here.
    expect(mark.getAttribute("aria-label")).toBe("Ready to retire");
    expect(mark.getAttribute("title")).toMatch(/its retro step is on file/);
  });

  it("says something TRUE about an EXCUSED row — the state that has no logged feedback at all", () => {
    // roborev 59693. `retirementPill` returns `ready` for ANY receipt (`retroSettled` is
    // `receipt != null`, it never reads `state`), so this same sentence paints a row whose agent
    // reported it has NO retro. The copy claimed "its feedback is logged", which sends the founder
    // looking for a bead that was never filed — a false-settled reading in the one direction
    // retroReceipts is otherwise fail-closed against.
    cachedReceipt.mockReturnValue({
      state: "excused",
      at: 1,
      source: "agent-declared",
      reasonCode: "absorbed",
      reasonText: "folded into the orchestrator's branch and reported there",
    });
    landedProject();
    renderRows();
    const mark = screen.getByTestId("row-retire-mark");
    expect(mark.getAttribute("data-retire-state")).toBe("ready");
    // The claim that was false here, named so a revert cannot pass quietly.
    expect(mark.getAttribute("title")).not.toMatch(/feedback is logged/);
    expect(mark.getAttribute("title")).toMatch(/its retro step is on file/);
  });

  it("does not tell the founder an EXCUSED agent logged feedback — in the DIALOG, where he reads it", () => {
    // roborev 59891. The tooltip fix above left the identical false sentence standing on the more
    // prominent surface: `RetireAgentConfirm` gated its settled lede on `settled` (= `receipt !=
    // null`, state-blind, same defect one layer up) and said "its feedback is logged". For an
    // `excused` receipt — the ONLY state with a live production writer today — that modal then
    // contradicted itself four lines later with "It gave no retro, and said why:" plus the agent's
    // own excuse. Both sentences, one screen.
    cachedReceipt.mockReturnValue({
      state: "excused",
      at: 1,
      source: "agent-declared",
      reasonCode: "absorbed",
      reasonText: "folded into the orchestrator's branch and reported there",
    });
    landedProject();
    renderRows();
    fireEvent.click(screen.getByTestId("row-retire-mark"));
    // The confirm is up…
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    // …and it does NOT make the claim. Asserted as the negative of the exact false sentence, so a
    // revert to the `settled`-keyed copy cannot pass quietly.
    expect(document.body.textContent).not.toMatch(/feedback is logged/);
    // What it says instead, and the excuse it is consistent with — both, so this cannot pass by the
    // dialog having failed to render at all.
    expect(document.body.textContent).toMatch(/recorded why it has no retro to file/);
    expect(document.body.textContent).toMatch(/It gave no retro, and said why/);
  });

  it("still says SOMETHING for a state this build has never heard of", () => {
    // roborev 59893. The union is compile-time only: retro_receipt.rs types `state` as a String on
    // purpose, so a receipt written by a NEWER frontend deserializes rather than being dropped, and
    // the TS read path casts without validating. A fourth state therefore reaches the map, misses,
    // and — before the fallback — rendered the settled paragraph with NO lede: a leading space, then
    // "Retiring removes the row…". Missing copy is the worst outcome here, because the button under
    // it is irreversible.
    cachedReceipt.mockReturnValue({
      state: "vouched" as never,
      at: 1,
      source: "pr-marker",
    } as never);
    landedProject();
    renderRows();
    fireEvent.click(screen.getByTestId("row-retire-mark"));
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    // A sentence that is true of EVERY settled receipt, and no lede-shaped hole in front of it.
    expect(document.body.textContent).toMatch(/its retro step is on file\. Retiring removes/);
  });

  it("DOES say feedback is logged for a CAPTURED one — the control for the sentence above", () => {
    // Without this, deleting the claim everywhere would pass the test above, and the one state where
    // "its feedback is logged" is TRUE would lose the only wording that says so.
    cachedReceipt.mockReturnValue({ state: "captured", at: 1, source: "pr-marker", tldr: "did it" });
    landedProject();
    renderRows();
    fireEvent.click(screen.getByTestId("row-retire-mark"));
    expect(document.body.textContent).toMatch(/its feedback is logged/);
  });

  it("puts the mark OUTSIDE the box that clips — the one surface it has cannot be cut off", () => {
    // roborev 59785. The merge that brought main in dropped this mark inside the name-and-chips box
    // main had just given `overflow: hidden` + `minWidth: 0` — the box flexbox shrinks FIRST, whose
    // trailing children are silently cut off. `clusterMarkCount` counts only notice marks and the
    // goal, so the notice collapse can never buy space for this one either. The row's own measured
    // budget makes that certain rather than theoretical: `row-narrow-probe` read the worst 220px row
    // (the width the app opens at) at 182 of 183px WITHOUT it.
    //
    // jsdom has no layout engine, so no test can render this row narrow and watch it disappear —
    // `columnWidth` is measured and reads 0 here forever. The defect is STRUCTURAL, so this asserts
    // the structure: the mark must not live inside the shrinking box. FAILS against the merge's
    // placement, where it was a child of exactly that box.
    landedProject();
    renderRows();
    const mark = screen.getByTestId("row-retire-mark");
    const clipped = screen.getByTestId("row-agent-name").parentElement!;
    // The box really is the shrinking, clipping one — without this the assertion below could pass
    // for the boring reason that the DOM was reshaped and it is now some other container.
    expect(clipped.style.overflow).toBe("hidden");
    expect(clipped.style.minWidth).toBe("0");
    // …and the mark is not in it.
    expect(clipped.contains(mark)).toBe(false);
  });

  it("keeps the WORDED pill on the expanded card, reading the same source as the mark", () => {
    // roborev 59693: `row-retire-pill` had zero coverage, so the surface that carries the actual
    // words could have been dropped by the next merge with a green suite — which is exactly how it
    // was lost once already. The pill is the expanded card's copy of the recommendation; the mark is
    // the collapsed row's. Both must be present, and both must say the same thing.
    cachedReceipt.mockReturnValue({ state: "captured", at: 1, source: "pr-marker", tldr: "did it" });
    landedProject();
    renderRows();
    // The pill lives on the hover card, which is portalled and only mounts once the card is open —
    // so it is absent from the scannable list by construction. That absence is exactly why the mark
    // exists, and why this surface needs its own test rather than a shared one.
    expect(screen.queryByTestId("row-retire-pill")).toBeNull();
    fireEvent.contextMenu(screen.getByText("Build 1"));
    const pill = screen.getByTestId("row-retire-pill");
    expect(pill.getAttribute("data-retire-state")).toBe("ready");
    // WORDED is the point of this surface — the mark deliberately has none.
    expect(pill.textContent).toBe("READY TO RETIRE");
    // ONE source for the sentence: a drifted edit on either surface breaks this equality.
    expect(pill.getAttribute("title")).toBe(
      screen.getByTestId("row-retire-mark").getAttribute("title"),
    );
    // And it opens the same confirm as the mark and the ×.
    fireEvent.click(pill);
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    expect(agentsNow()).toContain("a1");
  });

  it("ALWAYS offers an exit when the status is UNKNOWN — the normal case after a relaunch", () => {
    // roborev 59423, reversing my own probe-8 fix. `canAnswerRetroPing(undefined)` is TRUE by
    // design (fail-closed toward asking) and `runtimeStore.status` is written only by a mounted
    // AgentPane — so every landed row read as "still being asked" and was offered nothing but
    // keep-it. With no `captured` producer yet, that was EVERY landed row: no way out of the list.
    landedProject({ status: {} });
    clickClose();
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    // AND IT SAYS WHAT THE BUTTON WRITES. The gap note used to be gated on `!canAnswer` alongside
    // the button; restoring the button without moving that gate would have left "record the gap"
    // unexplained in precisely this case — the one the reversal made normal.
    expect(screen.getByTestId("retire-gap-note").textContent).toMatch(/no retro was on file/);
  });

  it("blocks the retire on a DIRTY reading even when the file preview is absent", () => {
    // `dirtyFiles === undefined` means "this build cannot tell you", NOT "no files" (roborev
    // 59423). Gating on the preview restored the button and force-removed the worktree — the exact
    // data-loss path probe 1 exists to close.
    buildAgentProject();
    useRuntimeStore.setState({
      branchStatus: {
        a1: { ahead: 0, behind: 0, dirty: true, filesChanged: 3, insertions: 0, deletions: 0 },
      },
      status: { a1: "stopped" },
      workflowStage: { a1: "merged" },
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    clickClose();
    expect(screen.queryByRole("button", { name: /^Retire/ })).toBeNull();
    expect(agentsNow()).toContain("a1");
    // AND THE COPY GOES WITH THE BUTTON (roborev 59545). The gap note explains what the retire
    // button WRITES, so with no button on the dialog it is describing an action nobody is being
    // offered — "Retiring now records a note…" printed directly under "Commit or discard them
    // first; the row stays until you do", with cancel as the only control. Widening its gate from
    // `!settled && !canAnswer` to `!settled` opened this hole in the mirror direction; it is keyed
    // on the button's own `!hasUncommitted` now, so neither gap can reopen without the other.
    expect(screen.queryByTestId("retire-gap-note")).toBeNull();
  });

  it("names the capped preview and says how many more it could not name", () => {
    buildAgentProject();
    useRuntimeStore.setState({
      branchStatus: {
        a1: {
          ahead: 0,
          behind: 0,
          dirty: true,
          filesChanged: 12,
          insertions: 0,
          deletions: 0,
          dirtyFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
          dirtyCount: 12,
        },
      },
      status: { a1: "stopped" },
      workflowStage: { a1: "merged" },
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    clickClose();
    // Without this the founder commits the five he was shown, retries, and is blocked again by
    // seven the dialog never mentioned.
    expect(screen.getByTestId("retire-uncommitted-block").textContent).toContain("+7 more");
  });

  it("still keeps the row when the agent can be asked, but no longer hides the exit", () => {
    // The dialog still opens — the row must never vanish on a click — but the only action is to
    // keep it. The Pusher is already pinging the agent; the honest move is to let the receipt
    // arrive, not to record a permanent "could not be asked" about an agent that can.
    landedProject({ status: { a1: "working" } });
    clickClose();
    expect(agentsNow()).toContain("a1");
    // The dialog SAYS the agent may answer, and still lets him finish — the two are not in tension.
    expect(screen.getByRole("button", { name: /^Retire/ })).toBeTruthy();
    expect(screen.getByText(/may still be reachable/)).toBeTruthy();
  });

  // ── THE FALSE-MARK GATE (bead `sparkle-y2p4f`) ──────────────────────────────────────────────
  // The founder was offered "Retire anyway — record the gap" for an agent whose own row showed a
  // FEEDBACK 2 pill. These pin the WRITER, not only the copy: the receipt is permanent — there is
  // no delete path for one anywhere in the app — so the fact that matters is that none is written.
  // 19 of the 29 receipts on disk when this was fixed were false marks of exactly this shape.
  function seedFeedbackBeads(n: number) {
    useBeadsStore.setState({
      byProject: {
        p1: {
          beads: Array.from({ length: n }, (_, i) => ({
            id: `b${i}`,
            labels: ["agent-feedback", "agent:a1"],
          })),
          board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [] },
          loadedAt: Date.now(),
        },
      },
    } as never);
    __setBeadsPolledAtForTest("p1", Date.now());
  }

  it("writes NO gap receipt against an agent that filed feedback", async () => {
    seedFeedbackBeads(2);
    landedProject();
    clickClose();
    expect(screen.queryByText(/nothing has been recorded/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Retire it$/ }));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(recordRetroOverridden).not.toHaveBeenCalled();
  });

  it("credits that agent with the SAME count its row pill shows", () => {
    // The two surfaces reading one predicate is the actual fix; a differing number would be the
    // same contradiction with better manners.
    seedFeedbackBeads(2);
    landedProject();
    clickClose();
    expect(screen.getByTestId("retire-feedback-credit").textContent).toMatch(/\b2\b/);
  });

  it("writes NO gap receipt when the backlog could not be read at all", async () => {
    // Absence of evidence. The beads store is shared and routinely starved, so this is the normal
    // failure — and it must not be able to mint an accusation.
    useBeadsStore.setState({ byProject: {} } as never);
    __setBeadsPolledAtForTest("p1", undefined);
    landedProject();
    clickClose();
    expect(screen.queryByText(/nothing has been recorded/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Retire it$/ }));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(recordRetroOverridden).not.toHaveBeenCalled();
  });

  it("STILL writes the gap receipt when the agent genuinely reported nothing", async () => {
    // THE PAIRED POSITIVE, and it is the load-bearing one. Without it every assertion above is
    // satisfied by a writer that no longer fires at all — the feature would be silently dead and
    // the suite would still be green. `beforeEach` seeds a fresh, successfully-read, empty backlog,
    // which is the one state that earns the mark.
    landedProject();
    clickClose();
    expect(screen.getByText(/nothing has been recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /record the gap/ }));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(recordRetroOverridden).toHaveBeenCalledTimes(1);
  });

  it("writes NO gap receipt when the backlog turns readable AFTER the dialog opened", async () => {
    // ── THE RE-READ MAY ONLY CANCEL A WRITE, NEVER INTRODUCE ONE (roborev, on this commit) ───────
    // `confirmRetire` re-reads the standing at click time — correct, since the modal sits open
    // across polls. But the beads read is UNSUBSCRIBED, and the `unknown`→`absent` transition can
    // be freshness-only (an unchanged poll advances the module-scope `polledAt` and deliberately
    // leaves `byProject` identical), so no re-render is owed and none happens. That is exactly what
    // this case reproduces: the dialog is showing "I won't record anything against this agent"
    // under a plain "Retire it" while the fresh read has already become `absent`.
    //
    // Taking the fresh answer alone writes the permanent, undeletable gap receipt that copy just
    // ruled out. The button's own promise is the ceiling.
    useBeadsStore.setState({ byProject: {} } as never);
    __setBeadsPolledAtForTest("p1", undefined);
    landedProject();
    clickClose();
    // What the human is looking at, and the button they are about to press.
    expect(screen.getByTestId("retire-unknown-note")).toBeTruthy();
    const retire = screen.getByRole("button", { name: /^Retire it$/ });

    // The poll lands. NOT wrapped in `act`, and not followed by a re-render: the whole point is
    // that React is owed no update here, so the dialog on screen is now out of date.
    useBeadsStore.setState({
      byProject: {
        p1: {
          beads: [],
          board: { backlog: [], blocked: [], inProgress: [], done: [], delivered: [] },
          loadedAt: Date.now(),
        },
      },
    } as never);
    __setBeadsPolledAtForTest("p1", Date.now());

    fireEvent.click(retire);
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
    expect(recordRetroOverridden).not.toHaveBeenCalled();
  });

  it("BLOCKS the retire while the worktree holds uncommitted files (knightwatch probe 1)", () => {
    // Landed work is safe; the worktree's post-merge edits are not, and teardown force-removes it.
    // The dialog names the files and withdraws the action rather than destroying them behind a
    // sentence that says the work landed.
    buildAgentProject();
    useRuntimeStore.setState({
      branchStatus: {
        a1: {
          ahead: 0,
          behind: 0,
          dirty: true,
          filesChanged: 1,
          insertions: 0,
          deletions: 0,
          dirtyFiles: ["src/notes.ts"],
        },
      },
      status: { a1: "stopped" },
      workflowStage: { a1: "merged" },
      pollBranchStatus: vi.fn(() => Promise.resolve()),
    } as never);
    clickClose();
    expect(screen.getByTestId("retire-uncommitted-block").textContent).toContain("src/notes.ts");
    expect(screen.queryByRole("button", { name: /^Retire/ })).toBeNull();
    expect(agentsNow()).toContain("a1");
  });

  it("removes the row only after the human confirms", async () => {
    landedProject();
    clickClose();
    fireEvent.click(screen.getByRole("button", { name: /^Retire/ }));
    await waitFor(() => expect(agentsNow()).not.toContain("a1"));
  });

  it("does not offer Ship/Save/Discard — nothing is at risk, so it is not that question", () => {
    // The two dialogs answer different questions. Showing the work-at-risk choice for landed work
    // would tell the founder his merged work might be lost, which is false and alarming.
    landedProject();
    clickClose();
    expect(screen.queryByText("Ship it")).toBeNull();
    expect(screen.queryByText("Save for later")).toBeNull();
    expect(screen.queryByText("Discard")).toBeNull();
  });
});
