import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteCloudSession = vi.fn();
vi.mock("../agentTransport", () => ({ deleteCloudSession: (id: string) => deleteCloudSession(id) }));

import { terminateCloudAgent, terminateIfCloud } from "./terminate";

beforeEach(() => {
  deleteCloudSession.mockReset().mockResolvedValue(undefined);
});

describe("terminateIfCloud", () => {
  it("DELETEs the server session for a cloud agent", async () => {
    await terminateIfCloud({ id: "sess-1", runtime: "cloud" });
    expect(deleteCloudSession).toHaveBeenCalledWith("sess-1");
  });

  it("is a no-op for a local agent, and for no agent at all", async () => {
    await terminateIfCloud({ id: "a1", runtime: "local" });
    await terminateIfCloud(undefined);
    await terminateIfCloud(null);
    expect(deleteCloudSession).not.toHaveBeenCalled();
  });

  // The close path awaits this: a rejection must never block the local teardown (an offline close
  // still has to remove the tab — the server's idle-pause bounds the cost).
  it("never rejects when the DELETE fails", async () => {
    deleteCloudSession.mockRejectedValue(new Error("offline"));
    await expect(terminateCloudAgent("sess-1")).resolves.toBeUndefined();
    await expect(terminateIfCloud({ id: "sess-1", runtime: "cloud" })).resolves.toBeUndefined();
  });
});
