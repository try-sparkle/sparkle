// The TypeScript half of the Rust↔TS seam guard. The Rust half is `research.rs`'s
// `the_shared_fixture_round_trips`, and they read THE SAME FILE — that is the whole point.
//
// AGENTS.md: "share ONE JSON fixture that both suites parse, so the Rust test asserting serde
// produces it and the TS test asserting the parser accepts it fail TOGETHER." A field list in a plan
// does not do that; both halves go green and the seam is broken in production.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  OPTION_BACKED_FIELDS,
  RESEARCH_DEPTHS,
  RESEARCH_STATUSES,
  RESEARCH_TASK_FIELDS,
  ResearchTaskParseError,
  isLive,
  isLivePhase,
  isTerminal,
  isUnread,
  parseResearchTask,
  phaseOf,
  type ResearchTask,
} from "./types";

const FIXTURE_PATH = join(__dirname, "fixtures", "researchTasks.sample.json");

/**
 * Load through the REAL validator, not an unchecked cast.
 *
 * `JSON.parse(...) as ResearchTask[]` was the first version and it made this whole file vacuous
 * (roborev 61551): a cast asserts nothing at runtime, so the guard could only catch someone editing
 * the fixture — never someone editing the interface it exists to protect. Routing through
 * `parseResearchTask` means every test below is also a test that the fixture still satisfies the
 * contract.
 */
function loadFixture(): ResearchTask[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  if (!Array.isArray(raw)) throw new Error("fixture is not an array");
  return raw.map(parseResearchTask);
}

/**
 * Find the ONE fixture task whose id contains `fragment` — and refuse an ambiguous one.
 *
 * `find` was the first version and it silently returned the first of two matches: `UNREAD_DONE`
 * contains `READ_DONE` as a substring, so the "already claimed" case was handed the UNCLAIMED task
 * and the assertion failed for a reason that had nothing to do with the contract. A helper that
 * picks arbitrarily among matches makes every test built on it a coin flip, so this one throws.
 */
function byId(tasks: ResearchTask[], fragment: string): ResearchTask {
  const found = tasks.filter((t) => t.id.includes(fragment));
  if (found.length === 0) throw new Error(`fixture has no task matching ${fragment}`);
  if (found.length > 1) {
    throw new Error(
      `fragment ${fragment} is ambiguous — it matches ${found.map((t) => t.id).join(", ")}`,
    );
  }
  return found[0]!;
}

/** A well-formed task to mutate per-case. Taken from the fixture so it can never drift from it. */
function validTask(): Record<string, unknown> {
  return { ...(loadFixture()[0] as unknown as Record<string, unknown>) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMPILE-TIME HALF OF THE SEAM GUARD — this is what `tsc` enforces, and vitest cannot.
//
// The runtime validator below catches a bad PAYLOAD. It structurally cannot catch a bad TYPE:
// rewriting `findings: string | null` as `findings?: string` changes nothing any assertion can
// observe at runtime, and `tsc` stays happy too because `!== null` is legal on `string | undefined`.
// That was the exact regression roborev 61551 named as undetectable, and it is the one that matters
// — `T?` means `T | undefined`, which does not include the `null` the wire actually sends.
//
// So it is pinned in the type system. `null extends T` is false the moment a field becomes
// optional-instead-of-nullable, and assigning `true` to `false` is a COMPILE error. This block has
// no runtime assertions on purpose: it is checked by `pnpm typecheck` / the `Node — static` CI job,
// not by the test run.
type AcceptsNull<T> = null extends T ? true : false;

const _everyOptionFieldAcceptsNull: {
  projectId: AcceptsNull<ResearchTask["projectId"]>;
  startedAt: AcceptsNull<ResearchTask["startedAt"]>;
  finishedAt: AcceptsNull<ResearchTask["finishedAt"]>;
  findings: AcceptsNull<ResearchTask["findings"]>;
  error: AcceptsNull<ResearchTask["error"]>;
  readAt: AcceptsNull<ResearchTask["readAt"]>;
} = {
  projectId: true,
  startedAt: true,
  finishedAt: true,
  findings: true,
  error: true,
  readAt: true,
};
void _everyOptionFieldAcceptsNull;

describe("the research task contract", () => {
  it("covers every status, so neither side can add one the fixture never exercises", () => {
    const seen = new Set(loadFixture().map((t) => t.status));
    // Not `>=`: an exact match means a NEW status is a failing test until the fixture gains a case,
    // which is the only thing that makes the Rust round-trip cover it too.
    expect([...seen].sort()).toEqual([...RESEARCH_STATUSES].sort());
  });

  it("covers both depths", () => {
    const seen = new Set(loadFixture().map((t) => t.depth));
    expect([...seen].sort()).toEqual([...RESEARCH_DEPTHS].sort());
  });

  // ── THE SEAM GUARD ────────────────────────────────────────────────────────────────────────────
  // This is the assertion the repo has already paid for once. serde emits `"findings": null` for
  // `Option::None`; it OMITS the key only under `skip_serializing_if`. A TS parser written against
  // `findings?: string` describes a shape the wire cannot produce, and the resulting all-or-nothing
  // parse failure discards the WHOLE payload silently — permanently inert, nothing logged, because
  // `None` is what the common case sends.
  //
  // `toHaveProperty` rather than a truthiness or `!== undefined` check on purpose: it distinguishes
  // "present and null" from "absent", which is exactly the distinction that broke last time and the
  // one a laxer assertion cannot see.
  it("carries every Option-backed field as an explicit null, never as an absent key", () => {
    for (const task of loadFixture()) {
      for (const field of OPTION_BACKED_FIELDS) {
        expect(task, `${task.id} is missing the key \`${field}\``).toHaveProperty(field);
        expect(task[field], `${task.id}.${field} must be null or a value, never undefined`).not.toBe(
          undefined,
        );
      }
    }
  });

  // ── THE GUARD THAT PINS THE INTERFACE, NOT THE FIXTURE ──────────────────────────────────────
  // The block above can only catch a bad fixture. These catch a bad TYPE: they drive the validator
  // that `RESEARCH_TASK_FIELDS` derives from, and that record is keyed on `keyof ResearchTask`, so
  // renaming or dropping an interface field breaks compilation here rather than passing quietly.
  describe("parseResearchTask", () => {
    it("rejects an Option field that arrives ABSENT rather than as null", () => {
      for (const field of OPTION_BACKED_FIELDS) {
        const broken = validTask();
        delete broken[field];
        expect(() => parseResearchTask(broken), `absent \`${field}\` must be rejected`).toThrow(
          ResearchTaskParseError,
        );
      }
    });

    it("accepts an Option field that arrives as an explicit null", () => {
      for (const field of OPTION_BACKED_FIELDS) {
        const nulled = { ...validTask(), [field]: null };
        expect(() => parseResearchTask(nulled)).not.toThrow();
      }
    });

    // A field renamed on the Rust side arrives as absent. Without this, only the six Option fields
    // were checked at all — `id`, `question`, `depth`, `projectRoot`, `createdAt` could all vanish
    // with the suite green.
    it("rejects a required field that is absent or null", () => {
      const required = (Object.keys(RESEARCH_TASK_FIELDS) as (keyof ResearchTask)[]).filter(
        (f) => RESEARCH_TASK_FIELDS[f] === "required",
      );
      expect(required.length).toBeGreaterThan(0);

      for (const field of required) {
        const missing = validTask();
        delete missing[field];
        expect(() => parseResearchTask(missing), `absent \`${field}\``).toThrow(
          ResearchTaskParseError,
        );
        expect(() => parseResearchTask({ ...validTask(), [field]: null }), `null \`${field}\``,
        ).toThrow(ResearchTaskParseError);
      }
    });

    it("rejects a status or depth outside the closed unions", () => {
      expect(() => parseResearchTask({ ...validTask(), status: "paused" })).toThrow(
        ResearchTaskParseError,
      );
      expect(() => parseResearchTask({ ...validTask(), depth: "exhaustive" })).toThrow(
        ResearchTaskParseError,
      );
    });

    it("rejects a non-object", () => {
      expect(() => parseResearchTask(null)).toThrow(ResearchTaskParseError);
      expect(() => parseResearchTask("a task")).toThrow(ResearchTaskParseError);
    });
  });

  // ── THE PARTITION ───────────────────────────────────────────────────────────────────────────
  // Two independent membership lists could leave a newly-added status neither live nor terminal —
  // uncounted by the row and never drained, with everything green. `phaseOf` is now one exhaustive
  // switch, so this is a real property rather than a coincidence of two lists agreeing.
  describe("phaseOf partitions the status union", () => {
    it("assigns every status exactly one phase, with none left over", () => {
      const live = RESEARCH_STATUSES.filter(isLivePhase);
      const terminal = RESEARCH_STATUSES.filter(isTerminal);
      expect(live.length + terminal.length).toBe(RESEARCH_STATUSES.length);
      expect(live.filter((s) => terminal.includes(s))).toEqual([]);
    });

    it("makes isLive the exact complement of isTerminal", () => {
      for (const status of RESEARCH_STATUSES) {
        expect(isLivePhase(status)).toBe(!isTerminal(status));
        expect(phaseOf(status)).toBe(isTerminal(status) ? "terminal" : "live");
      }
    });
  });

  it("says a queued task has not started and has no result", () => {
    const queued = byId(loadFixture(), "QUEUED");
    expect(queued.startedAt).toBeNull();
    expect(queued.finishedAt).toBeNull();
    expect(queued.findings).toBeNull();
  });

  describe("isTerminal", () => {
    it("is true for exactly the three states that never change again", () => {
      const terminal = RESEARCH_STATUSES.filter(isTerminal);
      expect(terminal).toEqual(["done", "failed", "cancelled"]);
    });

    it("is false while queued or running", () => {
      expect(isTerminal("queued")).toBe(false);
      expect(isTerminal("running")).toBe(false);
    });
  });

  describe("isLive — what the row's +[n] counts", () => {
    it("counts queued and running, and nothing else", () => {
      const live = loadFixture().filter(isLive).map((t) => t.status);
      expect(live.sort()).toEqual(["queued", "running"]);
    });
  });

  describe("isUnread — what the turn-start drain will fold into the preamble", () => {
    it("is true for a done task nobody has read", () => {
      expect(isUnread(byId(loadFixture(), "UNREAD_DONE"))).toBe(true);
    });

    // The claim is the whole delivery guarantee. If `readAt` stopped gating this, every finding
    // would be re-told on every turn forever.
    it("is false once readAt is stamped", () => {
      const read = byId(loadFixture(), "CLAIMED_DONE");
      expect(read.readAt).not.toBeNull();
      expect(isUnread(read)).toBe(false);
    });

    // A failed run has no findings, and telling the concierge "there are none" is not a finding.
    // Asserted rather than assumed because the natural implementation (`readAt === null`) would
    // wrongly include both of these.
    it("is false for a failed task, which has an error rather than findings", () => {
      const failed = byId(loadFixture(), "FAILED");
      expect(failed.readAt).toBeNull();
      expect(failed.error).not.toBeNull();
      expect(isUnread(failed)).toBe(false);
    });

    it("is false for a cancelled task, so a task the founder killed is never re-narrated", () => {
      const cancelled = byId(loadFixture(), "CANCELLED");
      expect(cancelled.readAt).toBeNull();
      expect(isUnread(cancelled)).toBe(false);
    });

    it("is false for a task still running", () => {
      expect(isUnread(byId(loadFixture(), "RUNNING"))).toBe(false);
    });
  });
});
