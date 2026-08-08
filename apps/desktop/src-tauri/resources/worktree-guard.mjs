// Claude Code PreToolUse guard: refuse any file-write whose resolved path escapes the agent's
// worktree. Invoked as `node worktree-guard.mjs <install-root>` with the tool payload on stdin.
//
// The <install-root> arg is only the worktree this hook was INSTALLED for; the SAME hook also runs
// for sub-agents / pooled worktrees whose real cwd is a DIFFERENT worktree. So the containment check
// is worktree-RELATIVE: it allows edits inside WHICHEVER worktree the caller is actually operating in
// (derived from the tool call's `cwd` via `git rev-parse --show-toplevel`), falling back to
// <install-root> when cwd isn't in a git work tree. Editing ANOTHER worktree is still blocked.
//
// NOTE: this is a best-effort guardrail, NOT a security sandbox. Its file-path containment check
// only inspects Edit/Write/MultiEdit/NotebookEdit paths — it does NOT otherwise constrain the Bash
// tool, which can write anywhere the user can. True isolation comes from the per-agent worktree+branch
// model; this hook just stops a well-behaved agent from accidentally editing outside its lane.
//
// It ALSO carries two narrow Bash guards:
//   - (sparkle-0ezz) it blocks a `security`-CLI invocation against the app's `ai.sparkle.desktop`
//     keychain item. Workers auto-approve their own shell commands, so an agent shelling out to
//     `security find-generic-password -s ai.sparkle.desktop` would pop a scary "security wants to use
//     your confidential information" OS prompt at the user. The app never shells out (it reads that
//     item in-process via keyring); only an agent does, so we stop the command from running.
//   - SECRET STAGING: it blocks a `git add` / `git commit` that would put a secret-shaped file into
//     git. Agents run with bypass-permissions and routinely type `git add -A && git commit`, so
//     nothing else stands between an untracked `.env.bak-<date>` holding a live API key and a public
//     GitHub repo. A `.gitignore` fix only ever helps the one repo somebody remembered to edit; this
//     guard ships with Sparkle and covers EVERY project a user points it at. (A repo-local
//     `pre-commit` hook is not an option: `core.hooksPath` is commonly set globally, which makes any
//     repo-local hook structurally unable to run. The PreToolUse hook is the layer that actually fires.)
import { relative, sep, isAbsolute, dirname, join } from "node:path";
import { lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// Canonicalize `p` by resolving symlinks one path segment at a time — a from-scratch realpath
// that also tolerates not-yet-existing trailing segments (the file a Write is about to create).
// This is the load-bearing part of the containment check: without full canonicalization an agent
// escapes its worktree by creating a symlink inside it that points outward (e.g. `ln -s ~/.ssh
// evil` then writing `<worktree>/evil/authorized_keys`).
//
// Why hand-rolled instead of fs.realpathSync: realpathSync throws on a DANGLING symlink (a link
// whose target doesn't exist yet — the `ln -s ~/.ssh/authorized_keys evil` injection), so it
// can't be used for a pre-write check. But getting this right is subtle; the walk MUST:
//   - resolve `..` against the *symlink-resolved* parent, never collapse it lexically up front
//     (path.resolve would turn `link/../x` into `x` before noticing `link` is a symlink), and
//   - re-walk EVERY segment of a symlink's target, including the target's own intermediate
//     symlinks (`a -> b/c`, `b -> /outside`), not just chain on the final component.
// So we process a growable segment QUEUE: a symlink's target is spliced back to the FRONT of the
// queue, so each of its components is itself re-checked for symlink-ness. A not-yet-existing
// component is accepted literally (a new file/dir). Returns null if a symlink loop blows the hop
// cap, so the caller fails closed.
function realResolve(p) {
  const startAbs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`;
  const queue = startAbs.split(sep).filter((s) => s.length > 0);
  let resolved = sep; // POSIX filesystem root
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === ".") continue;
    if (seg === "..") {
      resolved = dirname(resolved); // pop against the RESOLVED parent, never lexically
      continue;
    }
    const next = resolved === sep ? sep + seg : `${resolved}${sep}${seg}`;
    let st;
    try {
      st = lstatSync(next);
    } catch {
      resolved = next; // doesn't exist yet — a new file/dir; accept literally
      continue;
    }
    if (!st.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    // `hops` is a whole-path budget on TOTAL symlink resolutions (not a per-component chain
    // limit). Exceeding it — a cycle, or a pathological symlink farm — returns null → fail closed.
    if (++hops > 256) return null;
    let target;
    try {
      target = readlinkSync(next);
    } catch {
      // The link was deleted/replaced between the lstat above and here (a TOCTOU race). Don't
      // throw — that would escape to main() and (since only exit 2 blocks) fail OPEN; return
      // null so the caller fails closed instead.
      return null;
    }
    if (isAbsolute(target)) resolved = sep; // absolute target: restart from root
    // else the target is relative to the link's directory, which is the current `resolved`.
    queue.unshift(...target.split(sep).filter((s) => s.length > 0));
  }
  return resolved;
}

/** True iff `target` is `root` or a descendant of it, with BOTH sides canonicalized through
 *  symlinks (and `.`/`..`) so no symlinked or `..`-laden path component can escape the worktree.
 *  Fails closed (returns false) if either path can't be resolved (symlink loop). */
export function isInside(root, target) {
  const r = realResolve(root);
  // Join root+target WITHOUT lexical `..` collapse (realResolve handles `..` against resolved
  // parents); an absolute target is used as-is.
  const t = realResolve(isAbsolute(target) ? target : `${root}${sep}${target}`);
  if (r === null || t === null) return false;
  const rel = relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

/** True iff `command` (a Bash tool's command string) shells out to the macOS `security` CLI against
 *  the app's generic-password keychain item. We require ALL THREE signals so we block the confidential
 *  `ai.sparkle.desktop` access without snagging unrelated commands: (a) the `security` binary is invoked
 *  as a command word (bare or via an absolute path, not merely the substring "security" inside another
 *  word like "security-review"); (b) a `*-generic-password` subcommand; (c) the `ai.sparkle.desktop`
 *  service name. Apple's OS dialog can't be suppressed, so the goal is to stop the command from running. */
export function blocksKeychainCommand(command) {
  if (typeof command !== "string") return false;
  // (a) `security` invoked as a command word: at a start/separator boundary, optionally path-prefixed
  // (e.g. `/usr/bin/security`), followed by whitespace or end — so "insecurity"/"security-scan" miss.
  const invokesSecurity = /(^|[\s;&|()`'"])([^\s;&|()`'"]*\/)?security(\s|$)/.test(command);
  if (!invokesSecurity) return false;
  // (b) any *-generic-password subcommand (find/add/delete/set-generic-password).
  const genericPassword = /generic-password/.test(command);
  // (c) targeting the app's keychain service.
  const appService = /ai\.sparkle\.desktop/.test(command);
  return genericPassword && appService;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// SECRET-STAGING GUARD
//
// Two DISTINCT cases, deliberately kept apart. Conflating them is what makes a secret scanner noisy
// enough to get ripped out, and a guard nobody trusts protects nothing:
//
//   CASE 1 — the command NAMES a secret-shaped path (`git add .env`, and notably the deliberate
//            override `git add -f .env`, which no .gitignore can stop). Evidence comes from the
//            command line itself, so this needs no repo access and is pure string matching.
//   CASE 2 — the command SWEEPS (`git add -A` / `--all` / `.` / a directory, `git commit -a`). The
//            command line names nothing, so the evidence has to come from the repository: ask
//            `git status --porcelain --untracked-files=all` and complain only about files that are
//            UNTRACKED AND NOT IGNORED. A properly gitignored `.env` is the correct, safe and
//            extremely common state; blocking on it would fire on nearly every repo and destroy
//            trust in the guard.
//
// FAIL-OPEN / FAIL-CLOSED ASYMMETRY — read this before "fixing" it into an outage:
//   * CASE 1 fails CLOSED. It needs nothing but the command string, so an inability to reach git is
//     not an inability to decide: the path is secret-shaped regardless, and we block. (The one repo
//     lookup it does make — "is this path already tracked?" — resolves to `false` when git cannot be
//     reached, i.e. toward blocking.)
//   * CASE 2 fails OPEN. Its whole premise is evidence FROM the repo, and absence of evidence is not
//     evidence: if `git status` cannot run (not a repo, git missing, no usable cwd, or the command
//     `cd`s somewhere first so the directory we would inspect is the WRONG one) then we have learned
//     nothing about whether a secret exists. Blocking there would break ordinary `git add -A` work
//     in every non-repo and every mis-detected directory, for zero security benefit — and a
//     wrong-directory inspection produces the worst outcome of all, a confident FALSE block naming a
//     file that has nothing to do with the command. So: cannot determine repo state → allow.
// The rest of this file fails CLOSED on unexpected errors (only exit 2 blocks, so a thrown error
// would otherwise let the tool call through); that discipline is preserved — the fail-open here is a
// deliberate, narrow decision about a KNOWN unknowable, not a swallowed exception.

/** Basenames that are secrets outright. */
const SECRET_BASENAMES = new Set([
  ".env",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pgpass",
  ".claude.json",
  ".credentials.json",
  "credentials.json",
  "auth.json",
  "accounts.json",
]);

/** Extensions that are private key / keystore material. */
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".p8", ".keychain", ".keychain-db", ".jks", ".keystore"];

/** True iff `p` (a repo-relative or absolute path) looks like credential material. Basename-driven,
 *  with one path-anchored case (`.aws/credentials`). Covers the classes a `.gitignore` habitually
 *  misses — in particular `.env.<anything>` (the founder's `.env.bak-20260724`, which a bare `.env`
 *  literal does NOT match) and the suffix form (`production.env`, `deploy.env`).
 *
 *  Two exemptions keep the false-positive rate near zero, both of them files that are SUPPOSED to be
 *  committed: template files (`.env.example` / `.sample` / `.template` / `.dist` — this very repo
 *  tracks three `.env.example`s, so a false block here would be an immediate self-inflicted wound)
 *  and the `.pub` half of a keypair, which is public by definition. "Already tracked by git" is the
 *  third exemption and lives in the caller, since it needs the repo. */
export function isSecretPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  if (base.length === 0) return false;
  // Exemption: the public half of a keypair, and anything shaped like a committed template.
  if (base.endsWith(".pub")) return false;
  if (/(^|\.)(example|sample|template|dist)$/.test(base)) return false;
  if (/^(example|sample|template)\./.test(base)) return false;
  if (SECRET_BASENAMES.has(base)) return true;
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  // `.env.<anything>` (dotfile form) and `<anything>.env` (suffix form).
  if (base.startsWith(".env.") || base.endsWith(".env")) return true;
  // Private SSH keys, including suffixed variants like `id_ed25519_sparkle` (`.pub` already excluded).
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (/^service-account.*\.json$/.test(base)) return true;
  // Path-anchored: `credentials` is only a secret when it sits directly under `.aws/`.
  if (base === "credentials" && parts[parts.length - 2] === ".aws") return true;
  return false;
}

/** Lex a Bash command string into a list of SEGMENTS, each an array of word tokens, splitting on
 *  unquoted `;` `&&` `||` `|` `(` `)` and newlines. Quote- and backslash-aware so `git add "my
 *  dir/.env"` yields one path token and `echo 'git add -A'` yields no git segment at all. This is a
 *  guardrail's approximation of a shell, not a shell: exotica (command substitution, process
 *  substitution) simply degrades toward tokens we then fail to recognise as a git invocation, which
 *  is the safe direction for a check that must never fire spuriously. */
function lexCommand(command) {
  const segments = [];
  let cur = [];
  let word = "";
  let hasWord = false;
  let quote = null;
  const flushWord = () => {
    if (hasWord) {
      cur.push(word);
      word = "";
      hasWord = false;
    }
  };
  const flushSegment = () => {
    flushWord();
    if (cur.length > 0) {
      segments.push(cur);
      cur = [];
    }
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && c === "\\" && i + 1 < command.length) {
        word += command[++i];
        continue;
      }
      word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      continue;
    }
    if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === ")") {
      flushSegment();
      continue;
    }
    word += c;
    hasWord = true;
  }
  flushSegment();
  return segments;
}

/** git's own global options that take a separate value word, so we can skip past them to the
 *  subcommand without mistaking the value for one. */
const GIT_GLOBAL_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** If `tokens` is a git invocation, return `{ sub, args, dirOverride }`; otherwise null. Leading
 *  `VAR=value` env assignments are skipped, and the binary may be path-prefixed (`/usr/bin/git`) —
 *  but a command merely NAMED like git (`gitk`, `legit`) is not one. */
function gitInvocation(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const bin = tokens[i].split("/").pop();
  if (bin !== "git") return null;
  i++;
  let dirOverride = null;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const t = tokens[i];
    if (GIT_GLOBAL_VALUE_OPTS.has(t)) {
      if (t === "-C") dirOverride = tokens[i + 1] ?? null;
      i += 2;
      continue;
    }
    if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) {
      i++;
      continue;
    }
    i++;
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i], args: tokens.slice(i + 1), dirOverride };
}

/** Parse `git add` arguments into { paths, sweepsAll }. `sweepsAll` covers the forms that stage
 *  whatever happens to be lying around with no pathspec at all. `-u`/`--update` is deliberately NOT
 *  a sweep: it restages TRACKED modifications only and can never introduce an untracked file. */
function parseAddArgs(args) {
  const paths = [];
  let sweepsAll = false;
  let endOfOpts = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!endOfOpts && t === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && t.startsWith("--")) {
      const name = t.split("=")[0];
      if (name === "--all" || name === "--no-ignore-removal") sweepsAll = true;
      // A pathspec list we cannot read — treat as a whole-repo sweep (CASE 2, which fails open).
      if (name === "--pathspec-from-file") {
        sweepsAll = true;
        if (!t.includes("=")) i++;
      }
      if (name === "--chmod" && !t.includes("=")) i++;
      continue;
    }
    if (!endOfOpts && t.startsWith("-") && t.length > 1) {
      if (t.slice(1).includes("A")) sweepsAll = true;
      continue;
    }
    paths.push(t);
  }
  return { paths, sweepsAll };
}

/** git-commit short options that consume a value: the rest of the cluster, or the next word. This is
 *  what keeps `-am "msg"` (= `-a -m msg`, a sweep) apart from `-ma` (= `-m a`, NOT a sweep) and stops
 *  a commit MESSAGE from ever being read as a pathspec. */
const COMMIT_SHORT_VALUE_OPTS = new Set(["m", "F", "c", "C", "t"]);
const COMMIT_LONG_VALUE_OPTS = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--author",
  "--date",
  "--cleanup",
  "--template",
  "--fixup",
  "--squash",
  "--pathspec-from-file",
  "--trailer",
]);

/** Every `git commit` option that makes the commit publish the WHOLE INDEX rather than just the named
 *  pathspecs. git's own mutual-exclusion message names exactly this family — "Only one of --include,
 *  --only, --all, --interactive, --patch can be used" — and `--only` is the one that CONFIRMS scoping
 *  (it is the default when pathspecs are given), so the other four are the ones we must catch. */
const COMMIT_INDEX_PUBLISHING_LONG = ["--all", "--include", "--interactive", "--patch"];
const COMMIT_INDEX_PUBLISHING_SHORT = new Set(["a", "i", "p"]);

/** `git commit` options that do NOT change which paths the commit publishes. This list exists to be
 *  INCOMPLETE safely: anything absent from it is treated as "we do not understand this command", and
 *  the index probe then runs UNSCOPED. See the `unknownOption` note on parseCommitArgs. */
const COMMIT_SCOPE_NEUTRAL_SHORT = new Set(["b", "e", "n", "o", "q", "s", "S", "u", "v", "z"]);
const COMMIT_SCOPE_NEUTRAL_LONG = new Set([
  "--message", "--file", "--reuse-message", "--reedit-message", "--author", "--date", "--cleanup",
  "--template", "--fixup", "--squash", "--trailer", "--amend", "--no-amend", "--edit", "--no-edit",
  "--verify", "--no-verify", "--signoff", "--no-signoff", "--gpg-sign", "--no-gpg-sign", "--quiet",
  "--verbose", "--dry-run", "--status", "--no-status", "--short", "--porcelain", "--long", "--null",
  "--branch", "--no-branch", "--reset-author", "--allow-empty", "--allow-empty-message", "--only",
  "--untracked-files", "--pathspec-file-nul", "--no-post-rewrite", "--author-date", "--squash-message",
]);

/** Parse `git commit` arguments into { paths, sweepsAll, includesIndex, unknownOption }.
 *
 *  The last three all answer ONE question: may the index probe be SCOPED to `paths`? Scoping is sound
 *  only for git's default `--only` behaviour — the commit contains those paths and nothing else, so an
 *  unrelated staged secret is not published by it. Anything that publishes the whole index breaks
 *  that, and getting it wrong is a SILENT ALLOW, the guard's worst failure mode.
 *
 *  So this asks a PROPERTY rather than testing membership against a fixed list of spellings, which is
 *  how the first version of this got it wrong (it enumerated `--include` and `-i` and missed `-p`,
 *  `--interactive`, and every abbreviation):
 *    - long options are matched by PREFIX, because git accepts any unambiguous abbreviation — `--inc`
 *      IS `--include`, and an equality test misses it;
 *    - `unknownOption` is the fail-closed backstop. An option we do not positively recognise as
 *      scope-neutral — a git flag added after this was written, an abbreviation we cannot resolve —
 *      forces the UNSCOPED probe. That errs toward a false block whose remedy (un-stage the secret)
 *      is sound advice whenever it fires, rather than toward silently publishing a credential. The
 *      neutral list above is therefore safe to be incomplete, and unsafe to "optimise" into a
 *      publishing-only check. */
function parseCommitArgs(args) {
  const paths = [];
  let sweepsAll = false;
  let includesIndex = false;
  let unknownOption = false;
  let endOfOpts = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (!endOfOpts && t === "--") {
      endOfOpts = true;
      continue;
    }
    if (!endOfOpts && t.startsWith("--")) {
      const name = t.split("=")[0];
      // Prefix match: `name` is an abbreviation of a full option name iff the full name starts with it.
      const publishes = COMMIT_INDEX_PUBLISHING_LONG.filter((full) => full.startsWith(name));
      if (publishes.length > 0) {
        if (publishes.includes("--all")) sweepsAll = true;
        else includesIndex = true;
      } else if (name === "--pathspec-from-file") {
        sweepsAll = true;
      } else if (!COMMIT_SCOPE_NEUTRAL_LONG.has(name)) {
        unknownOption = true;
      }
      if (COMMIT_LONG_VALUE_OPTS.has(name) && !t.includes("=")) i++;
      continue;
    }
    if (!endOfOpts && t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (COMMIT_SHORT_VALUE_OPTS.has(ch)) {
          // This option eats the remainder of the cluster, or the next word if it is the last char.
          if (k === t.length - 1) i++;
          break;
        }
        if (ch === "a") sweepsAll = true;
        else if (COMMIT_INDEX_PUBLISHING_SHORT.has(ch)) includesIndex = true;
        else if (!COMMIT_SCOPE_NEUTRAL_SHORT.has(ch)) unknownOption = true;
      }
      continue;
    }
    paths.push(t);
  }
  return { paths, sweepsAll, includesIndex, unknownOption };
}

/** Split git PATHSPEC MAGIC off a pathspec token: `{ path, excluded }`. Two things matter here.
 *  (a) A magic prefix is not part of the filename — `:(top).env` names `.env`, and matching the raw
 *  token would miss it. (b) An EXCLUDING pathspec (`:!*.env`, `:^secrets/`, `:(exclude)*.env`) names
 *  files the command is deliberately keeping OUT. Reading that as "the command explicitly names a
 *  secret" would false-block the very idiom a careful agent uses to avoid one — so `excluded` specs
 *  are dropped from our own analysis entirely. (They are still handed to git verbatim on the CASE 2
 *  probe, which is what makes `git add . ':!*.env'` correctly come back clean.) */
function parsePathspec(p) {
  if (typeof p !== "string" || p.length === 0) return { path: "", excluded: false };
  if (p.startsWith(":(")) {
    const end = p.indexOf(")");
    if (end === -1) return { path: p, excluded: false };
    const magic = p.slice(2, end).split(",").map((s) => s.trim());
    return { path: p.slice(end + 1), excluded: magic.includes("exclude") };
  }
  if (p.startsWith(":!") || p.startsWith(":^")) return { path: p.slice(2), excluded: true };
  if (p.startsWith(":/")) return { path: p.slice(2), excluded: false };
  return { path: p, excluded: false };
}

/** True iff pathspec `p` stages a whole subtree rather than one named file — `.`, `./`, `*`, `:/`, a
 *  trailing-slash path, or (when we have a directory to resolve against) any path that IS a
 *  directory. A subtree stage is a CASE 2 sweep scoped to that pathspec. */
function isDirectoryPathspec(p, dir) {
  if (p === "." || p === "./" || p === ".." || p === "*" || p === ":/" || p === ":/.") return true;
  if (p.endsWith("/")) return true;
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    return statSync(isAbsolute(p) ? p : join(dir, p)).isDirectory();
  } catch {
    return false;
  }
}

/** Un-quote a path as `git status --porcelain` prints it. git C-quotes paths containing unusual
 *  bytes (`"src/caf\303\251.env"`); everything else is emitted verbatim. */
function unquoteStatusPath(p) {
  if (!(p.startsWith('"') && p.endsWith('"') && p.length >= 2)) return p;
  try {
    // JSON's escape grammar covers the common cases (\" \\ \n \t); octal escapes are left alone,
    // which at worst yields a slightly odd-looking filename in the refusal message.
    return JSON.parse(p);
  } catch {
    return p.slice(1, -1);
  }
}

/** Secret-shaped files that are UNTRACKED AND NOT IGNORED in `dir`, optionally scoped to
 *  `pathspecs`. Returns [] when the repo is clean of them, or null when the repo state could not be
 *  determined at all — the caller treats null as "allow" (see the fail-open note above).
 *
 *  `--untracked-files=all` is load-bearing: the default `normal` mode collapses an untracked
 *  directory to a single `dir/` entry, which would hide every secret inside it. Ignored files are
 *  simply absent from the output (we do NOT pass `--ignored`), which is exactly the semantics we
 *  want: a gitignored `.env` is safe and must never trigger this. */
function untrackedSecrets(dir, pathspecs) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const args = ["-C", dir, "status", "--porcelain", "--untracked-files=all"];
  if (pathspecs.length > 0) args.push("--", ...pathspecs);
  let out;
  try {
    out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000, // a PreToolUse hook must never hang the agent; a timeout throws → fail open
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null; // not a repo / git missing / timed out / output too large → cannot determine
  }
  const hits = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("?? ")) continue; // `??` is untracked-and-not-ignored, the only class we judge
    const p = unquoteStatusPath(line.slice(3).trim());
    if (isSecretPath(p)) hits.push(p);
  }
  return hits;
}

/** Secret-shaped files that are already IN THE INDEX at `dir`, i.e. staged for the next commit.
 *  Returns [] when there are none, or null when repo state could not be determined (fail open).
 *
 *  Why this exists on top of the untracked probe: a `git commit -m "…"` names nothing and sweeps
 *  nothing, yet it publishes whatever the index already holds — staged by something this hook could
 *  not see. A repo script the agent invokes (`bash scripts/deploy.sh`, which runs `git add -A`
 *  internally) is opaque to our lexer; so is a `bash -c "git add -A"`; so is anything staged before
 *  this guard shipped. Without this, the commit half of the guard is unenforced on the single most
 *  common command an agent types.
 *
 *  Only index codes `A`/`R`/`C` count — a path NEWLY introduced to the index. A tracked file's
 *  modification (`M`) is already in history, so blocking it protects nothing and would just fire on
 *  ordinary edits to legitimately committed files. `--untracked-files=no` keeps this probe cheap:
 *  it runs on every `git commit`, and the working-tree scan is not needed to read the index.
 *
 *  SCOPED to the commit's own pathspecs when it has any: `git commit -m "fix" src/app.ts` commits
 *  ONLY that path, so an unrelated staged secret elsewhere is not published by it and complaining
 *  would be a false block whose message ("this commit would publish them") is simply untrue. Raw
 *  pathspecs go to git verbatim, so magic and exclusions stay honoured. */
function stagedSecrets(dir, pathspecs = []) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  const args = ["-C", dir, "status", "--porcelain", "--untracked-files=no"];
  if (pathspecs.length > 0) args.push("--", ...pathspecs);
  let out;
  try {
    out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const hits = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const indexCode = line[0];
    if (indexCode !== "A" && indexCode !== "R" && indexCode !== "C") continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4); // rename/copy: the DESTINATION is what lands in the commit
    p = unquoteStatusPath(p);
    if (isSecretPath(p)) hits.push(p);
  }
  return hits;
}

/** True iff `p` is already tracked (or staged) in the repo at `dir`. Used only to EXEMPT a named
 *  path in CASE 1: a file git already carries is not something this guard can protect — it is
 *  already in history — and blocking edits to it would break ordinary work on legitimately tracked
 *  files (this repo tracks `.npmrc`, which is on the pattern list). Any failure returns false, i.e.
 *  toward blocking, which keeps CASE 1 strict. */
function isTrackedInRepo(dir, p) {
  if (typeof dir !== "string" || dir.length === 0) return false;
  try {
    execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", p], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Does this segment change the working directory for everything after it? If so, the `cwd` from the
 *  hook payload no longer describes where a later `git` actually runs, and CASE 2 must stand down. */
function changesDirectory(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const bin = (tokens[i] ?? "").split("/").pop();
  return bin === "cd" || bin === "pushd" || bin === "popd" || bin === "chdir";
}

/** THE SECRET-STAGING PREDICATE. Given a Bash tool's `command` string and the hook payload's `cwd`,
 *  return null to allow, or `{ kind, files }` to block — `kind` is `"named"` (CASE 1) or `"sweep"`
 *  (CASE 2) and `files` names the offending path(s) so the refusal message can quote them.
 *
 *  Note on `git commit -a`: strictly, `-a` stages TRACKED modifications and does not itself pick up
 *  an untracked file. We still treat it as a sweep, deliberately. The hazardous state is "a live
 *  credential is sitting in the working tree, un-ignored" — it is one `git add -A` away from a public
 *  remote either way, the agent typing `git commit -a` is mid-commit and about to do exactly that,
 *  and the remedy the refusal offers (ignore it, then retry) fixes the underlying hazard rather than
 *  just this one command. The false-positive cost is bounded by that same rare, dangerous state. */
export function blocksSecretStaging(command, cwd) {
  if (typeof command !== "string" || command.length === 0) return null;
  // Cheap bail-out: nothing to do unless the command mentions git at all.
  if (!command.includes("git")) return null;
  let cwdIsUnreliable = false;
  for (const tokens of lexCommand(command)) {
    if (changesDirectory(tokens)) {
      cwdIsUnreliable = true;
      continue;
    }
    const git = gitInvocation(tokens);
    if (git === null) continue;
    if (git.sub !== "add" && git.sub !== "commit") continue;
    const { paths, sweepsAll, includesIndex = false, unknownOption = false } =
      git.sub === "add" ? parseAddArgs(git.args) : parseCommitArgs(git.args);

    // Where a repo probe would have to run. An ABSOLUTE `-C` makes the probe reliable even after a
    // `cd`, because it pins the directory itself.
    let probeDir = null;
    if (typeof git.dirOverride === "string" && git.dirOverride.length > 0 && isAbsolute(git.dirOverride)) {
      probeDir = git.dirOverride;
    } else if (!cwdIsUnreliable && typeof cwd === "string" && cwd.length > 0) {
      probeDir = git.dirOverride ? join(cwd, git.dirOverride) : cwd;
    }

    // Classify each pathspec ONCE, with magic stripped and excluding specs dropped (see
    // parsePathspec): a subtree pathspec makes this a scoped CASE 2 sweep, a plain filename is a
    // CASE 1 candidate.
    const namedSecrets = [];
    let sweepsScope = false;
    for (const raw of paths) {
      const spec = parsePathspec(raw);
      if (spec.excluded) continue; // the command is keeping these OUT — never a reason to block
      const effective = spec.path.length > 0 ? spec.path : ".";
      if (isDirectoryPathspec(effective, probeDir)) sweepsScope = true;
      else if (isSecretPath(effective)) namedSecrets.push(effective);
    }

    // CASE 1 — an explicitly named secret path. Pure string matching; strict.
    const unexempt = namedSecrets.filter((p) => !isTrackedInRepo(probeDir, p));
    if (unexempt.length > 0) return { kind: "named", files: unexempt };

    // CASE 2 — a sweep. Consult the repo; fail OPEN if it cannot be consulted. Every raw pathspec is
    // handed to git verbatim (magic included), so an exclusion the agent wrote is honoured by git
    // itself and `git add . ':!*.env'` correctly comes back clean.
    if (sweepsAll || sweepsScope) {
      const hits = untrackedSecrets(probeDir, paths);
      // hits === null → could not determine repo state → allow (see the asymmetry note above).
      if (hits !== null && hits.length > 0) return { kind: "sweep", files: hits };
    }

    // A commit also publishes whatever is ALREADY staged, by something this hook never saw. Same
    // fail-open rule. (`git add` needs no equivalent — staging a secret is only dangerous once it is
    // committed, and that is this branch.) Scoped to the commit's own pathspecs, because git's
    // default with pathspecs is `--only`: the commit contains those paths and nothing else, so an
    // unrelated staged secret is not published by it. Anything that publishes the whole index
    // (`-a`, `-i`, `-p`, `--interactive`, and any abbreviation of those) must never be scoped —
    // scoping there would silently wave through the exact thing this guard exists to stop — and an
    // option we do not recognise AT ALL forces the unscoped probe too (see parseCommitArgs).
    if (git.sub === "commit") {
      const staged = stagedSecrets(probeDir, includesIndex || sweepsAll || unknownOption ? [] : paths);
      if (staged !== null && staged.length > 0) return { kind: "staged", files: staged };
    }
  }
  return null;
}

/** The stderr text for a secret-staging refusal. A refusal message is an instruction the reader will
 *  follow, so both remedies it offers have to be safe under the very conditions that triggered it —
 *  which is why `git add -f` is not among them. */
function secretStagingMessage(verdict) {
  const lead = {
    named: "Blocked: this command explicitly names a secret-shaped file:",
    sweep:
      "Blocked: this command stages everything untracked, and these secret-shaped files are neither tracked nor ignored:",
    staged: "Blocked: these secret-shaped files are already STAGED and this commit would publish them:",
  }[verdict.kind];
  const list = verdict.files.map((f) => `  - ${f}`).join("\n");
  // The remedies differ by kind because the file is in a different place each time — and a remedy
  // that does not actually apply is worse than none, since the reader will follow it.
  const remedies =
    verdict.kind === "staged"
      ? "  1. Un-stage it, then commit — `git restore --staged <path>` (older git: `git rm --cached\n" +
        "     <path>`), then add the path to .gitignore (or .git/info/exclude) so it cannot come back.\n" +
        "  2. Then re-run your commit. Anything else you staged is untouched by the un-stage above.\n"
      : "  1. Ignore it, then re-run the SAME command — add the path to .gitignore (commit that), or to\n" +
        "     .git/info/exclude if it should stay out of the repo's own history. Prefer a pattern that\n" +
        "     covers the whole family (`.env*`, not just `.env`) — a bare literal is what let this through.\n" +
        "  2. Stage only what you meant to commit — name the safe files explicitly\n" +
        "     (`git add src/app.ts docs/readme.md`) instead of sweeping the whole tree.\n";
  return (
    `${lead}\n${list}\n` +
    "Committing a live credential to a repo is effectively irreversible: it lands in history and, on a " +
    "public remote, is scraped within minutes. You are running with auto-approved shell commands, so " +
    "nothing else was going to stop this.\n" +
    "\nTwo safe ways forward:\n" +
    remedies +
    "If the file genuinely belongs in the repo, take the secret OUT of it first (move the value to an\n" +
    "environment variable or a .env the repo ignores) and commit the sanitized file. Do not force this\n" +
    "past the guard, and do not delete the file to make the message go away — it may be the only copy.\n"
  );
}

/** True iff `target` resolves into a Claude Code SESSION SCRATCHPAD directory — the harness-sanctioned
 *  location the Claude Code system prompt designates for ALL temporary files (helper scripts, PR-body
 *  text, intermediate data). Its shape is `/private/tmp/claude-<uid>/<session>/<uuid>/scratchpad/...`
 *  (macOS `/tmp` symlinks to `/private/tmp`, so a canonicalized target usually reads `/private/tmp`;
 *  Linux keeps `/tmp`). Without this carve-out the containment check blocks the scratchpad (it lives
 *  outside every worktree), forcing agents into clumsy Bash heredocs.
 *
 *  Two conditions, BOTH required, keep this from re-opening the very thing the guard exists to stop:
 *    (a) the resolved path sits under a uid-scoped temp root — `/tmp/claude-*` or
 *        `/private/tmp/claude-*` — never all of `/tmp`; and
 *    (b) `scratchpad` sits at the DOCUMENTED depth `claude-<uid>/<slug>/<uuid>/scratchpad` (parts[3])
 *        AND none of its ancestor segments (parts[0..2]) is a git worktree root (carries a `.git` entry).
 *  Condition (b) is load-bearing: agent WORKTREES are also created under `/private/tmp/claude-*`
 *  (e.g. `/private/tmp/claude-501/wt-foo`), so admitting a `scratchpad` segment by depth alone would let
 *  one agent edit a `scratchpad`-named dir nested inside ANOTHER agent's worktree (…/wt-foo/docs/scratchpad/x,
 *  which also lands on parts[3]) — precisely the guard's job to prevent. A git worktree always carries a
 *  `.git` entry at its root and a session temp root never does, so the `.git`-ancestor check is what
 *  distinguishes the two: it admits the real session scratchpad without admitting any sibling worktree.
 *
 *  Scope note: this is uid-scoped, NOT session-scoped — `/private/tmp/claude-<uid>` is shared by every
 *  concurrent agent under that uid, so the carve-out does not stop one agent writing into another's
 *  correctly-shaped scratchpad. That is an accepted trade-off: the file header states this is a
 *  best-effort guardrail against a well-behaved agent ACCIDENTALLY leaving its lane, not a security
 *  sandbox (Bash bypasses it entirely), and a well-behaved agent only ever targets its OWN scratchpad.
 *
 *  Symlink-safe: the target is canonicalized through symlinks FIRST (same realResolve machinery as the
 *  containment / note-dir checks), so a symlink planted inside a scratchpad that points at a worktree
 *  resolves OUT of the scratchpad and is rejected. Fails closed (false) on any unresolvable path. */
export function isAllowlistedScratchpad(target) {
  if (typeof target !== "string" || target.length === 0) return false;
  const t = realResolve(isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`);
  if (t === null) return false;
  // Canonicalize the temp bases too, so macOS `/tmp` (a symlink to /private/tmp) and the literal
  // `/private/tmp` both compare against the same resolved root.
  for (const base of ["/private/tmp", "/tmp"]) {
    const rb = realResolve(base);
    if (rb === null) continue;
    const rel = relative(rb, t);
    if (rel === "" || rel.startsWith("..")) continue; // target not under this temp base
    const parts = rel.split(sep);
    // (a) first segment beneath the temp base must be a uid session root `claude-*` …
    if (!parts[0].startsWith("claude-")) continue;
    // … and (b) `scratchpad` must sit at the DOCUMENTED depth — `claude-<uid>/<slug>/<uuid>/scratchpad`,
    // i.e. EXACTLY parts[3] — never merely present at some deeper segment.
    if (parts.length >= 4 && parts[3] === "scratchpad") {
      // Depth ALONE cannot tell a session temp root from a git worktree: a sibling worktree with a
      // `docs/scratchpad` subdir also lands `scratchpad` on parts[3] (…/claude-501/wt-victim/docs/scratchpad).
      // A git worktree ALWAYS carries a `.git` entry at its root; a session temp root NEVER does. So reject
      // the match if any ancestor segment (parts[0..2]) is a checkout root — that admits the real scratchpad
      // WITHOUT admitting a `scratchpad` dir nested anywhere inside a sibling worktree. An lstat error (a
      // not-yet-existing ancestor) means "not a worktree here" and is skipped; a real worktree always exists.
      let acc = rb;
      let insideWorktree = false;
      for (let i = 0; i < 3; i++) {
        acc = `${acc}${sep}${parts[i]}`;
        try {
          lstatSync(`${acc}${sep}.git`);
          insideWorktree = true;
          break;
        } catch {
          // no `.git` at this level (or unreadable) — keep walking down the ancestry.
        }
      }
      if (!insideWorktree) return true;
    }
  }
  return false;
}

/** True iff target resolves into one of the two NARROW append-only per-agent note dirs we allow
 *  writes to even though they live outside every worktree by design (item 1j):
 *    - $HOME/.claude/plans/                  plan files, and
 *    - $HOME/.claude/projects/<any>/memory/  per-agent cross-session memory.
 *  These are append-only NOTES, not code, so allowing them does not undermine the guard job of
 *  stopping an agent editing another agent code, and the header above already states this is
 *  "NOT a security sandbox". Both checks canonicalize through symlinks via the same
 *  realResolve/isInside machinery the containment check uses, so a symlink planted inside an
 *  allow-listed dir that points elsewhere does NOT tunnel a write out: the RESOLVED target simply
 *  will not be inside the allow-listed root. Kept deliberately narrow: ONLY these two dir classes,
 *  never all of ~/.claude/. Fails closed (false) on any unresolvable path. */
export function isAllowlistedNoteDir(homeDir, target) {
  if (typeof homeDir !== "string" || homeDir.length === 0) return false;
  if (typeof target !== "string" || target.length === 0) return false;
  const claudeRoot = `${homeDir}${sep}.claude`;
  // (1) Plan files: anywhere at/under $HOME/.claude/plans/ (reuse the symlink-safe isInside).
  if (isInside(`${claudeRoot}${sep}plans`, target)) return true;
  // (2) Per-agent memory: $HOME/.claude/projects/<anything>/memory/ and descendants. We cannot
  // express the <anything> wildcard through one isInside root, so canonicalize both the projects
  // root and the target, confirm the target is inside projects/, then require the resolved path to
  // be <projectId>/memory[/...]. Canonicalizing the target FIRST is what makes this symlink-safe:
  // an escaping symlink resolves OUT of projectsRoot and is rejected below.
  const projectsRoot = realResolve(`${claudeRoot}${sep}projects`);
  const t = realResolve(isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`);
  if (projectsRoot === null || t === null) return false;
  const rel = relative(projectsRoot, t);
  if (rel === "" || rel.startsWith("..")) return false; // not inside projects/
  const parts = rel.split(sep);
  // parts[0] = the project id; the very next segment must be the memory dir itself.
  return parts.length >= 2 && parts[1] === "memory";
}

/** Resolve the git worktree root that CONTAINS `dir`, via `git rev-parse --show-toplevel` run with
 *  `-C dir` so a linked worktree resolves to ITS OWN root (not the repo's main checkout). Returns the
 *  trimmed toplevel path, or null when `dir` isn't inside a git work tree or git isn't on PATH. stderr
 *  is silenced (git prints "not a git repository" there) and any spawn failure is swallowed → null. */
function gitToplevel(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const top = out.trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** The worktree the CALLER is actually operating in. The guard is installed with ONE baked-in root
 *  (argv[2] — the worktree it was installed for), but the same hook runs for sub-agents / pooled
 *  worktrees whose real cwd is a DIFFERENT worktree, so keying off the baked-in root alone wrongly
 *  blocks an agent editing its OWN (non-install-root) worktree. We derive the caller's worktree from
 *  the tool call's `cwd` (Claude Code puts the session's working dir in the hook payload) via git
 *  worktree semantics, falling back to `installRoot` when cwd isn't in a git work tree (or git is
 *  unavailable) — so a misconfigured/repo-less caller is no MORE permissive than before. This keeps the
 *  check worktree-RELATIVE: the returned root is fed to isInside(), which allows edits inside the
 *  caller's own worktree and still DENIES edits reaching into a different worktree. `resolveToplevel`
 *  is injectable so tests can exercise the logic without a real git repo. */
export function callerWorktreeRoot(installRoot, cwd, resolveToplevel = gitToplevel) {
  if (typeof cwd === "string" && cwd.length > 0) {
    const top = resolveToplevel(cwd);
    if (typeof top === "string" && top.length > 0) return top;
  }
  return installRoot;
}

async function main() {
  const root = process.argv[2];
  if (!root) process.exit(0); // misconfigured guard must not block work
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const input = payload?.tool_input ?? {};
  // Keychain guard (sparkle-0ezz): a Bash command that runs the `security` CLI against the
  // ai.sparkle.desktop keychain item is refused outright — exit 2 blocks the tool call before it runs.
  if (blocksKeychainCommand(input.command)) {
    process.stderr.write(
      "Blocked: refusing to run the macOS `security` CLI against the ai.sparkle.desktop keychain. " +
        "Sparkle stores its desktop-token / trial-device-token there and reads them in-process via " +
        "keyring; shelling out to `security` triggers a scary OS confidential-information prompt and " +
        "is never necessary. Do not touch this keychain item.\n",
    );
    process.exit(2); // exit code 2 → Claude Code blocks the tool call
  }
  // Secret-staging guard: a `git add` / `git commit` that would put credential material into git is
  // refused. `payload.cwd` is the session's working directory, which is what the Bash command runs
  // in — it is the directory the CASE 2 repo probe inspects. CASE 2 fails OPEN when that probe can't
  // run; CASE 1 needs no repo at all and stays strict (see the asymmetry note on the predicate).
  //
  // The try/catch is NOT the fail-open decision documented on the predicate — it is a blast-radius
  // limit, and it is the one place in this file where an exception must NOT reach the top-level
  // `.catch(() => process.exit(2))`. Two reasons. (1) This guard runs on EVERY Bash command and is by
  // far the largest code in the hook (a hand-rolled lexer, a statSync, three execFileSync calls); a
  // parser bug that exited 2 would block every shell command for every agent — a total outage, where
  // failing open merely restores the status quo that existed before this guard shipped. (2) This
  // block sits ABOVE the file-path containment check, so letting a throw exit here would take the
  // pre-existing worktree guard down with it for that call. A crash is a BUG, not evidence about the
  // repo; degrade this one guard rather than the whole hook.
  let secretStaging = null;
  try {
    secretStaging = blocksSecretStaging(input.command, payload?.cwd);
  } catch {
    secretStaging = null;
  }
  if (secretStaging !== null) {
    process.stderr.write(secretStagingMessage(secretStaging));
    process.exit(2); // exit code 2 → Claude Code blocks the tool call
  }
  const target = input.file_path ?? input.notebook_path;
  if (!target) process.exit(0); // nothing path-like to guard
  // Worktree-RELATIVE containment: allow edits inside WHICHEVER worktree the caller is operating in
  // (derived from the tool call's cwd), not just the single worktree this hook was installed for.
  // Falls back to the install-time `root` when cwd isn't in a git work tree.
  const callerRoot = callerWorktreeRoot(root, payload?.cwd);
  // Fail CLOSED on any unexpected error: only exit code 2 blocks the tool, so an exception that
  // escaped here would let the write proceed (fail open). Treat "couldn't decide" as "block".
  let inside;
  try {
    inside = isInside(callerRoot, target);
  } catch {
    inside = false;
  }
  if (inside) process.exit(0);
  // Narrow allow-list (item 1j): permit writes to the two append-only per-agent note dirs that
  // live OUTSIDE every worktree by design (plan files and cross-session memory) so an agent can
  // record what it learned for the next agent. Safe because these are notes, not code, and
  // isAllowlistedNoteDir canonicalizes through symlinks (same fail-closed machinery as above).
  let allowedNoteDir = false;
  try {
    allowedNoteDir = isAllowlistedNoteDir(homedir(), target);
  } catch {
    allowedNoteDir = false;
  }
  if (allowedNoteDir) process.exit(0);
  // Session scratchpad allow-list: the Claude Code system prompt designates a per-session scratchpad
  // dir (`/private/tmp`|`/tmp`/claude-*/.../scratchpad) for ALL temp files — helper scripts, PR-body
  // text. It lives outside every worktree, so the containment check above blocks it, pushing agents
  // into clumsy Bash heredocs. Permit it: a scratchpad is harness-sanctioned and is NOT a repo (see
  // isAllowlistedScratchpad — `scratchpad` is required at the DOCUMENTED depth parts[3] AND no ancestor
  // may be a git worktree root (`.git` check), which keeps this from admitting sibling agent worktrees
  // also created under /private/tmp/claude-*). uid-scoped, not session-scoped (accepted trade-off — see
  // the predicate docstring). Symlink-safe; fails closed.
  let allowedScratchpad = false;
  try {
    allowedScratchpad = isAllowlistedScratchpad(target);
  } catch {
    allowedScratchpad = false;
  }
  if (allowedScratchpad) process.exit(0);
  process.stderr.write(
    `Blocked: ${target} is outside this agent's worktree (${callerRoot}). ` +
      `Edit only files inside your worktree.\n`,
  );
  process.exit(2); // exit code 2 → Claude Code blocks the tool call
}

// Only run main() when executed as a script, not when imported by a test.
// The top-level `.catch` is the real fail-closed backstop: ANY uncaught error anywhere in main()
// — a stdin stream error, a future code path, etc. — exits 2 (block) rather than escaping as an
// unhandled rejection (which exits 1, and since only exit 2 blocks the tool, would fail OPEN).
if (process.argv[1] && process.argv[1].endsWith("worktree-guard.mjs")) {
  main().catch(() => process.exit(2));
}
