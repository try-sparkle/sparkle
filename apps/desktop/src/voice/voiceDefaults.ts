// Shared voice-control defaults — the single source of the built-in wake/stop words and the
// submit-listening behavior. Reused by the frontend settingsStore mirror, the VoiceControlsMenu
// pane, the reset-to-defaults action, and the wakeWords matcher's DEFAULT_WAKE_CONFIG. These MUST
// stay in lockstep with the Rust config defaults in src-tauri/src/config.rs ([voice] section).
export const DEFAULT_WAKE_WORD = "Hey Sparkle";
export const DEFAULT_STOP_WORD = "Sparkle, stop";
export const DEFAULT_PAUSE_ON_SUBMIT = true;
