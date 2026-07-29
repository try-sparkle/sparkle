// @vitest-environment jsdom
//
// The thread's two copy affordances together (PRD 1 §1 + §2), which is where the interesting part
// lives: they copy DIFFERENT THINGS on purpose, and the setting governs only one of them.
//
//   §1 selection → `sel.toString()`, the RENDERED words. A partial selection has no markdown source.
//   §2 button    → `m.text`, the MARKDOWN SOURCE, so a table stays a table on paste.
//
// The clipboard boundary is stubbed at `navigator.clipboard`, not by mocking ../../clipboard: going
// through the shared helper is part of the contract.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeMessage } from "./types";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const noop = () => {};

/** An answer whose VALUE is its structure — the exact case flattening would destroy. */
const MARKDOWN_ANSWER = [
  "Here is the split:",
  "",
  "| Project | Needs you |",
  "| --- | --- |",
  "| drodio-website | 2 |",
  "",
  "```ts",
  "const ready = agents.filter((a) => a.band === 'needs_you');",
  "```",
].join("\n");

const answer: ConciergeMessage = { id: "a1", kind: "sparkle", text: MARKDOWN_ANSWER };

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function thread(): HTMLElement {
  return screen.getByTestId("concierge-thread");
}

describe("ConciergeThread — copy affordances", () => {
  describe("§2 the whole-answer button", () => {
    it("copies the RAW MARKDOWN verbatim — table pipes and code fences intact", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onCopied={onCopied}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-answer"));
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toBe(MARKDOWN_ANSWER);
      // Stated separately from the equality above so a future rewrite of the fixture can't quietly
      // drop the two shapes this exists to protect.
      expect(copied).toContain("| Project | Needs you |");
      expect(copied).toContain("```ts");
      // And it is NOT the rendering. The rendered thread has the words without the syntax; that is
      // exactly what "copy the source, not the innerText" means.
      expect(copied).not.toBe(thread().textContent);
      expect(onCopied).toHaveBeenCalledWith("answer");
    });

    it("still copies when 'Copy on selection' is OFF", async () => {
      // An explicit click is an explicit instruction. The setting governs the SELECTION path only —
      // turning it off must not take the button away.
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          copyOnSelection={false}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-answer"));
      await settle();

      expect(writeText).toHaveBeenCalledWith(MARKDOWN_ANSWER);
    });

    it("is on proactive pushes too, and on nothing else in the thread", () => {
      const messages: ConciergeMessage[] = [
        { id: "u1", kind: "you", text: "what needs me?" },
        { id: "b1", kind: "batch", text: "All projects calm" },
        { id: "d1", kind: "digest", band: "needs_you", variant: "rows", text: "3 Need you", leadAgentId: "x" },
        {
          id: "n1",
          kind: "nudge",
          band: "needs_you",
          projectName: "drodio-website",
          agentName: "OG Image Pipeline",
          text: "A build warning needs your call.",
          actions: [],
        },
        answer,
        { id: "p1", kind: "sparkle", text: "Two agents went quiet.", proactive: true },
      ];
      render(<ConciergeThread messages={messages} onNudgeClick={noop} onNudgeAction={noop} />);

      // One per ANSWER — the reply and the push — and none for the user's own bubble or the cards.
      expect(screen.getAllByTestId("concierge-copy-answer")).toHaveLength(2);
      expect(screen.getByTestId("concierge-push").querySelector('[data-testid="concierge-copy-answer"]')).toBeTruthy();
      expect(screen.getByTestId("you-bubble").querySelector('[data-testid="concierge-copy-answer"]')).toBeNull();
    });
  });

  describe("§1 copy on selection", () => {
    /** Highlight the rendered answer, then release inside the thread. */
    function selectAndRelease(): void {
      const range = document.createRange();
      range.selectNodeContents(thread());
      const sel = window.getSelection();
      if (!sel) throw new Error("jsdom has no Selection");
      sel.removeAllRanges();
      sel.addRange(range);
      fireEvent.mouseDown(thread());
      fireEvent.mouseUp(thread());
    }

    it("copies the RENDERED text — not the markdown source — when the setting is ON", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onCopied={onCopied}
        />,
      );
      selectAndRelease();
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toContain("Here is the split:");
      // The deliberate difference from §2: a highlight has no markdown behind it.
      expect(copied).not.toBe(MARKDOWN_ANSWER);
      expect(onCopied).toHaveBeenCalledWith("selection");
    });

    it("does nothing when the setting is OFF", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          copyOnSelection={false}
          onCopied={onCopied}
        />,
      );
      selectAndRelease();
      await settle();

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
    });

    it("shows a confirmation that cannot shift the layout or take focus", async () => {
      render(<ConciergeThread messages={[answer]} onNudgeClick={noop} onNudgeAction={noop} />);
      selectAndRelease();
      await settle();

      const toast = screen.getByTestId("concierge-copy-toast");
      // Absolutely positioned (so it is out of flow) and inert to both the pointer and the reader —
      // the announcement goes through the column's ONE live region instead.
      expect(toast.style.position).toBe("absolute");
      expect(toast.style.pointerEvents).toBe("none");
      expect(toast.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("adds NO second live region — the confirmation leaves via onCopied", async () => {
    // The column's single `role="status" aria-live="polite"` node lives in ConciergeColumn and is
    // fed by the host's `announce()`. A region in here would double-announce every reply, which is
    // what roborev 52648/53010/53088 were about.
    const onCopied = vi.fn();
    const { container } = render(
      <ConciergeThread
        messages={[answer]}
        onNudgeClick={noop}
        onNudgeAction={noop}
        onCopied={onCopied}
      />,
    );
    fireEvent.click(screen.getByTestId("concierge-copy-answer"));
    await settle();

    expect(onCopied).toHaveBeenCalledWith("answer");
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});
