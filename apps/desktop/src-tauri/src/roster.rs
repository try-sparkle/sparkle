//! The cross-window agent roster aggregator.
//!
//! Each window publishes ITS OWN slice of open projects; this module merges every window's slice
//! into one fleet view and broadcasts it as `roster://changed`.
//!
//! This is NOT tray plumbing, despite having lived in `tray.rs` until the menu-bar extra was
//! replaced by the floating helper island. `useConciergeFeed` consumes it as the **cross-window
//! completeness source** — a window's own `runtimeStore.status` covers only the agents it hosts,
//! so without this merge the concierge's P0/P1 banding would silently miss every agent living in
//! another window.

use std::collections::HashMap;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecentPrompt {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RosterAgentSlice {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub status_color: String,
    pub status_label: String,
    pub parent_id: Option<String>,
    pub workflow_stage: Option<String>,
    pub last_activity_at: Option<i64>,
    // Most recent user prompts (oldest→newest) for the agent breadcrumb. Defaulted so older
    // windows that don't publish it still deserialize.
    #[serde(default)]
    pub recent_prompts: Vec<RecentPrompt>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RosterProjectSlice {
    pub id: String,
    pub name: String,
    pub agents: Vec<RosterAgentSlice>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RosterOut {
    pub projects: Vec<RosterProjectSlice>,
}

/// Merge every window's projects into one list, last-writer-wins per project id
/// (a project shows in at most one window; dedupe defensively).
pub fn merge(slices: &HashMap<String, Vec<RosterProjectSlice>>) -> Vec<RosterProjectSlice> {
    let mut by_id: HashMap<String, RosterProjectSlice> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for projects in slices.values() {
        for p in projects {
            if !by_id.contains_key(&p.id) {
                order.push(p.id.clone());
            }
            by_id.insert(p.id.clone(), p.clone());
        }
    }
    order.into_iter().filter_map(|id| by_id.remove(&id)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, status: &str) -> RosterAgentSlice {
        RosterAgentSlice {
            id: id.into(), name: id.into(), kind: "build".into(),
            status: status.into(), status_color: "#000".into(), status_label: "x".into(),
            parent_id: None, workflow_stage: None, last_activity_at: None,
            recent_prompts: Vec::new(),
        }
    }
    fn proj(id: &str, agents: Vec<RosterAgentSlice>) -> RosterProjectSlice {
        RosterProjectSlice { id: id.into(), name: id.into(), agents }
    }

    #[test]
    fn merge_dedupes_by_project_id_last_writer_wins() {
        let mut slices = HashMap::new();
        slices.insert("win-1".to_string(), vec![proj("p1", vec![agent("a", "idle")])]);
        slices.insert("main".to_string(), vec![proj("p2", vec![agent("b", "working")])]);
        let merged = merge(&slices);
        assert_eq!(merged.len(), 2);
        let ids: Vec<_> = merged.iter().map(|p| p.id.clone()).collect();
        assert!(ids.contains(&"p1".to_string()) && ids.contains(&"p2".to_string()));
    }

    #[test]
    fn merge_empty_is_empty() {
        assert!(merge(&HashMap::new()).is_empty());
    }

    #[test]
    fn merge_keeps_every_agent_from_every_window() {
        // The whole point of the aggregator: the concierge's P0/P1 banding must see agents hosted
        // in OTHER windows, which this window's own runtimeStore knows nothing about.
        let mut slices = HashMap::new();
        slices.insert("main".into(), vec![proj("p1", vec![agent("a", "waiting")])]);
        slices.insert(
            "win-2".into(),
            vec![proj("p2", vec![agent("b", "waiting"), agent("c", "idle")])],
        );
        let merged = merge(&slices);
        let total: usize = merged.iter().map(|p| p.agents.len()).sum();
        assert_eq!(total, 3);
    }
}

#[derive(Default)]
pub struct RosterState(pub Mutex<HashMap<String, Vec<RosterProjectSlice>>>);

use tauri::{AppHandle, Emitter, Manager, State};

fn current(state: &RosterState) -> RosterOut {
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    RosterOut { projects: merge(&guard) }
}

/// Push the merged roster to every window.
fn broadcast(app: &AppHandle) {
    let out = current(&app.state::<RosterState>());
    let _ = app.emit("roster://changed", &out);
}

#[tauri::command]
pub fn publish_window_roster(
    app: AppHandle,
    state: State<RosterState>,
    label: String,
    projects: Vec<RosterProjectSlice>,
) {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).insert(label, projects);
    broadcast(&app);
}

#[tauri::command]
pub fn clear_window_roster(app: AppHandle, state: State<RosterState>, label: String) {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&label);
    broadcast(&app);
}

#[tauri::command]
pub fn get_roster(state: State<RosterState>) -> RosterOut {
    current(&state)
}

/// Fully exit the app — the floating helper island's right-click "Quit Sparkle".
///
/// Load-bearing: closing the main window only hides it, and with the menu-bar extra gone this is
/// the only in-app full exit besides the OS ⌘Q.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
