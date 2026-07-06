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
    // Most recent user prompts (oldest→newest) for the tray breadcrumb. Defaulted so older windows
    // that don't publish it still deserialize.
    #[serde(default)]
    pub recent_prompts: Vec<RecentPrompt>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RosterProjectSlice {
    pub id: String,
    pub name: String,
    pub agents: Vec<RosterAgentSlice>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Counts {
    pub red: u32,
    pub grey: u32,
    pub green: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TrayRosterOut {
    pub projects: Vec<RosterProjectSlice>,
    pub counts: Counts,
}

/// Statuses that bucket to RED (needs you) and GREEN (working); everything else is GREY.
/// Mirrors AGENT_STATUS in packages/ui/tokens.ts — keep in sync.
fn status_bucket(status: &str) -> char {
    match status {
        "waiting" | "approval" | "errored" => 'r',
        "working" => 'g',
        _ => 'e', // grEy: idle, blocked, done, stopped, unknown
    }
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

pub fn bucket_counts(projects: &[RosterProjectSlice]) -> Counts {
    let mut c = Counts::default();
    for p in projects {
        for a in &p.agents {
            match status_bucket(&a.status) {
                'r' => c.red += 1,
                'g' => c.green += 1,
                _ => c.grey += 1,
            }
        }
    }
    c
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
    fn buckets_statuses_into_three_colors() {
        let projects = vec![proj("p1", vec![
            agent("a", "working"),   // green
            agent("b", "waiting"),   // red
            agent("c", "approval"),  // red
            agent("d", "errored"),   // red
            agent("e", "idle"),      // grey
            agent("f", "blocked"),   // grey
            agent("g", "done"),      // grey
            agent("h", "stopped"),   // grey
            agent("i", "weird"),     // grey (unknown)
        ])];
        assert_eq!(bucket_counts(&projects), Counts { red: 3, grey: 5, green: 1 });
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
        assert_eq!(bucket_counts(&[]), Counts::default());
    }
}

#[derive(Default)]
pub struct TrayState(pub Mutex<HashMap<String, Vec<RosterProjectSlice>>>);

use tauri::{AppHandle, Emitter, Manager, State};

fn current(state: &TrayState) -> TrayRosterOut {
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let projects = merge(&guard);
    let counts = bucket_counts(&projects);
    TrayRosterOut { projects, counts }
}

/// Push the merged roster + counts to the tray window (and anyone listening).
fn broadcast(app: &AppHandle) {
    let out = current(&app.state::<TrayState>());
    let _ = app.emit("tray://roster-changed", &out);
}

#[tauri::command]
pub fn publish_window_roster(
    app: AppHandle,
    state: State<TrayState>,
    label: String,
    projects: Vec<RosterProjectSlice>,
) {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).insert(label, projects);
    broadcast(&app);
}

#[tauri::command]
pub fn clear_window_roster(app: AppHandle, state: State<TrayState>, label: String) {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&label);
    broadcast(&app);
}

#[tauri::command]
pub fn get_tray_roster(state: State<TrayState>) -> TrayRosterOut {
    current(&state)
}

// ---------------------------------------------------------------------------
// Tray icon + popover window registration (Task 5)
// ---------------------------------------------------------------------------

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WebviewUrl, WebviewWindowBuilder,
};

const QUIT_MENU_ID: &str = "quit-sparkle";

const TRAY_LABEL: &str = "tray";
const POPOVER_W: f64 = 380.0;
const POPOVER_H: f64 = 560.0;

/// Create the hidden popover window and register the menu-bar icon. Called once in setup.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    // Hidden, borderless popover. Lives for the whole session; we only show/hide it.
    let _ = WebviewWindowBuilder::new(
        app,
        TRAY_LABEL,
        WebviewUrl::App("index.html?view=tray".into()),
    )
    .title("Sparkle Agents")
    .inner_size(POPOVER_W, POPOVER_H)
    .decorations(false)
    // .transparent(true) — requires tauri feature "macos-private-api" which is not enabled
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    // Right-click menu: a single "Quit Sparkle" item (the only true way to fully exit the app).
    // show_menu_on_left_click(false) keeps LEFT-click toggling the popover while RIGHT-click
    // raises this menu — without it the menu would steal the left click and the popover would
    // never open.
    let quit_item = MenuItem::with_id(app, QUIT_MENU_ID, "Quit Sparkle", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit_item])?;

    // A neutral starting icon (the bundled app png) until the first roster paints the numbers.
    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id("sparkle-tray")
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    builder
        .on_menu_event(|app, event| {
            if event.id().as_ref() == QUIT_MENU_ID {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Let the positioner remember the icon rect for TrayCenter placement.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Fully exit the app (used by the tray popover's "Quit Sparkle" button). The only in-app quit
/// path besides the tray's right-click menu and OS Cmd+Q — without it, closing the main window
/// just leaves the hidden tray window alive and the process running with no way out.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// pub(crate): also invoked by the global capture shortcut registered in lib.rs.
pub(crate) fn toggle_popover(app: &AppHandle) {
    let Some(win) = app.get_webview_window(TRAY_LABEL) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        use tauri_plugin_positioner::{Position, WindowExt};
        let _ = win.move_window(Position::TrayBottomCenter);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Replace the menu-bar icon with a webview-drawn PNG (base64, no data: prefix).
#[tauri::command]
pub fn set_tray_image(app: AppHandle, png_base64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(png_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    let image = Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("sparkle-tray") {
        tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
        tray.set_icon_as_template(false).map_err(|e| e.to_string())?;
    }
    Ok(())
}
