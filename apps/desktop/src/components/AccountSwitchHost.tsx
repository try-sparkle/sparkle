// Mounts the account-switch banner and connects it to the switch controller.
//
// Kept separate from AccountSwitchBanner so the banner stays a pure presentational component
// (rendered directly in tests with fixture props) while this host owns the polling hook and the
// account-label lookup. Mounted once app-wide next to UpdateBanner: a rate limit belongs to an
// ACCOUNT, so there is exactly one of these regardless of how many projects or panes are open.
import { useEffect, useState } from "react";
import { AccountSwitchBanner } from "./AccountSwitchBanner";
import { useAccountSwitch } from "../hooks/useAccountSwitch";
import { loadAccountState } from "../services/accountSelection";
import { accountDisplay, type Account, type Identity } from "../services/accountStore";

export function AccountSwitchHost() {
  const { recommendation, plan, accept, dismiss } = useAccountSwitch();
  const [identities, setIdentities] = useState<Identity[] | null>(null);

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
  useEffect(() => {
    if (!recommendation && !plan) return;
    let cancelled = false;
    void loadAccountState().then((s) => {
      if (!cancelled) setIdentities(s.failed ? null : s.identities);
    });
    return () => {
      cancelled = true;
    };
  }, [recommendation, plan]);

  // The gate is PER ACCOUNT, not all-or-nothing on the array: a non-empty list that happens to lack
  // a row for the recommended target still produces the false statement for that one account, and
  // the banner names TWO accounts — both have to be nameable for it to mean anything.
  //
  // Only the RECOMMENDATION branch is gated. The in-progress `plan` branch renders "Switching
  // accounts — N of M agents moved" and names no account, so withholding it would hide real
  // progress for no benefit.
  const named = (a: Account | undefined) =>
    a != null && identities != null && identities.some((i) => i.id === a.id);
  if (!plan && (!named(recommendation?.from) || !named(recommendation?.to))) return null;

  const display = (a: Account) => accountDisplay(a, identities!.find((i) => i.id === a.id));

  return (
    <AccountSwitchBanner
      recommendation={recommendation}
      plan={plan}
      display={display}
      onAccept={accept}
      onDismiss={dismiss}
    />
  );
}
