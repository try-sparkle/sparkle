// Diagnostics for the "can't type in ANY box while dictation is live" freeze (bead sparkle-d2ec).
// The app logs no first-responder / keyboard-focus transitions, so a recurrence could not be pinned
// from logs. This records — PII-SAFELY — the two signals that were missing: which element holds the
// DOM caret (the first responder within the webview), and whether keystrokes are actually reaching
// an editable target while the mic is live. It NEVER logs key values or field contents.

import { isEditableElement } from "../engine/focusGuard";
import { log } from "../logger";

/** A PII-safe descriptor of a focus/event target: STRUCTURAL identity only — tag, id, filtered
 *  class tokens, data-testid, role, contentEditable. NEVER value or textContent. Pure, so the
 *  no-PII guarantee is unit-assertable. */
export function describeFocusTarget(el: Element | null | undefined): string {
  if (!el) return "none";
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const testid = el.getAttribute?.("data-testid");
  const role = el.getAttribute?.("role");
  const editable = (el as HTMLElement).isContentEditable ? " [ce]" : "";
  // Class tokens can carry structural hints (e.g. "xterm-helper-textarea"). Include up to 3 short,
  // non-numeric tokens; drop long or digit-heavy tokens that could be hashed/identifying.
  const cls =
    typeof el.className === "string"
      ? el.className
          .split(/\s+/)
          .filter((c) => c && c.length <= 24 && !/\d{3,}/.test(c))
          .slice(0, 3)
      : [];
  return [
    tag + id,
    testid ? `testid=${testid}` : "",
    role ? `role=${role}` : "",
    cls.length ? `.${cls.join(".")}` : "",
  ]
    .filter(Boolean)
    .join(" ") + editable;
}

export interface InputFreezeTraceDeps {
  /** True only while speech is ACTUALLY being routed into a box — `enabled && phase === "active"`.
   *
   *  Deliberately not bare `enabled`: that flag is the master mute ("mic hot"), it is PERSISTED
   *  across relaunch, and it is true for a merely-hot-but-paused mic. Gating on it meant every user
   *  who had ever turned dictation on kept tracing forever, and made the keydown warning assert a
   *  live mic when nothing was listening (roborev 54719). Only the `active` phase can drive the
   *  focus pull this trace exists to catch. */
  isDictationActive: () => boolean;
  doc?: Document;
  win?: Window;
  now?: () => number;
}

/** Install the trace; returns an uninstall fn. While dictation is enabled:
 *   - logs DOM focus transitions (focusin) — the webview's first responder moving; and
 *   - logs (throttled to 1/s) any keydown whose target is NOT editable — the freeze fingerprint: a
 *     key that reaches no text field while the mic is live. `defaultPrevented` is included so a
 *     stuck global capture that swallowed the key upstream is distinguishable from plain focus loss. */
export function installInputFreezeTrace(deps: InputFreezeTraceDeps): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const now = deps.now ?? (() => Date.now());
  let lastFocus = "";
  let lastNonEditableLogAt = 0;

  const onFocusIn = () => {
    if (!deps.isDictationActive()) return;
    const d = describeFocusTarget(doc.activeElement);
    if (d !== lastFocus) {
      lastFocus = d;
      // DEBUG, not info: `log.info` always forwards to disk via `frontend_log`, and focusin fires
      // for every click or tab onto any focusable element — an unthrottled per-event disk write and
      // main-thread JSON render, which is exactly the cost `debugForwardEnabled` exists to gate
      // (roborev 54719). Still capturable on demand via `setDebugForwarding(true)`.
      log.debug("dictation", `focus-trace: activeElement=${d}`);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!deps.isDictationActive()) return;
    if (isEditableElement(e.target as Element)) return;
    const t = now();
    if (t - lastNonEditableLogAt < 1000) return; // throttle: at most one line per second
    lastNonEditableLogAt = t;
    // Says what it OBSERVED (dictation actively routing) rather than asserting "mic live", which
    // the old gate could not actually know — see `isDictationActive`.
    log.warn(
      "dictation",
      `focus-trace: keydown while dictation ACTIVE reached NON-editable target=${describeFocusTarget(
        e.target as Element,
      )} defaultPrevented=${e.defaultPrevented} activeElement=${describeFocusTarget(doc.activeElement)}`,
    );
  };

  doc.addEventListener("focusin", onFocusIn, true);
  win.addEventListener("keydown", onKeyDown, true);
  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    win.removeEventListener("keydown", onKeyDown, true);
  };
}
