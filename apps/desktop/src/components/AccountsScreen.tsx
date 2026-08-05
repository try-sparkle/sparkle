import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI } from "../theme/scale";
import { tag } from "./labelTreatment";
import {
  listAccounts,
  getUsage,
  getIdentities,
  addAccount,
  setNickname,
  removeAccount,
  accountDisplay,
  duplicateAccountGroups,
  type Account,
  type Usage,
  type Identity,
} from "../services/accountStore";

// Accounts settings screen for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). Lists each registered Claude
// config dir with its nickname, a "default" tag, per-window usage bars (5h / 7d) and an
// exhausted-until indicator; supports add / inline-rename / remove (the default can't be removed).
//
// ── The onLogin SEAM ──────────────────────────────────────────────────────────────────────────
// "Add account" creates an empty config dir via addAccount(), then needs to run the real
// `claude auth login` flow in that dir's CLAUDE_CONFIG_DIR so the user can OAuth into a Max account.
// Spawning the PTY lives on the spawn path (claudeSpawn / AgentPane), which this component must NOT
// import. So we hand the freshly-created Account back through the required `onLogin(account)` prop;
// the integrator wires it to a PTY `claude auth login` (env CLAUDE_CONFIG_DIR=account.configDir) —
// see AccountLoginModal, which owns the PTY and reports the identity that actually resolved.
//
// `onLogin` MAY return a promise that settles when the login window closes. When it does, we
// re-read identities afterwards, so the row shows the email the user just signed in as instead of
// the nickname they typed — and shows an explicit not-signed-in state when nothing resolved.
// Nothing here caps the number of accounts: add is a plain create-and-refresh loop, unbounded.

const DEPS = { listAccounts, getUsage, getIdentities, addAccount, setNickname, removeAccount };
export type AccountsDeps = typeof DEPS;

export interface AccountsScreenProps {
  /** Integrator seam: invoked with the Account to launch the `claude auth login` PTY in
   *  `account.configDir`. See the block comment above. May return a promise that settles when the
   *  login window closes — we re-read identities after it, so the list reflects the identity that
   *  actually resolved rather than the one the user hoped for. */
  onLogin: (account: Account) => void | Promise<void>;
  /** IO overrides — defaults to the real accountStore functions. Injectable for tests. */
  deps?: Partial<AccountsDeps>;
}

const fontStack = FONT_UI;

const card: CSSProperties = {
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: 12,
  marginBottom: 10,
  fontFamily: fontStack,
  color: C.cream,
};

const smallBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  color: C.cream,
  fontSize: 12,
  fontFamily: fontStack,
  padding: "4px 10px",
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  ...smallBtn,
  background: C.teal,
  borderColor: C.teal,
  color: ON_BRAND_FILL,
};

const tagStyle: CSSProperties = { ...tag(C.accentInk), borderColor: C.teal };

const inputStyle: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  color: C.cream,
  fontSize: 13,
  fontFamily: fontStack,
  padding: "4px 8px",
};

/** Human-readable token count (e.g. 9.3B, 1.2M, 34k). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/** A labelled usage bar showing this account's token usage for a window, filled RELATIVE to the
 *  busiest account (`peakTokens`) — there's no real Anthropic cap to read, so the comparison is
 *  cross-account: the heaviest-used account fills the bar and the emptiest reads shortest, making
 *  "which account has the most headroom" (where new jobs go) obvious at a glance. The raw count is
 *  shown alongside. A lone account (peak == its own usage) reads full — there's nothing to compare
 *  it against. */
function UsageBar({
  label,
  tokens,
  peakTokens,
}: {
  label: string;
  tokens: number;
  peakTokens: number;
}) {
  const pct = peakTokens > 0 ? Math.min(100, (tokens / peakTokens) * 100) : 0;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted }}>
        <span>{label}</span>
        <span>{fmtTokens(tokens)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 3,
          background: C.deepForest,
          border: `1px solid ${C.muted}`,
          marginTop: 2,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: C.teal }} />
      </div>
    </div>
  );
}

function exhaustedLabel(usage: Usage | undefined, now: number): string | null {
  if (!usage?.exhaustedUntil || usage.exhaustedUntil <= now) return null;
  const d = new Date(usage.exhaustedUntil);
  return `Exhausted until ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** Whether this account has a real Claude login. Derived from accountUuid OR email: the Rust
 *  `AccountIdentity` allows those independently, and `duplicateAccountGroups` matches on the
 *  identity key (uuid when recorded, else email — see `accountStore.identityKey`),
 *  so keying the login button on email alone could render "Log in" for an account that IS signed in
 *  (and even tint it as a duplicate at the same time). One definition, shared by every affordance. */
function isSignedIn(identity: Identity | undefined): boolean {
  return !!(identity?.accountUuid || identity?.email);
}

/** What the identity slot says for a login that IS real (it has an `accountUuid`) but carries no
 *  readable email. It is neither the email (there isn't one) nor "Not signed in" (that would be a
 *  lie in the other direction) nor the nickname (never evidence of anything).
 *
 *  NOTE this state is currently UNREACHABLE from the Rust side — `read_oauth_identity_at` refuses
 *  an `oauthAccount` with no non-empty `emailAddress`, so a non-null `accountUuid` implies a
 *  non-null `email` on the wire. It is rendered anyway because `isSignedIn` below (which predates
 *  this and drives the Log in / Switch login buttons) already treats the fields as independent, so
 *  without this arm a uuid-only identity would fall through to "Not signed in" while its own button
 *  read "Switch login". See the same note on `resolveLoginOutcome`.
 *
 *  Exported and shared with {@link AccountLoginModal} so the list and the login verdict cannot give
 *  opposite answers for the same identity. When §4c's `accountDisplay` lands in accountStore this
 *  belongs there, beside `NOT_SIGNED_IN`, and both callers should defer to it. */
export const SIGNED_IN_NO_EMAIL = "Signed in — no email on this login";

export function AccountsScreen({ onLogin, deps }: AccountsScreenProps) {
  const io: AccountsDeps = { ...DEPS, ...deps };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  // Real authenticated identity (email + org) per account id — the trustworthy label read from each
  // account's own .claude.json oauthAccount. The nickname is only a secondary alias.
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // Synchronous mirror of the active rename id. The state closures captured by the
  // input's onBlur/onKeyDown are stale by the time blur fires on unmount, so we
  // gate commit/cancel on this ref instead: Enter and Escape both clear it BEFORE
  // the resulting blur runs, which lets handleRename short-circuit a double-commit
  // (Enter) or a cancelled-edit save (Escape).
  const editingIdRef = useRef<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Two-step confirm for re-logging in the DEFAULT account, whose config dir is the user's real
  // ~/.claude — see the button below.
  const [confirmLogin, setConfirmLogin] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Depend on the individual functions actually used, not the whole `deps` object —
  // so an integrator passing an inline `deps={{...}}` literal (new object each render)
  // with stable function refs doesn't recreate `refresh` and spin the effect below.
  // The default (no `deps`) path resolves to the module-level DEPS, which are stable.
  const listAccountsFn = deps?.listAccounts ?? DEPS.listAccounts;
  const getUsageFn = deps?.getUsage ?? DEPS.getUsage;
  const getIdentitiesFn = deps?.getIdentities ?? DEPS.getIdentities;
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [a, u, ids] = await Promise.all([listAccountsFn(), getUsageFn(), getIdentitiesFn()]);
      setAccounts(a);
      setUsage(u);
      setIdentities(ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    }
  }, [listAccountsFn, getUsageFn, getIdentitiesFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usageFor = (id: string) => usage.find((u) => u.id === id);
  const identityFor = (id: string) => identities.find((i) => i.id === id);
  // Registrations that resolve to the SAME Anthropic account (same identity key: uuid when
  // recorded, else the verified email) — see the
  // banner below and `duplicateAccountGroups`.
  const duplicates = duplicateAccountGroups(accounts, identities);
  const duplicateIds = new Set(duplicates.flatMap((g) => g.accounts.map((a) => a.id)));
  const now = Date.now();
  // Each window's bar fills RELATIVE to the busiest account, so the emptiest account reads shortest
  // (= most headroom). Floor at 1 so an all-zero set divides cleanly to empty bars, not NaN.
  const peak5h = Math.max(1, ...usage.map((u) => u.tokens5h));
  const peak7d = Math.max(1, ...usage.map((u) => u.tokens7d));

  async function handleAdd() {
    const nickname = newName.trim();
    if (!nickname || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await io.addAccount(nickname);
      setAdding(false);
      setNewName("");
      await refresh();
      // Hand off to the integrator to run `claude auth login` in the new config dir (block comment
      // above). The account exists at this point but is a folder with no login in it.
      await onLogin(created);
      // The login attempt has ended. Re-read — never infer. A closed login window is not evidence
      // of a sign-in (it is equally what a cancelled OAuth, a failed one, and a `claude` that
      // exited on an unknown subcommand all look like), so the only way the list can be truthful
      // is to ask for the identities again. Whatever comes back drives the row: the resolved email
      // if there is one, an explicit "Not signed in" if there isn't.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add account");
    } finally {
      setBusy(false);
    }
  }

  // Re-login on an EXISTING account. Same rule as the add flow: the window closing is not a
  // verdict, so wait for it and re-read. Without this the row keeps showing the identity from
  // before the switch — which, for a user who just re-pointed an account at a different Claude
  // login, is the wrong email presented as the current one.
  async function handleLogin(a: Account) {
    try {
      await onLogin(a);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log in");
    }
  }

  function startRename(a: Account) {
    editingIdRef.current = a.id;
    setEditingId(a.id);
    setDraftName(a.nickname);
  }

  // Single exit point for the rename input — clears the ref (so a trailing
  // unmount-blur bails the guard in handleRename), the editing state, and the draft.
  // Used by both cancel (Escape) and commit (Enter / blur).
  function exitRename() {
    editingIdRef.current = null;
    setEditingId(null);
    setDraftName("");
  }

  async function handleRename(id: string) {
    // Commit only if this is still the active edit. Enter and Escape both exit (which
    // clears editingIdRef) first, so the trailing blur (fired as the input unmounts)
    // finds a mismatch and bails — preventing Enter's double-commit and Escape's
    // save-on-cancel.
    if (editingIdRef.current !== id) return;
    const nickname = draftName.trim();
    exitRename();
    if (!nickname) return;
    try {
      await io.setNickname(id, nickname);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function handleRemove(id: string) {
    setConfirmRemove(null);
    try {
      await io.removeAccount(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
    }
  }

  return (
    <div style={{ fontFamily: fontStack, color: C.cream }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Claude accounts</div>
        {!adding && (
          <button type="button" style={primaryBtn} onClick={() => setAdding(true)}>
            + Add account
          </button>
        )}
      </div>

      <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.4 }}>
        Each account is a separate Claude login. New jobs run under the least-used account. Bars
        show each account&apos;s usage relative to your busiest one. Sparkle never sees your Claude
        credentials.
      </p>

      {adding && (
        <div style={{ ...card, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            autoFocus
            aria-label="New account nickname"
            placeholder="Nickname (e.g. Personal Max)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setNewName("");
              }
            }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" style={primaryBtn} disabled={busy || !newName.trim()} onClick={() => void handleAdd()}>
            Create &amp; log in
          </button>
          <button type="button" style={smallBtn} onClick={() => { setAdding(false); setNewName(""); }}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...card, borderColor: C.amber, color: C.amber, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Two registrations of the SAME Claude login look like two accounts here but share one
          quota, so failover between them is a no-op that re-hits the same limit immediately. The
          nickname can't reveal this (it's user-typed), so we surface the identity clash instead.
          NOTE: a group is a PROVEN clash when it has an accountUuid, and an INFERENCE from a shared
          verified email when it does not — `duplicateAccountGroups` only infers when that email
          identifies exactly one uuid group, or none at all. */}
      {duplicates.map((g) => (
        <div
          key={g.key}
          role="alert"
          style={{ ...card, borderColor: C.amber, color: C.amber, fontSize: 12, lineHeight: 1.5 }}
        >
          <strong>
            {g.accounts.length} accounts are the same Claude login
            {g.email ? ` (${g.email})` : ""}.
          </strong>{" "}
          {g.accounts.map((a) => a.nickname).join(" and ")} share one usage quota, so switching
          between them gains you nothing — they hit the limit together. Log one of them into a
          different Claude account, or remove it.
        </div>
      ))}

      {accounts.length === 0 && !adding && (
        <div style={{ ...card, color: C.muted, fontSize: 13 }}>No accounts yet. Add one to get started.</div>
      )}

      {accounts.map((a) => {
        const u = usageFor(a.id);
        const identity = identityFor(a.id);
        const exhausted = exhaustedLabel(u, now);
        const isEditing = editingId === a.id;
        // The identity slot renders a VERIFIED identity or an explicit not-signed-in state — never
        // the user-typed nickname, which is not evidence of anything (contract §5). This row is how
        // an account with no `oauthAccount` in its config dir came to be displayed as "DROdio
        // Gmail": an unauthenticated registration presented as a login.
        //
        // `accountDisplay` is the shared authority (§4c) so this screen, the pane badge and the
        // switch banner cannot drift. THREE states, not two, though: `display.signedIn` is
        // email-only, while `isSignedIn` is WIDER (uuid OR email). A login carrying a uuid but no
        // readable email IS a real sign-in, so labelling it "Not signed in" would be the same lie
        // pointed the other way — it gets its own honest string instead.
        const display = accountDisplay(a, identity);
        const signedIn = isSignedIn(identity);
        const primary = display.signedIn
          ? display.primary
          : signedIn
            ? SIGNED_IN_NO_EMAIL
            : display.primary;
        const alias = primary !== display.nickname ? display.nickname : null;
        return (
          <div key={a.id} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {isEditing ? (
                <input
                  autoFocus
                  aria-label={`Rename ${a.nickname}`}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRename(a.id);
                    if (e.key === "Escape") exitRename();
                  }}
                  onBlur={() => void handleRename(a.id)}
                  style={{ ...inputStyle, flex: 1 }}
                />
              ) : (
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    data-testid={`account-identity-${a.id}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      ...(signedIn ? {} : { color: C.amber }),
                    }}
                    title={
                      signedIn
                        ? undefined
                        : "This config folder holds no Claude login. Log in to give it a real identity."
                    }
                  >
                    {primary}
                  </span>
                  {alias && (
                    <span style={{ fontSize: 12, color: C.muted, display: "block" }}>alias: {alias}</span>
                  )}
                  {identity?.organization && (
                    <span style={{ fontSize: 12, color: C.muted, display: "block" }}>{identity.organization}</span>
                  )}
                  {/* The separate amber "Not signed in" badge is gone: the identity slot above now
                      says it literally, and rendering the same words twice in one card was both
                      noise and an ambiguous target for tests. `isSignedIn` (uuid OR email) still
                      drives the Log in / Switch login affordance below — it is deliberately WIDER
                      than the identity slot's rule (email only), so an account holding an
                      `oauthAccount` with no readable `emailAddress` offers "Switch login" while its
                      identity slot honestly reports it has no email to show. */}
                </span>
              )}
              {a.isDefault && <span style={tagStyle}>default</span>}
              {/* Log in / re-point this config dir at a different Claude account. Without this an
                  account could only ever be logged in at the moment it was CREATED, so an account
                  that was never signed into — or two that turned out to hold the SAME login — had no
                  route to a fix but delete-and-recreate. Highlighted for a duplicate, since
                  re-logging one of the pair into a different account is exactly the remedy. */}
              {!isEditing &&
                // The DEFAULT account's config dir is the user's real `~/.claude` (registered by
                // reference, never copied — which is also why the Rust side refuses to delete it).
                // Re-logging it in therefore replaces the login used by `claude` EVERYWHERE on this
                // machine, not just inside Sparkle. That is not a one-click action, so it takes the
                // same confirm step as Remove.
                (a.isDefault && confirmLogin !== a.id ? (
                  <button
                    type="button"
                    style={
                      duplicateIds.has(a.id)
                        ? { ...smallBtn, borderColor: C.amber, color: C.amber }
                        : smallBtn
                    }
                    onClick={() => setConfirmLogin(a.id)}
                    // Scope named, not overstated — see AccountLoginModal (knightwatch probe 3).
                    title={`Changes the Claude login Sparkle uses for the default account (${a.configDir || "~/.claude.json"}).`}
                  >
                    {isSignedIn(identity) ? "Switch login" : "Log in"}
                  </button>
                ) : a.isDefault ? (
                  <>
                    <button
                      type="button"
                      style={{ ...smallBtn, borderColor: C.amber, color: C.amber }}
                      onClick={() => {
                        setConfirmLogin(null);
                        void handleLogin(a);
                      }}
                      title={`Replaces the login Sparkle uses for the default account (${a.configDir || "~/.claude.json"})`}
                    >
                      Change default account login
                    </button>
                    <button type="button" style={smallBtn} onClick={() => setConfirmLogin(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    style={
                      duplicateIds.has(a.id)
                        ? { ...smallBtn, borderColor: C.amber, color: C.amber }
                        : smallBtn
                    }
                    onClick={() => void handleLogin(a)}
                    title={
                      isSignedIn(identity)
                        ? `Currently ${identity?.email ?? "signed in"}. Logging in again lets you point this account at a different Claude login.`
                        : "Log this account into Claude"
                    }
                  >
                    {isSignedIn(identity) ? "Switch login" : "Log in"}
                  </button>
                ))}
              {!isEditing && (
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => startRename(a)}
                >
                  Rename
                </button>
              )}
              {/* The default account has no Remove control. NOTE: this is a UI-only rule —
                  `accounts_remove` does NOT reject a default, so do not rely on the backend for it.
                  What the backend does guarantee is that the DIRECTORY survives
                  (`dir_to_remove_on_remove` returns None for a default). */}
              {!a.isDefault &&
                (confirmRemove === a.id ? (
                  <>
                    <button
                      type="button"
                      style={{ ...smallBtn, borderColor: C.amber, color: C.amber }}
                      onClick={() => void handleRemove(a.id)}
                    >
                      Confirm remove
                    </button>
                    <button type="button" style={smallBtn} onClick={() => setConfirmRemove(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" style={smallBtn} onClick={() => setConfirmRemove(a.id)}>
                    Remove
                  </button>
                ))}
            </div>

            {exhausted && (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: C.amber }}>
                <FiAlertTriangle size={12} aria-hidden />
                {exhausted}
              </div>
            )}

            <UsageBar label="5-hour window" tokens={u?.tokens5h ?? 0} peakTokens={peak5h} />
            <UsageBar label="7-day window" tokens={u?.tokens7d ?? 0} peakTokens={peak7d} />
          </div>
        );
      })}
    </div>
  );
}
