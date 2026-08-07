// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  describeFocusTarget,
  installInputFreezeTrace,
  isTextKeystroke,
  micPhaseLabel,
  traceGates,
} from "./inputFreezeTrace";
import { log } from "../logger";
import type { Phase } from "../voice/dictationPhase";

/** The mic hot AND routing speech. */
const ACTIVE = () => ({ enabled: true, active: true });
/** The mic hot but PAUSED — the state a user lands in the moment they react to the freeze. */
const PAUSED = () => ({ enabled: true, active: false });
/** Mic off. */
const OFF = () => ({ enabled: false, active: false });

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
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((log.warn as any).mock.calls[0][1]).toContain("NON-editable");
    uninstall();
  });

  it("does NOT warn for a keydown on an editable target", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });

  // REPLACES an "is inert while dictation is disabled" test that asserted the OPPOSITE of this.
  // That gate is the bug this commit removes (bead sparkle-thm9o): during the founder's app-wide
  // freeze the trace wrote nothing, and the log could not distinguish "keystrokes never reached the
  // webview" from "the mic happened to be off, so the arm was gated out". The old assertion was
  // pinning exactly the ambiguity, so it is UPDATED deliberately rather than deleted — the
  // focus-stream half of its claim survives below, because only the keydown arm changes.
  it("STILL records the keydown fingerprint when the mic is OFF (the gap that made a freeze unreadable)", () => {
    const uninstall = installInputFreezeTrace({ dictationState: OFF });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((log.warn as any).mock.calls[0][1]).toContain("NON-editable");
    uninstall();
  });

  // The three-valued label is what makes the un-gated arm READABLE: "off" says the mic was muted
  // AND the trace still ran, so a silent log can never again be blamed on the gate. Reporting the
  // mic-off case as "passive" would resurrect the false claim roborev 54719 removed.
  it("labels the mic-off case as micPhase=off, distinctly from paused", () => {
    const uninstall = installInputFreezeTrace({ dictationState: OFF });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect((log.warn as any).mock.calls[0][1]).toContain("micPhase=off");
    uninstall();
  });

  // Un-gating the keydown arm must NOT widen the focus stream — that gate is the volume fix
  // (roborev 54719) and is the half of the old "inert while disabled" test that still holds.
  it("does NOT stream focus transitions while the mic is off", () => {
    const uninstall = installInputFreezeTrace({ dictationState: OFF });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
    uninstall();
  });

  // The filter and the throttle are what stopped the unbounded WARN stream (roborev 56020/56006).
  // Removing the mic gate widens WHEN the arm runs, so both bounds now carry the whole load — and
  // with the mic off is exactly the configuration in which nothing else would catch a regression.
  it("still applies the text-keystroke filter and the 1/s throttle with the mic off", () => {
    let t = 0;
    const uninstall = installInputFreezeTrace({ dictationState: OFF, now: () => t });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled(); // filtered, not throttled
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    t = 999;
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "b", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1); // second one throttled
    t = 1000;
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(2);
    uninstall();
  });

  // A keystroke landing on a caret-less control IS the freeze fingerprint — the key went nowhere
  // typable. The trace used its own copy of the editable predicate that answered `true` for every
  // `<input>`, so the one case a settings screen actually produces was silently never reported
  // (roborev 54719).
  it("warns for a keydown on a caret-less input[type=checkbox]", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    uninstall();
  });

  // Must stay at INFO. `debugForwardEnabled` defaults to DEV-only and nothing in the app calls
  // `setDebugForwarding`, so a `debug` line never reaches disk in a shipped build — demoting this
  // deletes the signal rather than deferring it. A real user's `focus-trace: activeElement=textarea
  // .xterm-helper-textarea` in ~/Library/Logs is what proved the terminal case (roborev 56006).
  it("records focus transitions at INFO so they reach a shipped build's log file", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(log.info).toHaveBeenCalledTimes(1);
    expect((log.info as any).mock.calls[0][1]).toContain("activeElement=");
    uninstall();
  });

  // The old warn asserted "mic live" off a flag that is really the persisted master-mute, so a
  // merely-hot-but-paused mic produced a false claim in the one log line meant to pin the freeze.
  it("does not claim the mic is live in the warn text", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect((log.warn as any).mock.calls[0][1]).not.toContain("mic live");
    uninstall();
  });
});

// The freeze is "recoverable only by restart" — it OUTLIVES the segment that caused it. Clicking the
// mic from active to passive is the first thing a user does when the keyboard goes dead, so a
// fingerprint gated on `active` would go silent at exactly the moment they react (roborev 56006).
describe("installInputFreezeTrace — the two gates are deliberately different", () => {
  it("STILL records the keydown fingerprint when the mic is hot but PAUSED", () => {
    const uninstall = installInputFreezeTrace({ dictationState: PAUSED });
    const div = document.createElement("div");
    document.body.appendChild(div);

    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((log.warn as any).mock.calls[0][1]).toContain("micPhase=passive");
    uninstall();
  });

  it("does NOT stream focus transitions while merely paused (that is the volume fix)", () => {
    const uninstall = installInputFreezeTrace({ dictationState: PAUSED });
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(log.info).not.toHaveBeenCalled();
    uninstall();
  });

  it("labels the phase as active when it is", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);

    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    expect((log.warn as any).mock.calls[0][1]).toContain("micPhase=active");
    uninstall();
  });
});

// The derivation itself, not just its consumer. Left inline at the single App.tsx call site this was
// pinned by nothing: reverting it to bare `enabled` kept the whole suite green (roborev 56006).
//
// The inputs are typed against the store's own `Phase` union rather than bare strings, so renaming
// or extending the phase vocabulary ("active" -> "listening") is a COMPILE ERROR here instead of a
// silent `active: false` forever with a green suite (roborev 56020). `satisfies` keeps the literals
// readable while still type-checking them.
type StorePhaseSlice = { enabled: boolean; phase: Phase };

describe("traceGates", () => {
  it("routes only when the mic is hot AND the phase is active", () => {
    const s = { enabled: true, phase: "active" } satisfies StorePhaseSlice;
    expect(traceGates(s)).toEqual({ enabled: true, active: true });
  });

  it("is hot-but-not-routing while paused", () => {
    const s = { enabled: true, phase: "passive" } satisfies StorePhaseSlice;
    expect(traceGates(s)).toEqual({ enabled: true, active: false });
  });

  it("is fully off when the mic is off, whatever the persisted phase says", () => {
    const on = { enabled: false, phase: "active" } satisfies StorePhaseSlice;
    const off = { enabled: false, phase: "passive" } satisfies StorePhaseSlice;
    expect(traceGates(on)).toEqual({ enabled: false, active: false });
    expect(traceGates(off)).toEqual({ enabled: false, active: false });
  });
});

// `micPhase` is now THREE-valued. The keydown arm runs unconditionally, so the mic state stopped
// being a precondition of the line and became a FIELD of it — which is the whole diagnostic gain:
// the reader can tell "the mic was off" from "the trace did not run".
describe("micPhaseLabel", () => {
  it("is 'active' only while speech is actually routing", () => {
    expect(micPhaseLabel({ enabled: true, active: true })).toBe("active");
  });

  it("is 'passive' when the mic is hot but paused", () => {
    expect(micPhaseLabel({ enabled: true, active: false })).toBe("passive");
  });

  it("is 'off' when the master mute is on — NOT 'passive'", () => {
    expect(micPhaseLabel({ enabled: false, active: false })).toBe("off");
  });

  it("reports 'off' even if a stale `active` says otherwise (master mute wins)", () => {
    expect(micPhaseLabel({ enabled: false, active: true })).toBe("off");
  });
});

// `defaultPrevented=false` was the ONE useful field the trace produced during the real freeze: it
// tells a stuck global capture handler (true) apart from plain focus loss (false). Nothing asserted
// it, so it could have been dropped in this un-gating with the suite green.
describe("installInputFreezeTrace — defaultPrevented is the capture-vs-focus-loss discriminator", () => {
  it("reports defaultPrevented=false when no handler consumed the key", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect((log.warn as any).mock.calls[0][1]).toContain("defaultPrevented=false");
    uninstall();
  });

  it("reports defaultPrevented=true when a handler already consumed the key", () => {
    // A capture listener that swallows the key BEFORE ours — the "stuck global handler" shape.
    // Registered on window/capture and BEFORE the install, since same-target same-phase listeners
    // run in registration order and there is no earlier point in the propagation path than this.
    const eat = (e: Event) => e.preventDefault();
    window.addEventListener("keydown", eat, true);
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    window.removeEventListener("keydown", eat, true);
    expect((log.warn as any).mock.calls[0][1]).toContain("defaultPrevented=true");
    uninstall();
  });
});

// Only a keystroke that should have PRODUCED TEXT is the freeze fingerprint. A key merely reaching a
// non-editable element is ordinary — that is most of normal keyboard use — and warning on all of it
// meant an unbounded WARN stream, forever, for anyone who had ever switched the mic on (roborev
// 56020).
describe("isTextKeystroke", () => {
  it("accepts an ordinary character", () => {
    expect(isTextKeystroke({ key: "a", metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
  });

  it.each(["Escape", "Tab", "ArrowLeft", "Enter", "Backspace", "F5", "Shift"])(
    "rejects the navigation/control key %s",
    (key) => {
      expect(isTextKeystroke({ key, metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
    },
  );

  it.each([
    ["meta", { key: "k", metaKey: true, ctrlKey: false, altKey: false }],
    ["ctrl", { key: "c", metaKey: false, ctrlKey: true, altKey: false }],
    ["alt", { key: "n", metaKey: false, ctrlKey: false, altKey: true }],
  ])("rejects a %s-modified shortcut", (_l, e) => {
    expect(isTextKeystroke(e)).toBe(false);
  });

  it("rejects Space — it ACTIVATES a focused button, the one printable key with a routine non-editable home", () => {
    expect(isTextKeystroke({ key: " ", metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});

describe("installInputFreezeTrace — only text keystrokes are the fingerprint", () => {
  it.each(["Escape", "Tab", "ArrowDown"])("does NOT warn for %s on a non-editable target", (key) => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });

  it("does NOT warn for a Cmd-shortcut on a non-editable target", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const div = document.createElement("div");
    document.body.appendChild(div);
    div.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });

  it("does NOT warn for Space activating a focused button", () => {
    const uninstall = installInputFreezeTrace({ dictationState: ACTIVE });
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(log.warn).not.toHaveBeenCalled();
    uninstall();
  });
});
