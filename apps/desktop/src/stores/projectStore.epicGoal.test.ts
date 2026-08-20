import { beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "./projectStore";
import type { Project } from "../types";

const OK = "every epic on the board shows a goal a human can read";
const OTHER = "the planning board opens and closes without a mode toggle";

function seed() {
  const project: Project = {
    id: "p1",
    name: "P",
    rootPath: "/tmp/p",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [
      {
        id: "a1",
        name: "A1",
        kind: "build",
        parentId: null,
        runtime: "local",
        worktreePath: null,
        branch: null,
        baseBranch: null,
        lastPrompt: "",
        promptHistory: [],
        namePinned: false,
        autoNameBasis: null,
        autoNameVariants: null,
        shellCommand: null,
      },
    ],
  };
  useProjectStore.setState({ projects: [project] } as never);
}

const goalOf = (epicId = "e1") =>
  useProjectStore.getState().projects.find((p) => p.id === "p1")?.epicGoals?.[epicId];

beforeEach(seed);

describe("setEpicGoal", () => {
  it("writes the text and the source", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "auto");
    expect(goalOf()).toMatchObject({ text: OK, source: "auto" });
    expect(goalOf()?.humanEditedAt).toBeUndefined();
  });

  it("a HUMAN write stamps the latch", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "human");
    expect(goalOf()?.humanEditedAt).toEqual(expect.any(Number));
  });

  it("narrows a `landed` check to `human` — an epic has no branch to prove ancestry against", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "human", { kind: "landed" });
    expect(goalOf()?.verify).toEqual({ kind: "human" });
  });

  it("writes NOTHING for text nobody could act on, rather than storing it", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", "tiny", "auto");
    expect(goalOf()).toBeUndefined();
  });

  it("keeps epics independent", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "human");
    useProjectStore.getState().setEpicGoal("p1", "e2", OTHER, "auto");
    expect(goalOf("e1")?.text).toBe(OK);
    expect(goalOf("e2")?.text).toBe(OTHER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE LATCH. The founder's first constraint on auto-generation is that a human edit must
// PERMANENTLY stop regeneration — silently overwriting his wording is what would make him stop
// trusting the field. Every route back to a machine write is asserted CLOSED here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("setEpicGoal — the human latch has no back door", () => {
  it("CLEARING a human goal does not un-latch it", () => {
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "human");
    s.setEpicGoal("p1", "e1", "", "human");
    expect(goalOf()?.text).toBe("");
    expect(goalOf()?.humanEditedAt).toEqual(expect.any(Number));
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
  });

  it("a later AUTO write cannot launder the latch away", () => {
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "human");
    const latched = goalOf()?.humanEditedAt;
    s.setEpicGoal("p1", "e1", OTHER, "auto");
    expect(goalOf()?.text).toBe(OTHER);
    expect(goalOf()?.humanEditedAt).toBe(latched);
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
  });

  it("a FAILED generation erases NEITHER the latch NOR his text", () => {
    // roborev 65849. This test used to assert `text === ""`, i.e. it pinned the DEFECT as intent —
    // a failed FORCE regenerate blanking the goal a person had asked to regenerate. The failure is
    // now recorded BESIDE the goal; the reader still learns generation produced nothing, and the
    // wording survives.
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "human");
    const latched = goalOf()?.humanEditedAt;
    s.noteEpicGoalFailure("p1", "e1", "the model call timed out");
    expect(goalOf()?.text).toBe(OK);
    expect(goalOf()?.humanEditedAt).toBe(latched);
    expect(goalOf()?.generationFailureReason).toBe("the model call timed out");
  });

  it("…and over an epic with NO goal, a failure still leaves no text to read", () => {
    useProjectStore.getState().noteEpicGoalFailure("p1", "e2", "timed out");
    expect(goalOf("e2")?.text).toBe("");
    expect(goalOf("e2")?.generationFailedAt).toEqual(expect.any(Number));
  });

  it("a HUMAN clearing an AUTO goal DOES latch — otherwise the generator writes it straight back", () => {
    // The case the suite could not see before: every other clear test wrote the goal as "human"
    // first, so `prior.humanEditedAt` was already set and the latch survived for the wrong reason.
    // Here the prior goal is the MACHINE's, carrying no latch — so this assertion can only pass if
    // the clear itself stamps one. It is also the case that matters most in use: he reads an
    // auto-written goal, decides it is wrong, and deletes it. If that did not latch, the next
    // generation would put it back and the delete would read as broken.
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "auto");
    expect(goalOf()?.humanEditedAt).toBeUndefined();
    s.setEpicGoal("p1", "e1", "", "human");
    expect(goalOf()?.text).toBe("");
    expect(goalOf()?.humanEditedAt).toEqual(expect.any(Number));
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
  });

  it("an AUTO clear of an AUTO goal drops the record and leaves the epic generatable", () => {
    // The paired direction, so the rule above cannot pass by latching every clear.
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "auto");
    s.setEpicGoal("p1", "e1", "", "auto");
    expect(goalOf()).toBeUndefined();
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(true);
  });

  it("a HUMAN clear of an epic with NO goal latches nothing — a no-op is not an opinion", () => {
    // roborev 65853, and this is the state the suite never mounted: every other clear test writes a
    // goal first, so a prior record always existed. Clearing a goal that EXISTS is a real opinion
    // and still latches (the test above); clearing nothing is not an opinion about anything.
    useProjectStore.getState().setEpicGoal("p1", "e1", "", "human");
    expect(goalOf()).toBeUndefined();
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(true);
  });

  it("clearing an epic NOBODY has edited drops the record entirely — no latch is invented", () => {
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "auto");
    s.setEpicGoal("p1", "e1", "", "auto");
    expect(goalOf()).toBeUndefined();
    // …and the machine may generate again, because no person has ever had an opinion here.
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(true);
  });
});

describe("mayGenerateEpicGoal", () => {
  it("is true for an epic with no record, false once it has usable text", () => {
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(true);
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "auto");
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
  });

  it("does not retry a failed generation on its own, but DOES under force", () => {
    useProjectStore.getState().noteEpicGoalFailure("p1", "e1", "timed out");
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1")).toBe(false);
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1", true)).toBe(true);
  });

  it("force beats even the human latch — an explicit ask is a person choosing to spend the call", () => {
    useProjectStore.getState().setEpicGoal("p1", "e1", OK, "human");
    expect(useProjectStore.getState().mayGenerateEpicGoal("p1", "e1", true)).toBe(true);
  });

  it("an unknown project reads as generatable rather than throwing", () => {
    expect(useProjectStore.getState().mayGenerateEpicGoal("nope", "e1")).toBe(true);
  });
});

describe("setEpicGoalMet", () => {
  it("marks and un-marks, and is a no-op for an epic with no goal", () => {
    const s = useProjectStore.getState();
    s.setEpicGoal("p1", "e1", OK, "human");
    s.setEpicGoalMet("p1", "e1", true);
    expect(goalOf()?.metAt).toEqual(expect.any(Number));
    useProjectStore.getState().setEpicGoalMet("p1", "e1", false);
    expect(goalOf()?.metAt).toBeUndefined();
    useProjectStore.getState().setEpicGoalMet("p1", "nope", true);
    expect(goalOf("nope")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// `markAgentGoalFromEpic` — the LINCHPIN of the orchestrator goal re-sync (roborev 65890).
//
// No marker means no re-sync, ever. Its only production caller is `services/sendToBuild`, whose
// suite replaces this whole store with a mock — so the write itself was covered by nothing, and
// every way of breaking it (inverting the guard, misspelling the field, dropping it in a refactor
// of `mapAgent`) left every suite green while re-sync was dead for good. The failure shape is
// SILENT ABSENCE — a stale sentence nobody notices — not an error.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("markAgentGoalFromEpic", () => {
  const agentGoal = () =>
    useProjectStore.getState().projects.find((p) => p.id === "p1")?.agents[0]?.goal;

  it("stamps the epic goal's setAt onto an EXISTING agent goal, leaving the goal itself intact", () => {
    const s = useProjectStore.getState();
    s.setAgentGoal("p1", "a1", OK);
    const before = agentGoal();
    useProjectStore.getState().markAgentGoalFromEpic("p1", "a1", 7);
    expect(agentGoal()?.fromEpicGoalAt).toBe(7);
    expect(agentGoal()?.text).toBe(before?.text);
    expect(agentGoal()?.setAt).toBe(before?.setAt);
  });

  it("MANUFACTURES NOTHING for an agent with no goal", () => {
    // The paired direction, and the safe one: a marker on a goal that does not exist would make the
    // re-sync rule read a goalless agent as a stale copy.
    useProjectStore.getState().markAgentGoalFromEpic("p1", "a1", 7);
    expect(agentGoal()).toBeUndefined();
  });

  it("is a no-op for an unknown project or agent rather than throwing", () => {
    expect(() => {
      useProjectStore.getState().markAgentGoalFromEpic("nope", "a1", 7);
      useProjectStore.getState().markAgentGoalFromEpic("p1", "nope", 7);
    }).not.toThrow();
  });

  it("a later mark REPLACES the earlier one — a re-sync re-stamps its own provenance", () => {
    const s = useProjectStore.getState();
    s.setAgentGoal("p1", "a1", OK);
    useProjectStore.getState().markAgentGoalFromEpic("p1", "a1", 7);
    useProjectStore.getState().markAgentGoalFromEpic("p1", "a1", 12);
    expect(agentGoal()?.fromEpicGoalAt).toBe(12);
  });
});
