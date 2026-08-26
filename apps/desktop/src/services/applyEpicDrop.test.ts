// EXECUTION, not decision. `epicDrop.test.ts` pins WHAT a drop writes; this pins that those writes
// actually reach `bd`, in the order the plan lists them, and that a failure does not swallow the
// refresh.
import { describe, expect, it, vi } from "vitest";

import { applyEpicDrop, type EpicDropDeps } from "./applyEpicDrop";
import type { EpicDropAccepted, EpicDropWrite } from "./epicDrop";
import { DELIVERED_LABEL, STALLED_LABEL } from "./beads";

/** Records every write in the order it was performed, so ORDER is assertable rather than implied. */
function spyDeps(over: Partial<EpicDropDeps> = {}) {
  const calls: string[] = [];
  const deps: EpicDropDeps = {
    claim: vi.fn(async (_p: string, id: string) => {
      calls.push(`claim:${id}`);
    }),
    unclaim: vi.fn(async (_p: string, id: string) => {
      calls.push(`unclaim:${id}`);
    }),
    close: vi.fn(async (_p: string, id: string) => {
      calls.push(`close:${id}`);
    }),
    label: vi.fn(async (_p: string, action: "add" | "remove", id: string, label: string) => {
      calls.push(`label-${action}:${id}:${label}`);
    }),
    build: vi.fn((args: { epicId: string }) => {
      calls.push(`build:${args.epicId}`);
      return "agent-1";
    }),
    refresh: vi.fn(async () => {
      calls.push("refresh");
    }),
    ...over,
  } as EpicDropDeps;
  return { deps, calls };
}

function accepted(writes: EpicDropWrite[]): EpicDropAccepted {
  return { ok: true, target: "done", writes, landsOn: "done" };
}

function run(writes: EpicDropWrite[], deps: EpicDropDeps) {
  return applyEpicDrop(
    {
      projectId: "p1",
      rootPath: "/repo",
      epicId: "e1",
      prdPath: "PRD/x.md",
      plan: accepted(writes),
    },
    deps,
  );
}

describe("applyEpicDrop", () => {
  it("performs every write, in the order the plan lists them", async () => {
    const { deps, calls } = spyDeps();
    await run(
      [
        { kind: "label-remove", label: DELIVERED_LABEL },
        { kind: "close" },
      ],
      deps,
    );
    // ORDER IS THE ASSERTION. `columnFor` ranks `delivered` above plain closed, so closing first
    // and un-labelling second leaves the card under Shipped for a poll.
    expect(calls).toEqual([`label-remove:e1:${DELIVERED_LABEL}`, "close:e1", "refresh"]);
  });

  it("passes the action through to labelBead rather than assuming add", async () => {
    const { deps } = spyDeps();
    await run([{ kind: "label-add", label: STALLED_LABEL }], deps);
    expect(deps.label).toHaveBeenCalledWith("/repo", "add", "e1", STALLED_LABEL);
  });

  it("claims and then binds an orchestrator for a Build: Active plan", async () => {
    const { deps, calls } = spyDeps();
    await run([{ kind: "claim" }, { kind: "send-to-build" }], deps);
    expect(calls).toEqual(["claim:e1", "build:e1", "refresh"]);
    expect(deps.build).toHaveBeenCalledWith({
      projectId: "p1",
      epicId: "e1",
      prdPath: "PRD/x.md",
      mode: "epic",
    });
  });

  it("carries a null prdPath through to sendToBuild instead of dropping the write", async () => {
    const { deps } = spyDeps();
    await applyEpicDrop(
      {
        projectId: "p1",
        rootPath: "/repo",
        epicId: "e1",
        prdPath: null,
        plan: accepted([{ kind: "send-to-build" }]),
      },
      deps,
    );
    expect(deps.build).toHaveBeenCalledWith(
      expect.objectContaining({ prdPath: null, epicId: "e1" }),
    );
  });

  it("refreshes so the card moves without waiting out the poll", async () => {
    const { deps } = spyDeps();
    await run([{ kind: "claim" }], deps);
    expect(deps.refresh).toHaveBeenCalledWith("p1", "/repo");
  });

  // A half-applied bead must still be SHOWN accurately — the refresh is in a `finally` precisely so
  // the column renders what landed rather than what was hoped for.
  it("still refreshes when a write throws, and re-throws the error", async () => {
    const { deps, calls } = spyDeps({
      close: vi.fn(async () => {
        throw new Error("bd timed out");
      }),
    });
    await expect(run([{ kind: "claim" }, { kind: "close" }], deps)).rejects.toThrow("bd timed out");
    expect(calls).toEqual(["claim:e1", "refresh"]);
  });

  it("stops at the first failure instead of running later writes", async () => {
    const { deps, calls } = spyDeps({
      unclaim: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await expect(
      run([{ kind: "unclaim" }, { kind: "label-add", label: STALLED_LABEL }], deps),
    ).rejects.toThrow("nope");
    expect(calls).toEqual(["refresh"]);
    expect(deps.label).not.toHaveBeenCalled();
  });

  // A refresh failure is cosmetic; the write error underneath it is not. Swallowing the wrong one
  // would report a failed drop as a success.
  it("does not let a failing refresh mask the write error", async () => {
    const { deps } = spyDeps({
      claim: vi.fn(async () => {
        throw new Error("the real error");
      }),
      refresh: vi.fn(async () => {
        throw new Error("refresh blew up");
      }),
    });
    await expect(run([{ kind: "claim" }], deps)).rejects.toThrow("the real error");
  });

  it("resolves quietly when a refresh fails but every write landed", async () => {
    const { deps } = spyDeps({
      refresh: vi.fn(async () => {
        throw new Error("refresh blew up");
      }),
    });
    await expect(run([{ kind: "claim" }], deps)).resolves.toBeUndefined();
  });
});
