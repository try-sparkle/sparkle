// Type surface for the shipped guard script (a plain .mjs with no companion .d.ts).
// Only the pure predicate is imported by tests; the runtime entrypoint has no exports.
declare module "*/worktree-guard.mjs" {
  export function isInside(root: string, target: string): boolean;
}
