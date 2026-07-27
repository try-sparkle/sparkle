// @vitest-environment jsdom
//
// The compose box half of the voice pass: the full dictation lifecycle the box is responsible for
// — register a target, paint live partials, commit finished segments into the text, stop — plus
// the invariant that the un-committed preview can never be sent.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDictated, ComposeBox } from "./ComposeBox";

afterEach(() => cleanup());

type Append = (text: string) => void;

function setup(over: { micLive?: boolean; interim?: string } = {}) {
  const onSend = vi.fn();
  const onMicToggle = vi.fn();
  const onAttach = vi.fn();
  // A STABLE identity, as the box requires: an unstable one would re-register every render.
  const seen: (Append | null)[] = [];
  const registerInsert = (fn: Append | null) => {
    seen.push(fn);
  };
  const view = render(
    <ComposeBox
      onSend={onSend}
      onMicToggle={onMicToggle}
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
  return { onSend, onMicToggle, onAttach, seen, dictate, view };
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
    setup({ micLive: true, interim: "approve the dep" });
    expect(interimNode()?.textContent).toBe("approve the dep");
    expect(box().value).toBe("");
  });

  it("PARTIAL: no interim means no ghost row at all", () => {
    setup({ micLive: true });
    expect(interimNode()).toBeNull();
  });

  it("COMMIT: a finished segment lands in the textarea", () => {
    const { dictate } = setup({ micLive: true });
    dictate("approve the deploy");
    expect(box().value).toBe("approve the deploy");
  });

  it("COMMIT: successive segments accumulate, space-separated", () => {
    const { dictate } = setup({ micLive: true });
    dictate("approve the deploy");
    dictate("then tell me what broke");
    expect(box().value).toBe("approve the deploy then tell me what broke");
  });

  it("COMMIT: dictated text appends to what the user already typed", () => {
    const { dictate } = setup({ micLive: true });
    fireEvent.change(box(), { target: { value: "hey" } });
    dictate("approve it");
    expect(box().value).toBe("hey approve it");
  });

  it("COMMIT: dictated text is editable and sendable exactly like typed text", () => {
    const { dictate, onSend } = setup({ micLive: true });
    dictate("approve the deploy");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("approve the deploy");
    expect(box().value).toBe("");
  });

  it("the un-committed preview is NEVER submitted", () => {
    const { onSend } = setup({ micLive: true, interim: "half a phra" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("STOP: unmounting hands the target back (registers null)", () => {
    const { seen, view } = setup();
    view.unmount();
    expect(seen.at(-1)).toBeNull();
  });

  it("the mic reflects the live state and reports the toggle", () => {
    const { onMicToggle } = setup({ micLive: true });
    const mic = screen.getByRole("button", { name: "Talk to Sparkle" });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(mic);
    expect(onMicToggle).toHaveBeenCalledTimes(1);
  });

  it("without registerInsert the box behaves exactly as the text-only version did", () => {
    const onSend = vi.fn();
    render(<ComposeBox onSend={onSend} onMicToggle={vi.fn()} onAttach={vi.fn()} />);
    const only = screen.getAllByRole("textbox", { name: "Message" }).at(-1)!;
    fireEvent.change(only, { target: { value: "typed" } });
    fireEvent.keyDown(only, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("typed");
  });
});
