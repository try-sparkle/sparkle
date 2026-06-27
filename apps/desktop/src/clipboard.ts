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
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    prevActive?.focus?.();
    return ok;
  } catch {
    return false;
  }
}
