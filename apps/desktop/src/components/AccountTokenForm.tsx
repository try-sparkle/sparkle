import { useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { copyToClipboard } from "../clipboard";
import {
  setOauthToken as realSetOauthToken,
  recordOauthIdentity as realRecordOauthIdentity,
} from "../services/accountStore";
import { checkClaudeAuthStatus as realCheckAuthStatus, type ClaudeAuthStatus } from "../preflight";

// Add / renew an account by pasting a LONG-LIVED token instead of the interactive browser OAuth.
// This is the RECOMMENDED path (the browser OAuth below it is the fallback): the interactive
// `claude auth login` mints a token that lasts only ~8–12h, so the founder's ~6 build accounts fall
// out of auth constantly and every expiry shows up as scattered downstream failures. `claude
// setup-token` mints a token that lasts ≈1 YEAR and keeps SUBSCRIPTION billing (not metered).
//
// This form takes that pasted value, has Rust write it into the account's own
// `<configDir>/.credentials.json` (0600) — the exact file an agent spawned with CLAUDE_CONFIG_DIR
// reads — and then CONFIRMS it authenticates before declaring success, so a token the CLI rejects
// surfaces as an error rather than a silent inert "added".
//
// The verify step is not optional: writing the file always "succeeds", so without re-probing
// `claude auth status` this could report a healthy account for a malformed paste. `onSaved` fires
// ONLY on a confirmed live login THAT IS ALSO ROUTABLE — see the identity hard gate in submit().

/** The command the user runs to mint the long-lived token. Copied verbatim by the copy button, so
 *  the string the button copies and the string the label renders can never drift apart. */
const SETUP_TOKEN_CMD = "claude setup-token";

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
  const [copied, setCopied] = useState(false);

  const trimmed = token.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  function copyCommand() {
    void copyToClipboard(SETUP_TOKEN_CMD).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }

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
      // 3. It authenticates — now HARD GATE on routability. A token account with no
      //    `oauthAccount.emailAddress` reads "not signed in" downstream and never gets a spawn, so it
      //    silently drops out of rotation while this UI says "added". That is exactly the failure the
      //    founder can't blind-switch to tokens over, so DO NOT report success unless we can route it:
      //    the identity must be present AND the record must land. Both were best-effort before; both
      //    are now blocking. `onSaved` fires only on a confirmed, routable account.
      if (!status.email) {
        // A live login with no email is genuinely unroutable: the dir gets a `.credentials.json` but
        // no `oauthAccount.emailAddress`, so `getIdentities` reports `isSignedIn: false` and
        // `pickAccount` can never spawn to it (see accounts.rs `record_oauth_email_at`). Surfacing it
        // as success would silently drop the account out of rotation. NO "try again" remedy — a retry
        // reads the same credential and gets the same empty email, so it would just loop.
        setError(
          "Verified the token, but Claude reported no email, so this account can't be routed. " +
            "Sign in with `claude setup-token` from an account that has an email address.",
        );
        return;
      }
      try {
        await recordIdentity(configDir, status.email);
      } catch {
        setError(
          "Verified the token, but couldn't save its identity, so this account wouldn't be routable. Try again.",
        );
        return;
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
      <div style={{ fontSize: 12, fontWeight: 600, color: C.cream }}>Recommended: token-based</div>
      <p style={{ fontSize: 12, color: C.muted, margin: "4px 0 4px", lineHeight: 1.5 }}>
        Run{" "}
        <code
          data-testid="account-token-cmd"
          style={{
            // A distinct FONT COLOR so it reads unmistakably as a terminal command, on top of the
            // monospace face. `tealInk` is the AA-safe brand-blue INK tier (the plain brand fill
            // does not clear the contrast floor as text).
            fontFamily: "monospace",
            fontSize: 12,
            color: C.tealInk,
            background: C.deepForest,
            border: `1px solid ${C.inputEdge}`,
            borderRadius: RADIUS.input,
            padding: "1px 6px",
            whiteSpace: "nowrap",
          }}
        >
          {SETUP_TOKEN_CMD}
        </code>{" "}
        <button
          type="button"
          data-testid="account-token-copy"
          onClick={copyCommand}
          aria-label={copied ? "Copied" : "Copy command"}
          title={copied ? "Copied" : "Copy"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            verticalAlign: "middle",
            background: "transparent",
            border: `1px solid ${C.inputEdge}`,
            borderRadius: RADIUS.input,
            color: copied ? C.successInk : C.tealInk,
            fontSize: 12,
            fontWeight: 600,
            padding: "1px 6px",
            cursor: "pointer",
          }}
        >
          {copied ? <FiCheck size={12} aria-hidden /> : <FiCopy size={12} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>{" "}
        in a terminal window.
      </p>
      <p style={{ fontSize: 12, color: C.muted, margin: "0 0 6px", lineHeight: 1.5 }}>
        It should last a year and keep you from having to log in every few hours.
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
      {/* RIGHT-justified — the primary action sits at the trailing edge of the field it acts on. */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
        <button
          type="button"
          data-testid="account-token-submit"
          onClick={() => void submit()}
          disabled={!canSubmit}
          style={{
            background: C.teal,
            border: `1px solid ${C.teal}`,
            borderRadius: RADIUS.input,
            color: ON_BRAND_FILL,
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 12px",
            // Grayed out until a token is pasted (enabled once the field is non-empty).
            cursor: canSubmit ? "pointer" : "default",
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          {busy ? "Saving…" : "Use this token"}
        </button>
      </div>
    </div>
  );
}
