// Show a "give Claude vision" hint pill when the user drags an IMAGE onto the terminal
// (spec: 2026-07-02-terminal-drag-hint).
//
// `enabled` used to mean "the AI composer is off", because with it on, Composer.tsx handled image
// drops itself and this listener must not double-handle. CM-U7 deleted that composer, so the
// caller now passes simply "this pane is VISIBLE" — the pill is informational (NO surface accepts
// an image yet), so there is no entitlement to gate it on. See AgentPane and the pill's header.
//
// Like useNewBuildAgentDrop this is a webview-level onDragDropEvent listener; Tauri fans events to
// every listener, so it coexists with the others. It stays passive: it never consumes the drop or
// spawns anything — it only flips a `show` flag the caller renders the pill from.
import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isImagePath } from "../components/composer/attachments";
import { safeUnlisten } from "../services/safeUnlisten";
import { log } from "../logger";

/** True when a Tauri drag/drop payload carries at least one image file path. `over` events carry
 *  no paths in Tauri v2 (only `enter`/`drop` do), so this is naturally a no-op for them. Pure so
 *  the image-filter can be unit-tested without a webview. */
export function dragPayloadHasImage(payload: { paths?: string[] }): boolean {
  return (payload.paths ?? []).some(isImagePath);
}

/**
 * Subscribe (only while `enabled`) to webview drag/drop and reveal the vision hint the first time
 * an image drag arrives. Returns `{ show, dismiss }`; the caller renders the pill on `show` and
 * clears it via `dismiss` (×, Esc, an action click, or the pill's auto-timeout). Turning `enabled`
 * off tears the listener down and hides any showing pill.
 */
export function useDragVisionHint(enabled: boolean): { show: boolean; dismiss: () => void } {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setShow(false);
      return;
    }
    const unlistenPromise = getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        // Only `enter` and `drop` carry file paths in Tauri v2 (`over` is position-only), so those
        // are the two that can tell us an image is being dragged.
        if (p.type === "enter" || p.type === "drop") {
          if (dragPayloadHasImage(p)) setShow(true);
        }
      })
      .catch((e) => {
        // A failed listen has no unlisten fn to return; log and let cleanup no-op.
        log.error("composer", "drag-vision-hint listen failed", e);
        return undefined;
      });
    return () => {
      setShow(false);
      // safeUnlisten awaits the listen() promise so a handler that resolves AFTER unmount is still
      // torn down (and the Tauri teardown race is swallowed).
      void safeUnlisten(unlistenPromise);
    };
  }, [enabled]);
  return { show, dismiss: () => setShow(false) };
}
