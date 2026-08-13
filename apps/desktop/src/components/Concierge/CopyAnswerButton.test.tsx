// @vitest-environment jsdom
//
// The per-answer copy button (PRD 1 §2). Its integration into the thread — which message kinds get
// one, and that it copies the SOURCE rather than the rendering — is ConciergeThread.copy.test's
// subject; this covers the button's own states.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyAnswerButton } from "./CopyAnswerButton";
import { COPY_TOAST_MS } from "./useCopyOnSelection";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const btn = () => screen.getByTestId("concierge-copy-answer");
const msgBtn = () => screen.getByTestId("concierge-copy-message");

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CopyAnswerButton", () => {
  it("copies the exact text it was given", async () => {
    const onCopied = vi.fn();
    render(<CopyAnswerButton text="**bold** and `code`" onCopied={onCopied} />);
    fireEvent.click(btn());
    await settle();

    expect(writeText).toHaveBeenCalledWith("**bold** and `code`");
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("flattens an agent reference instead of pasting an internal uuid", async () => {
    // THE MERGE-CREATED BUG (roborev 55063). Main encodes a concierge's agent mention as
    // `[@Name](sparkle-agent:<id>)` and renders it as a pill; this branch added a button that
    // copies the SOURCE. Neither side's tests could see the combination, and the result was that
    // any answer naming an agent — the common case for that feature — copied as a dead link
    // wrapped around an internal uuid, into whatever PR or Slack thread the user pasted it in.
    //
    // The pill reads `@Kraken Auth` and the selection path already yields `@Kraken Auth`; the
    // clipboard is the third rendering of the same words and has to agree with the other two.
    render(
      <CopyAnswerButton text="Ask [@Kraken Auth](sparkle-agent:9f3c1d2e) about the token refresh." />,
    );
    fireEvent.click(btn());
    await settle();

    expect(writeText).toHaveBeenCalledWith("Ask @Kraken Auth about the token refresh.");
    // Stated separately from the equality above: the equality can be updated by someone adjusting
    // the expected wording, and this is the part that must survive that edit.
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain("sparkle-agent:");
  });

  it("flattens a research reference instead of pasting an internal task id", async () => {
    // The same third-consumer tax as the agent case above, for a `sparkle-research:` link the
    // concierge writes when it names a task it dispatched. The pill reads the question and the
    // selection path already yields it, so the clipboard — the third rendering — must agree.
    render(
      <CopyAnswerButton text="I sent [how caching works](sparkle-research:rsh_1754700004000_0a1b2c3d4e5f6071) off." />,
    );
    fireEvent.click(btn());
    await settle();

    expect(writeText).toHaveBeenCalledWith("I sent how caching works off.");
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain("sparkle-research:");
  });

  it("leaves an ORDINARY link in the paste, where it belongs", async () => {
    // The flattening is scoped to agent references, not to links. A real URL is part of the answer
    // and a paste without it is a worse paste — stripping every link would be the opposite mistake.
    const text = "See [the runbook](https://example.com/runbook) first.";
    render(<CopyAnswerButton text={text} />);
    fireEvent.click(btn());
    await settle();

    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("swaps to a check mark and back after the confirmation window", async () => {
    vi.useFakeTimers();
    render(<CopyAnswerButton text="hello" />);
    expect(btn().dataset.copied).toBe("false");

    fireEvent.click(btn());
    await settle();
    expect(btn().dataset.copied).toBe("true");
    expect(btn().getAttribute("aria-label")).toBe("Answer copied");

    act(() => void vi.advanceTimersByTime(COPY_TOAST_MS + 10));
    expect(btn().dataset.copied).toBe("false");
    expect(btn().getAttribute("aria-label")).toBe("Copy answer");
  });

  it("is visible at rest and goes full-strength on hover AND on keyboard focus", () => {
    render(<CopyAnswerButton text="hello" />);
    // Present at rest — an affordance you must hover to discover is one most people never find.
    const resting = Number(btn().style.opacity);
    expect(resting).toBeGreaterThan(0);
    expect(resting).toBeLessThan(1);

    fireEvent.mouseEnter(btn());
    expect(btn().style.opacity).toBe("1");
    fireEvent.mouseLeave(btn());
    expect(Number(btn().style.opacity)).toBe(resting);

    // Keyboard users get the same lift — the button is reachable by Tab, so it must also be
    // legible once it is reached.
    fireEvent.focus(btn());
    expect(btn().style.opacity).toBe("1");
    fireEvent.blur(btn());
    expect(Number(btn().style.opacity)).toBe(resting);
  });

  it("carries no live region of its own", () => {
    // The column has exactly ONE aria-live node (roborev 52648/53010/53088). A per-message
    // announcer would speak once per answer on screen.
    const { container } = render(<CopyAnswerButton text="hello" />);
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("does not claim a copy that failed", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const onCopied = vi.fn();
    render(<CopyAnswerButton text="hello" onCopied={onCopied} />);
    fireEvent.click(btn());
    await settle();

    expect(btn().dataset.copied).toBe("false");
    expect(onCopied).not.toHaveBeenCalled();
  });

  // ── kind="message": the founder's OWN words ───────────────────────────────────────────────────
  //
  // "We should also have a copy button like we do for the concierge's responses." The word doing the
  // work is *like* — same component, same states, same confirmation window; only the label, the test
  // id and the edge it hangs off change, because a user bubble is right-aligned and an answer is not.
  describe('kind="message"', () => {
    it("labels itself for the USER's words, not for an answer", async () => {
      vi.useFakeTimers();
      render(<CopyAnswerButton kind="message" text="what needs me?" />);
      // A thread where BOTH sides carry a copy button is a screen-reader list of buttons, so the
      // label has to say whose words are on the clipboard.
      expect(msgBtn().getAttribute("aria-label")).toBe("Copy message");
      expect(msgBtn().getAttribute("title")).toBe("Copy message");
      // And it does NOT answer to the answer's id — the two must be tellable apart in a mixed thread.
      expect(screen.queryByTestId("concierge-copy-answer")).toBeNull();

      fireEvent.click(msgBtn());
      await settle();
      expect(msgBtn().getAttribute("aria-label")).toBe("Message copied");
      expect(msgBtn().getAttribute("title")).toBe("Copied");

      act(() => void vi.advanceTimersByTime(COPY_TOAST_MS + 10));
      expect(msgBtn().getAttribute("aria-label")).toBe("Copy message");
      expect(msgBtn().dataset.copied).toBe("false");
    });

    it("copies the user's text verbatim and confirms with a check mark", async () => {
      const onCopied = vi.fn();
      render(<CopyAnswerButton kind="message" text="ship the receipt fix" onCopied={onCopied} />);
      fireEvent.click(msgBtn());
      await settle();

      expect(writeText).toHaveBeenCalledWith("ship the receipt fix");
      expect(onCopied).toHaveBeenCalledTimes(1);
      expect(msgBtn().dataset.copied).toBe("true");
    });

    it("mirrors to the RIGHT edge, where the user's bubble is", () => {
      // The mirror is the whole reason `kind` touches layout at all. A user bubble is
      // `alignSelf: "flex-end"`; a button left-pulled under it lands in the middle of the column and
      // reads as an unrelated control. Asserted as the PAIR — answer left, message right — so a
      // regression that mirrored both, or neither, cannot pass.
      const { rerender } = render(<CopyAnswerButton text="an answer" />);
      expect(btn().parentElement?.style.justifyContent).toBe("");
      expect(btn().style.marginLeft).toBe("-2px");
      expect(btn().style.marginRight).toBe("");

      rerender(<CopyAnswerButton kind="message" text="a message" />);
      expect(msgBtn().parentElement?.style.justifyContent).toBe("flex-end");
      expect(msgBtn().style.marginRight).toBe("-2px");
      expect(msgBtn().style.marginLeft).toBe("");
    });

    it("carries no live region of its own either", () => {
      // Same contract as the answer variant: the column has exactly ONE aria-live node, and this
      // variant doubles the number of buttons in the thread — so a per-button announcer here would
      // double the damage rather than repeat it.
      const { container } = render(<CopyAnswerButton kind="message" text="hello" />);
      expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
    });

    it("does not claim a copy that failed", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      const onCopied = vi.fn();
      render(<CopyAnswerButton kind="message" text="hello" onCopied={onCopied} />);
      fireEvent.click(msgBtn());
      await settle();

      expect(msgBtn().dataset.copied).toBe("false");
      expect(msgBtn().getAttribute("aria-label")).toBe("Copy message");
      expect(onCopied).not.toHaveBeenCalled();
    });
  });
});
