// Show a "give Claude vision by enabling AI Features" hint pill when the user drags an IMAGE
// onto the terminal WHILE the AI composer is off (spec: 2026-07-02-terminal-drag-hint). With the
// composer on, Composer.tsx already handles image drops as attachments — this listener must NOT
// double-handle, so it only subscribes when `enabled` (i.e. `!aiComposer`) is true.
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
 * off (the composer coming on) tears the listener down and hides any showing pill.
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
