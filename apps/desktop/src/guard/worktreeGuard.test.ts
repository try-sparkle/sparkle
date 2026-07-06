import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import the pure predicate straight from the shipped guard script.
import { isInside, blocksKeychainCommand } from "../../src-tauri/resources/worktree-guard.mjs";

describe("isInside (lexical, no filesystem)", () => {
  const root = "/wt/proj/agent";
  it("allows the root itself and descendants", () => {
    expect(isInside(root, "/wt/proj/agent")).toBe(true);
    expect(isInside(root, "/wt/proj/agent/src/App.tsx")).toBe(true);
  });
  it("blocks siblings, parents, and ../ escapes", () => {
    expect(isInside(root, "/wt/proj/other/x")).toBe(false);
    expect(isInside(root, "/wt/proj")).toBe(false);
    expect(isInside(root, "/wt/proj/agent/../../escape.ts")).toBe(false);
    expect(isInside(root, "/Users/dev/Projects/myrepo/apps/x.ts")).toBe(false);
  });
});

// The symlink-escape regression: a lexical-only check (the previous implementation) would
// wrongly allow these because the path string sits "inside" the worktree. realResolve()
// canonicalizes through the symlink and correctly blocks them.
describe("isInside (real symlinks on disk)", () => {
  let tmp: string;
  let root: string;
  let outside: string;
  beforeEach(() => {
    // realpathSync so macOS /var→/private/var symlinking doesn't skew the comparison.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-")));
    root = join(tmp, "worktree");
    outside = join(tmp, "secrets");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "authorized_keys"), "secret");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("allows real files inside the worktree", () => {
    mkdirSync(join(root, "src"));
    expect(isInside(root, join(root, "src", "App.tsx"))).toBe(true); // not-yet-created file
    writeFileSync(join(root, "real.txt"), "x");
    expect(isInside(root, join(root, "real.txt"))).toBe(true);
  });

  it("blocks a write THROUGH a symlinked dir that points outside the worktree", () => {
    // ln -s <outside> <root>/evil  →  <root>/evil/authorized_keys actually lands in <outside>.
    symlinkSync(outside, join(root, "evil"));
    expect(isInside(root, join(root, "evil", "authorized_keys"))).toBe(false);
  });

  it("blocks writing to a symlink (inside the worktree) that targets an outside file", () => {
    symlinkSync(join(outside, "authorized_keys"), join(root, "link"));
    expect(isInside(root, join(root, "link"))).toBe(false);
  });

  it("blocks a DANGLING symlink whose outside target doesn't exist yet (the Write would create it)", () => {
    // The headline ~/.ssh/authorized_keys-injection case: link to an outside path that does NOT
    // exist, so the Write itself creates it. realpathSync throws on this; the segment walk must
    // still resolve the link and block it.
    symlinkSync(join(outside, "not-created-yet"), join(root, "danglink"));
    expect(isInside(root, join(root, "danglink"))).toBe(false);
    // …and the same via a dangling symlinked *directory* component.
    symlinkSync(join(tmp, "nonexistent-dir"), join(root, "dangdir"));
    expect(isInside(root, join(root, "dangdir", "file.txt"))).toBe(false);
  });

  it("blocks a NESTED two-hop symlink (a -> b/c where b -> outside)", () => {
    // The walk must re-resolve symlinks INSIDE a resolved link target, not just chain on the
    // final component: `a` -> `b/c`, and `b` is itself an outward symlink.
    symlinkSync(outside, join(root, "b")); // b -> <outside>
    symlinkSync("b/c", join(root, "a")); // a -> b/c (relative to the worktree)
    mkdirSync(join(outside, "c"));
    expect(isInside(root, join(root, "a", "file"))).toBe(false);
  });

  it("blocks `symlink/../x` (the symlink points outside, so .. must apply post-resolution)", () => {
    // Lexically `out/../realfile` collapses to `realfile` (inside) — but the kernel resolves the
    // `out` symlink to <outside> first, so the write lands at <outside>/../realfile, outside the
    // worktree. The `..` must be applied AFTER the symlink is resolved, not collapsed up front.
    // NB: use a RAW string (not path.join, which would normalize the `..` away) — the guard
    // receives tool file_path verbatim.
    symlinkSync(outside, join(root, "out")); // out -> <outside>
    expect(isInside(root, `${root}/out/../realfile`)).toBe(false);
  });

  it("fails closed (blocks) on a symlink cycle instead of hanging or escaping", () => {
    // a -> b, b -> a. The resolver must hit its hop cap, return null, and isInside must treat
    // that as "not inside" rather than looping forever or admitting the path.
    symlinkSync("b", join(root, "a"));
    symlinkSync("a", join(root, "b"));
    expect(isInside(root, join(root, "a", "x"))).toBe(false);
  });
});

// The keychain guard (sparkle-0ezz): block an agent shelling out to the macOS `security` CLI against
// the app's ai.sparkle.desktop keychain item (which holds desktop-token + trial-device-token). The app
// reads these in-process via keyring and never triggers the OS prompt; only an agent running `security`
// does. We can't suppress Apple's dialog, so we stop the command from running.
describe("blocksKeychainCommand", () => {
  it("blocks `security find-generic-password -s ai.sparkle.desktop`", () => {
    expect(blocksKeychainCommand("security find-generic-password -s ai.sparkle.desktop")).toBe(true);
  });

  it("blocks the fuller real invocation (flags, account, absolute path, -w)", () => {
    expect(
      blocksKeychainCommand("/usr/bin/security find-generic-password -w -s ai.sparkle.desktop -a desktop-token"),
    ).toBe(true);
    expect(
      blocksKeychainCommand("security add-generic-password -s ai.sparkle.desktop -a trial-device-token -w secret"),
    ).toBe(true);
    // Also inside a pipeline / after a separator (not just at the very start of the line).
    expect(blocksKeychainCommand("echo hi && security delete-generic-password -s ai.sparkle.desktop")).toBe(true);
  });

  it("does NOT block unrelated commands", () => {
    // Ordinary shell work.
    expect(blocksKeychainCommand("git commit -m 'security review of the login flow'")).toBe(false);
    expect(blocksKeychainCommand("ls -la && echo ai.sparkle.desktop")).toBe(false);
    expect(blocksKeychainCommand("npm run test")).toBe(false);
    // `security` against a DIFFERENT keychain service is not our item — leave it alone.
    expect(blocksKeychainCommand("security find-generic-password -s some.other.service")).toBe(false);
    // `security` without a generic-password subcommand isn't the targeted access pattern.
    expect(blocksKeychainCommand("security list-keychains")).toBe(false);
    // The service name mentioned but no `security` binary invoked.
    expect(blocksKeychainCommand("grep ai.sparkle.desktop generic-password.txt")).toBe(false);
    // Substring "security" inside another word must not trigger the invocation match.
    expect(blocksKeychainCommand("run-security-scan --target ai.sparkle.desktop generic-password")).toBe(false);
    // Non-string input is safely ignored.
    expect(blocksKeychainCommand(undefined)).toBe(false);
  });
});
