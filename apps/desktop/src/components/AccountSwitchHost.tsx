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
import { accountLabel, type Account, type Identity } from "../services/accountStore";

export function AccountSwitchHost() {
  const { recommendation, plan, accept, dismiss } = useAccountSwitch();
  const [identities, setIdentities] = useState<Identity[]>([]);

  // The banner names accounts by their REAL logged-in email where known, matching AccountsScreen
  // and the per-agent badge — a nickname is user-typed and may not reflect the actual login.
  useEffect(() => {
    if (!recommendation && !plan) return;
    let cancelled = false;
    void loadAccountState().then((s) => {
      if (!cancelled) setIdentities(s.identities);
    });
    return () => {
      cancelled = true;
    };
  }, [recommendation, plan]);

  const label = (a: Account) => accountLabel(a, identities.find((i) => i.id === a.id));

  return (
    <AccountSwitchBanner
      recommendation={recommendation}
      plan={plan}
      label={label}
      onAccept={accept}
      onDismiss={dismiss}
    />
  );
}
