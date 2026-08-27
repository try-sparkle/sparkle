// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConciergeMentionFeed } from "./ConciergeMentionFeed";
import type { CrossAgentMention } from "./crossAgentNotice";

afterEach(cleanup);

const REQUEST_FROM_IMPROVE: CrossAgentMention = {
  id: "m1",
  from: "improve",
  interaction: "request",
  beadId: "sparkle-hdlhox",
  body: "should PR #2153 supersede the artifact fixes?",
};

describe("ConciergeMentionFeed — the concierge-pane watch surface", () => {
  it("renders a NEW cross-agent mention as a compact notice: sender, verb, bead id, preview", () => {
    render(<ConciergeMentionFeed mentions={[REQUEST_FROM_IMPROVE]} />);
    const notice = screen.getByTestId("cross-agent-notice");
    expect(notice.getAttribute("data-from")).toBe("improve");
    // sender + verb (a REQUEST from Improve reads as asking the concierge for feedback)
    expect(within(notice).getByTestId("cross-agent-sentence").textContent).toContain("Improve Sparkle");
    expect(within(notice).getByTestId("cross-agent-verb").textContent).toBe("asked for my feedback");
    // bead id is the click-target, carrying the id
    expect(within(notice).getByTestId("cross-agent-bead-link").getAttribute("data-bead-id")).toBe("sparkle-hdlhox");
    // preview quotes the body
    expect(within(notice).getByTestId("cross-agent-preview").textContent).toContain("should PR #2153 supersede");
  });

  it("distinguishes a RESPONSE ('responded') from a REQUEST ('requested … feedback') by verb", () => {
    render(
      <ConciergeMentionFeed
        mentions={[
          { ...REQUEST_FROM_IMPROVE, id: "req", from: "sparkle", interaction: "request", body: "please review" },
          { ...REQUEST_FROM_IMPROVE, id: "res", from: "improve", interaction: "response", body: "agreed, holding." },
        ]}
      />,
    );
    const verbs = screen.getAllByTestId("cross-agent-verb").map((n) => n.textContent);
    expect(verbs).toContain("requested Improve Sparkle's feedback");
    expect(verbs).toContain("responded");
  });

  it("truncates a long preview to ~100 chars with an ellipsis", () => {
    const long = "detail ".repeat(60); // ~420 chars
    render(<ConciergeMentionFeed mentions={[{ ...REQUEST_FROM_IMPROVE, id: "big", body: long }]} previewCap={100} />);
    const preview = screen.getByTestId("cross-agent-preview").textContent ?? "";
    expect(preview).toContain("…");
    // The quoted preview text (between the curly quotes) is at most cap+ellipsis.
    const inner = preview.replace(/^:\s*“/, "").replace(/”$/, "");
    expect(inner.length).toBeLessThanOrEqual(101);
  });

  it("clicking the bead id opens that bead", () => {
    const onOpenBead = vi.fn();
    render(<ConciergeMentionFeed mentions={[REQUEST_FROM_IMPROVE]} onOpenBead={onOpenBead} />);
    fireEvent.click(screen.getByTestId("cross-agent-bead-link"));
    expect(onOpenBead).toHaveBeenCalledWith("sparkle-hdlhox");
  });

  it("renders nothing (no empty chrome) when there are no exchanges", () => {
    const { container } = render(<ConciergeMentionFeed mentions={[]} />);
    expect(container.querySelector('[data-testid="concierge-mention-feed"]')).toBeNull();
  });
});
