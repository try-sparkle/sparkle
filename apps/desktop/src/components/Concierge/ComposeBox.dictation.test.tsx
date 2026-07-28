// @vitest-environment jsdom
//
// The compose box half of the voice pass: the full dictation lifecycle the box is responsible for
// — register a target, paint live partials, commit finished segments into the text, stop — plus
// the invariant that the un-committed preview can never be sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDictated, ComposeBox } from "./ComposeBox";
import { useDictationStore } from "../../stores/dictationStore";
import {
  focusQuietly,
  resetProgrammaticFocusForTest,
} from "../../services/programmaticFocus";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => {
  cleanup();
  resetProgrammaticFocusForTest(); // module state outlives a component tree
});

type Append = (text: string) => void;

function setup(over: { interim?: string } = {}) {
  const onSend = vi.fn();
  const onAttach = vi.fn();
  // A STABLE identity, as the box requires: an unstable one would re-register every render.
  const seen: (Append | null)[] = [];
  const registerInsert = (fn: Append | null) => {
    seen.push(fn);
  };
  const view = render(
    <ComposeBox
      onSend={onSend}
      onAttach={onAttach}
      registerInsert={registerInsert}
      {...over}
    />,
  );
  // A committed segment arrives from a Tauri event, i.e. outside React, so drive it through act.
  const dictate = (segment: string) => {
    const append = seen.filter((f): f is Append => f !== null).at(-1);
    if (!append) throw new Error("no insert target registered");
    act(() => append(segment));
  };
  return { onSend, onAttach, seen, dictate, view };
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const interimNode = () => screen.queryByTestId("concierge-interim");

describe("appendDictated", () => {
  it("fills an empty box with the trimmed segment", () => {
    expect(appendDictated("", "  approve the deploy ")).toBe("approve the deploy");
  });

  it("space-separates a follow-on segment", () => {
    expect(appendDictated("approve the deploy", "then ship it")).toBe(
      "approve the deploy then ship it",
    );
  });

  it("never double-spaces after text the user left a trailing space on", () => {
    expect(appendDictated("approve ", "the deploy")).toBe("approve the deploy");
  });

  it("an empty segment leaves the box exactly as it was", () => {
    expect(appendDictated("approve", "   ")).toBe("approve");
  });
});

describe("ComposeBox — dictation lifecycle", () => {
  it("START: registers an insert target while mounted", () => {
    const { seen } = setup();
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("function");
  });

  it("PARTIAL: the live transcript renders outside the textarea and leaves the text alone", () => {
    setup({ interim: "approve the dep" });
    expect(interimNode()?.textContent).toBe("approve the dep");
    expect(box().value).toBe("");
  });

  it("PARTIAL: no interim means no ghost row at all", () => {
    setup();
    expect(interimNode()).toBeNull();
  });

  it("COMMIT: a finished segment lands in the textarea", () => {
    const { dictate } = setup();
    dictate("approve the deploy");
    expect(box().value).toBe("approve the deploy");
  });

  it("COMMIT: successive segments accumulate, space-separated", () => {
    const { dictate } = setup();
    dictate("approve the deploy");
    dictate("then tell me what broke");
    expect(box().value).toBe("approve the deploy then tell me what broke");
  });

  it("COMMIT: dictated text appends to what the user already typed", () => {
    const { dictate } = setup();
    fireEvent.change(box(), { target: { value: "hey" } });
    dictate("approve it");
    expect(box().value).toBe("hey approve it");
  });

  it("COMMIT: dictated text is editable and sendable exactly like typed text", () => {
    const { dictate, onSend } = setup();
    dictate("approve the deploy");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("approve the deploy");
    expect(box().value).toBe("");
  });

  it("the un-committed preview is NEVER submitted", () => {
    const { onSend } = setup({ interim: "half a phra" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("STOP: unmounting hands the target back (registers null)", () => {
    const { seen, view } = setup();
    view.unmount();
    expect(seen.at(-1)).toBeNull();
  });

  // The box's own mic button is gone — the column's single mic is the header ring, and the box is
  // now a pure dictation SINK: it registers a target and paints what arrives, with no control of
  // its own. Who is allowed to send it speech is decided in useConciergeDictation (see its tests);
  // that the column shows exactly one mic is pinned in ConciergeColumn.oneMic.test.tsx.
  it("without registerInsert the box behaves exactly as the text-only version did", () => {
    const onSend = vi.fn();
    render(<ComposeBox onSend={onSend} onAttach={vi.fn()} />);
    const only = screen.getAllByRole("textbox", { name: "Message" }).at(-1)!;
    fireEvent.change(only, { target: { value: "typed" } });
    fireEvent.keyDown(only, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("typed");
  });
});

// The MIRROR of Composer's surface claim (Composer.dictation.test.tsx, "naming the voice surface").
// Without this side, the arbiter is one-way: once the user's cursor has been in an agent composer,
// only the header ring brings dictation back, so clicking into THIS box and speaking would send
// every segment to a composer in another column while the caret blinks here.
describe("ComposeBox — naming the voice surface", () => {
  const ta = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

  it("the USER focusing it aims dictation at the concierge", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    fireEvent.focus(ta());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("TYPING in it aims dictation here too", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    fireEvent.keyDown(ta(), { key: "a" });
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("TAB-navigating in counts — no pointer or keystroke lands on the box itself", () => {
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().focus());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("CLICKING a box the app already focused still aims here", () => {
    // The mirror of the agent side's guard: a click on an ALREADY-FOCUSED textarea fires no focus
    // event, so a focus-only claim would leave the mic pointed at the other column while the caret
    // blinks in this one (roborev 54245).
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => focusQuietly(ta()));
    expect(useDictationStore.getState().voiceSurface).toBe("agent"); // the app's focus moved nothing

    fireEvent.pointerDown(ta()); // …and now the user clicks in

    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("requestComposeFocus aims dictation here — the caret the USER asked for", () => {
    // The seam behind the drop pill's "go to compose", a file drop, spawning an agent, and the
    // capture-window handoff. The focus itself is quiet, like every focus the app performs; what
    // makes dictation follow is that the effect NAMES the concierge outright, because reaching it
    // at all means a user gesture asked for this box (roborev 54259).
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().blur());

    act(() => useUiStore.getState().requestComposeFocus());

    expect(document.activeElement).toBe(ta());
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("…and even when the caret is ALREADY here, so no focus event fires at all", () => {
    // The load-bearing half of naming the surface in the effect rather than inferring it from the
    // focus event: dropping files on the terminal, or clicking the drop pill's "go to compose",
    // while the caret is already in this box focuses nothing — .focus() on the focused element
    // dispatches no event (roborev 54265). Without the effect's own claim this silently does
    // nothing, and the words keep going to the other column.
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => ta().focus()); // the caret is already here
    useDictationStore.setState({ voiceSurface: "agent" }); // …and that focus already had its say
    let focusEvents = 0;
    ta().addEventListener("focus", () => { focusEvents += 1; });

    act(() => useUiStore.getState().requestComposeFocus());

    expect(focusEvents).toBe(0); // nothing to infer from
    expect(useDictationStore.getState().voiceSurface).toBe("concierge");
  });

  it("PROGRAMMATIC focus does not re-aim it", () => {
    // Symmetrical to the agent side: this box is focused by code too — after a send, and on a
    // handoff from the capture window — and neither is a statement about where speech should go.
    useDictationStore.setState({ voiceSurface: "agent" });
    setup();
    act(() => focusQuietly(ta()));
    expect(useDictationStore.getState().voiceSurface).toBe("agent");
  });
});
