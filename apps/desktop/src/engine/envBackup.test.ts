import { describe, it, expect } from "vitest";
import {
  backupTitle,
  parseBackupTitle,
  joinBackups,
  summarize,
  rowsNeedingBackup,
  type EnvBackupRow,
} from "./envBackup";
import type { EnvFile, OpBackupRecord, ScanRoot } from "../services/onepassword";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function file(projectName: string, relPath: string, sha256 = HASH_A, over: Partial<EnvFile> = {}): EnvFile {
  return {
    projectId: `id-${projectName}`,
    projectName,
    relPath,
    absPath: `/Users/dev/${projectName}/${relPath}`,
    sizeBytes: 128,
    sha256,
    modifiedAt: "2026-07-24T12:00:00Z",
    ...over,
  };
}

function record(title: string, sha256 = HASH_A, over: Partial<OpBackupRecord> = {}): OpBackupRecord {
  return {
    itemId: `item-${title}`,
    title,
    sha256,
    updatedAt: "2026-07-24T11:00:00Z",
    ...over,
  };
}

function root(projectName: string): ScanRoot {
  return { projectId: `id-${projectName}`, projectName, rootPath: `/Users/dev/${projectName}` };
}

const byTitle = (rows: readonly EnvBackupRow[]) => rows.map((r) => r.title);
const statusOf = (rows: readonly EnvBackupRow[], title: string) => rows.find((r) => r.title === title)?.status;

// ── backupTitle ─────────────────────────────────────────────────────────────────────────────

describe("backupTitle", () => {
  it("joins project name and relative path with a slash", () => {
    expect(backupTitle("sparkle", ".env.local")).toBe("sparkle/.env.local");
  });

  it("preserves nested paths verbatim", () => {
    expect(backupTitle("sparkle", "apps/web/.env.local")).toBe("sparkle/apps/web/.env.local");
  });

  it("normalizes backslash separators to forward slashes", () => {
    expect(backupTitle("sparkle", "apps\\web\\.env.local")).toBe("sparkle/apps/web/.env.local");
  });

  it("collapses duplicate slashes so one file cannot get two titles", () => {
    expect(backupTitle("sparkle", "apps//web/.env.local")).toBe("sparkle/apps/web/.env.local");
  });

  it("strips a leading ./ and a leading slash", () => {
    expect(backupTitle("sparkle", "./.env.local")).toBe("sparkle/.env.local");
    expect(backupTitle("sparkle", "/.env.local")).toBe("sparkle/.env.local");
  });

  it("trims surrounding whitespace on both inputs", () => {
    expect(backupTitle("  sparkle  ", "  .env.local  ")).toBe("sparkle/.env.local");
  });

  // The documented judgment call: a slash in the PROJECT name is flattened, so the first `/` in a
  // title always separates project from path (which is what op_seed_worktree splits on).
  it("flattens a slash inside the project name to a dash, keeping the split unambiguous", () => {
    expect(backupTitle("acme/web", ".env.local")).toBe("acme-web/.env.local");
    expect(parseBackupTitle(backupTitle("acme/web", ".env.local"))).toEqual({
      projectName: "acme-web",
      relPath: ".env.local",
    });
  });

  it("is stable: the same inputs always produce the same title", () => {
    expect(backupTitle("sparkle", "apps/web/.env.local")).toBe(backupTitle("sparkle", "apps\\web\\.env.local"));
  });
});

describe("parseBackupTitle", () => {
  it("splits on the FIRST slash so nested paths survive", () => {
    expect(parseBackupTitle("sparkle/apps/web/.env.local")).toEqual({
      projectName: "sparkle",
      relPath: "apps/web/.env.local",
    });
  });

  it("treats a slashless title as a project with an empty path rather than dropping it", () => {
    expect(parseBackupTitle("orphan")).toEqual({ projectName: "orphan", relPath: "" });
  });
});

// ── joinBackups: status derivation ──────────────────────────────────────────────────────────

describe("joinBackups status", () => {
  it("reports a file with no vault record as not-backed-up", () => {
    const rows = joinBackups([file("sparkle", ".env.local")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("not-backed-up");
    expect(rows[0]?.record).toBeNull();
    expect(rows[0]?.file?.absPath).toBe("/Users/dev/sparkle/.env.local");
  });

  it("reports matching hashes as in-sync", () => {
    const rows = joinBackups([file("sparkle", ".env.local", HASH_A)], [record("sparkle/.env.local", HASH_A)]);
    expect(rows[0]?.status).toBe("in-sync");
    expect(rows[0]?.record?.itemId).toBe("item-sparkle/.env.local");
  });

  it("reports differing hashes as drifted", () => {
    const rows = joinBackups([file("sparkle", ".env.local", HASH_A)], [record("sparkle/.env.local", HASH_B)]);
    expect(rows[0]?.status).toBe("drifted");
  });

  it("compares hex case-insensitively — uppercase on one side is not drift", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A.toUpperCase())],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rows[0]?.status).toBe("in-sync");
  });

  it("tolerates stray whitespace around a hash read back from a vault text field", () => {
    const rows = joinBackups([file("sparkle", ".env.local", HASH_A)], [record("sparkle/.env.local", ` ${HASH_A}\n`)]);
    expect(rows[0]?.status).toBe("in-sync");
  });

  it("treats an empty vault hash as drift rather than claiming the file is safe", () => {
    const rows = joinBackups([file("sparkle", ".env.local", HASH_A)], [record("sparkle/.env.local", "")]);
    expect(rows[0]?.status).toBe("drifted");
  });

  it("ignores size and mtime — only the hash decides", () => {
    const sameHashBiggerFile = file("sparkle", ".env.local", HASH_A, {
      sizeBytes: 999_999,
      modifiedAt: "2030-01-01T00:00:00Z",
    });
    const rows = joinBackups([sameHashBiggerFile], [record("sparkle/.env.local", HASH_A)]);
    expect(rows[0]?.status).toBe("in-sync");
  });

  it("reports a vault record with no file on disk as missing-locally", () => {
    const rows = joinBackups([], [record("sparkle/.env.local")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("missing-locally");
    expect(rows[0]?.file).toBeNull();
    expect(rows[0]?.projectName).toBe("sparkle");
    expect(rows[0]?.relPath).toBe(".env.local");
  });

  it("recovers project and path for a missing-locally row from the title alone", () => {
    const rows = joinBackups([], [record("sparkle/apps/web/.env.local")]);
    expect(rows[0]?.projectName).toBe("sparkle");
    expect(rows[0]?.relPath).toBe("apps/web/.env.local");
  });

  it("joins a record whose title used backslashes against today's file", () => {
    const rows = joinBackups(
      [file("sparkle", "apps/web/.env.local", HASH_A)],
      [record("sparkle\\apps\\web\\.env.local", HASH_A)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("in-sync");
  });
});

// ── joinBackups: the collision case a naive relPath key gets wrong ───────────────────────────

describe("joinBackups keying", () => {
  it("does not collide when two projects each hold the SAME relPath", () => {
    const files = [file("sparkle", ".env.local", HASH_A), file("other", ".env.local", HASH_B)];
    const records = [record("sparkle/.env.local", HASH_A), record("other/.env.local", HASH_B)];
    const rows = joinBackups(files, records);

    expect(rows).toHaveLength(2);
    expect(byTitle(rows)).toEqual(["other/.env.local", "sparkle/.env.local"]);
    expect(statusOf(rows, "sparkle/.env.local")).toBe("in-sync");
    expect(statusOf(rows, "other/.env.local")).toBe("in-sync");
  });

  it("does not read one project's hash against another project's file", () => {
    // Keyed by relPath alone, `other`'s file (HASH_B) would pair with `sparkle`'s record (HASH_A)
    // and BOTH rows would come back wrong. Only `other` has drifted here.
    const files = [file("sparkle", ".env.local", HASH_A), file("other", ".env.local", HASH_B)];
    const records = [record("sparkle/.env.local", HASH_A), record("other/.env.local", HASH_A)];
    const rows = joinBackups(files, records);

    expect(statusOf(rows, "sparkle/.env.local")).toBe("in-sync");
    expect(statusOf(rows, "other/.env.local")).toBe("drifted");
  });

  it("keeps same-named files in different sub-paths of one project distinct", () => {
    const files = [file("sparkle", ".env.local", HASH_A), file("sparkle", "apps/web/.env.local", HASH_B)];
    const rows = joinBackups(files, [record("sparkle/.env.local", HASH_A)]);

    expect(byTitle(rows)).toEqual(["sparkle/.env.local", "sparkle/apps/web/.env.local"]);
    expect(statusOf(rows, "sparkle/.env.local")).toBe("in-sync");
    expect(statusOf(rows, "sparkle/apps/web/.env.local")).toBe("not-backed-up");
  });

  it("collapses byte-identical duplicates into one in-sync row, with no conflict noise", () => {
    // Same title, same bytes (`.env.local` and `./.env.local` normalize together). There is
    // genuinely one file here, so one row and no warning.
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A), file("sparkle", "./.env.local", HASH_A)],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("in-sync");
    expect(rows[0]?.conflicts).toBeUndefined();
  });

  it("never reports in-sync when a colliding duplicate has DIFFERENT bytes", () => {
    // The dangerous case. Two distinct files collapse onto one title (colliding project names,
    // two worktrees of one repo, overlapping scan roots). The first matches the vault copy; the
    // second does not. Dropping the loser silently would tell the user everything is backed up
    // while a drifted file sits unbacked — so the row escalates to drifted and counts the
    // collision instead.
    // Explicit absPaths: the kept file is chosen by lowest absPath (stable across input order), and
    // here that winner is the one MATCHING the vault — so the row is conflicted but has nothing to
    // upload, and offering it would leave the button lit forever.
    const rows = joinBackups(
      [
        file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" }),
        file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" }),
      ],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("drifted");
    expect(rows[0]?.conflicts).toBe(1);
    expect(rowsNeedingBackup(rows)).toHaveLength(0);
  });

  it("resolves duplicate vault items with the same title first-wins", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A)],
      [record("sparkle/.env.local", HASH_A, { itemId: "first" }), record("sparkle/.env.local", HASH_B, { itemId: "second" })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record?.itemId).toBe("first");
    expect(rows[0]?.status).toBe("in-sync");
  });
});

// ── joinBackups: scan scope ─────────────────────────────────────────────────────────────────

describe("joinBackups scan scope", () => {
  it("omits records for projects that were never scanned when roots are supplied", () => {
    const rows = joinBackups([file("sparkle", ".env.local")], [record("sparkle/.env.local"), record("other/.env")], {
      roots: [root("sparkle")],
    });
    expect(byTitle(rows)).toEqual(["sparkle/.env.local"]);
  });

  it("still reports missing-locally for a project that WAS scanned", () => {
    const rows = joinBackups([file("sparkle", ".env.local")], [record("sparkle/.env.local"), record("sparkle/.env")], {
      roots: [root("sparkle")],
    });
    expect(statusOf(rows, "sparkle/.env")).toBe("missing-locally");
  });

  it("reports every unmatched record as missing-locally when no roots are supplied", () => {
    const rows = joinBackups([], [record("sparkle/.env.local"), record("other/.env")]);
    expect(byTitle(rows)).toEqual(["other/.env", "sparkle/.env.local"]);
    expect(rows.every((r) => r.status === "missing-locally")).toBe(true);
  });

  it("matches scan roots against the same normalized project name a title uses", () => {
    const rows = joinBackups([], [record("acme-web/.env.local")], { roots: [root("acme/web")] });
    expect(byTitle(rows)).toEqual(["acme-web/.env.local"]);
  });
});

// ── joinBackups: ordering ───────────────────────────────────────────────────────────────────

describe("joinBackups ordering", () => {
  it("groups by project, then sorts by relPath, regardless of input order", () => {
    const files = [
      file("zeta", ".env.local"),
      file("alpha", "apps/web/.env.local"),
      file("alpha", ".env"),
      file("alpha", ".env.local"),
      file("mid", ".env.local"),
    ];
    const rows = joinBackups(files, []);
    expect(byTitle(rows)).toEqual([
      "alpha/.env",
      "alpha/.env.local",
      "alpha/apps/web/.env.local",
      "mid/.env.local",
      "zeta/.env.local",
    ]);
  });

  it("produces the same order no matter how the inputs are shuffled", () => {
    const files = [file("zeta", ".env"), file("alpha", ".env.local"), file("mid", "apps/api/.env")];
    const records = [record("mid/apps/api/.env"), record("alpha/.env.local")];
    const forward = byTitle(joinBackups(files, records));
    const reversed = byTitle(joinBackups([...files].reverse(), [...records].reverse()));
    expect(reversed).toEqual(forward);
  });

  it("interleaves missing-locally rows into the same grouping, not a separate tail", () => {
    const rows = joinBackups([file("beta", ".env.local")], [record("alpha/.env.local"), record("gamma/.env.local")]);
    expect(byTitle(rows)).toEqual(["alpha/.env.local", "beta/.env.local", "gamma/.env.local"]);
  });

  it("orders case-insensitively so casing does not scatter a project's files", () => {
    const rows = joinBackups([file("Beta", ".env"), file("alpha", ".env"), file("beta", ".env.local")], []);
    expect(byTitle(rows)).toEqual(["alpha/.env", "Beta/.env", "beta/.env.local"]);
  });

  it("is a total order — identical lowercase names still sort deterministically", () => {
    const a = byTitle(joinBackups([file("Beta", ".env"), file("beta", ".env")], []));
    const b = byTitle(joinBackups([file("beta", ".env"), file("Beta", ".env")], []));
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });
});

// ── summarize ───────────────────────────────────────────────────────────────────────────────

describe("summarize", () => {
  const mixed = () =>
    joinBackups(
      [
        file("alpha", ".env.local", HASH_A), // in-sync
        file("alpha", ".env.prod", HASH_A), // drifted
        file("beta", ".env.local", HASH_A), // not-backed-up
      ],
      [
        record("alpha/.env.local", HASH_A),
        record("alpha/.env.prod", HASH_B),
        record("gamma/.env.local", HASH_A), // missing-locally
      ],
    );

  it("counts every status and totals the rows", () => {
    expect(summarize(mixed())).toEqual({
      total: 4,
      inSync: 1,
      drifted: 1,
      notBackedUp: 1,
      missingLocally: 1,
      needsBackup: 2,
      canBackUpAll: true,
    });
  });

  it("returns all zeros and a disabled button for no rows", () => {
    expect(summarize([])).toEqual({
      total: 0,
      inSync: 0,
      drifted: 0,
      notBackedUp: 0,
      missingLocally: 0,
      needsBackup: 0,
      canBackUpAll: false,
    });
  });

  it("disables Back up all when everything is already in sync", () => {
    const rows = joinBackups([file("alpha", ".env.local", HASH_A)], [record("alpha/.env.local", HASH_A)]);
    const s = summarize(rows);
    expect(s.inSync).toBe(1);
    expect(s.canBackUpAll).toBe(false);
  });

  it("disables Back up all when the only rows are missing-locally — a click would upload nothing", () => {
    const s = summarize(joinBackups([], [record("alpha/.env.local")]));
    expect(s.missingLocally).toBe(1);
    expect(s.needsBackup).toBe(0);
    expect(s.canBackUpAll).toBe(false);
  });

  it("enables Back up all for a single drifted file", () => {
    const rows = joinBackups([file("alpha", ".env.local", HASH_A)], [record("alpha/.env.local", HASH_B)]);
    expect(summarize(rows).canBackUpAll).toBe(true);
  });

  it("enables Back up all for a single never-backed-up file", () => {
    expect(summarize(joinBackups([file("alpha", ".env.local")], [])).canBackUpAll).toBe(true);
  });

  it("keeps canBackUpAll exactly equal to needsBackup > 0 across every combination", () => {
    const rows = mixed();
    for (let i = 0; i <= rows.length; i++) {
      const slice = rows.slice(0, i);
      const s = summarize(slice);
      expect(s.canBackUpAll).toBe(s.needsBackup > 0);
      // The load-bearing invariant: the COUNT the button shows is the number of rows the click
      // would actually upload. `drifted + notBackedUp` is only an upper bound now, since a
      // conflicted row whose kept file is already in the vault has nothing to send.
      // Structural (documents the contract) …
      expect(s.needsBackup).toBe(rowsNeedingBackup(slice).length);
      expect(s.needsBackup).toBeLessThanOrEqual(s.drifted + s.notBackedUp);
      // … and independently computed, so the pair actually carries information: with no conflicts
      // in this fixture, every drifted/never-backed-up row is uploadable.
      expect(s.needsBackup).toBe(
        slice.filter((r) => r.status === "drifted" || r.status === "not-backed-up").length,
      );
      expect(s.total).toBe(s.inSync + s.drifted + s.notBackedUp + s.missingLocally);
    }
  });

  it("does not count a conflicted-but-unuploadable row as needing backup", () => {
    // The regression that shipped: summarize counted it, rowsNeedingBackup didn't, and the pane
    // rendered an enabled "Back up 1" whose click uploaded nothing and left the button lit.
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" }), file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" })],
      [record("sparkle/.env.local", HASH_A)],
    );
    const s = summarize(rows);
    expect(s.drifted).toBe(1);
    expect(s.needsBackup).toBe(0);
    expect(s.canBackUpAll).toBe(false);
    expect(rowsNeedingBackup(rows)).toHaveLength(0);
  });
});

// ── rowsNeedingBackup ───────────────────────────────────────────────────────────────────────

describe("rowsNeedingBackup", () => {
  const rows = () =>
    joinBackups(
      [
        file("alpha", ".env.local", HASH_A), // in-sync
        file("alpha", ".env.prod", HASH_A), // drifted
        file("beta", ".env.local", HASH_A), // not-backed-up
      ],
      [record("alpha/.env.local", HASH_A), record("alpha/.env.prod", HASH_B), record("gamma/.env.local", HASH_A)],
    );

  it("returns exactly the drifted and never-backed-up rows", () => {
    expect(byTitle(rowsNeedingBackup(rows()))).toEqual(["alpha/.env.prod", "beta/.env.local"]);
  });

  it("excludes in-sync rows", () => {
    expect(rowsNeedingBackup(rows()).some((r) => r.status === "in-sync")).toBe(false);
  });

  it("excludes missing-locally rows — there is no local file to upload", () => {
    expect(rowsNeedingBackup(rows()).some((r) => r.status === "missing-locally")).toBe(false);
  });

  it("every returned row carries a file, so the caller always has an absPath for op", () => {
    for (const row of rowsNeedingBackup(rows())) expect(row.file).not.toBeNull();
  });

  it("agrees with summarize().needsBackup", () => {
    const all = rows();
    expect(rowsNeedingBackup(all)).toHaveLength(summarize(all).needsBackup);
  });

  it("agrees with summarize().needsBackup when conflicted rows are in play", () => {
    // Both flavours of conflict at once: one whose kept file is already in the vault (not
    // uploadable) and one whose kept file differs (uploadable). The two functions must still agree.
    const withConflicts = joinBackups(
      [
        file("alpha", ".env.local", HASH_A),
        file("alpha", ".env.local", HASH_B), // conflicts, kept matches the vault
        file("beta", ".env.local", HASH_B),
        file("beta", ".env.local", HASH_C), // conflicts, kept differs from the vault
      ],
      [record("alpha/.env.local", HASH_A), record("beta/.env.local", HASH_A)],
    );
    expect(rowsNeedingBackup(withConflicts)).toHaveLength(summarize(withConflicts).needsBackup);
    expect(summarize(withConflicts).needsBackup).toBe(1);
  });

  it("preserves the display order of the rows it is given", () => {
    const all = rows();
    const kept = rowsNeedingBackup(all);
    expect(byTitle(kept)).toEqual(byTitle(all).filter((t) => byTitle(kept).includes(t)));
  });

  it("returns an empty array when nothing needs backing up", () => {
    const inSyncOnly = joinBackups([file("alpha", ".env.local", HASH_A)], [record("alpha/.env.local", HASH_A)]);
    expect(rowsNeedingBackup(inSyncOnly)).toEqual([]);
  });
});

describe("title safety — a vault title is untrusted input", () => {
  // Titles are free text a human can rename inside 1Password, and op_seed_worktree recreates the
  // layout a title encodes UNDER a destination root. So a traversing title is a request to write
  // a secret outside the worktree. Rust rejects these independently; these tests pin the guard on
  // the TS side, which is where titles are derived and parsed.

  it("refuses to build a title from a traversing relPath", () => {
    expect(backupTitle("sparkle", "../../../.ssh/config")).toBe("sparkle/");
    expect(backupTitle("sparkle", "apps/../../.ssh/config")).toBe("sparkle/");
  });

  it("strips . segments but keeps the real path", () => {
    expect(backupTitle("sparkle", "apps/./web/.env.local")).toBe("sparkle/apps/web/.env.local");
  });

  it("drops a traversing vault record instead of offering it as a restorable row", () => {
    const rows = joinBackups([], [record("sparkle/../../../.ssh/config", HASH_A)]);
    expect(rows).toHaveLength(0);
  });

  it("drops a slashless vault title rather than inventing a 'proj/' item", () => {
    // parseBackupTitle("orphan") gives relPath "", and re-deriving would produce "orphan/" — not
    // the item's real title. Since opBackup requires a title, such a row would edit the WRONG
    // item, so it must not become a row at all.
    const rows = joinBackups([], [record("orphan", HASH_A)]);
    expect(rows).toHaveLength(0);
  });

  it("carries a missing-locally row's OWN vault title, not a re-derived one", () => {
    // A record hand-titled with a backslash still joins, but any write must target the title the
    // vault actually holds.
    const rec = record("sparkle\\apps\\web\\.env.local", HASH_A);
    const rows = joinBackups([], [rec]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("missing-locally");
    expect(rows[0]?.title).toBe(rec.title);
    expect(rows[0]?.relPath).toBe("apps/web/.env.local");
  });
});

describe("title safety — the guard is symmetric across both loops", () => {
  it("drops a SCANNED file whose path normalizes away, as the records side already does", () => {
    // Asymmetry was the bug: a traversing relPath yields the title "sparkle/", which the records
    // loop refuses on sight — so backing it up would have created a vault item nothing could ever
    // see again, and every such file in a project would collapse onto that one title.
    const rows = joinBackups(
      [file("sparkle", "../../../.ssh/config", HASH_A), file("sparkle", ".env.local", HASH_B)],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relPath).toBe(".env.local");
  });

  it("drops a record whose RAW title traverses in its FIRST segment", () => {
    // The case only the raw-title check catches: `../.ssh/config` parses to projectName ".." with a
    // NON-empty relPath, so the `relPath === ""` branch lets it through. Deleting the raw-title
    // check makes this test fail — which the previous version of it did not.
    const rows = joinBackups([], [record("../.ssh/config", HASH_A)]);
    expect(rows).toHaveLength(0);
  });

  it("drops a SCANNED file whose PROJECT NAME traverses", () => {
    // normalizeProjectName only flattens slashes, so ".." survives it and yields "../.env.local" —
    // the same unrestorable vault item as a traversing path, via the other title segment.
    const rows = joinBackups([file("..", ".env.local", HASH_A)], []);
    expect(rows).toHaveLength(0);
  });
});

describe("duplicate titles — conflicts must be honest AND resolvable", () => {
  it("counts a differing duplicate as a conflict and forces the row to drifted", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" }), file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" })],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conflicts).toBe(1);
    expect(rows[0]?.status).toBe("drifted");
  });

  it("does NOT offer a conflicted row whose kept file is ALREADY in the vault", () => {
    // Uploading the kept file changes nothing and the next join re-derives the same conflict: the
    // button would stay lit forever, adding a redundant version to the item's history per click.
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" }), file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" })],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rowsNeedingBackup(rows)).toHaveLength(0);
    expect(summarize(rows).needsBackup).toBe(0);
    expect(summarize(rows).canBackUpAll).toBe(false);
  });

  it("DOES offer a conflicted row whose kept file genuinely differs from the vault", () => {
    // The opposite sub-case, and the one a blanket exclusion got wrong: this row holds a real
    // unbacked-up secret, and the pane has no per-row backup, so refusing it would leave the file
    // unbackable entirely. The conflict warning stays on the row either way.
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_B, { absPath: "/a/.env.local" }), file("sparkle", ".env.local", HASH_C, { absPath: "/b/.env.local" })],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rows[0]?.conflicts).toBe(1);
    expect(rowsNeedingBackup(rows)).toHaveLength(1);
    expect(summarize(rows).needsBackup).toBe(1);
  });

  it("offers a conflicted row that has never been backed up at all", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" }), file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" })],
      [],
    );
    expect(rows[0]?.conflicts).toBe(1);
    expect(rowsNeedingBackup(rows)).toHaveLength(1);
  });

  it("picks the SAME winner regardless of input order — the winner's bytes are what gets uploaded", () => {
    // A conflicted row can be backed up, so which duplicate wins decides which secret is uploaded
    // under that title. First-wins would make that the user's project ORDER: reorder the projects
    // and the next "Back up all" overwrites the item with a different file.
    const a = file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" });
    const b = file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" });
    const forward = joinBackups([a, b], []);
    const reverse = joinBackups([b, a], []);
    expect(forward[0]?.file?.absPath).toBe("/a/.env.local");
    expect(reverse[0]?.file?.absPath).toBe("/a/.env.local");
    expect(forward[0]?.conflicts).toBe(1);
    expect(reverse[0]?.conflicts).toBe(1);
  });

  it("never reports in-sync while a conflicting file sits unbacked, even if the winner matches", () => {
    // The winner's OWN bytes are in the vault, so a naive status read says in-sync — but another
    // file under this title is genuinely different and unbacked. Claiming in-sync here is the one
    // lie this pane must never tell, so a conflicted row is always drifted.
    const a = file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" });
    const b = file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local" });
    const rows = joinBackups([b, a], [record("sparkle/.env.local", HASH_A)]);
    expect(rows[0]?.file?.absPath).toBe("/a/.env.local");
    expect(rows[0]?.conflicts).toBe(1);
    expect(rows[0]?.status).toBe("drifted");
    // Not uploadable: re-uploading the winner it already holds could never clear the conflict, so
    // the button would stay lit forever.
    expect(rowsNeedingBackup(rows)).toHaveLength(0);
  });

  it("keeps status and conflicts independent of input order with THREE colliding files", () => {
    // Two files can't see this: the bug needed an escalation recorded against an EARLIER duplicate
    // to be thrown away when a later file won. Hashes H1/H2/H1 with a vault record of H1 could
    // settle on in-sync — summary would claim everything was backed up while H2 sat unbacked.
    const a = file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" });
    const b = file("sparkle", ".env.local", HASH_A, { absPath: "/b/.env.local" });
    const c = file("sparkle", ".env.local", HASH_B, { absPath: "/c/.env.local" });
    const vault = [record("sparkle/.env.local", HASH_A)];

    for (const order of [
      [b, c, a],
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      const rows = joinBackups(order, vault);
      expect(rows).toHaveLength(1);
      // Winner is intrinsic (lowest absPath), and so are the two fields derived from it.
      expect(rows[0]?.file?.absPath).toBe("/a/.env.local");
      expect(rows[0]?.status).toBe("drifted");
      // Exactly ONE of the other two differs from the winner — /b matches it, /c does not. The
      // count is "differs from the FINAL winner", not "differed from whoever was kept at the time".
      expect(rows[0]?.conflicts).toBe(1);
      expect(summarize(rows).inSync).toBe(0);
    }
  });

  it("counts EVERY differing duplicate, not just whether any differed", () => {
    // Nothing pinned conflicts above 1, so the whole counting loop could have been
    // `conflicts = anyDiffer ? 1 : 0` and stayed green — while the pane renders this number at the
    // user. Three mutually different files: both losers differ from the winner.
    // DISTINCT projectIds: the `file()` helper derives projectId from the project NAME, so three
    // fixtures under one project all share it and an assertion on projectId could never fail.
    const a = file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local", projectId: "id-a" });
    const b = file("sparkle", ".env.local", HASH_B, { absPath: "/b/.env.local", projectId: "id-b" });
    const c = file("sparkle", ".env.local", HASH_C, { absPath: "/c/.env.local", projectId: "id-c" });
    for (const order of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ]) {
      const rows = joinBackups(order, [record("sparkle/.env.local", HASH_A)]);
      expect(rows[0]?.conflicts).toBe(2);
      expect(rows[0]?.file?.absPath).toBe("/a/.env.local");
      // The winner supplies projectId too — it's what the pane navigates from, so it must not be
      // "whichever file the scan happened to yield first".
      expect(rows[0]?.projectId).toBe("id-a");
      expect(rows[0]?.status).toBe("drifted");
    }
  });

  it("keeps the FRESHEST snapshot of a re-scanned file, and never warns about it", () => {
    // One file scanned either side of an edit: same absPath, same projectId, different bytes. It is
    // ONE file — the pane must not warn that it conflicts with itself — and the snapshot kept must
    // be the newer one, because the bytes are re-read from disk at upload time. Backing up a stale
    // digest records a sha that never matches what was uploaded, and the row reports drift forever.
    const stale = file("sparkle", ".env.local", HASH_A, {
      absPath: "/same/.env.local",
      modifiedAt: "2026-07-24T12:00:00Z",
    });
    const fresh = file("sparkle", ".env.local", HASH_B, {
      absPath: "/same/.env.local",
      modifiedAt: "2026-07-25T09:30:00Z",
    });
    for (const order of [
      [stale, fresh],
      [fresh, stale],
    ]) {
      const rows = joinBackups(order, []);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.file?.sha256, "the freshest snapshot must win").toBe(HASH_B);
      expect(rows[0]?.conflicts, "one file cannot conflict with itself").toBeUndefined();
    }
  });

  it("falls back to content only to break a same-mtime tie, so the winner stays deterministic", () => {
    // Two snapshots that even share an mtime: nothing distinguishes them but the bytes, and the
    // choice still must not depend on input order.
    const one = file("sparkle", ".env.local", HASH_A, { absPath: "/same/.env.local" });
    const two = file("sparkle", ".env.local", HASH_B, { absPath: "/same/.env.local" });
    expect(joinBackups([one, two], [])[0]?.file?.sha256).toBe(HASH_A);
    expect(joinBackups([two, one], [])[0]?.file?.sha256).toBe(HASH_A);
  });

  it("does not warn about ONE file listed twice, even when its hash is unknown", () => {
    // absPath is a file's identity: a caller concatenating two scans lists the same physical file
    // twice, and the second listing is not a second file to warn about. Counting by object identity
    // (or by index) got this right only when both copies carried a known, equal hash — with an
    // unknown hash it warned about a conflict between a file and itself.
    const twice = file("sparkle", ".env.local", "", { absPath: "/repo/.env.local" });
    const rows = joinBackups([twice, { ...twice }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conflicts).toBeUndefined();
  });

  it("breaks an absPath TIE by projectId so the row never depends on scan order", () => {
    // Two registrations of the same directory (or two project names normalizing to one title) give
    // the same absPath with different projectIds. absPath alone left the winner — and therefore the
    // row's projectId — to input order, which is the one thing this join promises not to do.
    const one = file("sparkle", ".env.local", HASH_A, { absPath: "/same/.env.local", projectId: "id-1" });
    const two = file("sparkle", ".env.local", HASH_A, { absPath: "/same/.env.local", projectId: "id-2" });
    expect(joinBackups([one, two], [])[0]?.projectId).toBe("id-1");
    expect(joinBackups([two, one], [])[0]?.projectId).toBe("id-1");
  });

  it("reports no conflict when every colliding duplicate is byte-identical", () => {
    const a = file("sparkle", ".env.local", HASH_A, { absPath: "/a/.env.local" });
    const b = file("sparkle", ".env.local", HASH_A, { absPath: "/b/.env.local" });
    const c = file("sparkle", ".env.local", HASH_A, { absPath: "/c/.env.local" });
    const rows = joinBackups([c, a, b], [record("sparkle/.env.local", HASH_A)]);
    expect(rows[0]?.conflicts).toBeUndefined();
    expect(rows[0]?.status).toBe("in-sync");
  });

  it("warns on duplicates whose hashes are UNKNOWN rather than collapsing them silently", () => {
    // One rule everywhere: warn unless the files are PROVABLY identical. An unknown hash is not
    // evidence of sameness, and silently dropping the loser is the one lie this pane must not tell.
    // A conservative warning costs a look; a missing one costs a secret.
    //
    // The two fixtures need DISTINCT absPaths to mean what this test says. Built from the `file()`
    // helper alone they were identical in every field — indistinguishable from one file listed
    // twice, which is the case the test above says must NOT warn. Two different files always differ
    // in absPath; that is what makes them different files.
    const rows = joinBackups(
      [
        file("sparkle", ".env.local", "", { absPath: "/one/.env.local" }),
        file("sparkle", ".env.local", "", { absPath: "/two/.env.local" }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conflicts).toBe(1);
  });

  it("keeps an unconflicted drifted row backable", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_B)],
      [record("sparkle/.env.local", HASH_A)],
    );
    expect(rowsNeedingBackup(rows)).toHaveLength(1);
  });
});

describe("summarize — an unknown status fails loudly", () => {
  it("throws rather than returning a bare string when a row carries an unexpected status", () => {
    // The compile-time `never` guard cannot see a row that arrived over IPC. Without the throw the
    // function returns a string and every caller reads `summary.total === undefined`.
    const bogus = { title: "x/y", projectName: "x", relPath: "y", file: null, record: null, status: "weird" };
    expect(() => summarize([bogus as unknown as EnvBackupRow])).toThrow(/unhandled env backup status/);
  });
});

describe("row provenance", () => {
  it("carries projectId on scanned rows and omits it where only a title is known", () => {
    const rows = joinBackups(
      [file("sparkle", ".env.local", HASH_A)],
      [record("sparkle/.env.local", HASH_A), record("sparkle/apps/web/.env.local", HASH_B)],
    );
    const scanned = rows.find((r) => r.relPath === ".env.local");
    const gone = rows.find((r) => r.status === "missing-locally");
    expect(scanned?.projectId).toBeTruthy();
    // missing-locally rows come from a title alone — there is no project id to report, and a UI
    // navigating from the row has to handle that rather than trust a fabricated one.
    expect(gone?.projectId).toBeUndefined();
  });
});
