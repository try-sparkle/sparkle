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
  // TCC home-walk guard predicate (sparkle-cj4sl7): non-null iff a Bash command would run a
  // DIRECTORY WALK that descends into macOS TCC-protected app data. This is a NOISE-and-privacy
  // rule, not a destructive one — a `find ~ -maxdepth 5` destroys nothing, but each protected
  // container it descends into raises its own "would like to access data from other apps" dialog,
  // attributed to SPARKLE because macOS makes the spawning app the TCC responsible process for
  // every agent it spawns. So it is deliberately separate from `blocksDestructiveCommand` (whose
  // contract is "unconditionally destructive") and carries its own corpus keys,
  // `mustBlockAppDataWalk` / `mustAllowAppDataWalk`. PURE — reads no filesystem. `home` is an
  // injected seam so tests can pin a fixed home; production leaves it defaulted to `homedir()`.
  export function blocksProtectedAppDataWalk(
    command: unknown,
    home?: string,
    depth?: number,
  ): { rule: string; bin: string; root: string; reached: string[] } | null;
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
  // True iff `target` sits inside a worktree THIS session created from THIS repository. Ownership is
  // TWO facts, never a path shape: the creating session recorded the path under
  // `<git-common-dir>/sparkle-session-worktrees/<session-id>` (scripts/new-feature.sh writes it), and
  // git still resolves that path to a worktree ROOT whose common dir equals the caller's. A path
  // allow-list would admit a rival agent's worktree, which is what the guard exists to stop. Fails
  // closed on every unknown (sparkle-q39ja0, sparkle-6mpx2a).
  export function isSessionOwnedWorktree(callerRoot: unknown, sessionId: unknown, target: unknown): boolean;
  // The REAL (symlink-resolved) roots of the worktrees THIS session created from THIS repository, in
  // ledger order — the two-fact ownership check above, lifted out so it can also answer the misroute
  // question. Empty on every unknown (no session id, no ledger, no git), so a caller reading the
  // length fails closed.
  export function sessionOwnedWorktrees(callerRoot: unknown, sessionId: unknown): string[];
  // Non-null iff `target` is being edited on the app-owned ROOT worktree while THIS session owns a
  // fresh named worktree it should be editing instead (bead sparkle-tade76) — a misroute. `worktree`
  // names the recorded worktree to redirect under. Null on every non-misroute AND every uncertainty
  // (fails OPEN): this is a redirect nudge, not a security boundary. `callerRoot` is the worktree the
  // caller is operating in; `target` has already been established as inside it.
  export function misroutedRootEdit(
    callerRoot: unknown,
    sessionId: unknown,
    target: unknown,
  ): { callerRoot: string; target: string; worktree: string } | null;
  // The stderr text for a misrouted root edit. Names the exact worktree path prefix to redirect all
  // subsequent edits under (bead sparkle-tade76's first recommendation).
  export function misroutedRootEditMessage(m: {
    callerRoot?: string;
    target?: string;
    worktree?: string;
  } | null): string;
  // The session id this guard may use as a ledger key: the hook payload's `session_id` and nothing
  // else, or null when the payload cannot supply one. `env` is accepted and deliberately IGNORED —
  // the ledger's writer keys on the inherited `$CLAUDE_CODE_SESSION_ID`, which sibling agents
  // dispatched from one parent all share, so honouring it would admit agent B into agent A's
  // worktree. Taking the parameter is what makes that guarantee testable (sparkle-q39ja0).
  export function sessionIdForLedger(payload: unknown, env: unknown): string | null;
  // The plan file THIS session was assigned, read from the `plan_mode` attachment in its own
  // transcript (`transcript_path` in the hook payload), or null when the transcript cannot name one —
  // absent, unreadable, oversized, or plan mode never entered. The LAST such record wins.
  export function sessionPlanFile(transcriptPath: unknown): string | null;
  // True iff `target` resolves into a `plans/` dir under either Claude config root ($HOME/.claude or
  // `configDir`). Asks only WHERE the target is; whose it is, is sessionPlanFile's question.
  export function isUnderPlansRoot(homeDir: unknown, target: unknown, configDir?: unknown): boolean;
  // The stderr text for refusing a write to ANOTHER session's plan file: names this session's own
  // plan file, the one path that is safe under the conditions that triggered the refusal.
  export function otherSessionPlanMessage(target: string, planFile: string): string;
  // The stderr text for a containment refusal. Names the sanctioned hand-off (session scratchpad, or
  // a worktree in the target repo) instead of stating the rule and stopping — an agent whose work was
  // redirected into another repo mid-task otherwise improvises something worse (sparkle-itohi).
  // `sameRepo === true` (a target in a SIBLING worktree of the caller's own repo) selects a remedy
  // that points back at the caller's worktree and at scripts/new-feature.sh; `false`/`null` keep the
  // conservative cross-repo text, because an unproven same-repo claim must not pick the narrow one.
  export function outsideWorktreeMessage(target: string, callerRoot: string, sameRepo?: boolean | null): string;
  // Worktree-relative containment helper: the worktree the CALLER is actually operating in.
  // Derives the caller's worktree root from the tool call's `cwd` (via `resolveToplevel`, default
  // `git rev-parse --show-toplevel`), falling back to `installRoot` when cwd isn't in a git work tree.
  export function callerWorktreeRoot(
    installRoot: string,
    cwd: unknown,
    resolveToplevel?: (dir: string) => string | null,
  ): string;
}
