// Client-side view models for the desktop dashboard. These mirror the orchestration
// DB/socket shapes (§10/§11) but carry only what the UI renders.

export type AgentStatus =
  | "pending"
  | "active"
  | "waiting"
  | "error"
  | "paused"
  | "complete";

export type RiskClass = "safe" | "caution" | "dangerous";

export interface Session {
  id: string;
  name: string;
  branch?: string;
  status: AgentStatus;
  currentAction: string; // "Creating OAuth middleware"
  progressPercent: number; // 0-100
  tasksDone: number;
  tasksTotal: number;
  etaMinutes?: number;
  waitingFor?: string; // dependency name when status === "waiting"
  errorMessage?: string; // when status === "error"
  rawTerminal: string[]; // raw PTY lines for Expert Mode
}

export interface ChiefSignal {
  label: string;
  type: "pass" | "warn" | "info";
}

export interface Approval {
  id: string;
  sessionId: string;
  description: string;
  riskClass: "caution" | "dangerous";
  chiefRecommendation: string;
  chiefSignals: ChiefSignal[];
}

export interface ChatAction {
  label: string;
  type: "primary" | "secondary" | "destructive";
  action: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "chief";
  text: string;
  timestamp: string; // ISO 8601
  actions?: ChatAction[];
}
