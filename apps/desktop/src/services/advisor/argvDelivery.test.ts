// THE FINDINGS MUST REACH THE LAUNCH ARGV — asserted through the REAL delivery path.
//
// ══ WHY THIS TEST IS SHAPED THE WAY IT IS ═══════════════════════════════════════════════════════
//
// "The findings were written somewhere" is not the property that matters. `sendToBuild`'s own header
// records the measured failure: a store write DELIVERS NOTHING. `briefForLaunch` reads
// `agentBrief`'s held map and nothing else, so an earlier version that only called `appendPrompt`
// left TWELVE orchestrators exec'd with no prompt at all, and six epics spent their one-shot
// sweep-restart budget on an agent that was never told anything.
//
// So this test asserts against `briefForLaunch` — the function the pane actually calls to build
// claude's argv — rather than against `attachBrief` having been invoked or `appendPrompt` having
// been given the right string. `services/agentBrief` is deliberately left REAL for that reason: it
// IS the channel under test, and mocking it would leave the assertion measuring the mock.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { briefForLaunch, resetAgentBriefs } from "../agentBrief";
import { holdVerdict, resetHeldVerdicts } from "./findings";

const addAgentMock = vi.fn(() => "agent-1");
const appendPromptMock = vi.fn();
let projects: Array<{ id: string; rootPath: string; agents: unknown[] }> = [];

vi.mock("../../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects,
      addAgent: addAgentMock,
      appendPrompt: appendPromptMock,
      setAgentEpicId: vi.fn(),
      setAgentBeadId: vi.fn(),
      selectAgent: vi.fn(),
    }),
  },
}));
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: { getState: () => ({ open: vi.fn(), status: {}, openAgentIds: [] }) },
}));
vi.mock("../beads", async (orig) => ({
  ...(await orig<typeof import("../beads")>()),
  labelBead: vi.fn(async () => {}),
}));
vi.mock("../agentMount", async (orig) => ({
  ...(await orig<typeof import("../agentMount")>()),
  mountAgent: vi.fn(() => "opened"),
  mounted: vi.fn(() => true),
}));
vi.mock("../landInAgent", () => ({ landInAgent: vi.fn() }));
// The HOOK is mocked (it would reach Tauri); `advisorBriefFor` — the synchronous fold this test is
// about — is left REAL. Mocking the whole module would make the assertion measure nothing.
vi.mock("./index", async (orig) => ({
  ...(await orig<typeof import("./index")>()),
  advisorHandoffHook: vi.fn(async () => {}),
}));

// Imported AFTER the mocks, like every other suite in this directory.
const { sendToBuild } = await import("../sendToBuild");

beforeEach(() => {
  resetAgentBriefs();
  resetHeldVerdicts();
  addAgentMock.mockClear();
  projects = [{ id: "proj", rootPath: "/repo", agents: [] }];
});

describe("advisor findings on the launch argv", () => {
  it("reach briefForLaunch — the string a FRESH launch puts in claude's argv", () => {
    holdVerdict("sparkle-epic1", {
      model: "claude-opus-5",
      taskId: "task-7",
      findings: [
        {
          lens: "collision",
          severity: "high",
          summary: "PR #2130 already changes sendToBuild.ts",
          evidence: "pr-file-overlap.sh sendToBuild -> exit 10",
        },
      ],
    });

    const agentId = sendToBuild({
      projectId: "proj",
      epicId: "sparkle-epic1",
      prdPath: "PRD/x.md",
      reveal: false,
    });

    // THE ASSERTION. `resume: false` is the fresh-launch case — the only one that emits a positional
    // prompt, and the only channel that cannot lose the submit.
    const argv = briefForLaunch(agentId, false);
    expect(argv).toBeDefined();
    expect(argv).toContain("ADVISOR FINDINGS");
    expect(argv).toContain("PR #2130 already changes sendToBuild.ts");
    expect(argv).toContain("pr-file-overlap.sh sendToBuild -> exit 10");
    expect(argv).toContain("claude-opus-5");
    // …and the MISSION is still there. A findings block that displaced the seed would be a far worse
    // regression than a missing one.
    expect(argv).toContain("Build epic sparkle-epic1");
    expect(argv).toContain("PRD/x.md");
  });

  it("paints NOTHING when no verdict is held — the plan reaches the argv UNCHANGED", () => {
    // The failure contract, at the delivery layer: an advisor that could not run leaves no finding,
    // no reassurance, and no implied pass. This is the branch a happy-path-only test would miss, and
    // it is the common case (every first handoff).
    const agentId = sendToBuild({
      projectId: "proj",
      epicId: "sparkle-epic2",
      prdPath: "PRD/y.md",
      reveal: false,
    });
    const argv = briefForLaunch(agentId, false);
    expect(argv).toContain("Build epic sparkle-epic2");
    expect(argv).not.toContain("ADVISOR");
    expect(argv).not.toMatch(/advisor/i);
  });

  it("paints nothing for a verdict that RAN and raised nothing", () => {
    // "The advisor ran and found nothing" is recorded ON THE BEAD, attributable to a named model and
    // a task id. It is deliberately not put in front of the orchestrator: it is not information it
    // can act on, and a header saying a second model reviewed the plan is one step from reading as
    // approval.
    holdVerdict("sparkle-epic3", { model: "claude-opus-5", taskId: "t", findings: [] });
    const agentId = sendToBuild({
      projectId: "proj",
      epicId: "sparkle-epic3",
      prdPath: null,
      reveal: false,
    });
    expect(briefForLaunch(agentId, false)).not.toContain("ADVISOR FINDINGS");
  });

  it("returns undefined on a RESUME, so the findings cannot be re-emitted every reopen", () => {
    holdVerdict("sparkle-epic4", {
      model: "claude-opus-5",
      taskId: "t",
      findings: [{ lens: "scope", severity: "low", summary: "s" }],
    });
    const agentId = sendToBuild({
      projectId: "proj",
      epicId: "sparkle-epic4",
      prdPath: null,
      reveal: false,
    });
    // BOTH DIRECTIONS IN ONE TEST, and that is the point rather than thoroughness. `undefined` is
    // what this returns for an agent with NO brief held at all, so asserting only the resume case
    // passes just as cleanly against a broken attach — the failure would be invisible. The fresh
    // read proves a brief IS held; the resume read proves it is withheld on purpose.
    expect(briefForLaunch(agentId, true)).toBeUndefined();
    expect(briefForLaunch(agentId, false)).toContain("ADVISOR FINDINGS");
  });
});
