import { describe, it, expect, vi, beforeEach } from "vitest";

const close = vi.fn();
const removeAgent = vi.fn();
const spinDownAgentGit = vi.fn().mockResolvedValue(undefined);
let deleteMergedBranch = true;

vi.mock("../stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        {
          id: "p1",
          rootPath: "/r",
          agents: [
            { id: "build1" },
            { id: "w1", parentId: "build1" },
            { id: "w2", parentId: "build1" },
            { id: "other" }, // a different build agent — must NOT be touched
            { id: "wOther", parentId: "other" },
          ],
        },
      ],
      removeAgent,
    }),
  },
}));
vi.mock("../stores/runtimeStore", () => ({ useRuntimeStore: { getState: () => ({ close }) } }));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: { getState: () => ({ deleteMergedBranch }) },
}));
vi.mock("./closeAgentActions", () => ({ spinDownAgentGit: (...a: unknown[]) => spinDownAgentGit(...a) }));

import { closeBuildAgent } from "./closeBuildAgent";

beforeEach(() => {
  vi.clearAllMocks();
  deleteMergedBranch = true;
});

describe("closeBuildAgent", () => {
  it("closes the build agent + only its workers, git-teardown per setting, removeAgent last", async () => {
    const order: string[] = [];
    close.mockImplementation((id: string) => order.push(`close:${id}`));
    spinDownAgentGit.mockImplementation(async (p: { ids: string[]; deleteBranch: boolean }) =>
      order.push(`git:[${p.ids.join(",")}]:del=${p.deleteBranch}`),
    );
    removeAgent.mockImplementation((pid: string, id: string) => order.push(`remove:${pid}/${id}`));

    await closeBuildAgent("build1");

    expect(order).toEqual([
      "close:build1",
      "close:w1",
      "close:w2",
      "git:[build1,w1,w2]:del=true", // ids = build + only ITS workers; deleteBranch from the setting
      "remove:p1/build1", // removeAgent runs last (after worktrees are gone)
    ]);
  });

  it("threads deleteBranch=false from the setting", async () => {
    deleteMergedBranch = false;
    await closeBuildAgent("build1");
    expect(spinDownAgentGit).toHaveBeenCalledWith(expect.objectContaining({ deleteBranch: false }));
  });

  it("no-ops when the agent isn't in any project", async () => {
    await closeBuildAgent("ghost");
    expect(close).not.toHaveBeenCalled();
    expect(spinDownAgentGit).not.toHaveBeenCalled();
    expect(removeAgent).not.toHaveBeenCalled();
  });
});
