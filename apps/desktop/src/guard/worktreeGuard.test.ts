import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
// Import the pure predicate straight from the shipped guard script.
import { isInside, blocksKeychainCommand, isAllowlistedNoteDir, isAllowlistedScratchpad, callerWorktreeRoot, outsideWorktreeMessage } from "../../src-tauri/resources/worktree-guard.mjs";

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
