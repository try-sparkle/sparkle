// @vitest-environment jsdom
//
// The speaker affordance on Sparkle replies (CM-U9). Voice is opt-in, so the button must be
// absent entirely unless the integration layer supplied onSpeak.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeMessage, ConciergeSparkleMessage } from "./types";

afterEach(() => cleanup());

const messages: ConciergeMessage[] = [
  { id: "you-1", kind: "you", text: "status?" },
  // `speakable` is what the brain stream sets; the host's transactional notices don't (see below).
  { id: "brain-1", kind: "sparkle", text: "All calm.", speakable: true },
];

function setup(
  over: {
    onSpeak?: (m: ConciergeSparkleMessage) => void;
    speakingMessageId?: string | null;
  } = {},
) {
  render(
    <ConciergeThread
      messages={messages}
      onNudgeClick={vi.fn()}
      onNudgeAction={vi.fn()}
      {...over}
    />,
  );
}

describe("ConciergeThread — speaker button", () => {
  it("is absent when the integration layer offers no onSpeak", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Speak this reply" })).toBeNull();
  });

  it("renders on a Sparkle reply and reports the message back", () => {
    const onSpeak = vi.fn();
    setup({ onSpeak });
    fireEvent.click(screen.getByRole("button", { name: "Speak this reply" }));
    expect(onSpeak).toHaveBeenCalledTimes(1);
    expect(onSpeak.mock.calls[0]![0]).toMatchObject({ id: "brain-1", text: "All calm." });
  });

  it("never appears on a bookkeeping notice — only on a REPLY (roborev 48172)", () => {
    // The host posts its send outcomes as `sparkle` lines too ("Sent to CI Hardening.", "…that
    // didn't send."). Offering to read those aloud, and letting speakingMessageId point at one,
    // is not what "exactly one reply reads as active" meant.
    render(
      <ConciergeThread
        messages={[
          { id: "sparkle-9", kind: "sparkle", text: "Sent to CI Hardening.", speakable: false },
          { id: "brain-2", kind: "sparkle", text: "Rebasing now.", speakable: true },
        ]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
        onSpeak={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Speak this reply" })).toHaveLength(1);
    expect(screen.getByText("Sent to CI Hardening.")).toBeTruthy();
  });

  it("never appears on a user bubble", () => {
    setup({ onSpeak: vi.fn() });
    expect(
      screen.getAllByRole("button", { name: /Speak this reply|Stop speaking/ }),
    ).toHaveLength(1);
  });

  it("the reply that is playing offers Stop instead", () => {
    setup({ onSpeak: vi.fn(), speakingMessageId: "brain-1" });
    const btn = screen.getByRole("button", { name: "Stop speaking" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Speak this reply" })).toBeNull();
  });

  it("a different reply playing leaves this one on Speak", () => {
    setup({ onSpeak: vi.fn(), speakingMessageId: "brain-99" });
    expect(
      screen.getByRole("button", { name: "Speak this reply" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});
