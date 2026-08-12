// The `search_history` scope vocabulary, in ONE place because four independent consumers spell it
// and only one of them is protected by the type system.
//
// WHY THIS IS SHARED CODE RATHER THAN A LITERAL EACH SIDE REPEATS. The value travels across a
// package boundary and across a type boundary:
//
//   1. `apps/mcp-control`'s `sparkle_workspace` DESCRIPTION — the only place the model can learn the
//      argument exists at all. That dispatcher takes a free-form `args` object, so an argument the
//      prose does not name is unreachable in practice.
//   2. the `.strict()` zod enum in `conciergeTools/registry.ts`, which REFUSES anything else.
//   3. `conciergeTools/workspace.ts`'s filter, which decides whether concierge-sourced rows are
//      returned.
//   4. `conciergeTools/policy.ts`'s `perCallRiskFor`, which escalates the wide call to an approval
//      card — and this one reads `args: unknown`, so its comparison has NO typecheck coupling to the
//      union whatsoever.
//
// (4) is why a shared constant is worth a file. Re-spell the value and the typed consumers fail to
// compile, but `perCallRiskFor`'s string compare silently stops matching — so the widened read of
// the user's own private conversations would run as an auto-allowed `read-only` call with no
// approval card, which is precisely the gate the escalation exists to be. Silent, and in the
// permissive direction. Comparing against this constant makes a rename a compile error instead.
//
// It lives in `@sparkle/core` because that is the one package both `apps/desktop` and
// `apps/mcp-control` already depend on.

/** Search build/brainstorm history only — the default when the caller omits `scope`. */
export const DEFAULT_HISTORY_SCOPE = "default";

/**
 * Also search `concierge`-sourced rows: the user's own conversations with the concierge.
 *
 * Always raises an approval card, and does so as a FLOOR — an explicit `allow` on `search_history`
 * does not cover it. See `conciergeTools/policy.ts`'s `perCallRiskFor`.
 */
export const WIDE_HISTORY_SCOPE = "all";

export const HISTORY_SCOPES = [DEFAULT_HISTORY_SCOPE, WIDE_HISTORY_SCOPE] as const;

export type HistorySearchScope = (typeof HISTORY_SCOPES)[number];
