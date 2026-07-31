// @vitest-environment jsdom
//
// A long paste collapses into a pill instead of flooding the composer — asserted END TO END, at the
// PTY boundary, because that is the only place the feature's one dangerous failure is visible.
//
// THE FAILURE THIS FILE EXISTS FOR: sending the pill's LABEL instead of the pasted text. Nothing on
// screen would show it — the pill looks right either way — so every row below asserts what
// `submitPrompt` actually RECEIVED, never that a pill rendered.
//
// It also pins the expand-then-send path, which really was lossy (roborev 55720): "Show as regular
// text" moves the bytes out of the block and into the typed text, where `typed.trim()` dedented a
// pasted diff and ate its trailing newline. attachments.test.ts pins the rule; this pins the wiring.
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { submitPrompt, PtyGoneError } = vi.hoisted(() => ({
  submitPrompt: vi.fn((_id: string, _text: string) => Promise.resolve()),
  PtyGoneError: class PtyGoneError extends Error {
    constructor(readonly id: string) {
      super(`no such pty: ${id}`);
      this.name = "PtyGoneError";
    }
  },
}));
vi.mock("../pty", () => ({
  submitPrompt,
  writePty: vi.fn(() => Promise.resolve()),
  PtyGoneError,
}));
vi.mock("../screenshot", () => ({ captureScreenRegion: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/trialMeter", () => ({
  trialSendAllowed: () => true,
  recordTrialSend: vi.fn(() => Promise.resolve()),
}));

import { Composer, type ComposerApi } from "./Composer";
import { useDictationStore } from "../stores/dictationStore";
import { useUiStore } from "../stores/uiStore";
import { usePromptHistoryStore } from "../stores/promptHistoryStore";
import { pillPreview, PILL_MIN_LINES } from "./composer/attachments";

/** A realistic hostile paste: leading indentation (a diff's indentation is CONTENT), an interior
 *  blank line, a tab, and a trailing newline — every byte the trim used to eat. */
const PASTE =
  "    const x = 1;\n" +
  "    const y = 2;\n" +
  "\n" +
  "\tif (x) return y;\n" +
  "    line five\n" +
  "    line six\n" +
  "    line seven\n";

beforeEach(() => {
  submitPrompt.mockReset();
  submitPrompt.mockResolvedValue(undefined);
  useDictationStore.setState({ insertTarget: null, enabled: true, status: "idle", interim: "" });
  useUiStore.getState().setComposerMinimized(false);
  usePromptHistoryStore.setState({ history: [] });
});
afterEach(() => cleanup());

function renderComposer() {
  const apiRef = createRef<ComposerApi>();
  render(
    <Composer agentId="a1" active disabled={false} apiRef={apiRef} onSubmitPrompt={vi.fn()} />,
  );
  return { apiRef };
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const paste = (text: string) =>
  fireEvent.paste(textarea(), { clipboardData: { getData: () => text } });
const send = async () => {
  await act(async () => {
    screen.getByText("Send").click();
  });
};

describe("Composer — a long paste collapses to a pill", () => {
  it("keeps the textarea empty and shows a pill instead of the wall of text", () => {
    renderComposer();
    paste(PASTE);
    expect(textarea().value).toBe("");
    expect(screen.getByTestId("composer-text-pill")).toBeTruthy();
  });

  it("puts the paste's first line on the pill, so it is identifiable unopened", () => {
    renderComposer();
    paste(PASTE);
    expect(screen.getByTestId("composer-text-pill").textContent).toContain("const x = 1;");
  });

  it("leaves a SHORT paste alone — no pill, native insert", () => {
    renderComposer();
    const short = Array.from({ length: PILL_MIN_LINES - 1 }, (_, i) => `l${i}`).join("\n");
    paste(short);
    expect(screen.queryByTestId("composer-text-pill")).toBeNull();
  });

  it("SENDS THE FULL TEXT, byte-identical — never the pill's label", async () => {
    renderComposer();
    paste(PASTE);
    await send();
    expect(submitPrompt).toHaveBeenCalledWith("a1", PASTE, { machine: false });
    // Said outright, because this is the corruption that would be invisible on screen.
    //
    // THE THIRD ARG IS `expect.anything()`, NOT `{ machine: false }`, and it is load-bearing. A
    // negative `toHaveBeenCalledWith` matches on the WHOLE argument list, so when `submitPrompt`
    // gained a required third parameter this assertion — left at two arguments — could no longer
    // match any real call and passed no matter what was sent. It was guarding the one corruption
    // that is invisible on screen, and it had silently stopped guarding anything. Matching any third
    // argument restores it AND keeps it from rotting the same way the next time the signature moves.
    expect(submitPrompt).not.toHaveBeenCalledWith("a1", pillPreview(PASTE), expect.anything());
  });

  it("survives expand → send byte-identically (the path the trim used to corrupt)", async () => {
    renderComposer();
    paste(PASTE);
    // Open the pill's modal and take "Show as regular text".
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(PASTE);
    await act(async () => {
      screen.getByTestId("text-pill-show-as-text").click();
    });
    // It really is regular text now — the pill is gone and the box holds the bytes.
    expect(screen.queryByTestId("composer-text-pill")).toBeNull();
    expect(textarea().value).toBe(PASTE);

    await send();
    // The indentation and the trailing newline are still there.
    expect(submitPrompt).toHaveBeenCalledWith("a1", PASTE, { machine: false });
  });

  it("survives expand → EDIT → send, which is why anyone expands at all", async () => {
    // roborev 55728: the first fix keyed the exemption to the expansion's exact string, so it
    // evaporated on the first keystroke — and editing is the whole reason to take "Show as regular
    // text". Because `trim()` cuts the LEADING end too, and after an expansion the leading bytes are
    // the paste's first line, expand → type one character → send still arrived dedented.
    const { apiRef } = renderComposer();
    paste(PASTE);
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    await act(async () => {
      screen.getByTestId("text-pill-show-as-text").click();
    });
    await act(async () => {
      apiRef.current!.insertPrompt("make this async");
    });
    await send();
    const sent = submitPrompt.mock.calls.at(-1)?.[1] ?? "";
    // The paste's own indentation is still on line one…
    expect(sent.startsWith("    const x = 1;")).toBe(true);
    // …and the edit rode along.
    expect(sent).toContain("make this async");
  });

  it("keeps the bytes across a FAILED send and the retry (roborev 55767)", async () => {
    // `send` clears the latch before delivery, so a draft handed back by restoreDraft — under a
    // notice that literally says "your text is back in the box" — would go out dedented on the
    // retry. The restore has to re-arm it.
    renderComposer();
    paste(PASTE);
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    await act(async () => {
      screen.getByTestId("text-pill-show-as-text").click();
    });
    // An UNKNOWN submit failure, which is one of the two arms that hands the draft straight back.
    // Deliberately not the first PtyGoneError: that one re-queues and asks for a restart instead of
    // restoring, so it would not exercise restoreDraft at all.
    submitPrompt.mockRejectedValue(new Error("disk on fire"));
    await send();
    await act(async () => {});
    // The draft is back in the box, bytes intact.
    expect(textarea().value).toBe(PASTE);

    // Now it can be delivered. Send again.
    submitPrompt.mockReset();
    submitPrompt.mockResolvedValue(undefined);
    await send();
    expect(submitPrompt).toHaveBeenCalledWith("a1", PASTE, { machine: false });
  });

  it("keeps the bytes when the restore MERGES with keystrokes typed during the send", async () => {
    // The row above only restores into an EMPTY box, so it pins that the latch is re-armed but not
    // that the re-arm is UNCONDITIONAL (roborev 55791). Re-narrowing it to `verbatim && !cur` — the
    // exact form that shipped as a defect on the concierge side — leaves that row green while
    // restoring the dedent. This row takes `restoreDraft`'s other branch.
    renderComposer();
    paste(PASTE);
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    await act(async () => {
      screen.getByTestId("text-pill-show-as-text").click();
    });
    // Type from INSIDE the delivery, so the keystroke is in the box by the time restoreDraft runs.
    // That is the only way to reach its merge branch, and doing it here rather than by racing a
    // held-open promise keeps the row deterministic.
    submitPrompt.mockImplementation(() => {
      fireEvent.change(textarea(), { target: { value: "wait" } });
      return Promise.reject(new Error("disk on fire"));
    });
    await send();
    await act(async () => {});
    // The draft came back MERGED, prepended ahead of the new word — so `cur.trim()` was truthy and
    // the empty-box branch was NOT taken. A re-arm gated on emptiness would leave the latch off here.
    expect(textarea().value).toBe(`${PASTE}\nwait`);
    submitPrompt.mockReset();
    submitPrompt.mockResolvedValue(undefined);
    await send();
    const sent = submitPrompt.mock.calls.at(-1)?.[1] ?? "";
    // THE WHOLE PAYLOAD, not two partial predicates (roborev 55809). `startsWith` pins the leading
    // indent and `toContain("wait")` is true under every defect form, so the pair left the trailing
    // edge unpinned on the merge branch — and the natural "cleanup" here is a `trimEnd()` on the
    // restored half (the merge renders as a stray blank line in the box), which would eat the
    // paste's trailing newline with every row in this file still green. This is the one place the
    // merge branch's bytes are pinned, so it pins all of them.
    expect(sent).toBe(`${PASTE}\nwait`);
  });

  it("releases the exemption once the box is emptied by hand", async () => {
    // The latch is not permanent: an empty box holds nobody's paste, so what is typed next is the
    // user's own and gets the ordinary trim back. Without this the exemption would leak into every
    // later message in the session.
    const { apiRef } = renderComposer();
    paste(PASTE);
    fireEvent.click(screen.getByTestId("composer-text-pill"));
    await act(async () => {
      screen.getByTestId("text-pill-show-as-text").click();
    });
    // Clear it by hand, the way a user would.
    await act(async () => {
      fireEvent.change(textarea(), { target: { value: "" } });
    });
    await act(async () => {
      apiRef.current!.insertPrompt("  a fresh message  ");
    });
    await send();
    expect(submitPrompt).toHaveBeenCalledWith("a1", "a fresh message", { machine: false });
  });

  it("still trims what the user TYPED, so the exemption is narrow", async () => {
    const { apiRef } = renderComposer();
    await act(async () => {
      apiRef.current!.insertPrompt("  land it  ");
    });
    await send();
    expect(submitPrompt).toHaveBeenCalledWith("a1", "land it", { machine: false });
  });

  it("carries a pill alongside typed text, blocks first", async () => {
    const { apiRef } = renderComposer();
    paste(PASTE);
    await act(async () => {
      apiRef.current!.insertPrompt("please review this");
    });
    await send();
    expect(submitPrompt).toHaveBeenCalledWith("a1", `${PASTE}\n\nplease review this`, { machine: false });
  });
});
