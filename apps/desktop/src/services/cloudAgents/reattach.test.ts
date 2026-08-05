import { beforeEach, describe, it, expect, vi } from "vitest";
import { reattachCloudSessions, type ReattachDeps } from "./reattach";
import {
  cloudSessionStatusOf,
  resetCloudSessionStatusesForTests,
} from "./sessionStatus";
import type { CloudSessionSummary } from "./reconcile";
import type { AddAgentOpts } from "../../stores/projectStore";

function harness(opts: {
  sessions?: CloudSessionSummary[] | (() => Promise<CloudSessionSummary[]>);
  existing?: string[];
}) {
  const addAgent = vi.fn((_p: string, o: AddAgentOpts) => o.id ?? "gen");
  const onError = vi.fn();
  const fixed: CloudSessionSummary[] = typeof opts.sessions === "function" ? [] : (opts.sessions ?? []);
  const listSessions: () => Promise<CloudSessionSummary[]> =
    typeof opts.sessions === "function" ? opts.sessions : async () => fixed;
  const deps: ReattachDeps = {
    api: { listSessions },
    existingTabIds: () => opts.existing ?? [],
    addAgent,
    onError,
  };
  return { deps, addAgent, onError, listSessions };
}

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetCloudSessionStatusesForTests();
});

describe("reattachCloudSessions", () => {
  it("creates a cloud tab (id + runtime) for each live session lacking one", async () => {
    const { deps, addAgent } = harness({
      sessions: [
        { id: "s1", status: "active", name: "Live one" },
        { id: "s2", status: "paused" },
      ],
    });
    const created = await reattachCloudSessions("proj", deps);
    expect(created).toEqual(["s1", "s2"]);
    expect(addAgent).toHaveBeenNthCalledWith(1, "proj", {
      id: "s1",
      kind: "build",
      runtime: "cloud",
      name: "Live one",
    });
    expect(addAgent).toHaveBeenNthCalledWith(2, "proj", {
      id: "s2",
      kind: "build",
      runtime: "cloud",
    });
  });

  it("does not recreate a session that already has a tab", async () => {
    const { deps, addAgent } = harness({
      sessions: [{ id: "s1", status: "active" }],
      existing: ["s1"],
    });
    expect(await reattachCloudSessions("proj", deps)).toEqual([]);
    expect(addAgent).not.toHaveBeenCalled();
  });

  it("skips terminal sessions", async () => {
    const { deps, addAgent } = harness({
      sessions: [
        { id: "done", status: "complete" },
        { id: "live", status: "active" },
      ],
    });
    expect(await reattachCloudSessions("proj", deps)).toEqual(["live"]);
    expect(addAgent).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a listSessions failure creates nothing, never throws, and is RETRYABLE", async () => {
    // null, not [] (roborev 49295): [] means "asked, nothing to do" and settles the project for the
    // session. With a cached cloudProjectId this fetch is the only call that can fail, so reporting
    // it as [] left an offline cold boot unreconciled until relaunch.
    const { deps, addAgent, onError } = harness({
      sessions: async () => {
        throw new Error("offline");
      },
    });
    await expect(reattachCloudSessions("proj", deps)).resolves.toBeNull();
    expect(addAgent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("does not count a refused insert (unknown project) as a created tab", async () => {
    const { deps } = harness({ sessions: [{ id: "s1", status: "active" }] });
    deps.addAgent = vi.fn(() => null); // projectStore.addAgent's unknown-project return
    await expect(reattachCloudSessions("gone", deps)).resolves.toEqual([]);
  });

  // ── THE LIFECYCLE READINGS ────────────────────────────────────────────────────────────────────
  //
  // This listing is the app's only read of what the server thinks each sandbox is doing, and
  // `engine/goalContinuation` refuses to resume a cloud agent it has no CURRENT reading for. So
  // dropping the statuses on the floor here — which is what it did — leaves that gate with no
  // producer at all and every cloud agent permanently `cloud-session-unknown`. Asserted as the SIDE
  // EFFECT on the reader, not as a call on a spy.
  it("records every session's lifecycle, including the ones it creates no tab for", async () => {
    const { deps } = harness({
      sessions: [
        { id: "s1", status: "active" },
        { id: "s2", status: "paused" },
        { id: "s3", status: "complete" },
      ],
      existing: ["s1"], // already has a tab, so nothing is created for it — its status still matters
    });
    deps.now = () => T0;

    await reattachCloudSessions("proj", deps);

    expect(cloudSessionStatusOf("s1", T0)).toBe("active");
    expect(cloudSessionStatusOf("s2", T0)).toBe("paused");
    // The TERMINAL one too: a `complete` reading is exactly what stops a resume aimed at a finished
    // sandbox, and it is the one `reconcileCloudSessions` filters out.
    expect(cloudSessionStatusOf("s3", T0)).toBe("complete");
  });

  it("records nothing when the listing itself never landed", async () => {
    const { deps } = harness({ sessions: () => Promise.reject(new Error("offline")) });
    deps.now = () => T0;
    await expect(reattachCloudSessions("proj", deps)).resolves.toBeNull();
    expect(cloudSessionStatusOf("s1", T0)).toBeUndefined();
  });

  // One refused insert must not strand the project's OTHER live sessions — those tabs are the only
  // way a user reaches a sandbox that's already running and billing (roborev 46383).
  it("skips a single refused insert and still re-attaches the rest", async () => {
    const { deps } = harness({
      sessions: [
        { id: "s1", status: "active" },
        { id: "s2", status: "active" },
        { id: "s3", status: "active" },
      ],
    });
    deps.addAgent = vi.fn((_p: string, o: AddAgentOpts) => (o.id === "s2" ? null : (o.id ?? "gen")));
    await expect(reattachCloudSessions("proj", deps)).resolves.toEqual(["s1", "s3"]);
  });
});
