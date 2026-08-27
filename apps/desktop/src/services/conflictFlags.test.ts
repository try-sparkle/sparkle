// THE PROPERTY: nothing here can turn "we could not look" into "every PR can merge".
//
// This is the seam where the three-valued rule has teeth. Downstream, `undefined` and `[]` both
// produce no condition, so a bug that conflated them would be invisible in every `@sparkle/core`
// test — it becomes visible only here, as an all-clear synthesised from a failed read. The bead this
// class exists for is five PRs nobody was told about; a detector that answers `[]` when `gh` is
// unauthenticated recreates exactly that, with a green light on top.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import {
  parseConflictFlags,
  pollConflictFlags,
  CONFLICT_PROBE_STATUS_COMMAND,
} from "./conflictFlags";
import { useConflictStore } from "../stores/conflictStore";

// THE WIRE SHAPE, not a convenient subset. Every Option-typed field is spelled as `null`, because
// that is what serde renders for `None` and an absent key is a shape no producer can emit. An
// earlier version of this fixture omitted `blockedBy`, and that omission is precisely what let the
// absent-vs-null defect live on both sides at once (roborev 57886). Keep new optional fields here
// as `null` for the same reason: this fixture backs the only end-to-end parse-to-store coverage.
const raw = {
  pr: 1091,
  projectId: "project-alpha",
  branch: "sparkle/roborev-backlog-notice-collapse",
  ownerAgentId: null,
  kind: "conflicting",
  commitsBehind: 220,
  unresolvedSecs: 14400,
  evidence: "no-checks-ran",
  blockedBy: null,
  // Rust sends this as a plain `u64`, so it is always present and never `null` — unlike the
  // Option-typed fields above. It is `0` on a reading taken this look, which is the common case.
  readingAgeSecs: 0,
};

beforeEach(() => {
  invoke.mockReset();
  useConflictStore.getState()._resetForTests();
});

describe("parseConflictFlags", () => {
  // ── THE READING'S AGE MUST SURVIVE THE PARSE ─────────────────────────────────────────────────
  //
  // `parseOne` builds an EXPLICIT object rather than spreading the input, which is the right call
  // (it is what stops an unvalidated field riding along) and is also why a new field reaches the
  // consumer only if it is copied here by hand. A producer that states the age and a parser that
  // drops it renders exactly the surface this change exists to remove: a six-hour-old verdict
  // narrated with an unquantified hedge (bead sparkle-iw02bk).
  it("keeps the age of the reading, which is what makes a stale row legible as stale", () => {
    const [one] = parseConflictFlags([{ ...raw, evidence: "unknown", readingAgeSecs: 21600 }])!;
    expect(one!.readingAgeSecs).toBe(21600);
  });

  // VERSION SKEW MUST NOT MUTE THE DETECTOR. This parser is ALL-OR-NOTHING: one unreadable entry
  // turns the whole sweep into "we did not look". An older Rust half sends no `readingAgeSecs`, so
  // requiring it would silence the detector for the entire fleet on any mismatched build — trading
  // a disclosure gap for a total outage. Absent is accepted and simply carries no age.
  it("still parses a payload from a producer that does not send an age", () => {
    const { readingAgeSecs: _readingAgeSecs, ...withoutAge } = raw;
    const parsed = parseConflictFlags([withoutAge]);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.readingAgeSecs).toBeUndefined();
    expect(parsed![0]!.pr).toBe(1091);
  });

  // A NONSENSE AGE IS REAL DRIFT, and it is rejected at the boundary for the same reason
  // `commitsBehind` is: a negative renders as `-5`, from which the report's citation gate reads `5`
  // while `measured` holds `-5`. The two never match, so the WHOLE report is refused as
  // `fabricated-citation` — which presents as silence. Better to refuse the payload loudly here.
  it("refuses a negative or fractional age rather than letting it reach the report", () => {
    expect(parseConflictFlags([{ ...raw, readingAgeSecs: -5 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, readingAgeSecs: 1.5 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, readingAgeSecs: "6h" }])).toBeUndefined();
  });

  it("accepts the frozen wire shape and keeps every field", () => {
    expect(parseConflictFlags([raw])).toEqual([
      {
        pr: 1091,
        projectId: "project-alpha",
        branch: "sparkle/roborev-backlog-notice-collapse",
        ownerAgentId: null,
        kind: "conflicting",
        commitsBehind: 220,
        unresolvedSecs: 14400,
        evidence: "no-checks-ran",
        readingAgeSecs: 0,
      },
    ]);
  });

  // WHICH REPO the number belongs to. `#12` exists in every sibling project, so a row without this
  // sends the consumer asking all of them and accepting whichever answers — a weaker answer than
  // the producer already held. Absent and empty are both refused: the producer states it, and an
  // empty string is its "not attributed yet", which is not an identity either.
  it("refuses a row that does not say which project the PR is in", () => {
    const { projectId: _dropped, ...noProject } = raw;
    expect(parseConflictFlags([noProject])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, projectId: "" }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, projectId: 7 }])).toBeUndefined();
    // …and one good row alongside a bad one is still the whole payload refused.
    expect(parseConflictFlags([raw, noProject])).toBeUndefined();
  });

  it("carries the project through, so a flag is verifiable against ONE repo", () => {
    const [one] = parseConflictFlags([{ ...raw, projectId: "project-gamma" }])!;
    expect(one!.projectId).toBe("project-gamma");
  });

  it("keeps a recorded owner and an optional hold reason", () => {
    const [one] = parseConflictFlags([{ ...raw, ownerAgentId: "a1", blockedBy: "review" }])!;
    expect(one!.ownerAgentId).toBe("a1");
    expect(one!.blockedBy).toBe("review");
  });

  // THE CROSS-LANGUAGE SEAM, and the reason this test uses a hand-written literal rather than the
  // `raw` fixture above. `raw` OMITS `blockedBy`, which no real payload ever does: the producer is
  // Rust, the field is `Option<String>`, and serde with no `skip_serializing_if` renders `None` as
  // JSON `null` — never as an absent key. So the fixture exercised a shape the wire cannot produce,
  // and the healthy case went untested on both sides at once (the Rust suite cannot see this parser;
  // the TS suite never saw a real payload).
  //
  // The blast radius is why it is pinned here rather than fixed quietly: `blockedBy: null` is what
  // EVERY successfully-read PR carries, and `parseConflictFlags` is deliberately all-or-nothing, so
  // rejecting it turns every sweep into `undefined` — "we did not look" — and the class never fires.
  // A detector for PRs nobody was told about would itself have gone silent, permanently, with no
  // error anywhere. That is the exact failure this whole feature exists to prevent.
  it("accepts the null a Rust Option::None actually serialises to, not just an absent key", () => {
    const asRustSendsIt = {
      pr: 1124,
      projectId: "project-alpha",
      branch: "sparkle/staleness-merge-vs-rebase",
      ownerAgentId: null,
      kind: "conflicting",
      commitsBehind: 219,
      unresolvedSecs: 420,
      blockedBy: null,
      // HOW the producer knows the fields above, and the one field here the consumer must NOT
      // discard: a conflicting row is equally what a first-hand absence of CI and an inherited
      // verdict produce, so a parser that drops this hands the report a not-current reading it then
      // narrates as "no CI has ever run on it".
      evidence: "last-known",
      // Fields the real `ConflictFlag` also carries (conflict_watch.rs, `rename_all = "camelCase"`)
      // that this consumer has no use for. They must not make the payload unreadable — a stricter
      // parser here would fail closed on its own producer.
      target: "agent",
      raisedAtMs: 1785866624974,
      rung: 2,
    };
    const parsed = parseConflictFlags([asRustSendsIt]);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.pr).toBe(1124);
    // `null` means "no hold reason", which is the same fact as an absent key — so it must normalise
    // to absent rather than surviving as a null the consumers would have to re-check.
    expect(parsed![0]!.blockedBy).toBeUndefined();
    expect(parsed![0]!.evidence).toBe("last-known");
  });

  // THE FIELD THAT SAYS WHETHER THE ROW IS CURRENT. Rust states it on every flag (a plain `String`),
  // and the consumer that composes the founder's sentence branches on it — so an absent key is drift
  // of the same kind as an absent `ownerAgentId`, and it fails closed.
  it("requires the evidence field, which is the only thing separating a read row from an unread one", () => {
    const { evidence, ...withoutEvidence } = raw;
    void evidence;
    expect(parseConflictFlags([withoutEvidence])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, evidence: null }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, evidence: 7 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, evidence: "" }])).toBeUndefined();
  });

  // ...AND THE VALUE IS NOT AN ALLOWLIST, deliberately. This parser is all-or-nothing, so rejecting
  // a value the producer added later would turn every sweep into "we did not look" — for the whole
  // fleet, at once, which is the failure the producer's own evidence split exists to prevent. It is
  // kept verbatim; the report is what decides that an unfamiliar value cannot claim first-hand
  // knowledge.
  it("keeps an evidence value this build does not recognise rather than muting the sweep", () => {
    const parsed = parseConflictFlags([{ ...raw, evidence: "some-future-value" }]);
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.evidence).toBe("some-future-value");
  });

  it("distinguishes an empty ANSWER from no answer", () => {
    // An empty array is a real reading — the probe ran and every open PR can merge.
    expect(parseConflictFlags([])).toEqual([]);
    // Anything that is not a list is not a reading at all.
    expect(parseConflictFlags(undefined)).toBeUndefined();
    expect(parseConflictFlags(null)).toBeUndefined();
    expect(parseConflictFlags({ prs: [raw] })).toBeUndefined();
    expect(parseConflictFlags("nope")).toBeUndefined();
  });

  // ALL-OR-NOTHING. A filtered list is indistinguishable from a complete one downstream, so a field
  // rename that dropped four of five PRs would be delivered as a confident report about the fifth.
  it("rejects the WHOLE payload when one entry is unreadable, rather than reporting the rest", () => {
    expect(parseConflictFlags([raw, { ...raw, pr: 42, kind: "mergeable" }])).toBeUndefined();
    expect(parseConflictFlags([raw, { ...raw, commitsBehind: "220" }])).toBeUndefined();
    expect(parseConflictFlags([raw, { ...raw, branch: 7 }])).toBeUndefined();
    expect(parseConflictFlags([raw, null])).toBeUndefined();
  });

  // `null` is the contract's "unresolved" and must survive; an ABSENT key is a producer that failed
  // to state it, which is not the same fact.
  it("requires the owner field to be stated, even as null", () => {
    const { ownerAgentId, ...withoutOwner } = raw;
    void ownerAgentId;
    expect(parseConflictFlags([withoutOwner])).toBeUndefined();
  });
});

describe("pollConflictFlags", () => {
  it("records a reading the probe returned", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.resolve({ everProbed: true, repos: 1, unreadable: 0, lastFullReadMs: 1 })
        : Promise.resolve([raw]),
    );
    await expect(pollConflictFlags()).resolves.toBe(true);
    expect(useConflictStore.getState().flags).toHaveLength(1);
  });

  it("records an empty reading as an ANSWER, not as silence", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.resolve({ everProbed: true, repos: 1, unreadable: 0, lastFullReadMs: 1 })
        : Promise.resolve([]),
    );
    await expect(pollConflictFlags()).resolves.toBe(true);
    expect(useConflictStore.getState().flags).toEqual([]);
  });

  // THE SECOND CROSS-LANGUAGE SEAM, and the one that would have quietly undone this whole file.
  //
  // The tests above were written against the assumption that an unauthenticated `gh` makes the
  // command THROW. It does not. The Rust producer's per-PR fail-closed path only keeps
  // ALREADY-TRACKED PRs climbing, so a `gh` that is absent or unauthenticated from process start
  // means nothing is ever tracked and `conflict_flags` returns `[]` — forever, successfully.
  //
  // Read alone, that is indistinguishable from "we swept every repo and everything can merge". It
  // is precisely the all-clear-synthesised-from-a-failed-read this file's header says nothing here
  // may produce, and it arrives through the success path where no `catch` can see it. The producer
  // exposes `conflict_probe_status` for exactly this, so the consumer must ask.
  it("does not read an empty list as an all-clear when the probe never completed a sweep", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.resolve({ everProbed: false, repos: 0, unreadable: 0, lastFullReadMs: 0 })
        : Promise.resolve([]),
    );
    await expect(pollConflictFlags()).resolves.toBe(false);
    expect(useConflictStore.getState().flags).toBeUndefined();
  });

  it("does not read an empty list as an all-clear when a repo was unreadable", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.resolve({
            everProbed: true,
            repos: 3,
            unreadable: 1,
            lastError: "gh: not authenticated",
            lastFullReadMs: 0,
          })
        : Promise.resolve([]),
    );
    await expect(pollConflictFlags()).resolves.toBe(false);
    expect(useConflictStore.getState().flags).toBeUndefined();
  });

  // A NON-EMPTY answer is self-evidently a real reading: the producer cannot invent a conflicting
  // PR it could not read. So an incomplete sweep must not discard what it DID find — that would
  // trade a false all-clear for a false silence, which is the same bug wearing the other hat.
  it("still records a NON-empty reading from an incomplete sweep", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.resolve({ everProbed: true, repos: 3, unreadable: 1, lastFullReadMs: 0 })
        : Promise.resolve([raw]),
    );
    await expect(pollConflictFlags()).resolves.toBe(true);
    expect(useConflictStore.getState().flags).toHaveLength(1);
  });

  // An older backend has the flags command but not the status one. Absent proof of a complete sweep,
  // an empty list is still not an all-clear — the same fail-closed reading, not a reason to relax.
  it("treats a missing status command as no proof of a sweep", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === CONFLICT_PROBE_STATUS_COMMAND
        ? Promise.reject(new Error("command conflict_probe_status not found"))
        : Promise.resolve([]),
    );
    await expect(pollConflictFlags()).resolves.toBe(false);
    expect(useConflictStore.getState().flags).toBeUndefined();
  });

  // THE ONE THAT MATTERS. An older backend has no `conflict_flags` command at all, and an
  // unauthenticated `gh` makes the command throw. Neither may leave the store claiming an all-clear.
  it("leaves the store at NEVER-LOOKED when the probe throws", async () => {
    invoke.mockRejectedValue(new Error("command conflict_flags not found"));
    await expect(pollConflictFlags()).resolves.toBe(false);
    expect(useConflictStore.getState().flags).toBeUndefined();
  });

  it("leaves the store at NEVER-LOOKED when the payload cannot be read", async () => {
    invoke.mockResolvedValue({ unexpected: true });
    await expect(pollConflictFlags()).resolves.toBe(false);
    expect(useConflictStore.getState().flags).toBeUndefined();
  });

  // A conflicting PR does not heal itself between polls, and a condition that vanished and returned
  // would drop its cooldown stamp and re-report the identical paragraph. So a failed re-read keeps
  // the last good answer — the fail-closed rule lives upstream, in never synthesising one.
  it("keeps the last good reading when a later probe fails", async () => {
    invoke.mockResolvedValue([raw]);
    await pollConflictFlags();
    invoke.mockRejectedValue(new Error("gh: not authenticated"));
    await pollConflictFlags();
    expect(useConflictStore.getState().flags).toHaveLength(1);
  });
});

// The other half of the same rule, at the boundary: a count that cannot be true is evidence the
// payload is not what this build thinks it is, so the whole reading is refused rather than passed on.
describe("parseConflictFlags rejects impossible numbers", () => {
  it("refuses a negative or fractional count", () => {
    expect(parseConflictFlags([{ ...raw, commitsBehind: -1 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, commitsBehind: 2.5 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, unresolvedSecs: -1 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, pr: 0 }])).toBeUndefined();
    expect(parseConflictFlags([{ ...raw, pr: -3 }])).toBeUndefined();
  });

  it("still accepts the zero cases that ARE real", () => {
    expect(parseConflictFlags([{ ...raw, commitsBehind: 0, unresolvedSecs: 0 }])).toHaveLength(1);
  });
});
