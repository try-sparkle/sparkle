// Type surface for the shipped guard script (a plain .mjs with no companion .d.ts).
// Only the pure predicate is imported by tests; the runtime entrypoint has no exports.
declare module "*/worktree-guard.mjs" {
  export function isInside(root: string, target: string): boolean;
  // Keychain guard predicate (sparkle-0ezz): true iff a Bash command shells out to the macOS
  // `security` CLI against the ai.sparkle.desktop generic-password keychain item.
  export function blocksKeychainCommand(command: unknown): boolean;
  // Narrow allow-list predicate (item 1j): true iff target resolves into $HOME/.claude/plans/ or a
  // $HOME/.claude/projects/<any>/memory/ dir, canonicalized through symlinks (both are append-only
  // per-agent note dirs the guard permits even though they live outside the worktree).
  export function isAllowlistedNoteDir(homeDir: string, target: string): boolean;
  // Worktree-relative containment helper: the worktree the CALLER is actually operating in.
  // Derives the caller's worktree root from the tool call's `cwd` (via `resolveToplevel`, default
  // `git rev-parse --show-toplevel`), falling back to `installRoot` when cwd isn't in a git work tree.
  export function callerWorktreeRoot(
    installRoot: string,
    cwd: unknown,
    resolveToplevel?: (dir: string) => string | null,
  ): string;
}
