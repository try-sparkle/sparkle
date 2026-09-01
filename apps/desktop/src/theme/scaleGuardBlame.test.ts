// WHO PUT THIS LINE HERE — the unit tests for the ratchet-attribution helper.
//
// `blameSite` exists so a tree-wide ratchet can name the commit behind every site it lists, and
// sort the list newest-first, so the entry the CURRENT branch added is at the top instead of
// buried alphabetically. Two properties make or break it, and both are asserted here rather than
// discovered in CI:
//
//  1. IT DEGRADES, IT NEVER THROWS. The single most common case is a line the reader typed thirty
//     seconds ago and has not committed — `git blame` handles that, but a missing file, an
//     out-of-range line, and a directory that is not a git checkout all make it exit non-zero.
//     A ratchet that CRASHES instead of reporting its finding is strictly worse than one with
//     terse output, so every one of those must come back empty and quiet.
//
//  2. THE SORT IS NEWEST-FIRST, with an uncommitted line above every commit.
//
// Everything runs against a THROWAWAY repo built in a temp dir with pinned author dates, not
// against this checkout: a test that blames a real source line goes red the day someone touches
// that line, and one that asserts on real commit dates cannot pin an ORDER at all.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UNCOMMITTED_LABEL,
  UNATTRIBUTED_LABEL,
  attributeSites,
  attributedGuardReport,
  blameSite,
  blameInvocationCount,
  resetBlameInvocationCount,
} from "./scaleGuardTestUtils";

const OLD_DATE = "2020-01-02T03:04:05+00:00";
const NEW_DATE = "2024-06-07T08:09:10+00:00";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ...env },
  });
}

/** A repo with two files committed at KNOWN, different times, plus one uncommitted line. */
function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "scale-guard-blame-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "ratchet@example.invalid"]);
  git(dir, ["config", "user.name", "Ratchet Fixture"]);

  writeFileSync(join(dir, "old.ts"), "export const OLD = 1;\n");
  git(dir, ["add", "old.ts"]);
  git(dir, ["commit", "-q", "-m", "old"], {
    GIT_AUTHOR_DATE: OLD_DATE,
    GIT_COMMITTER_DATE: OLD_DATE,
  });

  writeFileSync(join(dir, "new.ts"), "export const NEW = 2;\n");
  git(dir, ["add", "new.ts"]);
  git(dir, ["commit", "-q", "-m", "new"], {
    GIT_AUTHOR_DATE: NEW_DATE,
    GIT_COMMITTER_DATE: NEW_DATE,
  });

  // The common case the whole feature is for: a line that exists on disk and in no commit.
  appendFileSync(join(dir, "new.ts"), "export const JUST_TYPED = 3;\n");
  // The OTHER shape of the same case: a whole file the reader just created. `git blame` refuses a
  // path with no index entry, so this used to read as "(unattributed)".
  writeFileSync(join(dir, "untracked.ts"), "export const BRAND_NEW = 4;\n");
  return dir;
}

let repo: string;
beforeAll(() => {
  repo = buildRepo();
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("blameSite attributes a line without ever throwing", () => {
  it("a committed line comes back with a sha, an author and a date", () => {
    const b = blameSite(join(repo, "old.ts"), 1);
    expect(b.known, "a plainly committed line was not attributed").toBe(true);
    expect(b.sha, "no sha for a committed line").toMatch(/^[0-9a-f]{7}$/);
    expect(b.author).toBe("Ratchet Fixture");
    expect(b.date).toBe("2020-01-02");
    expect(b.uncommitted).toBe(false);
    expect(b.time).toBeGreaterThan(0);
    expect(b.label).toBe(`${b.sha} 2020-01-02 Ratchet Fixture`);
  });

  it("an UNCOMMITTED line reads as the reader's own — the most useful answer it can give", () => {
    const b = blameSite(join(repo, "new.ts"), 2);
    expect(b.uncommitted, "an uncommitted line was not recognised as one").toBe(true);
    expect(b.label).toBe(UNCOMMITTED_LABEL);
    // It sorts above every commit, which is the whole point of flagging it.
    expect(b.time).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a brand-new UNTRACKED file reads as the reader's own, not as unattributable", () => {
    const b = blameSite(join(repo, "untracked.ts"), 1);
    expect(b.uncommitted, "a file the reader just created is the most attributable line there is").toBe(true);
    expect(b.label).toBe(UNCOMMITTED_LABEL);
  });

  it("a line PAST EOF of an untracked file is still unknown — presence is not authorship", () => {
    const b = blameSite(join(repo, "untracked.ts"), 400);
    expect(b.known).toBe(false);
    expect(b.uncommitted).toBe(false);
  });

  it("a NONEXISTENT file returns empty and does not throw", () => {
    let b!: ReturnType<typeof blameSite>;
    expect(() => {
      b = blameSite(join(repo, "no-such-file.ts"), 1);
    }, "a missing file must degrade, not crash the ratchet it is decorating").not.toThrow();
    expect(b.known).toBe(false);
    expect(b.sha).toBe("");
    expect(b.label).toBe("");
  });

  it("an OUT-OF-RANGE line returns empty and does not throw", () => {
    let b!: ReturnType<typeof blameSite>;
    expect(() => {
      b = blameSite(join(repo, "old.ts"), 9999);
    }, "a line past EOF must degrade, not crash").not.toThrow();
    expect(b.known).toBe(false);
    expect(b.label).toBe("");
  });

  it("a directory that is NOT a git checkout returns empty and does not throw", () => {
    const bare = mkdtempSync(join(tmpdir(), "scale-guard-nogit-"));
    try {
      writeFileSync(join(bare, "loose.ts"), "export const X = 1;\n");
      let b!: ReturnType<typeof blameSite>;
      expect(() => {
        b = blameSite(join(bare, "loose.ts"), 1);
      }, "outside a repo must degrade, not crash").not.toThrow();
      expect(b.known).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("a nonsense line number is rejected WITHOUT spawning git", () => {
    resetBlameInvocationCount();
    for (const line of [0, -1, 1.5, Number.NaN]) {
      expect(blameSite(join(repo, "old.ts"), line).known).toBe(false);
    }
    expect(blameInvocationCount(), "a bad line number should cost no process").toBe(0);
  });
});

describe("attributeSites orders the list so the new entry is on top", () => {
  it("sorts newest-commit-first, with an uncommitted line above every commit", () => {
    const sites = [
      // Deliberately handed over OLDEST-first — the order a file-walk produces, and the order
      // that buries the interesting entry at the bottom of the list.
      { file: "old.ts", line: 1, text: "the older commit" },
      { file: "new.ts", line: 1, text: "the newer commit" },
      { file: "new.ts", line: 2, text: "the line just typed" },
    ];
    const got = attributeSites(repo, sites);
    expect(got.map((s) => `${s.file}:${s.line}`)).toEqual(["new.ts:2", "new.ts:1", "old.ts:1"]);
    expect(got[0]!.blame.uncommitted).toBe(true);
    expect(got[1]!.blame.date).toBe("2024-06-07");
    expect(got[2]!.blame.date).toBe("2020-01-02");
  });

  it("an unattributable site sinks to the BOTTOM rather than scrambling the order", () => {
    const got = attributeSites(repo, [
      { file: "gone.ts", line: 1, text: "cannot be blamed" },
      { file: "old.ts", line: 1, text: "the older commit" },
    ]);
    expect(got.map((s) => s.file)).toEqual(["old.ts", "gone.ts"]);
  });
});

describe("the report spends the failure message on what the reader needs", () => {
  it("carries sha, date, author, file:line, the offending text and the remedy", () => {
    const msg = attributedGuardReport({
      root: repo,
      headline: "3 sites vs ceiling 2.",
      remedy: "Spread the shared treatment instead.",
      sites: [
        { file: "old.ts", line: 1, text: "the older commit" },
        { file: "new.ts", line: 1, text: "the newer commit" },
      ],
    });
    const sha = blameSite(join(repo, "new.ts"), 1).sha;
    expect(msg).toContain("3 sites vs ceiling 2.");
    expect(msg).toContain("NEWEST COMMIT FIRST");
    expect(msg).toContain(sha);
    expect(msg).toContain("2024-06-07 Ratchet Fixture");
    expect(msg).toContain("new.ts:1");
    expect(msg).toContain("the newer commit");
    expect(msg).toContain("Spread the shared treatment instead.");
    // Newest first, in the rendered text as well as in the array.
    expect(msg.indexOf("new.ts:1")).toBeLessThan(msg.indexOf("old.ts:1"));
  });

  it("renders a placeholder — not a crash, and not a blank column — for an unblamable site", () => {
    const msg = attributedGuardReport({
      root: repo,
      headline: "1 site.",
      remedy: "Fix it.",
      sites: [{ file: "gone.ts", line: 1, text: "cannot be blamed" }],
    });
    expect(msg).toContain(UNATTRIBUTED_LABEL);
    expect(msg).toContain("gone.ts:1");
  });
});
