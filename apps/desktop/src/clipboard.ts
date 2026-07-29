/**
 * Copy text to the system clipboard. Prefers the async Clipboard API (available in the
 * Tauri webview under a user gesture); falls back to a hidden-textarea execCommand for
 * environments where the async API is blocked. Returns whether the copy succeeded.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    // Selecting the temp textarea steals focus from whatever's active; remember it so we can
    // hand focus straight back after copying.
    const prevActive = document.activeElement as HTMLElement | null;
    // …and it steals the SELECTION too, which matters more.
    //
    // `ta.select()` replaces the document selection, and removing the textarea leaves it collapsed,
    // so this path ends with nothing highlighted. That is invisible when the caller is a copy
    // BUTTON — there was no selection to lose — but copy-on-selection and the terminal's
    // copy-on-select are gestures whose whole subject IS the highlight: the user drags across an
    // answer, releases, and watches their selection disappear at the instant it was copied. Reads
    // as "it didn't take", so they do it again.
    //
    // Snapshot the ranges before the steal and put them back after. Cloned, because the live Range
    // objects are mutated by the selection changes below.
    const sel = window.getSelection();
    const ranges: Range[] = [];
    if (sel) {
      for (let i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    // THE UNDO IS IN A `finally`, because the throw is not hypothetical here. `execCommand` raises
    // a SecurityError in a hardened webview and a TypeError where it has been removed outright —
    // and that is the SAME class of environment whose missing `navigator.clipboard` sent us down
    // this path to begin with, so the failure mode and the reason we are here share a cause.
    //
    // On the happy path only, a throw would leave the hidden textarea in the DOM holding the copied
    // text, still holding FOCUS — so the user's next keystrokes go into an invisible offscreen box
    // instead of the composer — with the selection sitting on it, and one more leaks per attempt.
    // Worse than the bug the restore was added to fix.
    try {
      ta.focus();
      ta.select();
      return document.execCommand("copy");
    } finally {
      ta.remove();
      prevActive?.focus?.();
      // AFTER the focus restore, not before: focusing a text input sets that input's own selection,
      // which would undo the restore we just made.
      if (sel && ranges.length) {
        sel.removeAllRanges();
        for (const r of ranges) sel.addRange(r);
      }
    }
  } catch {
    return false;
  }
}
