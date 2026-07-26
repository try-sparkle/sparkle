// "Is the user MID-SENTENCE somewhere else right now?" — the guard every automatic focus grab
// must pass.
//
// The concierge box is the app's only compose surface (CM-U7), but the visible agent pane still
// takes the caret when its PTY comes up so the terminal is usable directly. `ptyReady` flips
// ASYNCHRONOUSLY after spawn, so without a guard an agent finishing its start-up steals the caret
// out of a half-typed concierge message.
//
// The guard is "is there UNSENT TEXT in the focused field", NOT "is any field focused". The
// concierge box holding focus with nothing in it is the app's steady state — a bare focus check
// would mean the terminal never takes the caret again after the user's first click into the box,
// silently ending "the terminal is the input surface for anyone who wants to type directly".
//
// Pure + DOM-argument-injectable so it's testable without a browser.

/** Caret-less <input> types: these are buttons/toggles wearing an input tag. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "hidden",
]);

/** Element types that own a caret the user can type into RIGHT NOW: text inputs and textareas that
 *  are neither disabled nor readonly, plus anything contenteditable. */
export function isEditableElement(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    if (field.disabled || field.readOnly) return false;
    if (tag === "INPUT" && NON_TEXT_INPUT_TYPES.has((field as HTMLInputElement).type)) return false;
    return true;
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** The text currently sitting in an editable element ("" when it isn't one). */
function editableText(el: Element | null | undefined): string {
  if (!isEditableElement(el)) return "";
  const tag = el!.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") {
    return (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
  }
  return (el as HTMLElement).textContent ?? "";
}

/** True when the document's focus sits in an editable element. */
export function isEditableFocused(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): boolean {
  return isEditableElement(doc?.activeElement);
}

/**
 * True when the focused element is editable AND holds unsent text — i.e. the user is mid-message
 * and moving the caret away would lose their place. An empty focused box does NOT count, so the
 * terminal still takes the caret in the ordinary case. Safe outside a DOM.
 */
export function isTypingInProgress(
  doc: Document | undefined = typeof document !== "undefined" ? document : undefined,
): boolean {
  return editableText(doc?.activeElement).trim() !== "";
}
