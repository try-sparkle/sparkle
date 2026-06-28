import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import {
  listAccounts,
  getUsage,
  addAccount,
  setNickname,
  removeAccount,
  type Account,
  type Usage,
} from "../services/accountStore";

// Accounts settings screen for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). Lists each registered Claude
// config dir with its nickname, a "default" tag, per-window usage bars (5h / 7d) and an
// exhausted-until indicator; supports add / inline-rename / remove (the default can't be removed).
//
// ── The onLogin SEAM (integrator / Worker C must implement) ───────────────────────────────────
// "Add account" creates an empty config dir via addAccount(), then needs to run the real
// `claude login` flow in that dir's CLAUDE_CONFIG_DIR so the user can OAuth into a Max account.
// Spawning the PTY lives on the spawn path (claudeSpawn / AgentPane), which this component must NOT
// import. So we hand the freshly-created Account back through the required `onLogin(account)` prop;
// the integrator wires it to a PTY `claude login` (env CLAUDE_CONFIG_DIR=account.configDir). Until
// that login completes the account exists but is unauthenticated — that's expected for Phase 1.

const DEPS = { listAccounts, getUsage, addAccount, setNickname, removeAccount };
export type AccountsDeps = typeof DEPS;

export interface AccountsScreenProps {
  /** Integrator seam: invoked with the new Account right after it's created, to launch the
   *  `claude login` PTY in account.configDir. See the block comment above. */
  onLogin: (account: Account) => void;
  /** IO overrides — defaults to the real accountStore functions. Injectable for tests. */
  deps?: Partial<AccountsDeps>;
}

const fontStack = '"IBM Plex Sans", sans-serif';

const card: CSSProperties = {
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
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

const tag: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  border: `1px solid ${C.teal}`,
  color: C.accentInk,
  borderRadius: 4,
  padding: "1px 5px",
};

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
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted }}>
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

export function AccountsScreen({ onLogin, deps }: AccountsScreenProps) {
  const io: AccountsDeps = { ...DEPS, ...deps };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
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
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Depend on the individual functions actually used, not the whole `deps` object —
  // so an integrator passing an inline `deps={{...}}` literal (new object each render)
  // with stable function refs doesn't recreate `refresh` and spin the effect below.
  // The default (no `deps`) path resolves to the module-level DEPS, which are stable.
  const listAccountsFn = deps?.listAccounts ?? DEPS.listAccounts;
  const getUsageFn = deps?.getUsage ?? DEPS.getUsage;
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [a, u] = await Promise.all([listAccountsFn(), getUsageFn()]);
      setAccounts(a);
      setUsage(u);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    }
  }, [listAccountsFn, getUsageFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usageFor = (id: string) => usage.find((u) => u.id === id);
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
      // Hand off to the integrator to run `claude login` in the new config dir (see block comment).
      onLogin(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add account");
    } finally {
      setBusy(false);
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
        <div style={{ fontSize: 14, fontWeight: 600 }}>Claude accounts</div>
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

      {accounts.length === 0 && !adding && (
        <div style={{ ...card, color: C.muted, fontSize: 13 }}>No accounts yet. Add one to get started.</div>
      )}

      {accounts.map((a) => {
        const u = usageFor(a.id);
        const exhausted = exhaustedLabel(u, now);
        const isEditing = editingId === a.id;
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
                <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{a.nickname}</span>
              )}
              {a.isDefault && <span style={tag}>default</span>}
              {!isEditing && (
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => startRename(a)}
                >
                  Rename
                </button>
              )}
              {/* The default account can't be removed (the Rust side also refuses). */}
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
              <div style={{ marginTop: 6, fontSize: 12, color: C.amber }}>⚠ {exhausted}</div>
            )}

            <UsageBar label="5-hour window" tokens={u?.tokens5h ?? 0} peakTokens={peak5h} />
            <UsageBar label="7-day window" tokens={u?.tokens7d ?? 0} peakTokens={peak7d} />
          </div>
        );
      })}
    </div>
  );
}
