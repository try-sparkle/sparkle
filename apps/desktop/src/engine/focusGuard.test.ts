// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isEditableElement, isEditableFocused, isTypingInProgress } from "./focusGuard";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

describe("isEditableElement", () => {
  it("counts a textarea (the concierge compose box)", () => {
    expect(isEditableElement(mount("<textarea></textarea>"))).toBe(true);
  });

  it("counts a text input", () => {
    expect(isEditableElement(mount('<input type="text" />'))).toBe(true);
  });

  it("counts an input with no explicit type (defaults to text)", () => {
    expect(isEditableElement(mount("<input />"))).toBe(true);
  });

  it("does NOT count caret-less input types", () => {
    for (const type of ["button", "checkbox", "radio", "submit"]) {
      expect(isEditableElement(mount(`<input type="${type}" />`))).toBe(false);
    }
  });

  it("does NOT count a button or a plain div", () => {
    expect(isEditableElement(mount("<button>Send</button>"))).toBe(false);
    expect(isEditableElement(mount("<div>text</div>"))).toBe(false);
  });

  it("counts a contenteditable element", () => {
    const el = mount("<div>rich</div>");
    Object.defineProperty(el, "isContentEditable", { value: true });
    expect(isEditableElement(el)).toBe(true);
  });

  it("is false for null/undefined", () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
  });
});

describe("isEditableFocused", () => {
  it("is true while the caret sits in a textarea", () => {
    const ta = mount("<textarea></textarea>") as HTMLTextAreaElement;
    ta.focus();
    expect(isEditableFocused()).toBe(true);
  });

  it("is false when focus is on the body / a button", () => {
    const btn = mount("<button>Go</button>");
    btn.focus();
    expect(isEditableFocused()).toBe(false);
  });

  it("is false with no document at all (non-DOM contexts)", () => {
    expect(isEditableFocused(undefined)).toBe(false);
  });
});

// The guard the pane's focus grab actually uses. "Any editable focused" would be too broad: the
// concierge box holding focus with nothing in it is the app's STEADY STATE, and blocking on that
// would mean the terminal never takes the caret again after the user's first click into the box.
describe("isTypingInProgress", () => {
  it("is FALSE for a focused but EMPTY box — the terminal still gets the caret", () => {
    const ta = mount("<textarea></textarea>") as HTMLTextAreaElement;
    ta.focus();
    expect(isTypingInProgress()).toBe(false);
    // …even though the box IS focused — that's exactly the distinction this guard draws.
    expect(isEditableFocused()).toBe(true);
  });

  it("is TRUE once there's unsent text (don't yank a half-typed message)", () => {
    const ta = mount("<textarea></textarea>") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "rebase onto main and";
    expect(isTypingInProgress()).toBe(true);
  });

  it("treats whitespace-only as empty", () => {
    const ta = mount("<textarea></textarea>") as HTMLTextAreaElement;
    ta.focus();
    ta.value = "   \n ";
    expect(isTypingInProgress()).toBe(false);
  });

  it("covers a text input with a value", () => {
    const input = mount('<input type="text" />') as HTMLInputElement;
    input.focus();
    input.value = "half typed";
    expect(isTypingInProgress()).toBe(true);
  });

  it("ignores a disabled or readonly field (nothing is being typed there)", () => {
    const ro = mount('<input type="text" readonly value="fixed" />') as HTMLInputElement;
    ro.focus();
    expect(isTypingInProgress()).toBe(false);
    expect(isEditableElement(ro)).toBe(false);
  });

  it("is false when focus is on a button, or outside a DOM entirely", () => {
    mount("<button>Go</button>").focus();
    expect(isTypingInProgress()).toBe(false);
    expect(isTypingInProgress(undefined)).toBe(false);
  });
});
