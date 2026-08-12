// A one-shot request channel for the MANUAL "switch every agent to this account" button.
//
// The Accounts screen (AccountsScreen) is a TRANSIENT modal — it unmounts the moment the user
// closes it. But a fleet-wide switch is LONG-RUNNING: busy agents migrate only as they each reach a
// safe turn boundary, which can take minutes (accountSwitch.ts). So the switch must be DRIVEN by a
// component that outlives the modal — `useAccountSwitch`, mounted once app-wide in
// AccountSwitchHost, which already owns the `advanceSwitch` poll loop.
//
// This module is the bridge between the two: the modal `requestSwitchAll(accountId)`, and the
// app-wide driver subscribes so it can build the plan and run the ONE existing advance loop. Nothing
// here holds state beyond the live subscribers — a request is delivered synchronously to whoever is
// listening now, which in production is always the mounted host.

type Listener = (accountId: string) => void;

const listeners = new Set<Listener>();

/** Ask the app-wide switch driver to move every agent + the concierge to `accountId`. Called by the
 *  Accounts screen's button. Delivered synchronously to the mounted driver; if nothing is listening
 *  (no host mounted — not a real app state) it is a no-op rather than an error. */
export function requestSwitchAll(accountId: string): void {
  for (const l of [...listeners]) l(accountId);
}

/** Subscribe to manual switch-all requests. Returns an unsubscribe fn. Called by `useAccountSwitch`
 *  in an effect, so the subscription is torn down with the host. */
export function subscribeSwitchAll(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/teardown helper — drops every subscriber. */
export function resetSwitchAllListeners(): void {
  listeners.clear();
}
