// Shared types for the cross-window agent roster. Mirrors the Rust RosterOut (roster.rs) and the
// mobile RosterAgent/STATUS_RANK so desktop and phone read the fleet identically.
export interface RosterRecentPrompt {
  id: string;
  text: string;
}
export interface RosterAgent {
  id: string;
  name: string;
  kind: string;
  status: string;
  status_color: string;
  status_label: string;
  parent_id: string | null;
  workflow_stage?: string | null;
  last_activity_at?: number | null;
  recent_prompts?: RosterRecentPrompt[]; // most recent (~4) user prompts, oldest→newest; breadcrumb
}
export interface RosterProject { id: string; name: string; agents: RosterAgent[]; }
export interface Roster { projects: RosterProject[]; }
