import type { ClassifiedEvent } from "@sparkle/core";
import { create } from "zustand";
import { startAgent } from "../agentRunner";
import { MOCK_APPROVALS, MOCK_SESSIONS } from "../mock";
import type { AgentStatus, Approval, Session } from "../types";

// §10.2 — cards sorted: error first, then waiting, active, paused, complete, pending.
const ORDER: Record<AgentStatus, number> = {
  error: 0,
  waiting: 1,
  active: 2,
  paused: 3,
  complete: 4,
  pending: 5,
};

export function sortCards(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
}

// Detach a session's PTY listeners when it ends — avoids leaking a listener pair
// per launched agent.
const agentTeardowns = new Map<string, () => void>();

const MAX_TERMINAL_LINES = 500;

interface StartLocalAgentOptions {
  name: string;
  command: string; // absolute path to `claude` (from preflight) or any command
  args?: string[];
  cwd?: string;
  branch?: string;
}

interface SessionState {
  sessions: Session[];
  approvals: Approval[];
  setStatus: (id: string, status: AgentStatus) => void;
  upsertSession: (session: Session) => void;
  resolveApproval: (approvalId: string) => void;
  pendingApprovalFor: (sessionId: string) => Approval | undefined;
  /** Fold a classified PTY event into session state (current action, approvals). */
  ingest: (sessionId: string, event: ClassifiedEvent, rawLine: string) => void;
  appendTerminal: (sessionId: string, line: string) => void;
  /** Spawn a real local agent (the user's own claude) and stream it into the dashboard. */
  startLocalAgent: (opts: StartLocalAgentOptions) => Promise<string>;
}

function patch(
  sessions: Session[],
  id: string,
  fn: (s: Session) => Session,
): Session[] {
  return sessions.map((s) => (s.id === id ? fn(s) : s));
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: MOCK_SESSIONS,
  approvals: MOCK_APPROVALS,

  setStatus: (id, status) =>
    set((s) => ({ sessions: patch(s.sessions, id, (x) => ({ ...x, status })) })),

  upsertSession: (session) =>
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === session.id)
        ? patch(s.sessions, session.id, () => session)
        : [...s.sessions, session],
    })),

  resolveApproval: (approvalId) =>
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== approvalId) })),

  pendingApprovalFor: (sessionId) =>
    get().approvals.find((a) => a.sessionId === sessionId),

  appendTerminal: (sessionId, line) =>
    set((s) => ({
      sessions: patch(s.sessions, sessionId, (x) => ({
        ...x,
        rawTerminal: [...x.rawTerminal, line].slice(-MAX_TERMINAL_LINES),
      })),
    })),

  ingest: (sessionId, event, _rawLine) =>
    set((s) => {
      let approvals = s.approvals;
      let nextStatus: AgentStatus | undefined;

      if (event.event_type === "approval_needed" && event.risk_class !== "safe") {
        // One pending approval per session — Claude's TUI re-prints prompts. Update
        // the existing one in place (so a later "dangerous" re-print escalates a
        // "caution") instead of stacking duplicates. PTY stays blocked until decided.
        const incoming = event.risk_class === "dangerous" ? "dangerous" : "caution";
        const existing = s.approvals.find((a) => a.sessionId === sessionId);
        // Escalate only — never downgrade an already-dangerous prompt to caution.
        const riskClass: "caution" | "dangerous" =
          existing?.riskClass === "dangerous" ? "dangerous" : incoming;
        approvals = existing
          ? s.approvals.map((a) =>
              a.sessionId === sessionId
                ? { ...a, riskClass, description: event.description }
                : a,
            )
          : [
              ...s.approvals,
              {
                id: crypto.randomUUID(),
                sessionId,
                description: event.description,
                riskClass,
                chiefRecommendation: "", // Chief not wired on the local path yet
                chiefSignals: [],
              },
            ];
        nextStatus = "waiting"; // block until decided
      }
      // Non-approval events do NOT change status — don't clobber a "waiting" session.

      return {
        approvals,
        // rawTerminal is appended by onRawLine (every line); here we only fold in
        // the classified signal.
        sessions: patch(s.sessions, sessionId, (x) => ({
          ...x,
          currentAction: event.description,
          status: nextStatus ?? x.status,
          tasksDone:
            event.event_type === "task_complete" ? x.tasksDone + 1 : x.tasksDone,
        })),
      };
    }),

  startLocalAgent: async (opts) => {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      name: opts.name,
      branch: opts.branch,
      status: "active",
      currentAction: "Starting…",
      progressPercent: 0,
      tasksDone: 0,
      tasksTotal: 0,
      rawTerminal: [],
    };
    get().upsertSession(session);

    const teardown = await startAgent({
      id,
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      callbacks: {
        onEvent: (event, rawLine) => get().ingest(id, event, rawLine),
        onRawLine: (line) => get().appendTerminal(id, line),
        onExit: () => {
          // Mark complete AND drop any orphaned pending approval for this session.
          set((s) => ({
            sessions: patch(s.sessions, id, (x) => ({ ...x, status: "complete" })),
            approvals: s.approvals.filter((a) => a.sessionId !== id),
          }));
          agentTeardowns.get(id)?.(); // detach listeners — no leak
          agentTeardowns.delete(id);
        },
      },
    });
    agentTeardowns.set(id, teardown);

    return id;
  },
}));
