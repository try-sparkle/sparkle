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
  const [identities, setIdentities] = useState<Identity[]>([]);

  // The banner names accounts by their REAL logged-in email, matching the per-agent badge. It never
  // falls back to the nickname: a nickname is user-typed and has no bearing on which Anthropic login
  // a config dir holds, and this banner is asking to move the user's work between logins.
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

  const display = (a: Account) => accountDisplay(a, identities.find((i) => i.id === a.id));

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
