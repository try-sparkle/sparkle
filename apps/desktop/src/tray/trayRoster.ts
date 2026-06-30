// Shared types for the menu-bar tray popover. Mirrors the Rust TrayRosterOut (tray.rs) and the
// mobile RosterAgent/STATUS_RANK so the desktop popover reads identically to the phone Dashboard.
export interface TrayAgent {
  id: string;
  name: string;
  kind: string;
  status: string;
  status_color: string;
  status_label: string;
  parent_id: string | null;
  workflow_stage?: string | null;
  last_activity_at?: number | null;
}
export interface TrayProject { id: string; name: string; agents: TrayAgent[]; }
export interface Counts { red: number; grey: number; green: number; }
export interface TrayRoster { projects: TrayProject[]; counts: Counts; }

// Red (needs you) first, then idle/done, then working, then dormant — identical to the mobile store.
// errored is rank 0 (needs you) to match its red bucket assignment in trayIcon.ts — consistent with
// AGENT_STATUS.errored.color === C.sienna (red) in tokens.ts.
export const STATUS_RANK: Record<string, number> = {
  waiting: 0, approval: 0, errored: 0, idle: 1, done: 1, working: 2, blocked: 3, stopped: 3,
};
export const rankCmp = (a: TrayAgent, b: TrayAgent): number =>
  (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.name.localeCompare(b.name);
