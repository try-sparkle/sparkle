import { useState } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import {
  setOauthToken as realSetOauthToken,
  recordOauthIdentity as realRecordOauthIdentity,
} from "../services/accountStore";
import { checkClaudeAuthStatus as realCheckAuthStatus, type ClaudeAuthStatus } from "../preflight";

// Add / renew an account by pasting a LONG-LIVED token instead of the interactive browser OAuth.
//
// WHY THIS EXISTS: the interactive `claude auth login` mints a token that lasts only ~8–12h, so the
// founder's ~6 build accounts fall out of auth constantly and every expiry shows up as scattered
// downstream failures. `claude setup-token` mints a token that lasts ≈1 YEAR and keeps SUBSCRIPTION
// billing (not metered). This form takes that pasted value, has Rust write it into the account's
// own `<configDir>/.credentials.json` (0600) — the exact file an agent spawned with
// CLAUDE_CONFIG_DIR reads — and then CONFIRMS it authenticates before declaring success, so a token
// the CLI rejects surfaces as an error rather than a silent inert "added".
//
// The verify step is not optional: writing the file always "succeeds", so without re-probing
// `claude auth status` this could report a healthy account for a malformed paste. `onSaved` fires
// ONLY on a confirmed live login.

export interface AccountTokenFormDeps {
  /** Store the pasted token as the account's credential (Rust `account_set_oauth_token`). */
  setOauthToken: (configDir: string, token: string) => Promise<void>;
  /** Re-probe Claude's own auth status for this config dir, to confirm the token authenticates. */
  checkAuthStatus: (configDir?: string) => Promise<ClaudeAuthStatus>;
  /** Record the confirmed identity so the token account is routable (Rust
   *  `account_record_oauth_identity`). */
  recordOauthIdentity: (configDir: string, email: string) => Promise<void>;
}

const DEFAULT_DEPS: AccountTokenFormDeps = {
  setOauthToken: realSetOauthToken,
  checkAuthStatus: realCheckAuthStatus,
  recordOauthIdentity: realRecordOauthIdentity,
};

export interface AccountTokenFormProps {
  /** The account's config dir — where the credential is written and the account it authenticates. */
  configDir: string;
  /** Called once the token is stored AND confirmed to authenticate (a live `claude auth status`). */
  onSaved: () => void;
  /** Injectable IO for tests; defaults to the real store + preflight calls. */
  deps?: Partial<AccountTokenFormDeps>;
}

export function AccountTokenForm({ configDir, onSaved, deps }: AccountTokenFormProps) {
  const setToken = deps?.setOauthToken ?? DEFAULT_DEPS.setOauthToken;
  const checkAuth = deps?.checkAuthStatus ?? DEFAULT_DEPS.checkAuthStatus;
  const recordIdentity = deps?.recordOauthIdentity ?? DEFAULT_DEPS.recordOauthIdentity;

  const [token, setTokenValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = token.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // 1. Store the token as this account's credential (config_dir keyed — the founder does not guess).
      await setToken(configDir, trimmed);
      // 2. CONFIRM it authenticates. Writing the file always succeeds; only Claude's own status can
      //    say whether the token is real. Gate on `loggedIn && source === "cli"` — a LIVE reading —
      //    NOT `loggedIn` alone: `claude auth status` FAILS OPEN to `{loggedIn:true, source:"recorded"}`
      //    when the probe can't run (no `claude` binary, timeout) for any dir with an `oauthAccount`,
      //    which is exactly the renew case, so a garbage token would otherwise report a false success.
      const status = await checkAuth(configDir);
      const live = status.loggedIn && status.source === "cli";
      if (!live) {
        setError(
          status.loggedIn
            ? "Saved the token, but couldn't verify it with Claude (is `claude` installed and on your PATH?). Try again."
            : "Saved the token, but Claude did not accept it. Paste the full value from `claude setup-token` (it starts with sk-ant-oat…) and try again.",
        );
        return;
      }
      // 3. It authenticates. Record the identity Claude reported so the account is ROUTABLE — without
      //    an `oauthAccount.emailAddress` a token account reads "not signed in" and never gets a spawn.
      //    Best-effort: a failed identity write must not turn a genuinely-working login into an error.
      if (status.email) {
        try {
          await recordIdentity(configDir, status.email);
        } catch {
          /* the credential is valid regardless; the row may lag until the first spawn writes it */
        }
      }
      onSaved();
      return;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the token. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="account-token-form" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.cream }}>
        Faster: paste a long-lived token
      </div>
      <p style={{ fontSize: 12, color: C.muted, margin: "4px 0 6px", lineHeight: 1.4 }}>
        Run <code>claude setup-token</code> in your terminal and paste the result here. It lasts about
        a year and keeps your subscription billing, so you stop re-logging in every few hours.
      </p>
      <textarea
        data-testid="account-token-input"
        value={token}
        onChange={(e) => setTokenValue(e.target.value)}
        placeholder="sk-ant-oat…"
        rows={2}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          width: "100%",
          boxSizing: "border-box",
          resize: "vertical",
          fontFamily: "monospace",
          fontSize: 12,
          padding: 8,
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${C.muted}`,
          borderRadius: RADIUS.input,
        }}
      />
      {error && (
        <div
          data-testid="account-token-error"
          role="alert"
          style={{ fontSize: 12, color: C.amber, marginTop: 6, lineHeight: 1.4 }}
        >
          {error}
        </div>
      )}
      <button
        type="button"
        data-testid="account-token-submit"
        onClick={() => void submit()}
        disabled={!canSubmit}
        style={{
          marginTop: 8,
          background: C.teal,
          border: `1px solid ${C.teal}`,
          borderRadius: RADIUS.input,
          color: ON_BRAND_FILL,
          fontSize: 12,
          fontWeight: 600,
          padding: "6px 12px",
          cursor: canSubmit ? "pointer" : "default",
          opacity: canSubmit ? 1 : 0.5,
        }}
      >
        {busy ? "Saving…" : "Use this token"}
      </button>
    </div>
  );
}
