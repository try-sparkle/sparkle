import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Drive the REAL exported predicate from the shipped guard script — no mocks, no injected seams.
// Every repo-state case below runs against a REAL git repo on disk with a REAL .gitignore, because
// real ignore semantics are precisely what the founder's incident showed nobody was consulting.
import { blocksSecretStaging, isSecretPath } from "../../src-tauri/resources/worktree-guard.mjs";

/** A real, throwaway git repo, made HERMETIC against the host's own git configuration — every
 *  assertion below is a verdict about the guard, so none of them may be decided by whatever the
 *  developer happens to have in ~/.gitconfig.
 *
 *  Two neutered settings, both leaking in the same way and both load-bearing:
 *    - `core.hooksPath`: this machine sets one globally (roborev's), which would fire that machine's
 *      hooks inside our fixture.
 *    - `core.excludesFile`: the global ignore file (default ~/.config/git/ignore) is consulted for a
 *      temp repo like any other, and `.env` / `.env*` is one of the most common entries in a personal
 *      one. On such a machine every untracked-and-not-ignored assertion silently flips: the sweep
 *      cases go green for the wrong reason, and the positive control that the fail-open pair rests on
 *      goes red for a reason that has nothing to do with the change. Repo-level config outranks
 *      global, so this covers the guard's own `git status` child too. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "secretguard-")));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "core.hooksPath", "/dev/null"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "core.excludesFile", "/dev/null"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "guard@example.test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Guard Test"], { stdio: "ignore" });
  return dir;
}

function write(dir: string, rel: string, body = "SECRET=live-key\n"): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

describe("blocksSecretStaging — CASE 2: a sweeping add consults the real repo", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // THE HEADLINE CASE — the founder's actual incident. Two .env backups sat UNTRACKED and
  // UN-GITIGNORED for over a day holding a live API key; the project's .gitignore had only the
  // bare literal `.env`, no `.env.*` wildcard. One `git add -A` away from a public repo.
  it("blocks `git add -A` when an untracked, un-ignored .env.bak-* holds a live key", () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n"); // the bare literal — exactly the real repo
    write(repo, ".env.bak-20260724");
    write(repo, ".env.bak-concierge-20260806-021701");
    write(repo, "src/app.ts", "export const x = 1;\n");
    const verdict = blocksSecretStaging("git add -A", repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.kind).toBe("sweep");
    expect(verdict?.files).toEqual(
      expect.arrayContaining([".env.bak-20260724", ".env.bak-concierge-20260806-021701"]),
    );
    // The ordinary source file is not part of the complaint.
    expect(verdict?.files).not.toContain("src/app.ts");
  });

  // THE CRITICAL FALSE-POSITIVE GUARD. A properly gitignored .env is the correct, safe and
  // extremely common state; blocking on it would fire constantly and destroy trust in the guard.
  it("allows `git add -A` when the .env present IS gitignored", () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.*\n");
    write(repo, ".env");
    write(repo, ".env.local");
    write(repo, "src/app.ts", "export const x = 1;\n");
    expect(blocksSecretStaging("git add -A", repo)).toBeNull();
  });

  it("allows `git add -A` in a repo with nothing secret lying around", () => {
    write(repo, "src/app.ts", "export const x = 1;\n");
    write(repo, "README.md", "# hi\n");
    expect(blocksSecretStaging("git add -A", repo)).toBeNull();
  });

  // Naming safe files explicitly is the documented remedy, so it MUST keep working even while a
  // stray secret sits elsewhere in the tree — otherwise the refusal message sends the agent into a
  // dead end.
  it("allows `git add src/app.ts` even with a stray un-ignored secret elsewhere in the tree", () => {
    write(repo, "deploy.env");
    write(repo, "src/app.ts", "export const x = 1;\n");
    expect(blocksSecretStaging("git add src/app.ts", repo)).toBeNull();
    expect(blocksSecretStaging("git add src/app.ts README.md", repo)).toBeNull();
  });

  it("blocks `git commit -am \"msg\"` when an un-ignored secret is present", () => {
    write(repo, "credentials.json", '{"token":"live"}\n');
    const verdict = blocksSecretStaging('git commit -am "wire up the thing"', repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.files).toContain("credentials.json");
  });

  it("blocks `git add --all` and `git commit -a -m msg` too (long/split forms)", () => {
    write(repo, "server.key");
    expect(blocksSecretStaging("git add --all", repo)).not.toBeNull();
    expect(blocksSecretStaging("git commit -a -m 'x'", repo)).not.toBeNull();
  });

  // A commit message is not a pathspec. `-m` consumes its value, so a message that merely MENTIONS
  // a secret path must not be read as one — and a plain `git commit -m` stages nothing new at all.
  it("allows a plain `git commit -m` whose MESSAGE mentions a secret path", () => {
    write(repo, ".env.production");
    expect(blocksSecretStaging('git commit -m "ignore .env.production going forward"', repo)).toBeNull();
    // `-ma` is `-m` with the message "a" — NOT `-a`. It must not be read as a sweep.
    expect(blocksSecretStaging("git commit -ma", repo)).toBeNull();
  });

  // Precise short-option value consumption, in BOTH directions. A `-m` whose value is ATTACHED to
  // the cluster (`-mwip`) must NOT then also swallow the following word — otherwise a named secret
  // pathspec silently disappears and the command sails through. A `-m` at the end of its cluster
  // must consume the next word, or the commit MESSAGE gets read as a pathspec.
  it("consumes a `-m` value exactly once, so a following pathspec is still seen", () => {
    write(repo, ".env.production");
    // Message attached to the cluster; `.env.production` is a real pathspec → CASE 1 blocks.
    expect(blocksSecretStaging("git commit -mwip .env.production", repo)).not.toBeNull();
    // Message as the next word; `.env.production` IS the message, nothing is staged → allowed.
    expect(blocksSecretStaging("git commit -m .env.production", repo)).toBeNull();
  });

  // `git status --porcelain` defaults to collapsing an untracked directory to a single `dir/` entry,
  // which would hide every secret inside it. The guard must pass --untracked-files=all.
  it("blocks a secret nested inside an untracked DIRECTORY (the -uall case)", () => {
    write(repo, "secrets/prod.env");
    const verdict = blocksSecretStaging("git add -A", repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.files).toContain("secrets/prod.env");
  });

  it("respects .git/info/exclude, not just .gitignore", () => {
    write(repo, ".env.staging");
    // Un-ignored first: blocked.
    expect(blocksSecretStaging("git add -A", repo)).not.toBeNull();
    // The per-checkout exclude file is one of the two remedies the refusal message offers, so it
    // has to actually work.
    writeFileSync(join(repo, ".git", "info", "exclude"), ".env.staging\n");
    expect(blocksSecretStaging("git add -A", repo)).toBeNull();
  });

  it("scopes a directory pathspec: `git add subdir` ignores a secret outside it", () => {
    write(repo, "deploy.env");
    write(repo, "subdir/app.ts", "x\n");
    expect(blocksSecretStaging("git add subdir", repo)).toBeNull();
    // …but `git add .` from the repo root does sweep it up.
    expect(blocksSecretStaging("git add .", repo)).not.toBeNull();
    // …and a directory pathspec that DOES contain a secret is caught.
    write(repo, "subdir/service-account-prod.json", "{}\n");
    expect(blocksSecretStaging("git add subdir", repo)).not.toBeNull();
  });

  it("honours `git -C <dir>` so the right repo is inspected", () => {
    write(repo, ".env.bak-20260724");
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "secretguard-cwd-")));
    try {
      // cwd is NOT the repo; the -C override is what points the status probe at it.
      expect(blocksSecretStaging(`git -C ${repo} add -A`, elsewhere)).not.toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("blocks the chained `git add -A && git commit -m ...` shape agents actually type", () => {
    write(repo, ".env.bak-20260724");
    expect(blocksSecretStaging('git add -A && git commit -m "wip"', repo)).not.toBeNull();
  });

  it("leaves read-only git commands alone", () => {
    write(repo, ".env.bak-20260724");
    expect(blocksSecretStaging("git status --porcelain", repo)).toBeNull();
    expect(blocksSecretStaging("git diff --stat", repo)).toBeNull();
    expect(blocksSecretStaging("git log --oneline -5", repo)).toBeNull();
  });
});

describe("blocksSecretStaging — CASE 1: an explicitly named secret path", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // The deliberate override. `-f` defeats .gitignore, so this is the one shape a gitignore fix can
  // never protect against — and it needs no repo access to catch, only string matching.
  it("blocks `git add -f .env`", () => {
    write(repo, ".env");
    const verdict = blocksSecretStaging("git add -f .env", repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.kind).toBe("named");
    expect(verdict?.files).toContain(".env");
  });

  it("blocks a named secret even with NO repo access at all (pure string matching)", () => {
    // No cwd => no `git status` possible. CASE 1 is deliberately strict and still blocks.
    expect(blocksSecretStaging("git add -f .env", undefined)).not.toBeNull();
    expect(blocksSecretStaging("git add secrets/id_ed25519", undefined)).not.toBeNull();
    expect(blocksSecretStaging("git commit .env.production -m x", undefined)).not.toBeNull();
  });

  // A false block on .env.example would be an immediate self-inflicted wound — these files are
  // tracked in this very repo.
  it("allows the legitimate template files", () => {
    expect(blocksSecretStaging("git add .env.example", repo)).toBeNull();
    expect(blocksSecretStaging("git add apps/web/.env.sample", repo)).toBeNull();
    expect(blocksSecretStaging("git add .env.template", repo)).toBeNull();
  });

  it("allows a path that is ALREADY TRACKED by git", () => {
    // .npmrc is on the pattern list AND is tracked in this repo — without the tracked exemption the
    // guard would block ordinary work on it.
    write(repo, ".npmrc", "engine-strict=true\n");
    expect(blocksSecretStaging("git add .npmrc", repo)).not.toBeNull(); // untracked: blocked
    execFileSync("git", ["-C", repo, "add", "-f", ".npmrc"], { stdio: "ignore" }); // now tracked
    expect(blocksSecretStaging("git add .npmrc", repo)).toBeNull();
  });

  it("allows the PUBLIC half of a keypair but blocks the private half", () => {
    expect(blocksSecretStaging("git add id_rsa.pub", repo)).toBeNull();
    expect(blocksSecretStaging("git add id_rsa", repo)).not.toBeNull();
  });

  it("handles quoted paths with spaces", () => {
    expect(blocksSecretStaging('git add "my secrets/.env.prod"', repo)).not.toBeNull();
    expect(blocksSecretStaging("git add 'my docs/readme.md'", repo)).toBeNull();
  });
});

// A plain `git commit -m "..."` names nothing and sweeps nothing, yet it publishes whatever the
// index already holds — staged by something this hook could not see (a repo script that runs
// `git add -A` internally, a `bash -c "git add -A"`, or a stage predating this guard). Without an
// index probe the commit half of the guard is unenforced on the most common command an agent types.
// (roborev 60538, Medium.)
describe("blocksSecretStaging — CASE 3: a secret already in the INDEX", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const stage = (rel: string) => execFileSync("git", ["-C", repo, "add", "-f", rel], { stdio: "ignore" });

  it("blocks a plain `git commit -m` when a secret is already staged", () => {
    write(repo, ".env.production");
    write(repo, "src/app.ts", "x\n");
    stage(".env.production");
    stage("src/app.ts");
    const verdict = blocksSecretStaging('git commit -m "wire up the thing"', repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.kind).toBe("staged");
    expect(verdict?.files).toEqual([".env.production"]);
  });

  it("allows a plain `git commit -m` when only safe files are staged", () => {
    write(repo, "src/app.ts", "x\n");
    stage("src/app.ts");
    expect(blocksSecretStaging('git commit -m "wire up the thing"', repo)).toBeNull();
  });

  it("allows a staged TEMPLATE, and a staged MODIFICATION to an already-tracked file", () => {
    write(repo, ".env.example", "API_KEY=\n");
    stage(".env.example");
    expect(blocksSecretStaging("git commit -m x", repo)).toBeNull();
    // .npmrc committed first, then modified and re-staged: the index code is `M`, not `A`. The value
    // is already in history, so blocking protects nothing and would fire on ordinary edits.
    write(repo, ".npmrc", "engine-strict=true\n");
    stage(".npmrc");
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"], { stdio: "ignore" });
    write(repo, ".npmrc", "engine-strict=false\n");
    stage(".npmrc");
    expect(blocksSecretStaging("git commit -m x", repo)).toBeNull();
  });

  it("catches a RENAME whose DESTINATION is secret-shaped", () => {
    write(repo, "notes.txt", "hello\n");
    stage("notes.txt");
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "mv", "notes.txt", "deploy.env"], { stdio: "ignore" });
    const verdict = blocksSecretStaging("git commit -m x", repo);
    expect(verdict).not.toBeNull();
    expect(verdict?.files).toContain("deploy.env");
  });

  // A PATHSPEC commit publishes only those paths, so an unrelated staged secret is not published by
  // it — and the refusal's own sentence ("this commit would publish them") would be FALSE. Same
  // false-positive class the design notes warn about. (roborev 60563, Medium.)
  it("scopes the index probe to the commit's own pathspecs", () => {
    write(repo, ".env.production");
    write(repo, "src/app.ts", "x\n");
    stage(".env.production");
    stage("src/app.ts");
    // Committing only the safe path does not publish the staged secret → allowed.
    expect(blocksSecretStaging("git commit -m fix src/app.ts", repo)).toBeNull();
    // …while the unscoped commit on the very same repo DOES publish it → blocked.
    expect(blocksSecretStaging("git commit -m fix", repo)?.kind).toBe("staged");
    // …and a pathspec that DOES cover the secret is still caught.
    expect(blocksSecretStaging("git commit -m fix .env.production", repo)).not.toBeNull();
    // …and -i/--include INVERTS the scoping: it commits the whole staged index PLUS the named paths,
    // so the secret IS published and scoping to `src/app.ts` would be a silent bypass of the guard.
    // (roborev 60599, Medium — this was a real regression introduced by the scoping fix.)
    expect(blocksSecretStaging("git commit -i -m fix src/app.ts", repo)?.kind).toBe("staged");
    expect(blocksSecretStaging("git commit --include -m fix src/app.ts", repo)?.kind).toBe("staged");
    // …as does -a, which likewise commits the whole index.
    expect(blocksSecretStaging("git commit -a -m fix src/app.ts", repo)?.kind).toBeDefined();
    // `-im "msg"` is `-i` + `-m msg`: the cluster must set includesIndex AND consume the message.
    expect(blocksSecretStaging("git commit -im fix src/app.ts", repo)?.kind).toBe("staged");
  });

  // Enumerating the index-publishing options by exact SPELLING goes stale silently, and in the
  // BYPASS direction — the first version caught `-i`/`--include` and missed the rest of the family
  // git itself names ("Only one of --include/--only/--all/--interactive/--patch"), plus every
  // abbreviation. Ask the property instead. (roborev 60638, Medium.)
  it("catches every index-publishing spelling, including abbreviations and unknown options", () => {
    write(repo, ".env.production");
    write(repo, "src/app.ts", "x\n");
    stage(".env.production");
    stage("src/app.ts");
    // -p / --patch / --interactive commit the whole index too (git's own mutual-exclusion list).
    expect(blocksSecretStaging("git commit -p src/app.ts", repo)?.kind).toBe("staged");
    expect(blocksSecretStaging("git commit --patch src/app.ts", repo)?.kind).toBe("staged");
    expect(blocksSecretStaging("git commit --interactive src/app.ts", repo)?.kind).toBe("staged");
    // git accepts any unambiguous ABBREVIATION, so an equality test on the full name misses it.
    expect(blocksSecretStaging("git commit --inc -m fix src/app.ts", repo)?.kind).toBe("staged");
    expect(blocksSecretStaging("git commit --interact -m fix src/app.ts", repo)?.kind).toBe("staged");
    // An option added to git after this was written is not understood, so the probe runs UNSCOPED —
    // a false block whose remedy (un-stage the secret) is sound advice, rather than a silent allow.
    expect(blocksSecretStaging("git commit --some-future-flag -m fix src/app.ts", repo)?.kind).toBe("staged");
    expect(blocksSecretStaging("git commit -Z src/app.ts", repo)?.kind).toBe("staged");
    // …and that fail-closed backstop must not swallow the ordinary scoped commit. `--amend` is
    // recognised as scope-neutral, so scoping survives and this stays ALLOWED.
    expect(blocksSecretStaging("git commit --amend -m fix src/app.ts", repo)).toBeNull();
    expect(blocksSecretStaging("git commit --no-verify -q -m fix src/app.ts", repo)).toBeNull();
  });

  it("still fails OPEN when the index cannot be read", () => {
    expect(blocksSecretStaging("git commit -m x", "/nonexistent/path/nope")).toBeNull();
  });
});

// An EXCLUDING pathspec names files the command is deliberately keeping OUT. Reading it as "the
// command explicitly names a secret" false-blocks the very idiom a careful agent uses to avoid one.
// (roborev 60538, Medium.)
describe("blocksSecretStaging — pathspec magic", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("allows an add that EXCLUDES the secret, and still blocks the same add without the exclusion", () => {
    write(repo, "deploy.env");
    write(repo, "src/app.ts", "x\n");
    // Baseline: the un-excluded sweep is blocked…
    expect(blocksSecretStaging("git add .", repo)).not.toBeNull();
    // …and every excluding spelling of the same command is allowed, because the raw pathspec is
    // handed to git verbatim on the probe, so git itself honours the exclusion.
    expect(blocksSecretStaging("git add . ':!*.env'", repo)).toBeNull();
    expect(blocksSecretStaging("git add . ':^*.env'", repo)).toBeNull();
    expect(blocksSecretStaging("git add . ':(exclude)*.env'", repo)).toBeNull();
    expect(blocksSecretStaging("git add -A ':!*.env'", repo)).toBeNull();
  });

  // Magic must be STRIPPED before pattern-matching, not matched through. These use exact-basename
  // patterns (`credentials.json`, `.npmrc`, `id_rsa`) rather than `.env`, because the `*.env` suffix
  // rule matches a magic-prefixed token by accident and would hide a broken strip.
  it("strips leading magic before matching, so `:(top)credentials.json` is still recognised", () => {
    write(repo, "credentials.json", "{}\n");
    expect(blocksSecretStaging("git add ':(top)credentials.json'", repo)).not.toBeNull();
    expect(blocksSecretStaging("git add ':(literal,icase).npmrc'", repo)).not.toBeNull();
    expect(blocksSecretStaging("git add ':/id_rsa'", repo)).not.toBeNull();
    // …and stripping did not turn an ordinary magic-prefixed path into a false positive.
    expect(blocksSecretStaging("git add ':(top)src/app.ts'", repo)).toBeNull();
  });
});

describe("blocksSecretStaging — no over-matching", () => {
  it("ignores non-git commands that merely contain the word 'add'", () => {
    expect(blocksSecretStaging("npm run add-user", undefined)).toBeNull();
    expect(blocksSecretStaging("apt-get install add-apt-repository", undefined)).toBeNull();
    expect(blocksSecretStaging("echo 'add the .env to gitignore'", undefined)).toBeNull();
    expect(blocksSecretStaging("cat .env", undefined)).toBeNull();
    expect(blocksSecretStaging("rg 'add' src/", undefined)).toBeNull();
    // A command NAMED like git but that isn't (`gitk`, `legit`).
    expect(blocksSecretStaging("gitk add -A", undefined)).toBeNull();
  });

  it("ignores non-string / empty input", () => {
    expect(blocksSecretStaging(undefined, undefined)).toBeNull();
    expect(blocksSecretStaging(null, undefined)).toBeNull();
    expect(blocksSecretStaging("", undefined)).toBeNull();
    expect(blocksSecretStaging(42, undefined)).toBeNull();
  });
});

// FAIL-OPEN ASYMMETRY. CASE 2 needs evidence FROM THE REPO; when the repo cannot be read, there is
// no evidence a secret exists, so blocking would break ordinary work everywhere for no security
// benefit. CASE 1 needs no repo access and stays strict (asserted above).
describe("blocksSecretStaging — CASE 2 fails OPEN when repo state is undeterminable", () => {
  it("allows a sweeping add when the directory is not a git repo at all", () => {
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "secretguard-norepo-")));
    try {
      writeFileSync(join(notARepo, ".env.bak-20260724"), "SECRET=live\n");
      expect(blocksSecretStaging("git add -A", notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("allows a sweeping add when there is no cwd to inspect", () => {
    expect(blocksSecretStaging("git add -A", undefined)).toBeNull();
    expect(blocksSecretStaging("git add -A", "")).toBeNull();
    expect(blocksSecretStaging("git commit -am x", "/nonexistent/path/that/does/not/exist")).toBeNull();
  });

  it("allows a sweeping add when the command `cd`s first (we would inspect the wrong dir)", () => {
    const repo = makeRepo();
    try {
      writeFileSync(join(repo, ".env.bak-20260724"), "SECRET=live\n");
      // The git runs somewhere else entirely; inspecting `repo` would be a FALSE block.
      expect(blocksSecretStaging("cd /some/other/place && git add -A", repo)).toBeNull();
      // …but CASE 1 needs no repo access, so a named secret is still caught after a cd.
      expect(blocksSecretStaging("cd /some/other/place && git add -f .env", repo)).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// The predicate being right proves nothing if main() never calls it. These drive the REAL hook the
// way Claude Code does — `node worktree-guard.mjs <install-root>` with the tool payload on stdin —
// and assert the only thing that actually blocks a tool call: exit code 2.
describe("the hook entrypoint (end-to-end, real process)", () => {
  const guard = fileURLToPath(new URL("../../src-tauri/resources/worktree-guard.mjs", import.meta.url));
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** Run the guard exactly as the harness does. Returns { code, stderr }. */
  function runGuard(command: string, cwd: string): { code: number; stderr: string } {
    const payload = JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } });
    try {
      execFileSync("node", [guard, repo], { input: payload, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return { code: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: string };
      return { code: e.status ?? -1, stderr: e.stderr ?? "" };
    }
  }

  it("exits 2 and names the offending file when `git add -A` would sweep up a secret", () => {
    writeFileSync(join(repo, ".gitignore"), ".env\n"); // the bare literal, as in the real incident
    write(repo, ".env.bak-20260724");
    const { code, stderr } = runGuard("git add -A", repo);
    expect(code).toBe(2); // ONLY exit 2 blocks the tool call
    expect(stderr).toContain(".env.bak-20260724");
    expect(stderr).toContain(".gitignore");
    // The remedy must be safe under the very conditions that triggered the refusal.
    expect(stderr).not.toContain("git add -f");
  });

  it("exits 0 (allows) when the secret is properly gitignored", () => {
    writeFileSync(join(repo, ".gitignore"), ".env*\n");
    write(repo, ".env");
    write(repo, ".env.bak-20260724");
    expect(runGuard("git add -A", repo).code).toBe(0);
  });

  it("exits 2 and offers an UN-STAGE remedy when the secret is already in the index", () => {
    write(repo, ".env.production");
    execFileSync("git", ["-C", repo, "add", "-f", ".env.production"], { stdio: "ignore" });
    const { code, stderr } = runGuard('git commit -m "wip"', repo);
    expect(code).toBe(2);
    expect(stderr).toContain(".env.production");
    // The remedy has to match where the file actually IS — telling a reader to edit .gitignore does
    // not un-stage anything, so a staged secret gets the restore/rm --cached instruction instead.
    expect(stderr).toContain("git restore --staged");
    expect(stderr).not.toContain("git add -f");
  });

  // THE BLAST-RADIUS TEST (roborev 60538 / 60563, Medium). The wrap around blocksSecretStaging in
  // main() only matters when the predicate THROWS, and no natural input makes it throw — so an
  // earlier version of this test asserted `code is 0 or 2`, which a thrown exception satisfies too
  // (it hits the pre-existing top-level `.catch(() => process.exit(2))`). That test could not fail
  // if the wrap were deleted, which is the definition of vacuous.
  //
  // So INJECT the throw: copy the REAL guard, make blocksSecretStaging throw on its first line, and
  // run that. With the wrap, the hook degrades to "this one guard is off" and everything else keeps
  // working. Without it, the throw exits 2 with no message — blocking every Bash command for every
  // agent AND skipping the containment check. Deleting the try/catch turns both assertions red.
  it("keeps the rest of the hook alive when the predicate throws (the wrap in main())", () => {
    const real = readFileSync(guard, "utf8");
    const anchor = "export function blocksSecretStaging(command, cwd) {";
    expect(real, "anchor must track the real function signature").toContain(anchor);
    // The filename MUST still end in "worktree-guard.mjs" — main() is gated on
    // `process.argv[1].endsWith("worktree-guard.mjs")`, so any other name runs nothing and every
    // assertion below would pass for the wrong reason.
    const sabotaged = join(repo, "sabotaged-worktree-guard.mjs");
    writeFileSync(sabotaged, real.replace(anchor, `${anchor}\n  throw new Error("injected parser bug");`));

    const runSabotaged = (input: string) => {
      try {
        execFileSync("node", [sabotaged, repo], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        return { code: 0, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stderr?: string };
        return { code: e.status ?? -1, stderr: e.stderr ?? "" };
      }
    };

    // 1. An ordinary Bash command still runs. Unwrapped this is exit 2 — every shell command dead.
    expect(
      runSabotaged(JSON.stringify({ cwd: repo, tool_name: "Bash", tool_input: { command: "pnpm test" } })).code,
    ).toBe(0);

    // 2. The pre-existing containment guard still does its job, and says so. Unwrapped, the throw
    //    exits 2 from the top-level catch BEFORE the containment check runs, so stderr is empty —
    //    same exit code, different reason, which is why this asserts the MESSAGE and not just 2.
    const contained = runSabotaged(
      JSON.stringify({
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command: "git add -A", file_path: "/etc/passwd" },
      }),
    );
    expect(contained.code).toBe(2);
    expect(contained.stderr).toContain("outside this agent's worktree");
  });

  // The lexer must be TOTAL over hostile input — and every one of these has an exact expected
  // verdict, not "0 or 2". A range assertion here would be satisfied by a crash.
  it("returns the RIGHT decision for adversarial command strings", () => {
    const mustAllow = [
      'git add "unterminated',
      "git add '",
      "git add \\",
      "git commit -m",
      "git -C",
      "git",
      "git add :(",
      "git add :(exclude",
      "git add ::::",
      `git add ${"a/".repeat(5000)}b`,
      `git commit -m "${"x".repeat(50000)}"`,
      "git add $(cat files.txt)",
      "git add `ls`",
      "git\tadd\t-A\t",
      "((((git add -A))))",
      "git add -- -- --",
    ];
    // The fixture repo is clean, so every sweep above legitimately finds nothing.
    for (const command of mustAllow) {
      expect(runGuard(command, repo).code, `should ALLOW: ${JSON.stringify(command)}`).toBe(0);
    }
    // …and the lexer must not LOSE a pathspec to hostile whitespace either.
    write(repo, ".env");
    const mustBlock = [
      // A run of spaces must not merge into one token and swallow the path.
      "git add    .env",
      // A raw NUL written as an ESCAPE, never as a literal byte: a literal one makes git treat this
      // source file as binary (no diffs, no review) and `sourceIsText.test.ts` fails the build for
      // it. The runtime string is identical. Here the NUL only reaches `statSync` inside
      // isDirectoryPathspec — CASE 1 matches the `.env` sibling and returns before any git call —
      // so what this pins is that a swallowed statSync error does not lose the real pathspec.
      "git add \u0000 .env",
    ];
    for (const command of mustBlock) {
      expect(runGuard(command, repo).code, `should BLOCK: ${JSON.stringify(command)}`).toBe(2);
    }

    // …and the NUL reaching execFileSync, which needs a SWEEP (a named secret-shaped sibling makes
    // CASE 1 return first, before any git call). Node rejects a NUL-bearing argument outright, so
    // `untrackedSecrets` cannot run — which is precisely the documented CASE 2 fail-open. The PAIR
    // is what makes this non-vacuous: with an un-ignored `.env` present the plain sweep is a block,
    // and only the unrunnable probe turns it into an allow. (roborev 60583.)
    expect(runGuard("git add -A", repo).code, "plain sweep over an un-ignored .env").toBe(2);
    expect(runGuard("git add -A \u0000", repo).code, "sweep whose probe cannot run → fail OPEN").toBe(0);
  });

  it("exits 0 for ordinary commands and leaves the pre-existing guards working", () => {
    write(repo, "src/app.ts", "x\n");
    expect(runGuard("git add src/app.ts", repo).code).toBe(0);
    expect(runGuard("pnpm test", repo).code).toBe(0);
    // The keychain guard that shares this hook still fires.
    expect(runGuard("security find-generic-password -s ai.sparkle.desktop", repo).code).toBe(2);
  });
});

describe("isSecretPath", () => {
  it("matches the classes a .gitignore habitually misses", () => {
    for (const p of [
      ".env",
      ".env.local",
      ".env.bak-20260724",
      ".env.bak-concierge-20260806-021701",
      "production.env",
      "deploy.env",
      "certs/server.pem",
      "server.key",
      "cert.p12",
      "cert.pfx",
      "id_rsa",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "keys/id_ed25519_sparkle",
      ".netrc",
      ".npmrc",
      ".pgpass",
      "credentials.json",
      "service-account.json",
      "service-account-prod.json",
      "auth.json",
      "accounts.json",
      ".claude.json",
      ".credentials.json",
      "login.keychain",
      "release.jks",
      "upload.keystore",
      "AuthKey_ABC123.p8",
      ".aws/credentials",
      "home/.aws/credentials",
    ]) {
      expect(isSecretPath(p), `${p} should be secret-shaped`).toBe(true);
    }
  });

  it("does NOT match ordinary files, templates, or public keys", () => {
    for (const p of [
      "src/app.ts",
      "README.md",
      "package.json",
      "tsconfig.json",
      ".env.example",
      ".env.sample",
      ".env.template",
      "apps/web/.env.example",
      "credentials.json.example",
      "id_rsa.pub",
      "id_ed25519.pub",
      "environment.ts",
      "docs/keys.md",
      "credentials", // bare, not under .aws/
      "src/keychain.ts",
      "",
    ]) {
      expect(isSecretPath(p), `${p} should NOT be secret-shaped`).toBe(false);
    }
    expect(isSecretPath(undefined)).toBe(false);
  });
});
