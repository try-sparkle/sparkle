// The store's job is to keep two branches' verdicts apart and to never strand an entry mid-run.
// Both are assertions on the SIDE EFFECT (what the entry holds afterwards), never on a precondition.
import { afterEach, describe, expect, it } from "vitest";

import {
  entryKey,
  selectEntry,
  useAdversarialReviewStore,
} from "./adversarialReviewStore";
import type { AdversarialReviewStatus, AdversarialVerdict } from "../services/adversarialReview";

afterEach(() => useAdversarialReviewStore.setState({ entries: {} }));

function status(over: Partial<AdversarialReviewStatus> = {}): AdversarialReviewStatus {
  return {
    enabled: true,
    branch: "feat/x",
    headSha: "head1",
    record: null,
    stale: false,
    gate: "not-reviewed",
    blockOn: ["block", "unknown"],
    ...over,
  };
}

function record(over: Partial<AdversarialVerdict> = {}): AdversarialVerdict {
  return {
    verdict: "ship",
    summary: "clean",
    findings: [],
    model: "claude-opus-5",
    diffBytes: 10,
    truncated: false,
    reviewedSha: "head1",
    branch: "feat/x",
    reviewedAtMs: 1,
    note: null,
    ...over,
  };
}

describe("keying", () => {
  it("the same branch name in two projects does not share an entry", () => {
    // A verdict is a statement about a branch IN A REPO. Keying on branch alone would let one
    // project's `feat/x` render the other's verdict — the same class of bug the Rust side spends a
    // filename hash preventing.
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/repo-a", "feat/x", status({ headSha: "aaa" }));
    s.setStatus("/repo-b", "feat/x", status({ headSha: "bbb" }));
    const st = useAdversarialReviewStore.getState();
    expect(selectEntry(st, "/repo-a", "feat/x").status?.headSha).toBe("aaa");
    expect(selectEntry(st, "/repo-b", "feat/x").status?.headSha).toBe("bbb");
  });

  it("a trailing slash on the root is the same project", () => {
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/repo-a/", "feat/x", status({ headSha: "aaa" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/repo-a", "feat/x").status?.headSha).toBe(
      "aaa",
    );
    expect(entryKey("/repo-a/", "feat/x")).toBe(entryKey("/repo-a", "feat/x"));
  });

  it("an unknown pair reads as the stable empty entry rather than undefined", () => {
    const a = selectEntry(useAdversarialReviewStore.getState(), "/nope", "none");
    const b = selectEntry(useAdversarialReviewStore.getState(), "/other", "none");
    expect(a.status).toBeNull();
    expect(a.running).toBe(false);
    // Referentially stable, so a selector on an absent pair cannot churn re-renders.
    expect(a).toBe(b);
  });
});

describe("run lifecycle", () => {
  it("a failed run clears `running` and keeps the previous status standing", () => {
    // Two independent facts. Leaving `running` true renders a permanently disabled button that
    // reads as "Reviewing…" forever; clearing the status would throw away a real earlier verdict
    // because a LATER run could not start.
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/r", "feat/x", status({ record: record({ verdict: "block" }), gate: "blocking" }));
    s.beginRun("/r", "feat/x");
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").running).toBe(true);

    useAdversarialReviewStore.getState().failRun("/r", "feat/x", "ai_busy");
    const e = selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x");
    expect(e.running).toBe(false);
    expect(e.error).toBe("ai_busy");
    expect(e.status?.record?.verdict).toBe("block");
  });

  it("beginRun clears a stale error so the panel does not show yesterday's failure", () => {
    const s = useAdversarialReviewStore.getState();
    s.failRun("/r", "feat/x", "ai_busy");
    s.beginRun("/r", "feat/x");
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").error).toBeNull();
  });

  it("a finished run folds the fresh record in and marks it NOT stale", () => {
    // The staleness the run just resolved must not survive it — a panel that keeps showing "stale"
    // after a successful re-review sends the user round the loop again for nothing.
    const s = useAdversarialReviewStore.getState();
    s.setStatus(
      "/r",
      "feat/x",
      status({ record: record({ reviewedSha: "old1" }), headSha: "new2", stale: true }),
    );
    s.beginRun("/r", "feat/x");
    useAdversarialReviewStore
      .getState()
      .finishRun("/r", "feat/x", record({ reviewedSha: "new2", verdict: "ship-with-notes" }), 99);

    const e = selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x");
    expect(e.running).toBe(false);
    expect(e.error).toBeNull();
    expect(e.status?.stale).toBe(false);
    expect(e.status?.record?.reviewedSha).toBe("new2");
    expect(e.status?.record?.verdict).toBe("ship-with-notes");
    expect(e.status?.headSha).toBe("new2");
    expect(e.updatedAtMs).toBe(99);
  });

  it("a fresh BLOCKING verdict is not published behind a stale `clear` gate", () => {
    // roborev job 69293 (High). Both the service doc and the Rust doc tell a consumer to branch on
    // `gate`, never on `record.verdict` — so carrying the previous gate over a fresh record is a
    // fail-OPEN reading of the one field this feature exists to gate on. And it is not a
    // render-frame window: the panel's corrective refresh can itself fail, leaving a blocking
    // verdict durably reporting "does not block".
    const s = useAdversarialReviewStore.getState();
    s.setStatus(
      "/r",
      "feat/x",
      status({ record: record({ verdict: "ship" }), gate: "clear", blockOn: ["block", "unknown"] }),
    );
    s.finishRun("/r", "feat/x", record({ verdict: "block", reviewedSha: "new2" }));

    const e = selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x");
    expect(e.status?.record?.verdict).toBe("block");
    expect(e.status?.gate).toBe("blocking");
    expect(e.status?.gate).not.toBe("clear");
  });

  it("a fresh non-blocking verdict clears a gate that WAS blocking", () => {
    // The other direction, so the recompute is not merely a one-way escalation that happens to
    // look right: a branch whose block was fixed must stop reporting blocking.
    const s = useAdversarialReviewStore.getState();
    s.setStatus(
      "/r",
      "feat/x",
      status({ record: record({ verdict: "block" }), gate: "blocking", blockOn: ["block", "unknown"] }),
    );
    s.finishRun("/r", "feat/x", record({ verdict: "ship-with-notes", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "clear",
    );
  });

  it("an `unknown` verdict blocks when the project's blockOn says so", () => {
    // The fail-closed outcome has to survive the local recompute too — it is the one the whole
    // parser exists to produce, and it is in the shipped blockOn set.
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/r", "feat/x", status({ record: record(), gate: "clear", blockOn: ["block", "unknown"] }));
    s.finishRun("/r", "feat/x", record({ verdict: "unknown", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "blocking",
    );
  });

  it("a project that widened blockOn to ship-with-notes gets that answer locally too", () => {
    // The recompute reads the project's OWN blockOn, echoed on the status for exactly this — it is
    // not a hardcoded copy of the shipped default.
    const s = useAdversarialReviewStore.getState();
    s.setStatus(
      "/r",
      "feat/x",
      status({ record: record(), gate: "clear", blockOn: ["block", "unknown", "ship-with-notes"] }),
    );
    s.finishRun("/r", "feat/x", record({ verdict: "ship-with-notes", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "blocking",
    );
  });

  it("a blockOn entry in the DOCUMENTED lenient spelling still blocks", () => {
    // roborev job 69330 (High). `[adversarial_review].block_on`'s own doc advertises
    // `ship_with_notes` as equivalent, and config only trims and lowercases — so the entry reaches
    // the wire verbatim and a raw `.includes()` misses it. Rust parses each entry
    // (`Verdict::parse`), so the backend WOULD have said blocking. Every other test in this file
    // uses canonical kebab spellings, which is exactly why none of them can see this.
    const s = useAdversarialReviewStore.getState();
    s.setStatus(
      "/r",
      "feat/x",
      status({ record: record(), gate: "clear", blockOn: ["block", "unknown", "ship_with_notes"] }),
    );
    s.finishRun("/r", "feat/x", record({ verdict: "ship-with-notes", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "blocking",
    );
  });

  it("a TYPO'd blockOn entry blocks an `unknown` verdict, the way the backend does", () => {
    // The other half of the same gap: Rust parses an unrecognised entry to `Verdict::Unknown`, so
    // `block_on = ["blok"]` makes an `unknown` verdict blocking on the backend. A raw string match
    // would report `clear` — a fail-open produced by a one-character mistake in a config file.
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/r", "feat/x", status({ record: record(), gate: "clear", blockOn: ["blok"] }));
    s.finishRun("/r", "feat/x", record({ verdict: "unknown", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "blocking",
    );
  });

  it("a lenient entry does NOT block a verdict it does not name", () => {
    // The parse must not turn every entry into a match — `ship_with_notes` blocks
    // `ship-with-notes` and nothing else.
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/r", "feat/x", status({ record: record(), gate: "clear", blockOn: ["ship_with_notes"] }));
    s.finishRun("/r", "feat/x", record({ verdict: "ship", reviewedSha: "new2" }));
    expect(selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x").status?.gate).toBe(
      "clear",
    );
  });

  it("finishRun on a pair with no status yet still clears `running`", () => {
    // The status is left null (there is nothing to fold into), but a stranded `running: true` here
    // would be a button that never re-enables.
    useAdversarialReviewStore.getState().beginRun("/r", "fresh");
    useAdversarialReviewStore.getState().finishRun("/r", "fresh", record(), 5);
    const e = selectEntry(useAdversarialReviewStore.getState(), "/r", "fresh");
    expect(e.running).toBe(false);
    expect(e.status).toBeNull();
  });

  it("setStatus clears an error, because a successful read supersedes a failed one", () => {
    const s = useAdversarialReviewStore.getState();
    s.failRun("/r", "feat/x", "boom");
    s.setStatus("/r", "feat/x", status({ gate: "clear" }));
    const e = selectEntry(useAdversarialReviewStore.getState(), "/r", "feat/x");
    expect(e.error).toBeNull();
    expect(e.status?.gate).toBe("clear");
  });

  it("clear removes only the pair it names", () => {
    const s = useAdversarialReviewStore.getState();
    s.setStatus("/r", "a", status());
    s.setStatus("/r", "b", status());
    useAdversarialReviewStore.getState().clear("/r", "a");
    const st = useAdversarialReviewStore.getState();
    expect(selectEntry(st, "/r", "a").status).toBeNull();
    expect(selectEntry(st, "/r", "b").status).not.toBeNull();
  });
});
