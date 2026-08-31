import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
// Import the pure predicate straight from the shipped guard script.
import {
  isInside,
  blocksKeychainCommand,
  isAllowlistedNoteDir,
  isAllowlistedScratchpad,
  callerWorktreeRoot,
  outsideWorktreeMessage,
  isSessionOwnedWorktree,
  sessionOwnedWorktrees,
  misroutedRootEdit,
  misroutedRootEditMessage,
  sessionIdForLedger,
  sessionPlanFile,
  isUnderPlansRoot,
  otherSessionPlanMessage,
} from "../../src-tauri/resources/worktree-guard.mjs";

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

// sparkle-3moh0: the harness reads $CLAUDE_CONFIG_DIR when set and only falls back to $HOME/.claude,
// and Sparkle ALWAYS sets it (to the chosen account's dir). So an app-spawned agent is handed a plan
// path under the account dir, which a $HOME-only allow-list blocked — making plan mode unusable in an
// app-managed worktree. Each allow assertion below is paired with the same path WITHOUT the configDir
// argument, which is the state before this change: the pair is what proves the third argument is what
// admits the path, rather than some pre-existing $HOME rule.
describe("isAllowlistedNoteDir (a config root that is NOT $HOME/.claude)", () => {
  let home: string;
  let config: string;
  let outside: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-home-")));
    config = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-cfg-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-out-")));
    writeFileSync(join(outside, "evil.md"), "x");
  });
  afterEach(() => {
    for (const d of [home, config, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("allows a plans path under the config root, which is blocked without it", () => {
    const plansDir = join(config, "plans");
    mkdirSync(plansDir, { recursive: true });
    const plan = join(plansDir, "my-plan.md");
    expect(isAllowlistedNoteDir(home, plan)).toBe(false);
    expect(isAllowlistedNoteDir(home, plan, config)).toBe(true);
    expect(isAllowlistedNoteDir(home, join(plansDir, "nested", "deep.md"), config)).toBe(true);
  });

  it("allows a memory path under the config root, which is blocked without it", () => {
    const memDir = join(config, "projects", "proj-abc", "memory");
    mkdirSync(memDir, { recursive: true });
    const note = join(memDir, "notes.md");
    expect(isAllowlistedNoteDir(home, note)).toBe(false);
    expect(isAllowlistedNoteDir(home, note, config)).toBe(true);
    expect(isAllowlistedNoteDir(home, memDir, config)).toBe(true);
  });

  it("keeps the $HOME/.claude root working when a config root is also supplied", () => {
    const plansDir = join(home, ".claude", "plans");
    mkdirSync(plansDir, { recursive: true });
    expect(isAllowlistedNoteDir(home, join(plansDir, "p.md"), config)).toBe(true);
  });

  it("stays narrow under the config root: siblings and the root itself are blocked", () => {
    mkdirSync(join(config, "commands"), { recursive: true });
    mkdirSync(join(config, "projects", "proj-abc", "other"), { recursive: true });
    expect(isAllowlistedNoteDir(home, join(config, "commands", "foo.md"), config)).toBe(false);
    expect(isAllowlistedNoteDir(home, join(config, "projects", "proj-abc", "other", "x.md"), config)).toBe(false);
    expect(isAllowlistedNoteDir(home, join(config, "projects", "proj-abc", "config.json"), config)).toBe(false);
    expect(isAllowlistedNoteDir(home, join(config, "settings.json"), config)).toBe(false);
  });

  it("blocks a symlink-escape out of the config root's plans and memory dirs", () => {
    const plansDir = join(config, "plans");
    mkdirSync(plansDir, { recursive: true });
    symlinkSync(outside, join(plansDir, "escape"));
    expect(isAllowlistedNoteDir(home, join(plansDir, "escape", "evil.md"), config)).toBe(false);
    const memDir = join(config, "projects", "proj-abc", "memory");
    mkdirSync(memDir, { recursive: true });
    symlinkSync(outside, join(memDir, "escape"));
    expect(isAllowlistedNoteDir(home, join(memDir, "escape", "evil.md"), config)).toBe(false);
  });

  it("ignores an empty or relative config root rather than resolving it against cwd", () => {
    const plansDir = join(config, "plans");
    mkdirSync(plansDir, { recursive: true });
    const plan = join(plansDir, "my-plan.md");
    // "" is the harness's own "unset" sentinel; a relative root would be cwd-dependent.
    expect(isAllowlistedNoteDir(home, plan, "")).toBe(false);
    expect(isAllowlistedNoteDir(home, plan, relative(process.cwd(), config))).toBe(false);
    // …and neither form may admit a relative-shaped plans path either.
    expect(isAllowlistedNoteDir(home, plan, "plans")).toBe(false);
  });
});


// Session-scratchpad carve-out: the Claude Code system prompt designates a per-session scratchpad dir
// (/private/tmp|/tmp/claude-*/.../scratchpad) for ALL temp files. The containment check blocks it (it
// is outside every worktree), so the guard permits it explicitly. Critically, agent WORKTREES are also
// created under /private/tmp/claude-*, so the carve-out anchors `scratchpad` to the documented depth
// (parts[3]) to admit the temp dir WITHOUT admitting a sibling worktree — the guard's core purpose stays intact.
describe("isAllowlistedScratchpad (session scratchpad carve-out)", () => {
  it("allows helper-script / PR-body paths inside a session scratchpad", () => {
    // The documented shape: /private/tmp/claude-<uid>/<session>/<uuid>/scratchpad/... (paths need not
    // exist on disk — realResolve accepts not-yet-created trailing segments, like a Write about to run).
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/proj-slug/sess-uuid/scratchpad/helper.sh")).toBe(true);
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/proj-slug/sess-uuid/scratchpad/pr-body.md")).toBe(true);
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/proj/uuid/scratchpad")).toBe(true); // the dir itself
    // The /tmp form (macOS symlinks it to /private/tmp; Linux keeps it) is allowed too.
    expect(isAllowlistedScratchpad("/tmp/claude-501/proj/uuid/scratchpad/notes.txt")).toBe(true);
  });

  // THE mutation-check: without the scratchpad carve-out (predicate returns false / no `scratchpad`
  // gate), the assertions above flip to false. A sibling worktree under the SAME session root must
  // still be DENIED, or one agent could edit another agent's worktree.
  it("still blocks a sibling worktree under the same /private/tmp/claude-* session root", () => {
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/wt-other-agent/src/App.tsx")).toBe(false);
    // A segment merely CONTAINING "scratchpad" is not the scratchpad dir.
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/scratchpad-decoy/App.tsx")).toBe(false);
  });

  // Depth-anchoring: `scratchpad` must be the 4th segment (claude-<uid>/<slug>/<uuid>/scratchpad, i.e.
  // parts[3]). A `scratchpad`-named dir at any OTHER depth is inside a sibling worktree, not a session
  // scratchpad, and must be DENIED — otherwise an unanchored `includes` scan lets one agent write into
  // another agent's worktree via a conveniently-named subdir. (roborev 55025/55026.)
  it("blocks a `scratchpad` segment that is not at the documented depth (sibling-worktree escape)", () => {
    // A worktree wt-victim with a `scratchpad` dir one level too shallow (parts[2], not parts[3]).
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/wt-victim/scratchpad/x.ts")).toBe(false);
    // `scratchpad` as a bare dir at a worktree root (parts[2], too shallow).
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/wt-other-agent/scratchpad")).toBe(false);
    // The documented shape (parts[3]) is still allowed — anchoring did not over-tighten.
    expect(isAllowlistedScratchpad("/private/tmp/claude-501/proj/uuid/scratchpad/x.ts")).toBe(true);
  });

  // Depth-3 escape: `scratchpad` can land on parts[3] while sitting two levels inside a sibling git
  // worktree (…/claude-<uid>/wt-victim/docs/scratchpad). Depth alone can't tell that from a real session
  // root, so the predicate also rejects the match when any ancestor is a checkout (`.git` at its root).
  // Real dirs + a `.git` marker are required because the discriminator is a filesystem check. (roborev 55038.)
  it("blocks a `scratchpad` dir nested inside a sibling git worktree (depth-3, .git ancestor)", () => {
    const root = realpathSync(mkdtempSync(join("/tmp", "claude-wtguardtest-")));
    // A sibling worktree: `.git` marker at its root (git worktrees always carry one).
    const victimWt = join(root, "wt-victim");
    mkdirSync(join(victimWt, "docs", "scratchpad"), { recursive: true });
    writeFileSync(join(victimWt, ".git"), "gitdir: /somewhere/.git/worktrees/wt-victim\n");
    // A real session temp root: <slug>/<uuid>/scratchpad, NO `.git` anywhere in the ancestry.
    const sessScratch = join(root, "proj-slug", "sess-uuid", "scratchpad");
    mkdirSync(sessScratch, { recursive: true });
    try {
      // `scratchpad` at parts[3] but two levels inside a worktree (root has `.git`) -> DENIED.
      expect(isAllowlistedScratchpad(join(victimWt, "docs", "scratchpad", "notes.md"))).toBe(false);
      // The real session scratchpad (no `.git` ancestor) -> allowed.
      expect(isAllowlistedScratchpad(join(sessScratch, "helper.sh"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks temp paths that are NOT session-scoped (never all of /tmp)", () => {
    expect(isAllowlistedScratchpad("/tmp/scratchpad/App.tsx")).toBe(false); // no claude-* session root
    expect(isAllowlistedScratchpad("/tmp/notclaude-501/x/scratchpad/App.tsx")).toBe(false);
    expect(isAllowlistedScratchpad("/private/tmp/evil/scratchpad/App.tsx")).toBe(false);
  });

  it("blocks arbitrary other-repo paths and non-string input", () => {
    expect(isAllowlistedScratchpad("/Users/dev/Projects/myrepo/apps/x.ts")).toBe(false);
    expect(isAllowlistedScratchpad("")).toBe(false);
    expect(isAllowlistedScratchpad(undefined)).toBe(false);
  });

  // Symlink-safety: a symlink planted inside a real scratchpad that points at a sibling worktree must
  // NOT tunnel a write out. The target is canonicalized FIRST, so it resolves out of the scratchpad.
  it("blocks a symlink-escape out of a scratchpad dir", () => {
    // A real session root under /tmp (a symlink to /private/tmp on macOS, a real dir on Linux) matching
    // the claude-* pattern, with a scratchpad and an outside sibling "worktree".
    const sessionRoot = realpathSync(mkdtempSync(join("/tmp", "claude-wtguardtest-")));
    const scratch = join(sessionRoot, "sess", "uuid", "scratchpad");
    mkdirSync(scratch, { recursive: true });
    const worktree = join(sessionRoot, "wt-victim");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "App.tsx"), "x");
    try {
      // A legit file inside the scratchpad is allowed.
      expect(isAllowlistedScratchpad(join(scratch, "helper.sh"))).toBe(true);
      // …but a symlink inside it pointing at the sibling worktree does not tunnel out.
      symlinkSync(worktree, join(scratch, "escape"));
      expect(isAllowlistedScratchpad(join(scratch, "escape", "App.tsx"))).toBe(false);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
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

// The containment refusal's TEXT. The block itself was never in doubt; what the message says is, and
// a refusal message is an instruction the reader will follow. The old text stated the rule ("Edit only
// files inside your worktree") and named no destination, so an agent redirected into another repo
// mid-task improvised: it committed the deliverable into whatever repo was writable, which had no
// remote and so could not open a PR (bead sparkle-itohi, the inbox's highest-recurrence finding).
//
// Every assertion below is on a phrase the OLD one-line message did not contain, so this suite reds if
// the message reverts. Asserting merely that the target and root appear would be vacuous — both were
// already in the old string.
describe("outsideWorktreeMessage (the refusal names a sanctioned hand-off)", () => {
  const msg = () => outsideWorktreeMessage("/other/repo/deliverable.md", "/wt/pool/agent-7");

  it("still says what was blocked and where the caller is confined", () => {
    expect(msg()).toContain("/other/repo/deliverable.md");
    expect(msg()).toContain("/wt/pool/agent-7");
    expect(msg().startsWith("Blocked:")).toBe(true);
  });

  it("offers the session scratchpad as the staging area, and asking for a worktree as the PR path", () => {
    expect(msg()).toContain("scratchpad");
    expect(msg()).toMatch(/ask for a worktree/i);
    expect(msg()).toMatch(/open a PR/i);
  });

  it("names the improvisation it exists to prevent — committing into another repo", () => {
    expect(msg()).toMatch(/do NOT commit it into a repo it does not belong to/i);
    expect(msg()).toMatch(/no remote/i);
  });

  // THE cross-check, and the reason this is more than a copy edit: a remedy has to be SAFE under the
  // conditions that triggered the refusal, so the path shape the message tells the reader to use must
  // be one this same guard actually admits. If the carve-out is ever tightened out from under the
  // wording, this fails rather than leaving the message pointing at a path the guard now blocks.
  it("recommends a path shape the guard's own scratchpad carve-out accepts", () => {
    const recommended = "/tmp/claude-<uid>/<session>/<uuid>/scratchpad/";
    expect(msg()).toContain(recommended);
    // The same shape with the placeholders filled in is allow-listed.
    expect(isAllowlistedScratchpad("/tmp/claude-501/some-session/some-uuid/scratchpad/deliverable.md")).toBe(true);
  });
});

// ── Worktree ownership: the worktree THIS SESSION created (sparkle-q39ja0, sparkle-6mpx2a) ──────
//
// `scripts/new-feature.sh <name>` — the repo's documented way to start from fresh origin/main — puts
// the new worktree BESIDE the repo root, so `isInside(callerRoot, …)` refused every edit inside the
// worktree the agent had just been told to make. These cases run against REAL git worktrees rather
// than an injected resolver on purpose: the whole judgement is "what does git say about this path",
// and a defaulted seam every test stubs out would leave that judgement covered by nothing.
//
// The allowance and its PAIRED NEGATIVES are asserted together. An allowance test alone passes for a
// guard that allows everything, and the negatives are the guard's actual job: a rival agent's
// worktree — same repo, registered with git, same name shape — must still be refused.
describe("isSessionOwnedWorktree (real git worktrees on disk)", () => {
  const SESSION = "fa25cafd-4561-44b2-9748-d934ae26d235";
  let tmp: string;
  let repo: string;
  let owned: string; // a worktree this session created and recorded
  let rival: string; // a worktree of the SAME repo that this session did NOT create
  let ledgerDir: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });

  const initRepo = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init");
    git(dir, "commit", "--allow-empty", "-m", "init");
    return dir;
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-own-")));
    repo = initRepo(join(tmp, "repo"));
    owned = join(tmp, "sparkle-feature");
    rival = join(tmp, "sparkle-rival");
    git(repo, "worktree", "add", owned, "-b", "feature/mine");
    git(repo, "worktree", "add", rival, "-b", "feature/theirs");
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    ledgerDir = join(common, "sparkle-session-worktrees");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, SESSION), `${owned}\n`);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("allows a write into the worktree this session created and recorded", () => {
    expect(isSessionOwnedWorktree(repo, SESSION, join(owned, "apps", "desktop", "src", "App.tsx"))).toBe(true);
    // A file that does not exist yet (the Write that creates it) is the normal case.
    expect(isSessionOwnedWorktree(repo, SESSION, join(owned, "brand", "new", "file.ts"))).toBe(true);
    // …and the caller may itself be standing in a worktree, not the main checkout.
    expect(isSessionOwnedWorktree(rival, SESSION, join(owned, "apps", "x.ts"))).toBe(true);
  });

  // THE paired negative, and the reason a path allow-list would have been the wrong fix: `rival` is a
  // real registered worktree of the SAME repository carrying the SAME `sparkle-*` name shape. Only the
  // ledger separates it from `owned`. If ownership were inferred from the path, this flips to true.
  it("still refuses a write into ANOTHER agent's worktree of the same repository", () => {
    expect(isSessionOwnedWorktree(repo, SESSION, join(rival, "apps", "x.ts"))).toBe(false);
  });

  it("still refuses paths outside the repository entirely", () => {
    expect(isSessionOwnedWorktree(repo, SESSION, join(tmp, "not-a-worktree", "x.ts"))).toBe(false);
    expect(isSessionOwnedWorktree(repo, SESSION, "/Users/dev/Projects/elsewhere/apps/x.ts")).toBe(false);
    expect(isSessionOwnedWorktree(repo, SESSION, join(tmp, "..", "escape.ts"))).toBe(false);
  });

  // ── THE ENV VAR IS NOT A PER-SESSION KEY, so it must never open this door ────────────────────
  // (bead sparkle-q39ja0) The ledger's writer, scripts/new-feature.sh, keys on
  // `$CLAUDE_CODE_SESSION_ID`; this reader keys on the hook payload's `session_id`. They are not
  // reliably equal, so the ledger is filed under a key never looked up and the feature admits
  // nothing. The tempting repair — try the env id too — is UNSOUND: an environment variable is
  // INHERITED, so every sibling agent dispatched from one parent carries the same value. Agent A
  // records its worktree under the shared id and agent B is then admitted into A's worktree.
  //
  // These assert the SELECTION step, which is the only place a fallback can live. Asserting
  // `isSessionOwnedWorktree` with hand-chosen ids cannot catch it: that function does exactly what
  // it is told, and it is WHICH id it is told that is the security property.
  it("keys the ledger on the payload id alone, never on the inherited env id", () => {
    expect(sessionIdForLedger({ session_id: "payload-id" }, { CLAUDE_CODE_SESSION_ID: "env-id" })).toBe("payload-id");
    // No payload id: null, so the caller admits NOTHING. Returning the env id here is the hole.
    expect(sessionIdForLedger({}, { CLAUDE_CODE_SESSION_ID: "env-id" })).toBeNull();
    expect(sessionIdForLedger({ session_id: "" }, { CLAUDE_CODE_SESSION_ID: "env-id" })).toBeNull();
    expect(sessionIdForLedger(undefined, { CLAUDE_CODE_SESSION_ID: "env-id" })).toBeNull();
    expect(sessionIdForLedger({ session_id: 42 }, { CLAUDE_CODE_SESSION_ID: "env-id" })).toBeNull();
  });

  // The same fact, composed the way the call site composes it, on real worktrees. `rival` is
  // recorded ONLY under the inherited id — the shape a sibling agent produces — and this session's
  // payload id names a different ledger. Any fallback that consults the env id turns this true.
  it("refuses a worktree a SIBLING recorded under the shared inherited id", () => {
    const inherited = "inherited-parent-session-id";
    writeFileSync(join(ledgerDir, inherited), `${rival}\n`);
    const env = { CLAUDE_CODE_SESSION_ID: inherited };
    const key = sessionIdForLedger({ session_id: SESSION }, env);
    expect(isSessionOwnedWorktree(repo, key, join(rival, "x.ts"))).toBe(false);
    // PAIRED POSITIVE: the same composition still admits what this session really did record, so
    // the refusal above is the env id being ignored, not the whole path being broken.
    expect(isSessionOwnedWorktree(repo, key, join(owned, "x.ts"))).toBe(true);
    // …and the ledger under the inherited id is genuinely populated — otherwise the refusal above
    // would pass for a ledger that was never written and this test would prove nothing.
    expect(isSessionOwnedWorktree(repo, inherited, join(rival, "x.ts"))).toBe(true);
  });

  // Cheap secondary net only — the behavioural tests above are the real guard. This catches the
  // sloppiest reintroduction (a bare env read) but not a renamed or destructured one.
  it("performs no executable read of CLAUDE_CODE_SESSION_ID", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src-tauri/resources/worktree-guard.mjs", import.meta.url)),
      "utf8",
    );
    const executableReads = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .filter((l) => /CLAUDE_CODE_SESSION_ID/.test(l));
    expect(executableReads).toEqual([]);
  });

  it("refuses when a DIFFERENT session recorded the worktree", () => {
    // The ledger is per session, so another session's recording grants this one nothing.
    expect(isSessionOwnedWorktree(repo, "11111111-2222-3333-4444-555555555555", join(owned, "x.ts"))).toBe(false);
  });

  it("refuses an absent, empty, or traversal-shaped session id rather than sanitizing it", () => {
    expect(isSessionOwnedWorktree(repo, undefined, join(owned, "x.ts"))).toBe(false);
    expect(isSessionOwnedWorktree(repo, "", join(owned, "x.ts"))).toBe(false);
    expect(isSessionOwnedWorktree(repo, `../${SESSION}`, join(owned, "x.ts"))).toBe(false);
    expect(isSessionOwnedWorktree(repo, `sub/${SESSION}`, join(owned, "x.ts"))).toBe(false);
  });

  // The ledger is a CLAIM, not a capability: git is re-consulted at write time, so a line naming a
  // worktree of a DIFFERENT repository grants nothing even though this session wrote the line itself.
  it("refuses a recorded path that belongs to a different repository", () => {
    const other = initRepo(join(tmp, "otherrepo"));
    const otherWt = join(tmp, "sparkle-other-repo-wt");
    git(other, "worktree", "add", otherWt, "-b", "feature/other");
    writeFileSync(join(ledgerDir, SESSION), `${owned}\n${otherWt}\n`);
    expect(isSessionOwnedWorktree(repo, SESSION, join(otherWt, "x.ts"))).toBe(false);
    // The genuinely-owned entry on the line above still works — the reject was targeted, not blanket.
    expect(isSessionOwnedWorktree(repo, SESSION, join(owned, "x.ts"))).toBe(true);
  });

  // …and a line naming a path that is no longer a worktree at all (removed, then the name reused by
  // an ordinary directory) resolves to no toplevel, so it grants nothing either.
  it("refuses a stale recorded path whose name is now an ordinary directory", () => {
    const stale = join(tmp, "sparkle-removed");
    mkdirSync(join(stale, "src"), { recursive: true });
    writeFileSync(join(ledgerDir, SESSION), `${stale}\n`);
    expect(isSessionOwnedWorktree(repo, SESSION, join(stale, "src", "x.ts"))).toBe(false);
  });

  it("refuses when this session recorded nothing at all", () => {
    rmSync(join(ledgerDir, SESSION));
    expect(isSessionOwnedWorktree(repo, SESSION, join(owned, "x.ts"))).toBe(false);
  });
});

// ── Misroute: editing the app-owned ROOT while a fresh named worktree exists (sparkle-tade76) ────
//
// The ownership check above admits writes INTO the worktree a session created. It cannot catch the
// OPPOSITE mistake — the one that happened — where the session's cwd stayed on the app-owned root
// after `git worktree add`, so an absolute-path Edit landed on the SHARED root instead of the
// isolated worktree. `misroutedRootEdit` catches exactly that, keyed on the same verified ledger as
// ownership (not a path shape), and the allowance and its PAIRED NEGATIVES are asserted together: an
// allowance-only test passes for a predicate that fires on everything, and a block-only test passes
// for one that never fires, so neither alone shows the rule guards what it claims.
describe("misroutedRootEdit + sessionOwnedWorktrees (real git worktrees on disk)", () => {
  const SESSION = "fa25cafd-4561-44b2-9748-d934ae26d235";
  let tmp: string;
  let repo: string; // the app-owned root checkout
  let owned: string; // a worktree this session created and recorded, BESIDE the root
  let nested: string; // …and one UNDER the root, the real `.claude/worktrees/<name>` layout
  let ledgerDir: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-misroute-")));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init");
    git(repo, "commit", "--allow-empty", "-m", "init");
    owned = join(tmp, "sparkle-feature");
    nested = join(repo, ".claude", "worktrees", "mine");
    git(repo, "worktree", "add", owned, "-b", "feature/mine");
    git(repo, "worktree", "add", nested, "-b", "feature/nested");
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    ledgerDir = join(common, "sparkle-session-worktrees");
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, SESSION), `${owned}\n`);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns this session's verified owned worktree roots, and [] when it owns none", () => {
    expect(sessionOwnedWorktrees(repo, SESSION)).toEqual([realpathSync(owned)]);
    // No session id / no ledger → empty, so a caller reading the length fails closed.
    expect(sessionOwnedWorktrees(repo, undefined)).toEqual([]);
    rmSync(join(ledgerDir, SESSION));
    expect(sessionOwnedWorktrees(repo, SESSION)).toEqual([]);
  });

  // THE POSITIVE: caller is on the app-owned root, the edit lands on a root file, and this session
  // owns a fresh named worktree — a misroute. The descriptor names the worktree to redirect into.
  it("flags an edit on the root when this session owns a fresh named worktree", () => {
    const m = misroutedRootEdit(repo, SESSION, join(repo, "apps", "x.ts"));
    expect(m).not.toBeNull();
    expect(m!.worktree).toBe(realpathSync(owned));
    // …and the message names that exact prefix (the bead's first recommendation).
    expect(misroutedRootEditMessage(m)).toContain(`${realpathSync(owned)}/`);
  });

  // PAIRED NEGATIVE 1 — the edit is aimed INTO the owned worktree (an absolute path from a root cwd).
  // That is precisely what the agent should do, so it must NOT be flagged.
  it("does NOT flag an edit aimed into the owned worktree", () => {
    expect(misroutedRootEdit(repo, SESSION, join(owned, "apps", "x.ts"))).toBeNull();
  });

  // PAIRED NEGATIVE 2 — the whole reason this is not "block every root edit": with NO recorded
  // worktree, editing the root is ordinary work. If this returned a descriptor, the guard would
  // refuse every agent that never created a worktree.
  it("does NOT flag a root edit when this session owns no named worktree", () => {
    rmSync(join(ledgerDir, SESSION));
    expect(misroutedRootEdit(repo, SESSION, join(repo, "apps", "x.ts"))).toBeNull();
  });

  // PAIRED NEGATIVE 3 — the caller is correctly STANDING IN its own worktree (cwd there). A write to
  // that worktree's own root file is correctly placed, not a misroute.
  it("does NOT flag when the caller is operating inside its own worktree", () => {
    expect(misroutedRootEdit(owned, SESSION, join(owned, "x.ts"))).toBeNull();
  });

  // The real layout: the worktree lives UNDER the root at `.claude/worktrees/<name>`. An edit to a
  // root file OUTSIDE that subtree is still a misroute; an edit INTO the nested worktree is not.
  it("handles a worktree nested under the root (the real .claude/worktrees layout)", () => {
    writeFileSync(join(ledgerDir, SESSION), `${nested}\n`);
    const m = misroutedRootEdit(repo, SESSION, join(repo, "scripts", "x.sh"));
    expect(m).not.toBeNull();
    expect(m!.worktree).toBe(realpathSync(nested));
    expect(misroutedRootEdit(repo, SESSION, join(nested, "scripts", "x.sh"))).toBeNull();
  });

  // Ownership is a CLAIM re-verified against git: a rival's worktree recorded under ANOTHER session's
  // id grants this session nothing, so a root edit by a session that recorded nothing stays allowed
  // even while a sibling's ledger is populated.
  it("does NOT flag on a worktree recorded by a DIFFERENT session", () => {
    writeFileSync(join(ledgerDir, "99999999-2222-3333-4444-555555555555"), `${owned}\n`);
    rmSync(join(ledgerDir, SESSION));
    expect(misroutedRootEdit(repo, SESSION, join(repo, "apps", "x.ts"))).toBeNull();
  });
});

// ── Plan mode: exactly THIS session's plan file (sparkle-hshjw, seen 3x) ─────────────────────────
//
// One `plans/` dir is shared by every concurrent agent, so the directory-level allowance that
// unblocked plan mode also admitted writes into a rival's plan — the file it is about to present.
// `sessionPlanFile` reads the harness's own record of which file is ours out of the session
// transcript, so the allowance can be narrowed to exactly that path.
describe("sessionPlanFile (reads the assigned plan path out of the session transcript)", () => {
  let tmp: string;
  const line = (planFilePath: string) =>
    JSON.stringify({ type: "attachment", attachment: { type: "plan_mode", reminderType: "full", planFilePath, planExists: false } });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-plan-")));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns the planFilePath a plan_mode attachment names", () => {
    const t = join(tmp, "session.jsonl");
    writeFileSync(t, `${JSON.stringify({ type: "user", message: "hi" })}\n${line("/cfg/plans/mine.md")}\n`);
    expect(sessionPlanFile(t)).toBe("/cfg/plans/mine.md");
  });

  it("takes the LAST assignment — re-entering plan mode reassigns the file", () => {
    const t = join(tmp, "session.jsonl");
    writeFileSync(t, `${line("/cfg/plans/first.md")}\n${line("/cfg/plans/second.md")}\n`);
    expect(sessionPlanFile(t)).toBe("/cfg/plans/second.md");
  });

  it("returns null when the transcript names no plan, is absent, or is unparseable", () => {
    const empty = join(tmp, "empty.jsonl");
    writeFileSync(empty, `${JSON.stringify({ type: "user", message: "hi" })}\n`);
    expect(sessionPlanFile(empty)).toBe(null);
    expect(sessionPlanFile(join(tmp, "does-not-exist.jsonl"))).toBe(null);
    const broken = join(tmp, "broken.jsonl");
    writeFileSync(broken, '{"planFilePath": "/cfg/plans/x.md"\n'); // truncated JSON
    expect(sessionPlanFile(broken)).toBe(null);
    expect(sessionPlanFile(undefined)).toBe(null);
    expect(sessionPlanFile("")).toBe(null);
    // A relative planFilePath is not a path the guard can compare, so it is ignored.
    const rel = join(tmp, "rel.jsonl");
    writeFileSync(rel, `${line("plans/mine.md")}\n`);
    expect(sessionPlanFile(rel)).toBe(null);
  });
});

describe("isUnderPlansRoot (which config roots' plans/ dir a target sits in)", () => {
  it("matches plans/ under $HOME/.claude and under the account config dir", () => {
    expect(isUnderPlansRoot("/home/dev", "/home/dev/.claude/plans/a.md", undefined)).toBe(true);
    expect(isUnderPlansRoot("/home/dev", "/accounts/abc/plans/a.md", "/accounts/abc")).toBe(true);
  });
  it("does not match the memory dir, the config root itself, or a relative configDir", () => {
    expect(isUnderPlansRoot("/home/dev", "/home/dev/.claude/projects/p/memory/m.md", undefined)).toBe(false);
    expect(isUnderPlansRoot("/home/dev", "/home/dev/.claude/settings.json", undefined)).toBe(false);
    expect(isUnderPlansRoot("/home/dev", "/accounts/abc/plans/a.md", "accounts/abc")).toBe(false);
    expect(isUnderPlansRoot("/home/dev", "", "/accounts/abc")).toBe(false);
  });
});

// The refusal for a rival's plan file. A refusal message is an instruction the reader will follow, so
// it has to name a path that is SAFE under the conditions that triggered it — here, the session's own
// plan file, which the same guard admits and which ExitPlanMode actually reads.
describe("otherSessionPlanMessage (the refusal names the caller's OWN plan file)", () => {
  const msg = () => otherSessionPlanMessage("/cfg/plans/theirs.md", "/cfg/plans/mine.md");
  it("says what was blocked and names the caller's own plan file as the destination", () => {
    expect(msg().startsWith("Blocked:")).toBe(true);
    expect(msg()).toContain("/cfg/plans/theirs.md");
    expect(msg()).toContain("/cfg/plans/mine.md");
    expect(msg()).toMatch(/ExitPlanMode/);
  });
  it("names the improvisation it exists to prevent — leaving the owner a note in their plan", () => {
    expect(msg()).toMatch(/do NOT edit the file above/i);
  });
  // Cross-check: the path the message tells the reader to use must be one this guard admits, or the
  // refusal accomplishes nothing. The plan file it names is by construction the session's own.
  it("recommends a path the plans allow-list accepts", () => {
    expect(isUnderPlansRoot("/home/dev", "/cfg/plans/mine.md", "/cfg")).toBe(true);
  });
});

// ── The guard's ACTUAL decision, end to end ─────────────────────────────────────────────────────
//
// The predicates above are pure; these run the shipped hook the way Claude Code runs it — a JSON
// payload on stdin, argv[2] the install root — and assert the only thing the harness reads: the exit
// code (2 blocks the tool call, 0 lets it through). This is what keeps the wiring covered: a correct
// predicate that main() never calls still fails these.
describe("worktree-guard process decisions (exit codes, real git)", () => {
  const GUARD = fileURLToPath(new URL("../../src-tauri/resources/worktree-guard.mjs", import.meta.url));
  const SESSION = "fa25cafd-4561-44b2-9748-d934ae26d235";
  let tmp: string;
  let repo: string;
  let owned: string;
  let rival: string;
  let config: string;
  let transcript: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });

  /** Run the hook exactly as the harness does. Returns the exit code and stderr. */
  const runGuard = (payload: Record<string, unknown>, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [GUARD, repo], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, ...env },
    });
    return { code: r.status, stderr: r.stderr ?? "" };
  };

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "wtguard-e2e-")));
    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init");
    git(repo, "commit", "--allow-empty", "-m", "init");
    owned = join(tmp, "sparkle-feature");
    rival = join(tmp, "sparkle-rival");
    git(repo, "worktree", "add", owned, "-b", "feature/mine");
    git(repo, "worktree", "add", rival, "-b", "feature/theirs");
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    mkdirSync(join(common, "sparkle-session-worktrees"), { recursive: true });
    writeFileSync(join(common, "sparkle-session-worktrees", SESSION), `${owned}\n`);
    config = join(tmp, "account");
    mkdirSync(join(config, "plans"), { recursive: true });
    transcript = join(tmp, "session.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "attachment",
        attachment: { type: "plan_mode", planFilePath: join(config, "plans", "mine.md"), planExists: false },
      })}\n`,
    );
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const edit = (file: string, extra: Record<string, unknown> = {}) => ({
    session_id: SESSION,
    transcript_path: transcript,
    cwd: repo,
    tool_name: "Write",
    tool_input: { file_path: file },
    ...extra,
  });

  // DEFECT C (bead sparkle-tade76). cwd is the app-owned ROOT checkout while THIS session created a
  // fresh named worktree (recorded in the ledger by beforeEach). Editing the root here is the
  // misroute the bead names: the edit lands on the shared checkout instead of the isolated worktree.
  // Red before the fix — the containment allow exits 0, silently corrupting the app-owned tree.
  it("blocks an edit on the app-owned ROOT when this session owns a fresh named worktree", () => {
    const r = runGuard(edit(join(repo, "apps", "x.ts")));
    expect(r.code).toBe(2);
    // The remedy names the exact worktree path prefix to redirect under (the bead's first rec).
    expect(r.stderr).toContain(realpathSync(owned));
  });

  // THE PAIRED NEGATIVE, and the reason this is not just "block every root edit": with NO recorded
  // worktree, editing the root is ordinary work an agent launched in the checkout is entitled to do.
  // If this flipped to 2, the guard would refuse every agent that never made a worktree.
  it("allows an edit on the ROOT when this session owns NO named worktree", () => {
    const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
    rmSync(join(common, "sparkle-session-worktrees", SESSION));
    expect(runGuard(edit(join(repo, "apps", "x.ts"))).code).toBe(0);
  });

  // DEFECT A. Red before the fix: this exits 2 with "outside this agent's worktree", which is what
  // sent a measured session back to its stale launch worktree.
  it("allows an edit in the worktree THIS session created via new-feature.sh", () => {
    expect(runGuard(edit(join(owned, "apps", "desktop", "src", "App.tsx"))).code).toBe(0);
  });

  it("still blocks an edit in a RIVAL agent's worktree of the same repo", () => {
    const r = runGuard(edit(join(rival, "apps", "x.ts")));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/outside this agent's worktree/);
  });

  it("still blocks an edit outside the repository entirely", () => {
    const r = runGuard(edit(join(tmp, "elsewhere", "x.ts")));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/outside this agent's worktree/);
  });

  it("still blocks the owned worktree for a session that did not create it", () => {
    const r = runGuard(edit(join(owned, "x.ts"), { session_id: "99999999-2222-3333-4444-555555555555" }));
    expect(r.code).toBe(2);
  });

  // DEFECT B, the allowance half: plan mode's one editable file. (Already allowed at directory
  // granularity before this change; asserted so the narrowing cannot break it.)
  it("allows the plan file THIS session was assigned", () => {
    expect(runGuard(edit(join(config, "plans", "mine.md"))).code).toBe(0);
  });

  // DEFECT B, the paired negative. Red before the fix: the directory-level allowance exits 0 here,
  // letting one agent overwrite the plan another is about to present.
  it("blocks ANOTHER session's plan file in the same shared plans dir", () => {
    const r = runGuard(edit(join(config, "plans", "theirs.md")));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(join(config, "plans", "mine.md"));
  });

  // The fallback, stated as a test because it is the difference between a narrowing and a
  // regression: with no transcript to name a plan file, the directory-level allowance stands rather
  // than leaving the human with no plan at all.
  it("keeps the directory-level plans allowance when the transcript names no plan file", () => {
    expect(runGuard(edit(join(config, "plans", "anything.md"), { transcript_path: undefined })).code).toBe(0);
    expect(runGuard(edit(join(config, "plans", "anything.md"), { transcript_path: join(tmp, "gone.jsonl") })).code).toBe(0);
  });

  // The memory half of the note-dir allow-list is untouched by the plans narrowing.
  it("still allows the per-agent memory dir", () => {
    const mem = join(config, "projects", "some-project", "memory", "note.md");
    mkdirSync(join(config, "projects", "some-project", "memory"), { recursive: true });
    expect(runGuard(edit(mem)).code).toBe(0);
  });
});
