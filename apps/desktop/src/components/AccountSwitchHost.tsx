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

  // The banner names accounts by their REAL logged-in email, matching the per-agent badge. It never
  // falls back to the nickname: a nickname is user-typed and has no bearing on which Anthropic login
  // a config dir holds, and this banner is asking to move the user's work between logins.
  //
  // `null` means NOT LOADED YET, and that is a third state — not "nobody is signed in". Identities
  // arrive from an async effect, so with `[]` as the initial value every account resolved to
  // NOT_SIGNED_IN on first paint and the banner read "An account that isn't signed in has hit its
  // limit. Switch to an account that isn't signed in to keep working." Both the `from` (which by
  // construction IS signed in — it just hit a limit) and the `to` collapsed to the same string, so
  // the user could not tell what they were being asked to switch to. Not merely a flash either: if
  // `loadAccountState` rejects, or the recommended target has no identity row, it stayed that way.
  useEffect(() => {
    if (!recommendation && !plan) return;
    let cancelled = false;
    void loadAccountState()
      .then((s) => {
        if (!cancelled) setIdentities(s.identities);
      })
      // Swallowed on purpose, and it is load-bearing: without it a rejected read is an unhandled
      // rejection, and `identities` stays `null` — which is exactly right. We cannot name the
      // accounts, so we render nothing and the switcher retries on its next poll. Failing loudly
      // here would buy nothing; naming them wrongly would cost the user their work.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [recommendation, plan]);

  // Until identities resolve we cannot NAME the accounts, and this banner exists to ask the user to
  // move work between named logins. Showing nothing is the honest answer: a prompt that cannot say
  // which account it means is worse than no prompt, and it is the same "wrong identity is worse than
  // none" rule the rest of this feature follows. The switcher retries on its own poll.
  if (identities === null) return null;

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
