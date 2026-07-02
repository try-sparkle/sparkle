// Frontend bridge to the interactive screen-region capture (src-tauri/src/screenshot.rs).
// Invokes the native macOS crosshair picker and returns the captured PNG.

import { invoke } from "@tauri-apps/api/core";

export interface Screenshot {
  /** Absolute path to the captured PNG — reference this in a CLI prompt. */
  path: string;
  /** `data:image/png;base64,…` for an inline <img> thumbnail. */
  dataUrl: string;
}

/** Wire shape from Rust (serde keeps snake_case field names). */
interface ScreenshotWire {
  path: string;
  data_url: string;
}

/**
 * Open the macOS crosshair region picker. Resolves to the captured screenshot,
 * or `null` if the user cancels (Esc) — callers should treat null as a no-op.
 */
export async function captureScreenRegion(): Promise<Screenshot | null> {
  const res = await invoke<ScreenshotWire | null>("capture_screen_region");
  if (!res) return null;
  return { path: res.path, dataUrl: res.data_url };
}

/**
 * Hand a captured shot to the dedicated `capture` window (src-tauri/src/capture_window.rs):
 * positions it on the cursor's monitor, shows it, and emits `capture://shot` to its webview.
 * CaptureShot is serde camelCase, so the invoke payload is `{ shot: { path, dataUrl } }`.
 */
export async function showCaptureWindow(shot: Screenshot): Promise<void> {
  await invoke("show_capture_window", { shot: { path: shot.path, dataUrl: shot.dataUrl } });
}
