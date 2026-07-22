// React error boundaries — the safety net that keeps ONE render exception from white-screening the
// whole app. React unmounts the entire tree when a render throws and nothing catches it: the window
// goes blank, every running agent becomes invisible, and the only recovery is a force-quit. A
// boundary catches that throw, keeps the rest of the UI alive, and offers a recoverable fallback.
//
// Two placements use this (see main.tsx and Workspace.tsx):
//   1. A top-level boundary around the app root → AppErrorFallback (full-window recovery card).
//   2. A per-pane boundary around each AgentPane → AgentPaneErrorCard (inline card) so one crashing
//      pane degrades gracefully instead of taking down the workspace and its sibling agents.
//
// Every caught error is funneled through the SAME logger the rest of the app uses (logger.ts), so it
// still reaches the persistent log file + crash pipeline (frontend_log → Rust) exactly as an
// uncaught error would — we recover the UI WITHOUT losing the diagnostic.
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { C, FONT } from "../theme/colors";
import { log } from "../logger";
import { SupportModal } from "./SupportModal";
import { paneVisibilityStyle } from "./paneVisibility";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Scope label for the log line (funnels into the persistent log + crash pipeline). */
  scope?: string;
  /** Renders the recovery UI. `reset` clears the caught error, remounting `children`. */
  fallback: (args: { error: Error; reset: () => void }) => ReactNode;
  /** Optional extra side-effect on catch — logging already happens internally. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Generic error boundary. Catches render/lifecycle exceptions in its subtree, logs them through the
 * app logger, and renders `fallback` instead of the crashed subtree. `reset` (handed to the
 * fallback) clears the error so React re-mounts `children` on the next render.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Route through logger.ts so the caught error still lands in the same time-ordered log
    // (and crash pipeline) an uncaught render error would have — we swallow the white-screen,
    // not the diagnostic.
    log.error(this.props.scope ?? "errorBoundary", `React render error caught: ${error.message}`, {
      stack: error.stack,
      componentStack: info.componentStack,
    });
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback({ error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

// ── Fallbacks ─────────────────────────────────────────────────────────────────────────────────

function buttonStyle(filled: boolean) {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: filled ? C.accentInk : "transparent",
    border: `1px solid ${C.accentInk}`,
    color: filled ? C.deepForest : C.accentInk,
    borderRadius: 8,
    padding: "9px 18px",
    fontSize: 13.5,
    fontWeight: 600,
    fontFamily: FONT.ui,
    cursor: "pointer",
  } as const;
}

/**
 * Full-window recovery card for the TOP-LEVEL boundary. "Reload UI" remounts the React tree (via
 * `reset`); "Report" opens the existing SupportModal so the user can file a ticket with redacted
 * logs attached through the established support/crash pipeline — no new pipeline is invented.
 */
export function AppErrorFallback({ reset }: { error: Error; reset: () => void }) {
  const [showSupport, setShowSupport] = useState(false);
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
        textAlign: "center",
        background: C.forest,
        color: C.cream,
        fontFamily: FONT.ui,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Something broke</h1>
      <p style={{ margin: 0, maxWidth: 440, fontSize: 14, lineHeight: 1.6, color: C.muted }}>
        The app hit an unexpected error. Your agents are still running in the background — reload the
        UI to get back to them, or report it and we'll take a look.
      </p>
      <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
        <button onClick={reset} style={buttonStyle(true)}>
          Reload UI
        </button>
        <button onClick={() => setShowSupport(true)} style={buttonStyle(false)}>
          Report
        </button>
      </div>
      {showSupport && <SupportModal onClose={() => setShowSupport(false)} />}
    </div>
  );
}

/**
 * Inline error card for a single AgentPane. Stacks in the same absolutely-positioned box the pane
 * used (respecting `visible`, so a crashed background pane stays hidden and never steals a click),
 * so one crashing pane degrades to this card while its siblings and the rest of the workspace keep
 * running. "Retry" remounts just this pane.
 */
export function AgentPaneErrorCard({
  reset,
  visible,
}: {
  error: Error;
  reset: () => void;
  visible: boolean;
}) {
  return (
    <div
      role="alert"
      style={{
        position: "absolute",
        inset: 0,
        ...paneVisibilityStyle(visible),
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 32,
        textAlign: "center",
        background: C.forest,
        color: C.cream,
        fontFamily: FONT.ui,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>This agent's view hit an error</h2>
      <p style={{ margin: 0, maxWidth: 380, fontSize: 13.5, lineHeight: 1.6, color: C.muted }}>
        The rest of your agents are unaffected. Retry to reload just this pane.
      </p>
      <button onClick={reset} style={buttonStyle(true)}>
        Retry
      </button>
    </div>
  );
}
