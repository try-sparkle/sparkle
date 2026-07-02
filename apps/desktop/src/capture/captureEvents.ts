// Tauri bindings for the capture modal, isolated so CaptureApp stays renderable (and testable)
// with no backend: every call is a no-op outside Tauri, mirroring services/attention.ts. The
// component test mocks THIS module to fire a synthetic `capture://shot`.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CaptureSendPayload, CaptureShot } from "./types";

const hasTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribe to shots delivered by Rust's `show_capture_window` (capture_window.rs). */
export function onCaptureShot(handler: (shot: CaptureShot) => void): Promise<UnlistenFn> {
  if (!hasTauri) return Promise.resolve(() => {});
  return listen<CaptureShot>("capture://shot", (e) => handler(e.payload));
}

/** Broadcast a send to every window; the owning project window routes it (plan Task 4). */
export function emitCaptureSend(payload: CaptureSendPayload): Promise<void> {
  if (!hasTauri) return Promise.resolve();
  return emit("capture://send", payload);
}

/** Hide the takeover window (Rust keeps it alive for the next capture). */
export function hideCaptureWindow(): Promise<void> {
  if (!hasTauri) return Promise.resolve();
  return invoke("hide_capture_window");
}
