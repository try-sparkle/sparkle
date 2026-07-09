import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  FiCheckCircle,
  FiDownload,
  FiAlertCircle,
  FiLock,
  FiLoader,
  FiGitBranch,
  FiBox,
  FiTerminal,
} from "react-icons/fi";
import type { IconType } from "react-icons";
import { C, FONT_WEIGHT, DANGER } from "../theme/colors";
import {
  checkPrereqs,
  checkClaudeSignedIn,
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
import { buildClaudeLoginExec, SHELL } from "../services/claudeSpawn";
import { safeUnlisten } from "../services/safeUnlisten";
import { Terminal } from "./Terminal";

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
 * missing one (no sudo) and streams live progress. A final "Sign in to Claude Code" step runs
 * `claude login` in an embedded terminal. When everything is green, `onReady` proceeds into the app.
 *
 * Replaces the old link-only Onboarding: we now DETECT and AUTO-INSTALL rather than just guide,
 * falling back to clear guidance only when an auto-install can't complete.
 */
export function SetupChecklist({ onReady }: { onReady: () => void }) {
  const [state, dispatch] = useReducer(setupReducer, undefined, initialSetupState);
  const gitPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Path to the user's claude binary, needed to spawn `claude login`. Set once claude is installed.
  const [claudePath, setClaudePath] = useState<string | null>(null);

  // Shared detection: probe all three prereqs and fold the result into the machine. On failure the
  // caller decides whether to force everything to "missing" (initial load) or leave state as-is.
  const detect = useCallback((onError?: () => void) => {
    return checkPrereqs()
      .then((r) => {
        dispatch({ type: "detected", statuses: { git: r.git, node: r.node, claude: r.claude } });
        if (r.claude.installed) setClaudePath(r.claude.path);
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

  // Proceed into the app once every prerequisite is green AND the user has signed in.
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
        setClaudePath(path);
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

  // The `claude login` terminal spawn (no cwd — runs before any worktree exists).
  const loginSpawn =
    claudePath != null
      ? { command: SHELL, args: ["-l", "-c", buildClaudeLoginExec(claudePath)] }
      : null;

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
      <div style={{ fontSize: 22, fontWeight: FONT_WEIGHT.semibold }}>Let’s finish setting up</div>
      <div style={{ color: C.muted, maxWidth: 520, lineHeight: 1.5, textAlign: "center" }}>
        Sparkle runs Claude on your own Mac. We’ll install everything it needs — no Terminal
        required — then sign you in to Claude Code (Sparkle never sees your credentials).
      </div>

      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 10 }}>
        {PREREQ_ORDER.map((key) => (
          <PrereqRowView key={key} row={state.rows[key]} onInstall={() => void handleInstall(key)} />
        ))}

        {/* Final step: sign in to Claude Code. */}
        <LoginRow
          phase={state.login}
          spawn={loginSpawn}
          onStart={() => dispatch({ type: "loginStart" })}
          onExit={() => {
            // The `claude login` terminal exited. Don't treat that as success on its own (the user
            // may have quit or failed) — verify Claude Code actually recorded an authenticated
            // identity. Only a confirmed sign-in advances; anything else (not signed in OR a probe
            // failure) resets so the user can retry or use the manual confirm. A `loginReset` here
            // can't regress an already-`done` login — the reducer guards that (this callback is
            // frozen at Terminal mount, so it can't check the live phase itself).
            void checkClaudeSignedIn()
              .then((ok) => dispatch(ok ? { type: "loginDone" } : { type: "loginReset" }))
              .catch(() => dispatch({ type: "loginReset" }));
          }}
          onManualDone={() => dispatch({ type: "loginDone" })}
          onCancel={() => dispatch({ type: "loginReset" })}
        />
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
            All set — opening Sparkle…
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
        borderRadius: 10,
        background: C.deepForest,
        border: `1px solid ${C.forest}`,
      }}
    >
      <Icon size={20} style={{ color: C.muted, flexShrink: 0 }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: FONT_WEIGHT.semibold, fontSize: 14 }}>{meta.label}</div>
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

function LoginRow({
  phase,
  spawn,
  onStart,
  onExit,
  onManualDone,
  onCancel,
}: {
  phase: "locked" | "ready" | "inProgress" | "done";
  spawn: { command: string; args: string[] } | null;
  onStart: () => void;
  onExit: () => void;
  onManualDone: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        borderRadius: 10,
        background: C.deepForest,
        border: `1px solid ${C.forest}`,
        opacity: phase === "locked" ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <FiTerminal size={20} style={{ color: C.muted, flexShrink: 0 }} aria-hidden />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: FONT_WEIGHT.semibold, fontSize: 14 }}>Sign in to Claude Code</div>
          <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.4 }}>
            Runs <code>claude login</code> in your browser. Sparkle never handles your credentials.
          </div>
        </div>
        {phase === "locked" && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.muted }}>
            <FiLock size={16} aria-hidden />
            <span style={{ fontSize: 12 }}>Install Claude Code first</span>
          </span>
        )}
        {phase === "ready" && (
          <button onClick={onStart} style={primaryBtn} disabled={!spawn}>
            Sign in
          </button>
        )}
        {phase === "done" && (
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: C.successInk }}>
            <FiCheckCircle size={18} aria-hidden />
            <span style={{ fontSize: 13, fontWeight: FONT_WEIGHT.medium }}>Signed in</span>
          </span>
        )}
      </div>

      {phase === "inProgress" && spawn && (
        <>
          <div
            style={{
              height: 300,
              border: `1px solid ${C.forest}`,
              borderRadius: 8,
              overflow: "hidden",
              padding: 6,
            }}
          >
            <Terminal
              agentId="setup-claude-login"
              projectId="setup"
              projectRootPath=""
              command={spawn.command}
              args={spawn.args}
              active
              onStatus={() => {}}
              onExit={onExit}
            />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={onManualDone} style={primaryBtn}>
              I’ve signed in
            </button>
            <button onClick={onCancel} style={secondaryBtn(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
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
  color: C.cream,
  border: "none",
  borderRadius: 8,
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
    borderRadius: 8,
    padding: "8px 16px",
    fontWeight: FONT_WEIGHT.medium,
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
