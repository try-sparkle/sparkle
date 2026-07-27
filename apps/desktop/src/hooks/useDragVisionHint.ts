// Show a "give Claude vision" hint pill when the user drags an IMAGE onto the terminal — and ONLY
// the terminal (spec: 2026-07-02-terminal-drag-hint).
//
// HIT-TESTED, because the pill's copy is an instruction: it says "drop it on the Sparkle box
// instead". Without a hit-test this listener fired on any image drag anywhere in the window, so a
// user who FOLLOWED that instruction got the file correctly attached AND the pill popped up again
// over the terminal telling them to do what they had just done (roborev 46911). Every sibling drag
// listener (useConciergeAttachments, useNewBuildAgentDrop) hit-tests; this one now does too, and a
// drop that lands on a real target clears the pill rather than leaving it up for the full 8s.
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
import { isOverFileDropTarget } from "../services/dndTargets";
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
    // Does the drag currently crossing the window carry an image? LATCHED on `enter`, because
    // only `enter` and `drop` carry paths in Tauri v2 — the `over` events that follow are
    // position-only. Without the latch there is nothing to hit-test the approach with, and
    // "the pill clears when the drag reaches the box" is unreachable: the OS sends exactly one
    // `enter` per webview, so a drag that came in over the terminal and then moves onto the
    // compose box never produces a second one (roborev 52362/52363).
    let dragCarriesImage = false;
    const unlistenPromise = getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          dragCarriesImage = false;
          return;
        }
        if (p.type === "enter") dragCarriesImage = dragPayloadHasImage(p);
        // `drop` carries paths too, and is authoritative for what actually landed.
        const carriesImage =
          p.type === "drop" ? dragCarriesImage || dragPayloadHasImage(p) : dragCarriesImage;
        if (p.type === "drop") dragCarriesImage = false;
        if (!carriesImage) return;
        // Over a surface that actually takes the file (services/dndTargets.FILE_DROP_TARGETS) the
        // hint is simply wrong: the drop is about to work, and the pill would be telling the user
        // to do what they are already doing. Clearing on `over` is what makes following its advice
        // dismiss it DURING the approach instead of after the drop.
        if (isOverFileDropTarget(p.position)) {
          setShow(false);
          return;
        }
        // Raising the pill stays an enter/drop decision: an `over` that merely wanders back off
        // the box must not re-raise a pill the user has watched disappear.
        if (p.type === "enter" || p.type === "drop") setShow(true);
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
