import { beforeEach, describe, expect, it } from "vitest";
import {
  CHIEF_SYNC_REASON_COPY,
  UNKNOWN_SYNC,
  __resetChiefSyncStore,
  chiefSyncFor,
  describeChiefSync,
  reduceBlocked,
  reduceStart,
  reduceSuccess,
  useChiefSyncStore,
  type ChiefSyncReason,
} from "./chiefSyncStore";

const NOW = 1_700_000_000_000;
const state = () => useChiefSyncStore.getState();

describe("reduceStart", () => {
  it("marks the run in flight and stamps the attempt WITHOUT claiming a success", () => {
    const r = reduceStart(UNKNOWN_SYNC, NOW);
    expect(r.phase).toBe("syncing");
    expect(r.lastAttemptAt).toBe(NOW);
    expect(r.lastSuccessAt).toBeNull(); // starting is not succeeding
  });

  it("keeps a prior reason visible until the run actually resolves", () => {
    // The pane shows "syncing" while the last known cause is still the truth about the library's
    // state. Clearing it here would flash a clean slate on every poll of a persistently broken sync.
    const blocked = reduceBlocked(UNKNOWN_SYNC, "unreachable", "Load failed", NOW);
    const started = reduceStart(blocked, NOW + 1);
    expect(started.reason).toBe("unreachable");
    expect(started.consecutiveFailures).toBe(1);
  });
});

describe("reduceSuccess", () => {
  it("records what the run actually WROTE, not merely that it ran", () => {
    const r = reduceSuccess(
      UNKNOWN_SYNC,
      { chiefProjectId: "project_abc", uploaded: 7, deleted: 2 },
      NOW,
    );
    expect(r.phase).toBe("ok");
    expect(r.lastUploaded).toBe(7);
    expect(r.lastDeleted).toBe(2);
    expect(r.lastSuccessAt).toBe(NOW);
    expect(r.chiefProjectId).toBe("project_abc");
  });

  it("clears a prior reason and failure count — a round trip disproves every earlier cause", () => {
    const blocked = reduceBlocked(UNKNOWN_SYNC, "unreachable", "Load failed", NOW);
    expect(blocked.consecutiveFailures).toBe(1);
    const ok = reduceSuccess(blocked, { chiefProjectId: "p", uploaded: 0, deleted: 0 }, NOW + 1);
    expect(ok.reason).toBeNull();
    expect(ok.detail).toBe("");
    expect(ok.consecutiveFailures).toBe(0);
  });
});

describe("reduceBlocked", () => {
  it("keeps lastSuccessAt so a blocked project still says when it last worked", () => {
    const ok = reduceSuccess(UNKNOWN_SYNC, { chiefProjectId: "p", uploaded: 3, deleted: 0 }, NOW);
    const blocked = reduceBlocked(ok, "unreachable", "Load failed", NOW + 60_000);
    expect(blocked.phase).toBe("blocked");
    expect(blocked.lastSuccessAt).toBe(NOW);
  });

  it("counts only genuine failures — an unmet precondition must not escalate the backoff", () => {
    // no_pat / no_worktree are not failures OF anything; counting them would make a fresh install
    // read as an outage and would drive a retry backoff that has nothing to retry.
    let r = reduceBlocked(UNKNOWN_SYNC, "no_pat", "", NOW);
    expect(r.consecutiveFailures).toBe(0);
    r = reduceBlocked(r, "no_worktree", "", NOW + 1);
    expect(r.consecutiveFailures).toBe(0);
    r = reduceBlocked(r, "unreachable", "boom", NOW + 2);
    expect(r.consecutiveFailures).toBe(1);
    r = reduceBlocked(r, "unreachable", "boom", NOW + 3);
    expect(r.consecutiveFailures).toBe(2);
  });

  it("returns the SAME reference when an unchanged precondition is re-evaluated", () => {
    const first = reduceBlocked(UNKNOWN_SYNC, "no_pat", "", NOW);
    const second = reduceBlocked(first, "no_pat", "", NOW + 30_000);
    expect(second).toBe(first); // no churn on a poll that learned nothing
  });

  it("does move when the reason changes", () => {
    const first = reduceBlocked(UNKNOWN_SYNC, "no_pat", "", NOW);
    const second = reduceBlocked(first, "project_gone", "gone", NOW + 1);
    expect(second).not.toBe(first);
    expect(second.reason).toBe("project_gone");
  });
});

describe("describeChiefSync", () => {
  it("says nothing at all before the first attempt", () => {
    expect(describeChiefSync(UNKNOWN_SYNC)).toBeNull();
  });

  it("distinguishes 'ran, nothing changed' from 'ran and wrote' — the two silent-identical states", () => {
    const nothing = reduceSuccess(UNKNOWN_SYNC, { chiefProjectId: "p", uploaded: 0, deleted: 0 }, NOW);
    const wrote = reduceSuccess(UNKNOWN_SYNC, { chiefProjectId: "p", uploaded: 4, deleted: 1 }, NOW);
    const a = describeChiefSync(nothing);
    const b = describeChiefSync(wrote);
    expect(a).not.toBe(b);
    expect(a).toContain("nothing changed");
    expect(b).toContain("wrote 4");
    expect(b).toContain("removed 1");
  });

  it("gives every reason its own sentence, so no two causes read alike", () => {
    const reasons: ChiefSyncReason[] = ["no_pat", "no_worktree", "project_gone", "unreachable"];
    const sentences = reasons.map((reason) =>
      describeChiefSync(reduceBlocked(UNKNOWN_SYNC, reason, "", NOW)),
    );
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const s of sentences) expect(s).toBeTruthy();
  });

  it("names a remedy in every reason — a status the reader cannot act on sends them back to asking", () => {
    for (const copy of Object.values(CHIEF_SYNC_REASON_COPY)) {
      expect(copy.length).toBeGreaterThan(20);
    }
    // project_gone is the one that must NOT tell the user to wait: nothing about it is transient.
    expect(CHIEF_SYNC_REASON_COPY.project_gone).toMatch(/re-link|unlink/i);
    expect(CHIEF_SYNC_REASON_COPY.project_gone).not.toMatch(/retry|retrying|wait/i);
    expect(CHIEF_SYNC_REASON_COPY.unreachable).toMatch(/retry|retrying/i);
    expect(CHIEF_SYNC_REASON_COPY.no_pat).toMatch(/settings/i);
  });
});

describe("useChiefSyncStore wiring", () => {
  beforeEach(__resetChiefSyncStore);

  it("keeps a record PER project, so one broken project cannot mask a healthy one", () => {
    state().noteBlocked("proj-a", "project_gone", "gone", NOW);
    state().noteSuccess("proj-b", { chiefProjectId: "p", uploaded: 2, deleted: 0 }, NOW);
    expect(chiefSyncFor(state(), "proj-a").reason).toBe("project_gone");
    expect(chiefSyncFor(state(), "proj-b").phase).toBe("ok");
  });

  it("reads as the zero-state for a project that has never synced", () => {
    expect(chiefSyncFor(state(), "never-seen")).toBe(UNKNOWN_SYNC);
  });

  it("surfaces WHICH Chief project it writes to — the only way a split library is visible", () => {
    state().noteSuccess("proj-a", { chiefProjectId: "project_one", uploaded: 1, deleted: 0 }, NOW);
    state().noteSuccess("proj-b", { chiefProjectId: "project_two", uploaded: 1, deleted: 0 }, NOW);
    expect(chiefSyncFor(state(), "proj-a").chiefProjectId).toBe("project_one");
    expect(chiefSyncFor(state(), "proj-b").chiefProjectId).toBe("project_two");
  });

  it("marks a run in flight and then resolves it", () => {
    state().noteStart("proj-a", NOW);
    expect(chiefSyncFor(state(), "proj-a").phase).toBe("syncing");
    expect(chiefSyncFor(state(), "proj-a").lastAttemptAt).toBe(NOW);
    state().noteSuccess("proj-a", { chiefProjectId: "p", uploaded: 0, deleted: 0 }, NOW + 5);
    expect(chiefSyncFor(state(), "proj-a").phase).toBe("ok");
  });

  it("does not replace the byProject map when the reducer reports no change", () => {
    state().noteBlocked("proj-a", "no_pat", "", NOW);
    const before = state().byProject;
    state().noteBlocked("proj-a", "no_pat", "", NOW + 30_000);
    expect(state().byProject).toBe(before); // subscribers must not re-render on a no-op poll
  });
});
