// The tray, actually reaching a menu bar — bead sparkle-uz87.9.
//
// `trayStatus.ts` answers "what WOULD the tray say". This file is the half that makes the answer
// leave the process: it derives the status from a live session snapshot and hands it to
// `overlay_tray.rs`, which owns the icon.
//
// TWO THINGS ARE DELIBERATE HERE.
//
//   1. THE GATE IS THE HOST'S, NOT OURS. This module does not decide whether a tray may exist; it
//      asks and reports what happened. The Rust side reads its own gate and fails CLOSED, so a
//      frontend bug — a flag misread, a component mounting something it should not — cannot put an
//      icon in anyone's menu bar. That is why `syncTray` returns `installed` from the host rather
//      than from what it intended: "we asked" and "an icon appeared" are different facts.
//   2. A REFUSED SYNC IS NOT AN ERROR. With the gate shut the host answers `false` and the caller
//      carries on. The overlay is off by default; a tray that declines to exist is the normal case.
import { invoke } from "@tauri-apps/api/core";
import {
  deriveTrayStatus,
  trayTooltip,
  type TrayInputs,
  type TrayStatus,
} from "./trayStatus";

/** The host seam. Injectable so a test can drive both gate directions without a running app. */
export interface TrayBackend {
  /** Publish a status. Resolves to whether a tray icon exists in the menu bar afterwards. */
  sync(status: TrayStatus): Promise<boolean>;
  /** Whether the host's gate is open at all, so a caller can skip the sync loop entirely. */
  gateOpen(): Promise<boolean>;
}

/**
 * The real backend: the two `#[tauri::command]`s in `overlay_tray.rs`.
 *
 * The command names and the argument key are matched by NAME at runtime, so a rename on either
 * side is a runtime-only failure with no compile error — which is why `tray.realDeps.test.ts` pins
 * both strings rather than trusting the typechecker.
 */
export function defaultTrayBackend(): TrayBackend {
  return {
    sync: (status) => invoke<boolean>("overlay_tray_sync", { status }),
    gateOpen: () => invoke<boolean>("overlay_tray_gate_open"),
  };
}

export interface TraySyncResult {
  status: TrayStatus;
  tooltip: string;
  /** What the HOST reported: whether an icon exists in the menu bar now. */
  installed: boolean;
}

/**
 * Derive the tray status from a session snapshot and publish it.
 *
 * The derivation is `deriveTrayStatus`'s, unchanged — this file adds no opinion of its own about
 * which state may render as "listening", because that mapping is the privacy surface and it has
 * exactly one implementation on purpose.
 */
export async function syncTray(
  inputs: TrayInputs,
  backend: TrayBackend = defaultTrayBackend(),
): Promise<TraySyncResult> {
  const status = deriveTrayStatus(inputs);
  const installed = await backend.sync(status);
  return { status, tooltip: trayTooltip(status), installed };
}
