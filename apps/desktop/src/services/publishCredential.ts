import { invoke } from "@tauri-apps/api/core";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The publish destination's BEARER TOKEN, webview side (bead `sparkle-131ms.3`).
//
// The Rust half is `apps/desktop/src-tauri/src/publish_credential.rs`. Its four commands have been
// registered in `lib.rs` and covered by Rust tests since the credential store landed, and NOTHING
// IN THE WEBVIEW CALLED ANY OF THEM — so the keychain worked and was unreachable, and the pane's
// empty state told the user to "paste its token here" pointing at a field that did not exist. This
// module is the front door those commands never had.
//
// THE TOKEN NEVER CROSSES THIS BOUNDARY IN THE READ DIRECTION, and that asymmetry is deliberate
// rather than an omission. `resolve_token` is pointedly NOT a command: the only consumer of the
// secret is the Rust publish client, which builds the `Authorization` header host-side. What the UI
// legitimately needs is *where the credential comes from*, and that is what it gets. So there is a
// `set` and no `get` here, and a caller wanting to render "connected" reads a SOURCE, never a value.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where a destination's credential comes from. Mirrors Rust's `TokenSource`, which derives
 * `serde::Serialize` with `#[serde(rename_all = "lowercase")]` — so these three lowercase strings
 * are the literal wire values, and the union is TOTAL: there is no `Option` on the Rust side, so
 * this side never has to model `null` versus an absent key.
 *
 * - `"keychain"` — an item the user stored through Sparkle. THE ONLY SOURCE `clearPublishToken`
 *   CAN REMOVE.
 * - `"environment"` — supplied by {@link publishTokenEnvVarName}'s variable. Sparkle cannot unset a
 *   variable in the user's shell, so it cannot revoke this; only whoever exported it can.
 * - `"none"` — no usable credential from either source.
 *
 * PRECEDENCE, because the UI copy depends on it: the environment is a FALLBACK, NEVER AN OVERRIDE.
 * When a keychain item exists the environment is not consulted at all — which is why saving a token
 * on a machine that also exports the variable is a meaningful action and not a no-op.
 */
export type TokenSource = "keychain" | "environment" | "none";

/** Every source value, for a caller that wants to iterate the closed set rather than hand-list it. */
export const TOKEN_SOURCES: readonly TokenSource[] = ["keychain", "environment", "none"] as const;

/** The environment fallback's variable prefix. `ENV_TOKEN_PREFIX` in `publish_credential.rs`. */
export const PUBLISH_TOKEN_ENV_PREFIX = "SPARKLE_PUBLISH_TOKEN";

/**
 * The per-destination environment variable name for a destination id — the same derivation
 * `env_var_name` performs in Rust: the prefix, an underscore, then the id with every ASCII
 * alphanumeric upper-cased and EVERY OTHER CHARACTER mapped to `_`.
 *
 * Duplicated in TS on purpose. The name is not returned by any command, and a UI that tells the
 * user Sparkle cannot clear their credential is useless unless it also says WHICH variable to
 * unset — so the derivation has to exist on this side. It is pure and total (the prefix supplies
 * the leading letter, so every input yields a legal variable name), and its test pins it against
 * the cases the Rust unit tests pin, which is what keeps the two copies from drifting.
 *
 * Iterated by code point (`for…of`), matching Rust's `chars()`, so one non-ASCII character becomes
 * one underscore rather than one per UTF-16 unit.
 */
export function publishTokenEnvVarName(destinationId: string): string {
  let name = `${PUBLISH_TOKEN_ENV_PREFIX}_`;
  for (const ch of destinationId) {
    name += /^[0-9A-Za-z]$/.test(ch) ? ch.toUpperCase() : "_";
  }
  return name;
}

/**
 * Store a destination's bearer token in the OS keychain.
 *
 * Write-only by design — there is no read counterpart. Rejects with the host's own message when the
 * id or the token is rejected (an empty value, an interior newline: the token rides in an
 * `Authorization: Bearer` header, where a newline is a header-injection primitive). The message is
 * safe to display: the Rust side never puts the token in it.
 *
 * Resolving does NOT mean the destination now works — it means the item was written. A caller must
 * re-read the source rather than assume, which is why this returns nothing.
 */
export function setPublishToken(destinationId: string, token: string): Promise<void> {
  return invoke<void>("publish_token_set", { destinationId, token });
}

/**
 * Delete a destination's keychain item (disconnect), and answer WITH THE SOURCE THAT SURVIVES.
 *
 * The return value is the whole point of the call: `"environment"` here means the erase succeeded
 * and the destination is STILL CREDENTIALED, because a variable supplies the token and Sparkle
 * cannot unset it. Rendering that as "no token" is a lie that costs somebody a debugging session —
 * every publish would keep succeeding under the credential the user just revoked.
 *
 * A missing item is the state the caller wanted, so clearing an already-clear destination resolves.
 */
export function clearPublishToken(destinationId: string): Promise<TokenSource> {
  return invoke<TokenSource>("publish_token_clear", { destinationId });
}

/**
 * Where this destination's credential comes from. Read-only and side-effect free, so it is safe to
 * call on mount and again after every mutation.
 *
 * The Rust command's return type is a bare `TokenSource` rather than a `Result`, so it has no
 * failure of its own to report — but the IPC hop does, and a rejection here is a genuine
 * COULD-NOT-RUN. It is not "no token": treat the two as distinct states, or the row asserts a fact
 * about a destination it never managed to ask about.
 */
export function getPublishTokenSource(destinationId: string): Promise<TokenSource> {
  return invoke<TokenSource>("publish_token_source", { destinationId });
}

/**
 * Whether a destination has a usable token, from either source, without the secret crossing the
 * boundary.
 *
 * This is the coarse question. Prefer {@link getPublishTokenSource} anywhere the answer is rendered:
 * `true` cannot tell a keychain item from a variable, and the difference decides whether Sparkle is
 * able to revoke it.
 */
export function isPublishTokenPresent(destinationId: string): Promise<boolean> {
  return invoke<boolean>("publish_token_present", { destinationId });
}
