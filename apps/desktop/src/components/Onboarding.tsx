import { SetupChecklist } from "./SetupChecklist";

/**
 * First-run setup gate (spec §8). Shown inside an agent pane when the user's own Claude Code
 * (`claude`) isn't found — which on a brand-new Mac is also when git and Node.js are typically
 * missing. Rather than only linking to docs, we DETECT each runtime prerequisite and AUTO-INSTALL
 * the missing ones (no sudo), then walk the user through `claude login`. When everything is green,
 * `onRetry` re-runs the pane's preflight/prepare so the agent starts.
 *
 * Sparkle runs the user's OWN claude locally (ToS-compliant terminal-emulator model); it never
 * handles the auth token — the sign-in step runs the genuine `claude login` in an embedded terminal.
 */
export function Onboarding({ onRetry }: { onRetry: () => void }) {
  return <SetupChecklist onReady={onRetry} />;
}
