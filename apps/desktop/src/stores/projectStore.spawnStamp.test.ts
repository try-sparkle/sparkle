// `AgentTab.createdAt` — the spawn stamp.
//
// The field was DECLARED in types.ts (documented for mergePreservingLiveWorkers' eviction shield)
// but never actually written by any code path, so every agent read as `createdAt: undefined` and
// anything keying off it was silently inert. engine/newAgentAttention needs a real spawn time to
// answer "is this agent fresh?" for its 5-minute backstop, and an always-undefined field answers
// "no" forever — the whole rule would have been dead on arrival with nothing failing.
//
// So these tests exist to keep the field WRITTEN. They assert the stamp is present and plausible at
// both creation sites, not that it equals a particular instant.
import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";

const agentIn = (pid: string, id: string) =>
  useProjectStore
    .getState()
    .projects.find((p) => p.id === pid)
    ?.agents.find((a) => a.id === id);

describe("AgentTab.createdAt is stamped at spawn", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
  });

  it("addAgent stamps a spawn time", () => {
    const before = Date.now();
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    const after = Date.now();

    const createdAt = agentIn(pid, id)?.createdAt;
    expect(createdAt).toBeTypeOf("number");
    expect(createdAt!).toBeGreaterThanOrEqual(before);
    expect(createdAt!).toBeLessThanOrEqual(after);
  });

  it("stamps workers too — a worker is spawned like any other agent", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const parent = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    const worker = useProjectStore
      .getState()
      .addAgent(pid, { kind: "worker", parentId: parent, task: "fix the parser", select: false })!;

    expect(agentIn(pid, worker)?.createdAt).toBeTypeOf("number");
  });

  // adoptWorker is NOT a spawn. It is the disk-reconcile self-heal: a worker whose PROCESS is
  // already running (possibly for hours, possibly from before a restart) gets its row rebuilt from
  // the manifest. Minting a fresh stamp there would hand an hours-old, genuinely errored worker a
  // brand-new 5-minute suppression window — and, since the manifest's `task` is optional, a
  // task-less re-adopted worker would also read as briefless and have its `blocked` permanently
  // rewritten to `new`. That directly contradicts "no red can be retroactively calmed across a
  // restart", which is the guarantee the whole design rests on. Leaving the field undefined makes
  // the age UNKNOWN, and unknown is deliberately treated as old. (roborev 54696)
  it("does NOT stamp a re-adopted worker — its process is already running, this is not a spawn", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const parent = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    useProjectStore.getState().adoptWorker(pid, {
      id: "w-readopted",
      parentId: parent,
      branch: "sparkle/w",
      worktreePath: "/tmp/wt",
    });

    expect(agentIn(pid, "w-readopted")).toBeDefined();
    expect(agentIn(pid, "w-readopted")?.createdAt).toBeUndefined();
  });

  it("stamps a later agent no earlier than an earlier one (monotonic within a session)", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const first = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    const second = useProjectStore.getState().addAgent(pid, { kind: "build" })!;

    expect(agentIn(pid, second)!.createdAt!).toBeGreaterThanOrEqual(
      agentIn(pid, first)!.createdAt!,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// `AgentTab.terminalBriefedAt` — the DURABLE half of route 4 (roborev 54771, tested per 54849).
//
// The same failure mode as `createdAt` above, one level up: the field is only useful if something
// WRITES it, and every assertion in newAgentAttention.durable.test.ts hands the predicate an object
// with the stamp already set. Nothing there would notice if `noteTerminalBrief` stopped working, or
// if its write-once guard were deleted — and that guard is load-bearing, not tidiness: this action
// fires per submitted line, so without it every Enter mints a fresh `projects` array, which is a
// debounced persist write and a fleet-wide re-render per keystroke line.
describe("AgentTab.terminalBriefedAt — stamped once, by the terminal", () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
  });

  const spawn = () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    return { pid, id };
  };

  it("is unset on a fresh agent — the stamp must mean something", () => {
    const { pid, id } = spawn();
    expect(agentIn(pid, id)?.terminalBriefedAt).toBeUndefined();
  });

  it("stamps the agent a submitted line belongs to", () => {
    const { pid, id } = spawn();
    const before = Date.now();
    useProjectStore.getState().noteTerminalBrief(pid, id);
    const after = Date.now();

    const at = agentIn(pid, id)?.terminalBriefedAt;
    expect(at).toBeTypeOf("number");
    expect(at!).toBeGreaterThanOrEqual(before);
    expect(at!).toBeLessThanOrEqual(after);
  });

  it("WRITE-ONCE: a second line neither moves the stamp nor churns the store", () => {
    const { pid, id } = spawn();
    useProjectStore.getState().noteTerminalBrief(pid, id);
    const first = agentIn(pid, id)!.terminalBriefedAt;
    const projectsRef = useProjectStore.getState().projects;

    useProjectStore.getState().noteTerminalBrief(pid, id);
    useProjectStore.getState().noteTerminalBrief(pid, id);

    expect(agentIn(pid, id)!.terminalBriefedAt).toBe(first);
    // IDENTITY, not equality: a new array here is a persist write and a re-render, per Enter.
    expect(useProjectStore.getState().projects).toBe(projectsRef);
  });

  it("leaves every other agent alone", () => {
    const { pid, id } = spawn();
    const other = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
    useProjectStore.getState().noteTerminalBrief(pid, id);

    expect(agentIn(pid, id)?.terminalBriefedAt).toBeTypeOf("number");
    expect(agentIn(pid, other)?.terminalBriefedAt).toBeUndefined();
  });

  it("no-ops on an unknown project or agent instead of throwing", () => {
    const { pid, id } = spawn();
    expect(() => useProjectStore.getState().noteTerminalBrief("nope", id)).not.toThrow();
    expect(() => useProjectStore.getState().noteTerminalBrief(pid, "nope")).not.toThrow();
    expect(agentIn(pid, id)?.terminalBriefedAt).toBeUndefined();
  });
});
