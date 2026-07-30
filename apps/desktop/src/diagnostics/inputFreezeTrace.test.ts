// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { describeFocusTarget, installInputFreezeTrace } from "./inputFreezeTrace";
import { log } from "../logger";

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("describeFocusTarget — PII-safe structural descriptor", () => {
  it("never leaks the field's value or textContent", () => {
    const ta = document.createElement("textarea");
    ta.id = "compose";
    ta.className = "composer-input xterm-helper-textarea";
    ta.value = "my secret password 12345";
    ta.setAttribute("data-testid", "agent-composer");
    document.body.appendChild(ta);
    const d = describeFocusTarget(ta);
    expect(d).toContain("textarea#compose");
    expect(d).toContain("testid=agent-composer");
    expect(d).toContain("xterm-helper-textarea");
    // The value must NEVER appear.
    expect(d).not.toContain("secret");
    expect(d).not.toContain("password");
  });

  it("returns 'none' for null", () => {
    expect(describeFocusTarget(null)).toBe("none");
  });

  it("marks contentEditable hosts", () => {
    const div = document.createElement("div");
    Object.defineProperty(div, "isContentEditable", { value: true });
    expect(describeFocusTarget(div)).toContain("[ce]");
  });
});

describe("installInputFreezeTrace", () => {
  it("warns when a keydown while the mic is live reaches a NON-editable target (the freeze fingerprint)", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => true });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((log.warn as any).mock.calls[0][1]).toContain("NON-editable");
    uninstall();
  });

  it("does NOT warn for a keydown on an editable target", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => true });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });

  it("is inert while dictation is disabled", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => false });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
    uninstall();
  });

  // A keystroke landing on a caret-less control IS the freeze fingerprint — the key went nowhere
  // typable. The trace used its own copy of the editable predicate that answered `true` for every
  // `<input>`, so the one case a settings screen actually produces was silently never reported
  // (roborev 54719).
  it("warns for a keydown on a caret-less input[type=checkbox]", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => true });
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    uninstall();
  });

  // `log.info` ALWAYS forwards to disk via `frontend_log`; only `log.debug` is gated behind
  // `debugForwardEnabled`. focusin fires on every click onto any focusable element, so an `info`
  // line per transition is an unthrottled per-event disk write for every user who has ever turned
  // the mic on (roborev 54719).
  it("records focus transitions at DEBUG, never at info (info always forwards to disk)", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => true });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(log.debug).toHaveBeenCalledTimes(1);
    expect((log.debug as any).mock.calls[0][1]).toContain("activeElement=");
    expect(log.info).not.toHaveBeenCalled();
    uninstall();
  });

  // The old warn asserted "mic live" off a flag that is really the persisted master-mute, so a
  // merely-hot-but-paused mic produced a false claim in the one log line meant to pin the freeze.
  it("does not claim the mic is live in the warn text", () => {
    const uninstall = installInputFreezeTrace({ isDictationActive: () => true });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect((log.warn as any).mock.calls[0][1]).not.toContain("mic live");
    uninstall();
  });
});
