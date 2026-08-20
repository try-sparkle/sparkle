// Type surface for the shipped guard script (a plain .mjs with no companion .d.ts).
// Only the pure predicate is imported by tests; the runtime entrypoint has no exports.
declare module "*/worktree-guard.mjs" {
  export function isInside(root: string, target: string): boolean;
  // Keychain guard predicate (sparkle-0ezz): true iff a Bash command shells out to the macOS
  // `security` CLI against the ai.sparkle.desktop generic-password keychain item.
  export function blocksKeychainCommand(command: unknown): boolean;
  // Destructive-command guard predicate: non-null iff a Bash command is one of the small set of
  // unambiguously destructive commands Sparkle refuses outright (managed agents run with the
  // approval prompt off, so there is no prompt left to catch them). Segment-wise and
  // command-position anchored, so it sees inside a compound (`cd /tmp && rm -rf ~`) while leaving
  // a MENTION of a denied command (`grep -rn 'push origin main' docs/`) alone. Pure — consults no
  // repo and no filesystem. The contract is apps/desktop/shared/destructive-commands.json.
  export function blocksDestructiveCommand(
    command: unknown,
  ): { rule: string; why: string } | null;
  // Merge-policy guard predicate (contract §7): non-null iff a Bash command invokes `gh pr merge`
  // in a worktree whose `<worktree>/.sparkle/merge-policy.json` refuses it. Deliberately NOT a
  // global rule — in the owner's own repo merging is the sanctioned path — so the verdict is
  // per-worktree and resolved in Rust. Three file states: ABSENT -> null (not a Sparkle-managed
  // worktree, no opinion); PRESENT but unparseable / wrong `version` / no boolean `mergeProtected`
  // -> `kind: "unreadable"` (the tamper case, fails closed); `mergeProtected: true` ->
  // `kind: "protected"`. A fourth verdict, `kind: "foreign-target"`, covers the case the
  // worktree-anchored design cannot otherwise see: `gh` takes its target repo from an explicit
  // `-R`/`--repo`/`GH_REPO` override rather than from the worktree, so a policy that permits the
  // merge is answering about a DIFFERENT repository — `target` names the one actually being merged.
  // Reads the file only after the command is recognised as a merge, and sees inside a compound
  // (`cd other && gh pr merge`) — which is the whole reason the lexer layer exists, since a
  // prefix-matched deny rule cannot.
  export function blocksProtectedMerge(
    command: unknown,
    cwd: unknown,
  ): {
    kind: "protected" | "unreadable" | "foreign-target";
    file: string | null;
    slug: string | null;
    why: string | null;
    remedy: string | null;
    target?: string | null;
  } | null;
  // Secret-staging guard predicate: non-null iff a Bash command would put credential material into
  // git. `kind: "named"` = the command line explicitly names a secret-shaped path (pure string
  // matching, fails CLOSED); `kind: "sweep"` = the command stages whatever is lying around and the
  // repo holds untracked, un-ignored secret-shaped files; `kind: "staged"` = a `git commit` whose
  // INDEX already carries one (staged by something this hook never saw). The two repo-consulting
  // kinds need `git status` and fail OPEN when repo state cannot be determined. Returns null to allow.
  export function blocksSecretStaging(
    command: unknown,
    cwd: unknown,
  ): { kind: "named" | "sweep" | "staged"; files: string[] } | null;
  // True iff a path looks like credential material (.env/.env.*/*.env, *.pem/*.key/*.p12/…, id_rsa…,
  // .netrc/.npmrc/.pgpass, credentials.json/service-account*.json/…, .aws/credentials). Template
  // files (.env.example/.sample/.template/.dist) and the .pub half of a keypair are exempt.
  export function isSecretPath(p: unknown): boolean;
  // Narrow allow-list predicate (item 1j): true iff target resolves into <config>/plans/ or a
  // <config>/projects/<any>/memory/ dir, canonicalized through symlinks (both are append-only
  // per-agent note dirs the guard permits even though they live outside the worktree). Checked
  // against BOTH $HOME/.claude and `configDir` — the harness prefers $CLAUDE_CONFIG_DIR when set and
  // Sparkle always sets it to the account dir, so a $HOME-only allow-list blocks an app-spawned
  // agent's own plan file (sparkle-3moh0). An empty or relative `configDir` is ignored.
  export function isAllowlistedNoteDir(homeDir: string, target: string, configDir?: string): boolean;
  // Session-scratchpad allow-list predicate: true iff target resolves into a per-session scratchpad
  // dir (`/private/tmp`|`/tmp`/claude-*/.../scratchpad), canonicalized through symlinks. The harness
  // designates this dir for all temp files; `scratchpad` is required at the documented depth parts[3]
  // (claude-<uid>/<slug>/<uuid>/scratchpad) AND no ancestor may be a git worktree root (`.git` check),
  // which keeps sibling agent worktrees (also created under /private/tmp/claude-*) blocked. uid-scoped,
  // not session-scoped (see the .mjs docstring).
  export function isAllowlistedScratchpad(target: unknown): boolean;
  // The stderr text for a containment refusal. Names the sanctioned hand-off (session scratchpad, or
  // a worktree in the target repo) instead of stating the rule and stopping — an agent whose work was
  // redirected into another repo mid-task otherwise improvises something worse (sparkle-itohi).
  export function outsideWorktreeMessage(target: string, callerRoot: string): string;
  // Worktree-relative containment helper: the worktree the CALLER is actually operating in.
  // Derives the caller's worktree root from the tool call's `cwd` (via `resolveToplevel`, default
  // `git rev-parse --show-toplevel`), falling back to `installRoot` when cwd isn't in a git work tree.
  export function callerWorktreeRoot(
    installRoot: string,
    cwd: unknown,
    resolveToplevel?: (dir: string) => string | null,
  ): string;
}
