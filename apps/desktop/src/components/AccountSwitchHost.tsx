// Mounts the account-switch banner and connects it to the switch controller.
//
// Kept separate from AccountSwitchBanner so the banner stays a pure presentational component
// (rendered directly in tests with fixture props) while this host owns the polling hook and the
// account-label lookup. Mounted once app-wide next to UpdateBanner: a rate limit belongs to an
// ACCOUNT, so there is exactly one of these regardless of how many projects or panes are open.
import { useCallback, useEffect, useState } from "react";
import { AccountSwitchBanner } from "./AccountSwitchBanner";
import { useAccountSwitch } from "../hooks/useAccountSwitch";
import { loadAccountState } from "../services/accountSelection";
import { accountDisplay, listAccounts, type Account, type Identity } from "../services/accountStore";
import { useUiStore } from "../stores/uiStore";

/** How often the on-screen switch notice re-checks its destination against the account registry.
 *  Longer than `loadAccountState`'s 5s cache TTL so every tick is a genuinely fresh read, and slow
 *  enough that a notice sitting up for an hour costs a handful of small JSON reads. */
const REVALIDATE_MS = 10_000;

export function AccountSwitchHost() {
  const { recommendation, plan, accept, dismiss } = useAccountSwitch();
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  // `null` = NO SUCCESSFUL READ (not loaded yet, or the read failed); `[]` = the registry really is
  // empty. Collapsing those two — which this state did, as `useState<Account[]>([])` — is what let
  // the banner treat "we could not look" and "the destination is gone" as the same silent nothing.
  // Same discipline as the accounts pane's `loaded` flag, deliberately, so the two surfaces reach
  // the same verdict about emptiness from the same evidence.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  // The account id whose in-progress notice the user has dismissed with the ✕. Keyed by target so a
  // NEW switch (different destination) shows its own notice again; dismissing only hides THIS one.
  const [hiddenSwitchTo, setHiddenSwitchTo] = useState<string | null>(null);

  // `null` = NOT LOADED YET, which is a third state and not "nobody is signed in". With `[]` as the
  // initial value every account resolved to NOT_SIGNED_IN on first paint and the banner read "An
  // account that isn't signed in has hit its limit. Switch to an account that isn't signed in to
  // keep working." — the `from` account by construction IS signed in (it just hit a limit), and
  // from/to collapsed to one string.
  //
  // `loadAccountState` NEVER REJECTS. It catches internally and RESOLVES with
  // `{ identities: [], failed: true }`, so a `.catch` here is dead code and an emptiness check
  // cannot tell a failed read from a genuinely empty account list. Both were true of the first
  // version of this guard, which is why it did not actually close the hole it described.
  // ── THE ONLY WRITER FOR `accounts`, because there are TWO READERS ───────────────────────────
  //
  // Both the load effect below and the revalidation tick further down produce a registry read, and
  // the corroboration rule has to hold for both. Applying it at each call site is how it already
  // went wrong once: the rule was added to the tick and forgotten on this effect, leaving the very
  // outcome it exists to prevent reachable through the other door. One helper owns the rule so the
  // two provably cannot drift.
  //
  // THE RULE: only a NON-EMPTY array is evidence. Anything else — a failed read, a non-array from a
  // bridge that cannot answer, or a wholly-empty registry — is "we learned nothing", and the prior
  // snapshot stands. `read_accounts_at` returns `Ok(vec![])` for a missing file and an intermittent
  // empty read on this exact IPC path is the known defect behind this whole incident, so an empty
  // result cannot be told apart from a broken one and must not be trusted as either.
  //
  // Note `loadAccountState` does NOT flag that case: it sets `failed` from a SHAPE check, and `[]`
  // is a well-shaped array. So "not failed" is not the same as "believable", which is why the rule
  // lives here rather than being expressed as a `failed` test.
  //
  // Why it matters more than a blanked name: `targetUnverified` needs a non-empty registry to
  // accuse, so accepting `[]` would silently CLEAR a raised amber alert back to green — an alarm
  // switching itself off on its own trigger condition. And this effect re-runs often during a real
  // migration (`advanceSwitch` returns a NEW plan object each time an agent moves), so that path is
  // live, not theoretical.
  const applyRegistryRead = useCallback((a: Account[] | null | undefined) => {
    if (!Array.isArray(a) || a.length === 0) return;
    setAccounts(a);
  }, []);

  useEffect(() => {
    if (!recommendation && !plan) return;
    let cancelled = false;
    void loadAccountState().then((s) => {
      if (cancelled) return;
      setIdentities(s.failed ? null : s.identities);
      applyRegistryRead(s.failed ? null : s.accounts);
    });
    return () => {
      cancelled = true;
    };
  }, [recommendation, plan, applyRegistryRead]);

  // ── THE SNAPSHOT MUST NOT FREEZE ────────────────────────────────────────────────────────────
  //
  // The effect above is keyed on `plan`, and a plan whose agents never reach a safe boundary keeps
  // the SAME object forever: `advanceSwitch` returns the identical reference when nothing moved, so
  // React bails out of the setState, the deps never change, and the effect never re-runs. Phase 1
  // of `useAccountSwitch` is also short-circuited while a plan exists, and a plan retires only on
  // full completion. Net effect: the account list — and the destination name rendered from it —
  // was captured once at plan creation and then displayed indefinitely, with nothing able to
  // correct it. That is what let a green bar keep naming a destination while the accounts pane,
  // reading live, showed something else entirely.
  //
  // THE TICK READS THE ACCOUNT LIST ONLY, never `loadAccountState`, and that is a cost decision
  // rather than a stylistic one. `loadAccountState`'s cache TTL is 5s and this tick is 10s, so
  // EVERY tick would miss the cache and pay a full uncached load: `accounts_usage` (the transcript
  // walk `AccountsScreen` documents at 17,316 files / 5.7 GB and ~10s on the founder's machine)
  // plus a parse of every account's `.claude.json`. Unforced does not help — an always-stale cache
  // is the same as no cache — and the wedged-plan case this fix exists for is exactly the one that
  // would keep that running for hours. The destination check needs `accounts` and nothing else.
  useEffect(() => {
    // Gated on the notice being VISIBLE, not merely on a plan existing: after the ✕ this component
    // renders null, and a timer revalidating a claim that is not on screen is pure cost.
    if (!plan || plan.toAccountId === hiddenSwitchTo) return;
    let cancelled = false;
    const t = setInterval(() => {
      void listAccounts()
        .then((a) => {
          // Same single writer as the load effect — see `applyRegistryRead` for the rule and why
          // it lives in one place.
          if (!cancelled) applyRegistryRead(a);
        })
        .catch(() => {
          // KEEP THE LAST GOOD READ. A failed probe is not evidence the destination is gone, and
          // blanking to `null` here would make the notice flicker between states on every hiccup.
        });
    }, REVALIDATE_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [plan, hiddenSwitchTo, applyRegistryRead]);

  // The gate is PER ACCOUNT, not all-or-nothing on the array: a non-empty list that happens to lack
  // a row for the recommended target still produces the false statement for that one account, and
  // the banner names TWO accounts — both have to be nameable for it to mean anything.
  //
  // Only the RECOMMENDATION branch is gated by RETURNING NULL, and that stays right: the plan
  // branch reports a migration that is genuinely under way, so hiding it outright would hide real
  // progress. This comment used to justify the asymmetry by saying the plan branch "names no
  // account" — which stopped being true when the destination nickname was added to that sentence,
  // leaving the only named claim on screen as the one nothing verified. The plan branch is now
  // gated too, by `targetUnverified` below: it keeps rendering, but it cannot render a NAME the
  // registry does not corroborate.
  // NAMEABLE, not merely present. `identities_at` maps 1:1 over accounts and emits a row for EVERY
  // registered account, with email and accountUuid both null when the config is unresolvable — so a
  // row-presence check passes for exactly the account we cannot name, and `leadName` then says "An
  // account that isn't signed in has hit its limit" about the account the user is working in. `from`
  // is never filtered for a login (it comes straight from currentAccountId; only `to` goes through
  // signedInAccountIds), so a truncated mid-write read of .claude.json — the routine tick the Rust
  // half of this feature is built around — reaches it.
  const named = (a: Account | undefined) => {
    if (a == null || identities == null) return false;
    return accountDisplay(a, identities.find((i) => i.id === a.id)).hasLogin;
  };
  if (!plan && (!named(recommendation?.from) || !named(recommendation?.to))) return null;

  // `identities?.` rather than a non-null assertion: the gate above proves identities are loaded
  // only on the RECOMMENDATION path, and the plan branch reaches this line with them still null.
  // The banner does not call `display` in that branch today, but an assertion that is true only by
  // the caller's current behaviour is a crash waiting for the next edit.
  const display = (a: Account) => accountDisplay(a, identities?.find((i) => i.id === a.id));

  // The user's nickname for the account this switch is moving TO — the friendly label the progress
  // notice names. Resolved from the plan's real target account, so it is never a guessed name.
  const targetAccount = plan ? (accounts?.find((a) => a.id === plan.toAccountId) ?? null) : null;
  const targetName = targetAccount?.nickname ?? null;
  // THE CONTRADICTION GATE. True only when a read DEFINITIVELY completed, that read is SELF-
  // CONSISTENT, and the plan's destination was still not in it — the one state in which the green
  // "switching to X" bar would be making a claim the registry contradicts.
  //
  // `accounts.length > 0` is the corroboration requirement, and it is the whole difference between
  // this gate and a second copy of the bug it fixes. A registry that reads WHOLLY EMPTY mid-
  // migration is evidence about the READ, not about the destination: the plan's source account is
  // missing from it too, and by construction that account exists — it is the one the fleet is
  // migrating off. `read_accounts_at` returns `Ok(vec![])` for a missing file, and an intermittent
  // empty read on this exact IPC path is a KNOWN defect (it is what put "No accounts yet" on the
  // founder's screen next to an accounts.json holding seven rows, which is the incident this whole
  // change comes from). Condemning the destination on that evidence would replace an honest green
  // bar with a false amber one — the same failure, pointed the other way.
  //
  // So a wholly-empty read is treated like a failed read: no name (the destination is genuinely
  // unresolvable), but no accusation either. Only a registry that shows us OTHER accounts and not
  // this one has actually told us something about this one.
  //
  // This is the plan branch's equivalent of the `named()` gate the recommendation branch already
  // applies below. That gate was skipped here on the stated grounds that the progress notice
  // "names no account" — true when it was written, and false ever since the destination nickname
  // was added to the sentence. The copy changed; the gate that justified itself by the old copy
  // did not.
  const targetUnverified =
    plan != null && accounts != null && accounts.length > 0 && targetAccount == null;

  // Hide the in-progress notice if the user dismissed THIS switch's target. A fresh switch to a
  // different account resets to a visible notice by construction (the key no longer matches).
  const planForBanner = plan && plan.toAccountId !== hiddenSwitchTo ? plan : null;
  if (!planForBanner && !recommendation) return null;

  return (
    <AccountSwitchBanner
      recommendation={recommendation}
      plan={planForBanner}
      display={display}
      targetName={targetName}
      targetUnverified={targetUnverified}
      onAccept={accept}
      onDismiss={dismiss}
      onManage={() => useUiStore.getState().openSettings("accounts")}
      onDismissProgress={() => plan && setHiddenSwitchTo(plan.toAccountId)}
    />
  );
}
