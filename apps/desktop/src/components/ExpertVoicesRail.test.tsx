// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpertVoicesRail } from "./ExpertVoicesRail";
import type { VoiceDef } from "../services/voices";

afterEach(cleanup);

const VOICES: VoiceDef[] = [
  { name: "Novice Vibe Coder", oneLiner: "Just wants it to work.", instructions: "..." },
  { name: "Security Skeptic", oneLiner: "Assumes everything is a threat.", instructions: "..." },
];

describe("ExpertVoicesRail", () => {
  it("renders nothing when idle with no voices", () => {
    const { container } = render(
      <ExpertVoicesRail voices={[]} status="idle" onMention={() => {}} />,
    );
    expect(container.querySelector('[data-testid="expert-voices-rail"]')).toBeNull();
  });

  it("shows a generating state", () => {
    render(<ExpertVoicesRail voices={[]} status="generating" onMention={() => {}} />);
    expect(screen.getByText(/spinning up expert voices/i)).toBeTruthy();
  });

  it("shows an error state", () => {
    render(
      <ExpertVoicesRail voices={[]} status="error" error="boom" onMention={() => {}} />,
    );
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it("lists the voices with their one-liners", () => {
    render(<ExpertVoicesRail voices={VOICES} status="idle" onMention={() => {}} />);
    expect(screen.getByText("@Novice Vibe Coder")).toBeTruthy();
    expect(screen.getByText("Just wants it to work.")).toBeTruthy();
    expect(screen.getByText("@Security Skeptic")).toBeTruthy();
  });

  it("fires onMention with the voice name when clicked", () => {
    const onMention = vi.fn();
    render(<ExpertVoicesRail voices={VOICES} status="idle" onMention={onMention} />);
    fireEvent.click(screen.getByText("@Security Skeptic"));
    expect(onMention).toHaveBeenCalledWith("Security Skeptic");
  });
});
