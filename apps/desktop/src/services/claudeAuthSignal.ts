// "Something just failed to authenticate against Claude" — a one-line in-process signal.
//
// WHY THIS EXISTS. The readiness gate re-probes auth on window focus, which catches an expiry that
// happens while the app is in the background. It does NOT catch the case that actually bit the
// founder: the app is focused, he types a question, and the concierge child is the thing that
// discovers the session is dead. Without a signal, the gate would keep reporting the last (healthy)
// probe until the next focus event — so the user sits in a focused, apparently-fine app being told
// each request failed, which is precisely the experience being fixed.
//
// So the concierge's failure handler publishes here, and the gate re-probes. The publisher does not
// decide anything: it reports evidence ("a child said it could not authenticate") and the gate's own
// live probe decides whether that is real. That split matters — the CLI's error text is a heuristic
// and could be a misclassification, while `claude auth status` is authoritative. Publishing a
// suspicion can therefore never itself gate the app; it can only ask the question again.
//
// Deliberately a plain module-level Set rather than a store: there is no state here, only an edge.

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Subscribe to auth-failure reports. Returns an unsubscribe function (the shape `useEffect` wants).
 */
export function onClaudeAuthFailed(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Report that something failed to authenticate against Claude.
 *
 * Safe to call on every failed turn: subscribers re-probe, and the probe is the only thing that can
 * conclude anything. A listener that throws must not prevent the others from running — a broken
 * subscriber taking down the notification would leave the gate blind to exactly the event it was
 * added for.
 */
export function reportClaudeAuthFailed(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn("claude auth-failure listener threw:", e);
    }
  }
}

/** Test-only: drop all subscribers so one suite's mounts cannot leak into the next. */
export function resetClaudeAuthSignalForTests(): void {
  listeners.clear();
}
