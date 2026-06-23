// Shared agent-event risk model (§6.2). Used by both the orchestration backend
// (E2B/cloud path) and the desktop app (local-PTY path) so classification is identical.

export type RiskClass = "safe" | "caution" | "dangerous";

export type EventType =
  | "task_start"
  | "file_read"
  | "file_write"
  | "shell_exec"
  | "approval_needed"
  | "task_complete"
  | "session_complete"
  | "error"
  | "log";

export interface ClassifiedEvent {
  event_type: EventType;
  risk_class: RiskClass | null;
  description: string;
  payload: Record<string, unknown>;
}
