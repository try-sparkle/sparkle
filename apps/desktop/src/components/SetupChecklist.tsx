import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  FiCheckCircle,
  FiDownload,
  FiAlertCircle,
  FiLoader,
  FiGitBranch,
  FiBox,
  FiTerminal,
} from "react-icons/fi";
import type { IconType } from "react-icons";
import { C, FONT_WEIGHT, DANGER, ON_BRAND_FILL } from "../theme/colors";
import {
  checkPrereqs,
  checkGit,
  installNode,
  installClaudeCode,
  installGit,
  onSetupProgress,
} from "../preflight";
import {
  initialSetupState,
  setupReducer,
  setupComplete,
  anyInstalling,
  PREREQ_ORDER,
  type PrereqKey,
  type PrereqRow,
} from "../setupState";
import { safeUnlisten } from "../services/safeUnlisten";

/** How often we re-probe git after triggering the (user-driven, slow) CLT installer. */
const GIT_POLL_MS = 4000;
/** Stop polling and surface a retry after this long — the CLT install is user-driven and may be
 *  cancelled/never completed, so we must not spin forever (which would strand the row in
 *  `installing` with no recovery affordance). ~10 min covers a slow download. */
const GIT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface PrereqMeta {
  label: string;
  blurb: string;
  icon: IconType;
}

const META: Record<PrereqKey, PrereqMeta> = {
  git: {
    label: "git",
    blurb: "Version control — Sparkle uses it to manage each agent's isolated workspace.",
    icon: FiGitBranch,
  },
  node: {
    label: "Node.js",
    blurb: "JavaScript runtime that Claude Code runs on.",
    icon: FiBox,
  },
  claude: {
    label: "Claude Code",
    blurb: "The agent CLI Sparkle drives on your Mac.",
    icon: FiTerminal,
  },
};

/**
 * First-run setup checklist (install-readiness). One row per runtime prerequisite — git, Node.js,
 * Claude Code — each showing detected/missing state with an Install button that auto-installs the
 * missing one (no sudo) and streams live progress. When every row is green, `onReady` hands off.
 *
 * Replaces the old link-only Onboarding: we now DETECT and AUTO-INSTALL rather than just guide,
 * falling back to clear guidance only when an auto-install can't complete.
 *
 * NO SIGN-IN STEP — see setupState.ts for the full reasoning. In short: this screen runs once, on a
 * fresh machine, so a login step living here could never ask a RETURNING user whose session had
 * expired. Authentication is a gate now (ReadinessGate), which serves first run and every run after.
 * `onReady` therefore means "the installs are done", not "the user can run agents" — the caller
 * re-probes and the auth gate takes over.
 *
 * The upshot for a new user is the thing that was asked for: this screen no longer waits on them.
 * Installs run unattended, and the first thing they are actually asked for is signing in.
 */
export function SetupChecklist({ onReady }: { onReady: () => void }) {
  const [state, dispatch] = useReducer(setupReducer, undefined, initialSetupState);
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Shared detection: probe all three prereqs and fold the result into the machine. On failure the
  // caller decides whether to force everything to "missing" (initial load) or leave state as-is.
  const detect = useCallback((onError?: () => void) => {
    return checkPrereqs()
      .then((r) => {
        dispatch({ type: "detected", statuses: { git: r.git, node: r.node, claude: r.claude } });
      })
      .catch(() => onError?.());
  }, []);

  // Initial detection + subscribe to streamed install progress.
  useEffect(() => {
    let alive = true;
    void detect(() => {
      if (!alive) return;
      // Detection itself failed — treat all as missing so the user can still act.
      dispatch({
        type: "detected",
        statuses: {
          git: { installed: false, path: null },
          node: { installed: false, path: null },
          claude: { installed: false, path: null },
        },
      });
    });

    const unlistenP = onSetupProgress((p) => {
      if (!alive) return;
      const key = p.prereq as PrereqKey;
      if (PREREQ_ORDER.includes(key)) {
        dispatch({ type: "installProgress", key, message: p.message });
      }
    });

    return () => {
      alive = false;
      // safeUnlisten awaits the listen() promise so a listener that resolves AFTER this
      // cleanup still gets torn down, and swallows the benign Tauri teardown race.
      void safeUnlisten(unlistenP);
      if (gitPollRef.current) clearInterval(gitPollRef.current);
    };
  }, [detect]);

  // Hand off once every prerequisite is green. The auth gate is what comes next, not the workspace.
  useEffect(() => {
    if (setupComplete(state)) {
      const t = setTimeout(onReady, 500); // brief beat so the final ✓ is visible
      return () => clearTimeout(t);
    }
  }, [state, onReady]);

  async function handleInstall(key: PrereqKey) {
    dispatch({ type: "installStart", key });
    try {
      if (key === "node") {
        const path = await installNode();
        dispatch({ type: "installOk", key, path });
      } else if (key === "claude") {
        const path = await installClaudeCode();
        dispatch({ type: "installOk", key, path });
      } else {
        // git: trigger, then poll for the user-driven CLT install to complete.
        const res = await installGit();
        if (res.status === "already-installed") {
          dispatch({ type: "installOk", key, path: res.path });
        } else {
          startGitPolling();
        }
      }
    } catch (e) {
      dispatch({ type: "installError", key, error: errText(e) });
    }
  }

  function startGitPolling() {
    if (gitPollRef.current) clearInterval(gitPollRef.current);
    const startedAt = Date.now();
    gitPollRef.current = setInterval(() => {
      // Give up (and offer Retry) if the user never completes Apple's installer, so the row can't
      // spin forever with no recovery path.
      if (Date.now() - startedAt > GIT_POLL_TIMEOUT_MS) {
        if (gitPollRef.current) clearInterval(gitPollRef.current);
        gitPollRef.current = null;
        dispatch({
          type: "installError",
          key: "git",
          error:
            "Didn't detect git yet. Finish the macOS Command Line Tools install, then click Retry.",
        });
        return;
      }
      void checkGit()
        .then((s) => {
          if (s.installed) {
            if (gitPollRef.current) clearInterval(gitPollRef.current);
            gitPollRef.current = null;
            dispatch({ type: "installOk", key: "git", path: s.path });
          }
        })
        .catch(() => {
          /* transient probe failure — keep polling until the timeout */
        });
    }, GIT_POLL_MS);
  }

  // Re-run detection for all prereqs (the "check again" affordance / after a manual install).
  function recheck() {
    void detect();
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        color: C.cream,
        overflow: "auto",
      }}
    >
      <style>{SPIN_KEYFRAMES}</style>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold }}>Setting up your Mac</div>
      <div style={{ color: C.muted, maxWidth: 520, lineHeight: 1.5, textAlign: "center" }}>
        Sparkle runs Claude on your own Mac. We’ll install everything it needs — no Terminal
        required. You’ll sign in to Claude next.
      </div>

      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 10 }}>
        {PREREQ_ORDER.map((key) => (
          <PrereqRowView key={key} row={state.rows[key]} onInstall={() => void handleInstall(key)} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button
          onClick={recheck}
          disabled={anyInstalling(state)}
          style={secondaryBtn(anyInstalling(state))}
        >
          Check again
        </button>
        {setupComplete(state) && (
          <span style={{ color: C.successInk, fontWeight: FONT_WEIGHT.medium }}>
            Installed — next, sign in to Claude…
          </span>
        )}
      </div>
    </div>
  );
}

function PrereqRowView({ row, onInstall }: { row: PrereqRow; onInstall: () => void }) {
  const meta = META[row.key];
  const Icon = meta.icon;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 6,
        background: C.deepForest,
        border: `1px solid ${C.hairline}`,
      }}
    >
      <Icon size={20} style={{ color: C.muted, flexShrink: 0 }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: FONT_WEIGHT.semibold, fontSize: 13 }}>{meta.label}</div>
        <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.4 }}>
          {row.phase === "installing" && row.progress
            ? truncate(row.progress, 72)
            : row.phase === "error" && row.error
              ? row.error
              : meta.blurb}
        </div>
      </div>
      <StatusControl row={row} onInstall={onInstall} />
    </div>
  );
}

function StatusControl({ row, onInstall }: { row: PrereqRow; onInstall: () => void }) {
  switch (row.phase) {
    case "checking":
      return <Spinner label="Checking" />;
    case "installed":
      return (
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.successInk }}>
          <FiCheckCircle size={18} aria-hidden />
          <span style={{ fontSize: 13, fontWeight: FONT_WEIGHT.medium }}>Installed</span>
        </span>
      );
    case "installing":
      return <Spinner label="Installing" />;
    case "error":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <FiAlertCircle size={18} style={{ color: DANGER }} aria-hidden />
          <button onClick={onInstall} style={primaryBtn}>
            Retry
          </button>
        </div>
      );
    case "missing":
    default:
      return (
        <button onClick={onInstall} style={primaryBtn}>
          <FiDownload size={14} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
          Install
        </button>
      );
  }
}

/** Spin keyframes, rendered exactly once by SetupChecklist (not per-spinner). */
const SPIN_KEYFRAMES = `@keyframes setup-spin { to { transform: rotate(360deg) } } .setup-spin { animation: setup-spin 1s linear infinite; }`;

function Spinner({ label }: { label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.muted }}>
      <FiLoader size={16} aria-hidden className="setup-spin" />
      <span style={{ fontSize: 12 }}>{label}…</span>
    </span>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: string })?.message;
  return m ?? String(e);
}

const primaryBtn: React.CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 6,
  padding: "8px 16px",
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function secondaryBtn(disabled: boolean): React.CSSProperties {
  return {
    background: "transparent",
    color: C.cream,
    border: `1px solid ${C.muted}`,
    borderRadius: 6,
    padding: "8px 16px",
    fontWeight: FONT_WEIGHT.medium,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
