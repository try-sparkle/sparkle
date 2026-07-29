import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import the pure predicate straight from the shipped guard script.
import { isInside, blocksKeychainCommand, isAllowlistedNoteDir, callerWorktreeRoot } from "../../src-tauri/resources/worktree-guard.mjs";

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

// item 1j: the guard allows writes to two NARROW append-only per-agent note dirs that live outside
// every worktree by design - $HOME/.claude/plans/ and $HOME/.claude/projects/<any>/memory/ - so an
// agent can record cross-session knowledge and plan files for the next agent. Everything else under
// ~/.claude stays blocked, and a symlink planted inside an allow-listed dir cannot tunnel out.
describe("isAllowlistedNoteDir (real dirs on disk)", () => {
  let home: string;
  let outside: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-home-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-out-")));
    writeFileSync(join(outside, "evil.md"), "x");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows a per-agent memory-dir path (existing and not-yet-created)", () => {
    const memDir = join(home, ".claude", "projects", "proj-abc", "memory");
    mkdirSync(memDir, { recursive: true });
    expect(isAllowlistedNoteDir(home, join(memDir, "notes.md"))).toBe(true);
    writeFileSync(join(memDir, "real.md"), "x");
    expect(isAllowlistedNoteDir(home, join(memDir, "real.md"))).toBe(true);
    expect(isAllowlistedNoteDir(home, memDir)).toBe(true);
  });

  it("allows a plans path", () => {
    const plansDir = join(home, ".claude", "plans");
    mkdirSync(plansDir, { recursive: true });
    expect(isAllowlistedNoteDir(home, join(plansDir, "my-plan.md"))).toBe(true);
    expect(isAllowlistedNoteDir(home, join(plansDir, "nested", "deep.md"))).toBe(true);
  });

  it("still blocks siblings: commands, projects/<id>/other, and the rest of ~/.claude", () => {
    const commands = join(home, ".claude", "commands");
    mkdirSync(commands, { recursive: true });
    expect(isAllowlistedNoteDir(home, join(commands, "foo.md"))).toBe(false);
    const other = join(home, ".claude", "projects", "proj-abc", "other");
    mkdirSync(other, { recursive: true });
    expect(isAllowlistedNoteDir(home, join(other, "x.md"))).toBe(false);
    expect(isAllowlistedNoteDir(home, join(home, ".claude", "projects", "proj-abc", "config.json"))).toBe(false);
    expect(isAllowlistedNoteDir(home, join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("blocks a symlink-escape out of an allow-listed memory dir", () => {
    const memDir = join(home, ".claude", "projects", "proj-abc", "memory");
    mkdirSync(memDir, { recursive: true });
    symlinkSync(outside, join(memDir, "escape"));
    expect(isAllowlistedNoteDir(home, join(memDir, "escape", "evil.md"))).toBe(false);
  });

  it("blocks a symlink-escape out of the plans dir", () => {
    const plansDir = join(home, ".claude", "plans");
    mkdirSync(plansDir, { recursive: true });
    symlinkSync(outside, join(plansDir, "escape"));
    expect(isAllowlistedNoteDir(home, join(plansDir, "escape", "evil.md"))).toBe(false);
  });

  it("blocks when the memory dir itself is a symlink pointing outside", () => {
    const proj = join(home, ".claude", "projects", "proj-xyz");
    mkdirSync(proj, { recursive: true });
    symlinkSync(outside, join(proj, "memory"));
    expect(isAllowlistedNoteDir(home, join(proj, "memory", "notes.md"))).toBe(false);
  });
});


// Worktree-RELATIVE containment: the guard is invoked with ONE baked-in install-root, but the same
// hook runs for sub-agents / pooled worktrees whose real cwd is a DIFFERENT worktree. callerWorktreeRoot
// derives the caller's OWN worktree from the tool call's cwd (git rev-parse --show-toplevel), so an
// edit inside the caller's own worktree is allowed even when that worktree isn't the install-root,
// while an edit reaching into a different worktree is still denied. resolveToplevel is injected here so
// the logic is exercised without a real git repo.
describe("callerWorktreeRoot (worktree-relative)", () => {
  const installRoot = "/wt/self/__sparkle_self__"; // the single worktree the hook was installed for
  const poolWorktree = "/wt/pool/agent-42"; // a DIFFERENT worktree the caller actually runs in

  it("derives the caller's worktree from cwd, not the baked-in install-root", () => {
    const resolve = (dir: string) => (dir.startsWith(poolWorktree) ? poolWorktree : null);
    expect(callerWorktreeRoot(installRoot, `${poolWorktree}/apps/desktop`, resolve)).toBe(poolWorktree);
  });

  it("falls back to the install-root when cwd is not in a git work tree", () => {
    expect(callerWorktreeRoot(installRoot, "/some/where", () => null)).toBe(installRoot);
    // Missing / non-string cwd also falls back (never derives a bogus root).
    expect(callerWorktreeRoot(installRoot, undefined, () => poolWorktree)).toBe(installRoot);
    expect(callerWorktreeRoot(installRoot, "", () => poolWorktree)).toBe(installRoot);
  });

  // THE regression / mutation-check: an edit inside the caller's OWN (non-install-root) worktree must
  // be ALLOWED, and an edit into a DIFFERENT worktree must still be DENIED. If the guard reverts to
  // keying off the install-root (isInside(installRoot, ...)), the first expectation flips to false.
  it("allows edits in the caller's own worktree yet blocks edits into another worktree", () => {
    const resolve = (dir: string) => (dir.startsWith(poolWorktree) ? poolWorktree : installRoot);
    const callerRoot = callerWorktreeRoot(installRoot, `${poolWorktree}/src`, resolve);
    // Own worktree — allowed even though it is NOT the install-root.
    expect(isInside(callerRoot, `${poolWorktree}/src/App.tsx`)).toBe(true);
    // A different worktree (the install-root here) — still denied.
    expect(isInside(callerRoot, `${installRoot}/src/App.tsx`)).toBe(false);
    // A sibling worktree — denied.
    expect(isInside(callerRoot, "/wt/pool/agent-99/src/App.tsx")).toBe(false);
  });
});
