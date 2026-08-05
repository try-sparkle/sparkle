// Pure state machine for the first-run setup checklist (SetupChecklist.tsx). Kept separate from the
// component so the transitions — all-missing → installing → all-green — are unit-testable without
// rendering React or touching Tauri IPC.
//
// INSTALL ONLY. THE LOGIN STEP IS GONE, AND ITS ABSENCE IS THE POINT.
//
// This used to carry a fourth step: a `LoginPhase` (`locked` → `ready` → `inProgress` → `done`) that
// stayed LOCKED until claude was installed, ran `claude login` in an embedded terminal, and gated
// `setupComplete`. It is deleted. Authentication is now a GATE (ReadinessGate), not a step.
//
// Why that is better rather than merely different — the login step had a structural flaw no amount
// of fixing within the checklist could reach. A first-run checklist runs ONCE, on a fresh machine.
// But auth is not a one-time fact: sessions expire. So the one place the app knew how to ask for
// credentials was a screen that, by construction, a returning user would never see again. When the
// founder's OAuth session expired on his second machine, nothing asked him to sign in — the
// concierge simply failed, and told him to try again in a moment.
//
// The split that fixes it: INSTALL is machine work that runs unattended and genuinely only happens
// once (this file), while AUTH is user work that can be needed at any time (the gate). The
// dependency order is unchanged and unavoidable — `claude auth login` needs the claude binary, so
// install still precedes auth — but install no longer waits on a human, so auth is the first thing
// the user is actually ASKED for.
//
// The three prerequisites are ordered by dependency: git and node are independent; claude's shebang
// needs node. The UI can install them in any order.

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

export interface SetupState {
  rows: Record<PrereqKey, PrereqRow>;
}

/** Fixed display order (also the order rows are rendered). */
export const PREREQ_ORDER: PrereqKey[] = ["git", "node", "claude"];

export type SetupEvent =
  /** Result of the initial (or a re-run) detection probe. */
  | { type: "detected"; statuses: Partial<Record<PrereqKey, { installed: boolean; path: string | null }>> }
  | { type: "installStart"; key: PrereqKey }
  | { type: "installProgress"; key: PrereqKey; message: string }
  | { type: "installOk"; key: PrereqKey; path: string | null }
  | { type: "installError"; key: PrereqKey; error: string };

function row(key: PrereqKey): PrereqRow {
  return { key, phase: "checking", path: null, progress: "", error: null };
}

export function initialSetupState(): SetupState {
  return { rows: { git: row("git"), node: row("node"), claude: row("claude") } };
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
      return { rows };
    }
    case "installStart": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], phase: "installing", progress: "", error: null };
      return { rows };
    }
    case "installProgress": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], progress: event.message };
      return { rows };
    }
    case "installOk": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], phase: "installed", path: event.path, error: null };
      return { rows };
    }
    case "installError": {
      const rows = { ...state.rows };
      rows[event.key] = { ...rows[event.key], phase: "error", error: event.error };
      return { rows };
    }
    default:
      return state;
  }
}

/** All three prerequisites detected/installed. */
export function allPrereqsInstalled(state: SetupState): boolean {
  return PREREQ_ORDER.every((k) => state.rows[k].phase === "installed");
}

/** The checklist's work is done — every prerequisite is installed.
 *
 *  This NO LONGER means "the user can run agents": the auth gate still stands between here and a
 *  usable app, and `onReady` hands off to it rather than dismissing straight into the workspace. The
 *  name is kept because it means what it says for THIS screen; see the module header for the split. */
export function setupComplete(state: SetupState): boolean {
  return allPrereqsInstalled(state);
}

/** True while any prerequisite install is running (used to disable "check again" / proceed). */
export function anyInstalling(state: SetupState): boolean {
  return PREREQ_ORDER.some((k) => state.rows[k].phase === "installing");
}
