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
    const uninstall = installInputFreezeTrace({ isDictationEnabled: () => true });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((log.warn as any).mock.calls[0][1]).toContain("NON-editable");
    uninstall();
  });

  it("does NOT warn for a keydown on an editable target", () => {
    const uninstall = installInputFreezeTrace({ isDictationEnabled: () => true });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });

  it("is inert while dictation is disabled", () => {
    const uninstall = installInputFreezeTrace({ isDictationEnabled: () => false });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    uninstall();
  });
});
