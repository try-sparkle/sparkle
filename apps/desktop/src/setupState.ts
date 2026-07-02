// Pure state machine for the first-run setup checklist (SetupChecklist.tsx). Kept separate from the
// component so the transitions — all-missing → installing → all-green, plus the gated `claude login`
// step — are unit-testable without rendering React or touching Tauri IPC.
//
// The three prerequisites are ordered by dependency: git and node are independent; claude's shebang
// needs node, and the final `claude login` step needs claude. The UI can install them in any order,
// but the login step stays LOCKED until claude is present.

export type PrereqKey = "git" | "node" | "claude";

/** Per-prerequisite lifecycle. `checking` is the initial detect pass; `installing` covers a running
 *  install (progress streams into `progress`); `error` is a failed install (the row shows guidance
 *  and an explicit retry). */
export type PrereqPhase = "checking" | "missing" | "installing" | "installed" | "error";

export interface PrereqRow {
  key: PrereqKey;
  phase: PrereqPhase;
  /** Resolved absolute path once installed (for display / debugging). */
  path: string | null;
  /** Latest streamed installer line, shown while `installing`. */
  progress: string;
  /** Failure message when `phase === "error"`, else null. */
  error: string | null;
}

/** The final "Sign in to Claude Code" step. `locked` until claude is installed, then `ready`;
 *  `inProgress` while the login terminal is open; `done` once completed. */
export type LoginPhase = "locked" | "ready" | "inProgress" | "done";

export interface SetupState {
  rows: Record<PrereqKey, PrereqRow>;
  login: LoginPhase;
}

/** Fixed display order (also the order rows are rendered). */
export const PREREQ_ORDER: PrereqKey[] = ["git", "node", "claude"];

export type SetupEvent =
  /** Result of the initial (or a re-run) detection probe. */
  | { type: "detected"; statuses: Partial<Record<PrereqKey, { installed: boolean; path: string | null }>> }
  | { type: "installStart"; key: PrereqKey }
  | { type: "installProgress"; key: PrereqKey; message: string }
  | { type: "installOk"; key: PrereqKey; path: string | null }
  | { type: "installError"; key: PrereqKey; error: string }
  | { type: "loginStart" }
  | { type: "loginDone" }
  | { type: "loginReset" };

function row(key: PrereqKey): PrereqRow {
  return { key, phase: "checking", path: null, progress: "", error: null };
}

export function initialSetupState(): SetupState {
  return {
    rows: { git: row("git"), node: row("node"), claude: row("claude") },
    login: "locked",
  };
}

/** Derive the login gate from the claude row: it unlocks only once claude is installed, and never
 *  regresses out of `done` (a completed login stays done even if a re-detect re-runs). */
function deriveLogin(prev: LoginPhase, claude: PrereqRow): LoginPhase {
  if (prev === "done" || prev === "inProgress") return prev;
  return claude.phase === "installed" ? "ready" : "locked";
}

export function setupReducer(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case "detected": {
      const rows = { ...state.rows };
      for (const key of PREREQ_ORDER) {
        const s = event.statuses[key];
        if (!s) continue;
        // A detect pass never clobbers an in-flight install or an already-surfaced error unless it
        // finds the tool present (a successful install racing the poll).
        const current = rows[key];
        if (s.installed) {
          rows[key] = { ...current, phase: "installed", path: s.path, error: null };
        } else if (current.phase === "checking") {
          rows[key] = { ...current, phase: "missing", path: null };
        }
      }
      return { rows, login: deriveLogin(state.login, rows.claude) };
    }
    case "installStart": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], phase: "installing", progress: "", error: null };
      return { rows, login: deriveLogin(state.login, rows.claude) };
    }
    case "installProgress": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], progress: event.message };
      return { ...state, rows };
    }
    case "installOk": {
      const rows = { ...state.rows };
      rows[event.key] = {
        ...rows[event.key],
        phase: "installed",
        path: event.path,
        error: null,
      };
      return { rows, login: deriveLogin(state.login, rows.claude) };
    }
    case "installError": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], phase: "error", error: event.error };
      return { rows, login: deriveLogin(state.login, rows.claude) };
    }
    case "loginStart":
      // Guard: can't start login before claude is installed.
      if (state.login === "locked") return state;
      return { ...state, login: "inProgress" };
    case "loginDone":
      return { ...state, login: "done" };
    case "loginReset":
      // Never regress a COMPLETED sign-in. A late `claude login` terminal exit can fire during
      // unmount (its PTY-exit callback is captured at mount, so it can't see the live phase) — if
      // that probe resolves "not signed in" AFTER the user already confirmed, this must not flip a
      // done login back. Reducer-level guard keeps the invariant regardless of the caller's closure.
      // `done` is intentionally TERMINAL for reset — there is no sign-out flow in first-run setup; if
      // a re-auth path is ever added, introduce a dedicated `loginSignOut` event rather than relaxing
      // this (which exists to swallow the late-probe race, not to model logging back out).
      if (state.login === "done") return state;
      // Otherwise return to `ready` if claude is present, else `locked` (e.g. login closed early).
      return { ...state, login: state.rows.claude.phase === "installed" ? "ready" : "locked" };
    default:
      return state;
  }
}

/** All three prerequisites detected/installed. */
export function allPrereqsInstalled(state: SetupState): boolean {
  return PREREQ_ORDER.every((k) => state.rows[k].phase === "installed");
}

/** The whole flow is complete — every prereq installed AND the user has signed in to Claude Code.
 *  This is the gate the UI uses to proceed into the app. */
export function setupComplete(state: SetupState): boolean {
  return allPrereqsInstalled(state) && state.login === "done";
}

/** True while any prerequisite install is running (used to disable "check again" / proceed). */
export function anyInstalling(state: SetupState): boolean {
  return PREREQ_ORDER.some((k) => state.rows[k].phase === "installing");
}
