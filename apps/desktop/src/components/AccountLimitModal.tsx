// The interruption when a build agent hits a REAL account limit — and, more importantly, the place
// the user can log into another account WITHOUT opening a terminal.
//
// Why it exists (founder, verbatim): "The first one to hit a session limit pops up a modal front and
// center because when that happens I'm dead in the water… I need to stop logging in through
// terminals but I do that because that's the only place that I know that I can and have things get
// unblocked."
//
// The terminal habit is the actual defect, not a preference. Every terminal `claude login` lands in
// whichever config dir the shell points at — for the founder, one shared dir that took SIX different
// Anthropic identities in six hours. Sparkle then sees one account whose identity keeps changing
// instead of six accounts, and `AccountCeiling::reset_by_identity_change` correctly discards every
// ceiling it had learned. So this modal's primary action creates a FRESH config dir first and logs
// in there: the new login cannot overwrite the shared one, and the account stays distinguishable.
//
// It does NOT halt the fleet. Agents on other accounts keep working; the limited account is benched
// by `markExhausted` (services/limitSync.ts) so `pickAccount` routes around it, and any agent
// already on it migrates at a SAFE TURN BOUNDARY via the existing accountSwitch path. Nothing is
// killed mid-turn.
import { useEffect, useState } from "react";
import { C, MODAL_SHADOW, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import {
  addAccount,
  adoptionOutcome,
  getIdentities,
  listAccounts,
  setNickname,
  type Account,
} from "../services/accountStore";
import { invalidateAccountState } from "../services/accountSelection";
import { useAccountLimitStore } from "../stores/accountLimitStore";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { ModalLayer } from "./ModalLayer";

/** Above `AccountLoginModal`'s 120 (see the app-modal band in components/layers.ts): this modal can
 *  OPEN that flow, so it must not be painted over by the surface it spawns. Like every scrim-painting
 *  dialog it reaches the root stacking context via {@link ModalLayer} — the number alone would not
 *  win from inside the concierge column. */
const ACCOUNT_LIMIT_MODAL_Z = 130;

/** Placeholder nickname for the row created before the login runs. It is replaced by the account's
 *  real email the moment the login confirms ({@link adoptionOutcome}); it is only ever visible if
 *  the user abandons the flow half-way, so it reads as an explanation rather than a name. */
export const PENDING_NICKNAME = "Signing in…";

/** When the limit resets, in the user's own locale. Mirrors `AccountsScreen`'s `exhaustedLabel`
 *  rather than inventing a second format — the same instant should read the same everywhere. */
export function resetLabel(until: number, now: number): string | null {
  if (until <= now) return null;
  return new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The one-line outcome to show the user after a login completes. Pure, so the copy is testable
 *  without a PTY: the duplicate case is the one that must NOT read as success. */
export function outcomeMessage(outcome: ReturnType<typeof adoptionOutcome>): string {
  switch (outcome.kind) {
    case "named":
      return `Signed in as ${outcome.nickname}. Sparkle will now include it in rotation.`;
    case "duplicate":
      return `That is the same Claude account as “${outcome.existingNickname}”, which is already registered — so it shares the same limit. Log in as a DIFFERENT account to get more headroom.`;
    case "unidentified":
      return "The login didn’t complete, so this account wasn’t registered. You can try again.";
  }
}

export function AccountLimitModal() {
  const current = useAccountLimitStore((s) => s.current);
  const dismiss = useAccountLimitStore((s) => s.dismiss);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pending, setPending] = useState<Account | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!current) return;
    void listAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [current]);

  if (!current) return null;

  const limited = accounts.find((a) => a.id === current.accountId);
  const resetsAt = resetLabel(current.until, Date.now());

  const startLogin = async () => {
    setBusy(true);
    setResult(null);
    try {
      // The row (and its fresh config dir) MUST exist before the login runs — that is what keeps
      // the credentials out of the shared dir. Creating it after would be the terminal behaviour
      // this modal replaces.
      setPending(await addAccount(PENDING_NICKNAME));
    } catch (e) {
      setResult(`Couldn’t create the account folder: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Runs when ClaudeSignIn CONFIRMS a credential landed (it polls `claude auth status`, so this is
  // not merely "the PTY exited"). Only here can the account be named, because only now does its
  // config dir carry an `oauthAccount` to read.
  const onSignedIn = async () => {
    if (!pending) return;
    try {
      const [rows, identities] = await Promise.all([listAccounts(), getIdentities()]);
      const outcome = adoptionOutcome(pending.id, rows, identities);
      if (outcome.kind === "named") await setNickname(pending.id, outcome.nickname);
      setResult(outcomeMessage(outcome));
      // The selection cache holds a 5s snapshot of accounts+usage; without this the account just
      // registered cannot win auto-pick until it expires.
      invalidateAccountState();
    } catch (e) {
      setResult(`Signed in, but couldn’t read the account back: ${String(e)}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <ModalLayer>
      <div
        data-testid="account-limit-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          background: SCRIM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: ACCOUNT_LIMIT_MODAL_Z,
        }}
      >
        <div
          style={{
            width: pending ? 760 : 520,
            maxWidth: "92vw",
            maxHeight: "85vh",
            // THE SCROLL IS ON THE BODY BELOW, NOT HERE. Making the card the scrollport scrolls its
            // own title and its dismiss/sign-in footer out of view — on exactly the short window
            // this ceiling exists for, the controls leave the screen instead of merely being cut
            // off, which is not an improvement. `minHeight: 0` lets the column shrink so the
            // ceiling binds at all. See ModalShell.
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            background: C.dialogSurface,
            border: `1px solid ${C.dialogEdge}`,
            borderRadius: RADIUS.modal,
            padding: 16,
            color: C.cream,
            fontFamily: FONT_UI,
            boxShadow: MODAL_SHADOW,
          }}
        >
          {/* PINNED — the title states which account, and must stay visible while reading. */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, flex: "0 0 auto" }}>
            {limited?.nickname ? `“${limited.nickname}” hit its Claude limit` : "A Claude account hit its limit"}
          </div>

          {/* THE SCROLLPORT — everything between the pinned title and the pinned buttons. */}
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.5 }}>
            {resetsAt
              ? `It resets at ${resetsAt}. Retrying can’t clear it — this is an account limit, not a network error.`
              : "Retrying can’t clear it — this is an account limit, not a network error."}{" "}
            Agents on your other accounts keep running.
          </p>

          {pending ? (
            <div style={{ flex: 1, minHeight: 360, display: "flex", flexDirection: "column" }}>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.5 }}>
                Complete the Claude login below (it opens your browser). It goes into a{" "}
                <strong>new, separate config folder</strong>, so it won’t overwrite the account
                you’re already signed into — and Sparkle names it from the email automatically.
              </p>
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <ClaudeSignIn
                  key={pending.configDir}
                  configDir={pending.configDir}
                  onSignedIn={() => void onSignedIn()}
                />
              </div>
            </div>
          ) : null}

          {result ? (
            <p data-testid="account-limit-result" style={{ fontSize: 12, color: C.cream, lineHeight: 1.5 }}>
              {result}
            </p>
          ) : null}

          </div>

          {/* PINNED — the way out, and the sign-in that fixes the problem. Never scrolls away. */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12, flex: "0 0 auto" }}>
            <button
              type="button"
              onClick={dismiss}
              style={{
                background: "transparent",
                border: `1px solid ${C.muted}`,
                borderRadius: RADIUS.input,
                color: C.cream,
                fontSize: 12,
                padding: "5px 12px",
                cursor: "pointer",
              }}
            >
              {result ? "Done" : "Not now"}
            </button>
            {pending ? null : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startLogin()}
                style={{
                  background: "transparent",
                  border: `1px solid ${C.accentInk}`,
                  borderRadius: RADIUS.input,
                  color: C.accentInk,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "5px 12px",
                  cursor: busy ? "default" : "pointer",
                  opacity: busy ? 0.6 : 1,
                }}
              >
                Log in to another account
              </button>
            )}
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
