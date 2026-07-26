import { describe, it, expect } from "vitest";

import { pathKind, describePaths, scrubPaths } from "./logSafePaths";

// Fixtures use a synthetic `/fixture/…` root on purpose. A home-shaped `/Users/<name>/…`
// literal here would be exactly the string this module exists to keep out of the log — and
// scripts/sparkle-scrub.sh flags it as such, correctly, even in a test.
describe("pathKind", () => {
  it("reduces a path to its lowercased extension", () => {
    expect(pathKind("/fixture/desk/diagram.PNG")).toBe("png");
    expect(pathKind("D:\\fixture\\desk\\notes.md")).toBe("md");
  });

  it("returns 'none' for a file with no extension", () => {
    expect(pathKind("/fixture/Makefile")).toBe("none");
    expect(pathKind("/fixture/dir/")).toBe("none");
    expect(pathKind("")).toBe("none");
  });

  it("treats a dotfile's name as a name, not an extension", () => {
    // `.env` must not log as kind "env" — the whole basename IS the identifying part.
    expect(pathKind("/fixture/project/.env")).toBe("none");
  });

  it("refuses an 'extension' long enough or free-form enough to carry the filename", () => {
    expect(pathKind("/fixture/report.2026-07-21-final")).toBe("none");
    expect(pathKind("/fixture/backup.tar gz")).toBe("none");
    expect(pathKind("/fixture/x.averylongextension")).toBe("none");
  });

  it("keeps a real extension that follows dots earlier in the name", () => {
    // The observed leak shape: a screenshot named with a timestamp. Only "png" survives.
    expect(pathKind("/fixture/Snap 2026-07-21 at 7.04.41 PM.png")).toBe("png");
  });
});

describe("describePaths", () => {
  it("summarizes a batch as a count plus a per-kind tally", () => {
    expect(
      describePaths(["/fixture/a.png", "/fixture/b.PNG", "/fixture/contract-acme.pdf"]),
    ).toEqual({ count: 3, kinds: { png: 2, pdf: 1 } });
  });

  it("emits no fragment of any path it was given", () => {
    const paths = ["/fixture/Clients/Acme Corp/Q3 revenue.xlsx"];
    const serialized = JSON.stringify(describePaths(paths));
    for (const fragment of ["fixture", "Clients", "Acme", "Corp", "Q3", "revenue"]) {
      expect(serialized).not.toContain(fragment);
    }
    expect(serialized).toContain("xlsx");
  });

  it("handles an empty batch", () => {
    expect(describePaths([])).toEqual({ count: 0, kinds: {} });
  });
});

describe("scrubPaths", () => {
  // The exact message shapes load_attachment produces (src-tauri/src/attachments.rs): every one
  // interpolates the path the frontend handed it, so the caught rejection is a second copy of the
  // leak the kind/count summary just closed.
  const P = "/fixture/Clients/Acme Corp/Q3 revenue.xlsx";

  it("removes a known path even when its filename contains spaces", () => {
    for (const message of [
      `cannot access ${P}: No such file or directory (os error 2)`,
      `stat ${P}: Permission denied (os error 13)`,
      `read ${P}: Input/output error (os error 5)`,
      `refusing to read a path outside allowed directories: ${P}`,
    ]) {
      const out = scrubPaths(message, P);
      for (const fragment of ["fixture", "Clients", "Acme", "Corp", "Q3", "revenue", "xlsx"]) {
        expect(out).not.toContain(fragment);
      }
    }
  });

  it("keeps the reason, which is the whole point of logging the error at all", () => {
    expect(scrubPaths(`cannot access ${P}: No such file or directory (os error 2)`, P)).toBe(
      "cannot access «path»: No such file or directory (os error 2)",
    );
  });

  it("removes a bare basename without leaving the directory half behind", () => {
    // A message that names the file but not the full path still must not print the filename.
    expect(scrubPaths("destination has no filename: Q3 revenue.xlsx", P)).toBe(
      "destination has no filename: «path»",
    );
  });

  it("doesn't let a basename that collides with the errno tail corrupt the reason", () => {
    // An extensionless file named `error`: once the full path is gone, sweeping the basename
    // again would only find the `error` in `(os error 2)`.
    const p2 = "/fixture/logs/error";
    expect(scrubPaths(`cannot access ${p2}: No such file or directory (os error 2)`, p2)).toBe(
      "cannot access «path»: No such file or directory (os error 2)",
    );
  });

  it("backstops an absolute path it was never told about", () => {
    // Defense against a Rust-side message that interpolates some OTHER path.
    expect(scrubPaths("copy failed into /fixture/dest/sub: denied")).toBe(
      "copy failed into «path»: denied",
    );
    expect(scrubPaths("copy failed into D:\\fixture\\dest\\sub: denied")).toBe(
      "copy failed into «path»: denied",
    );
  });

  it("leaves ordinary prose alone", () => {
    expect(scrubPaths("read/write conflict, retry")).toBe("read/write conflict, retry");
    expect(scrubPaths("load_attachment task failed: panicked")).toBe(
      "load_attachment task failed: panicked",
    );
  });
});
