// Mock data so the dashboard renders before the orchestration socket is wired.
import type { Approval, ChatMessage, Session } from "./types";

export const MOCK_SESSIONS: Session[] = [
  {
    id: "s-auth",
    name: "Auth Agent",
    branch: "feature/auth",
    status: "active",
    currentAction: "Creating OAuth middleware",
    progressPercent: 70,
    tasksDone: 7,
    tasksTotal: 10,
    etaMinutes: 12,
    rawTerminal: [
      "Task: implement Clerk OAuth middleware",
      "Writing file src/middleware.ts",
      "npm install @clerk/backend",
    ],
  },
  {
    id: "s-db",
    name: "Schema Agent",
    branch: "feature/schema",
    status: "waiting",
    currentAction: "Waiting for: Auth Agent",
    waitingFor: "Auth Agent",
    progressPercent: 30,
    tasksDone: 3,
    tasksTotal: 10,
    rawTerminal: ["Task: design sparkle_projects table"],
  },
  {
    id: "s-pay",
    name: "Billing Agent",
    branch: "feature/billing",
    status: "error",
    currentAction: "Stripe webhook signature mismatch",
    errorMessage: "Stripe webhook signature mismatch",
    progressPercent: 45,
    tasksDone: 4,
    tasksTotal: 9,
    rawTerminal: ["Task: wire Stripe webhook", "Error: invalid signature"],
  },
  {
    id: "s-ui",
    name: "UI Agent",
    branch: "feature/dashboard",
    status: "complete",
    currentAction: "Complete",
    progressPercent: 100,
    tasksDone: 8,
    tasksTotal: 8,
    rawTerminal: ["Done: dashboard grid"],
  },
];

export const MOCK_APPROVALS: Approval[] = [
  {
    id: "a-deploy",
    sessionId: "s-db", // a "waiting" session, so the ApprovalCard actually renders
    description: "Deploy to staging environment",
    riskClass: "caution",
    chiefRecommendation: "Safe to deploy",
    chiefSignals: [
      { label: "All tests passing (47/47)", type: "pass" },
      { label: "No schema migrations pending", type: "pass" },
      { label: "First deploy for this project", type: "warn" },
    ],
  },
];

export const MOCK_CHAT: ChatMessage[] = [
  {
    id: "m1",
    role: "chief",
    text: "Chief captured your intent from Monday Planning. Ready to start building?",
    timestamp: "2026-06-19T19:00:00Z",
    actions: [
      { label: "Start Building", type: "primary", action: "start_building" },
      { label: "Edit Plan", type: "secondary", action: "edit_plan" },
    ],
  },
  {
    id: "m2",
    role: "user",
    text: "Yes, start building.",
    timestamp: "2026-06-19T19:00:30Z",
  },
];
