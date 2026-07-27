// @vitest-environment jsdom
//
// The connected recommended-action row. It was mocked out of every host test, which is how a
// NO_PTY set containing two non-existent statuses went unnoticed (roborev 53074) — so the gate,
// the failure reporting, and "clear only on a real action" are pinned here directly.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  buttons: [] as unknown[],
  clear: vi.fn(),
  dismiss: vi.fn(),
  applySuggestion: vi.fn(
    async (
      _agentId: string,
      _b: unknown,
      _opts: { disabled?: boolean; deliverPrompt: (t: string) => unknown },
    ) => true,
  ),
  status: "working" as string,
  // A SPY, not a plain arrow: the "engine still runs while hidden" assertion has to observe that
  // the hook was CALLED. Asserting on the fixture instead (as this once did) passes identically if
  // the component early-returns before ever reaching the hook (roborev 53159).
  useSuggestions: vi.fn((_agentId: string, _composerEmpty: boolean) => ({
    buttons: [] as unknown[],
    dismiss: () => {},
    clear: () => {},
  })),
}));

vi.mock("../../services/suggestions/useSuggestions", () => ({
  useSuggestions: h.useSuggestions,
}));
vi.mock("../../services/suggestions/applySuggestion", () => ({
  applySuggestion: h.applySuggestion,
}));
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: (sel: (s: unknown) => unknown) => sel({ status: { a1: h.status } }),
}));

import { ConciergeSuggestions } from "./ConciergeSuggestions";

const BUTTON = {
  id: "b1",
  label: "Yes",
  value: "y\n",
  kind: "terminal" as const,
  source: "heuristic" as const,
};

function setup(over: { onDeliverPrompt?: () => Promise<boolean>; visible?: boolean } = {}) {
  const onFailure = vi.fn();
  // Pass-through queue: the host's real one serializes, but these tests are about the click's
  // behaviour, not its ordering. `onApply` receiving the WHOLE action is the contract that matters
  // here — terminal-kind pills write inside applySuggestion, so a wrapper around only the prompt
  // branch would leave them unqueued (roborev 53119).
  const onApply = vi.fn((run: () => Promise<boolean>) => run());
  render(
    <ConciergeSuggestions
      agentId="a1"
      agentName="Kraken Auth"
      visible={over.visible ?? true}
      onApply={onApply}
      onDeliverPrompt={over.onDeliverPrompt ?? (async () => true)}
      onFailure={onFailure}
    />,
  );
  return { onFailure, onApply };
}

beforeEach(() => {
  h.buttons = [BUTTON];
  h.status = "working";
  h.useSuggestions.mockReset();
  h.useSuggestions.mockImplementation(() => ({
    buttons: h.buttons,
    dismiss: h.dismiss,
    clear: h.clear,
  }));
  h.clear.mockReset();
  h.applySuggestion.mockReset();
  h.applySuggestion.mockResolvedValue(true);
});
afterEach(() => cleanup());

describe("ConciergeSuggestions — the dead-PTY gate", () => {
  it.each(["stopped", "errored"])("passes disabled for a %s agent", async (status) => {
    h.status = status;
    setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(h.applySuggestion).toHaveBeenCalled());
    expect(h.applySuggestion.mock.calls[0]![2]).toMatchObject({ disabled: true });
  });

  it("passes disabled: false for a running agent", async () => {
    setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(h.applySuggestion).toHaveBeenCalled());
    expect(h.applySuggestion.mock.calls[0]![2]).toMatchObject({ disabled: false });
  });

  // A vetoed click used to do nothing at all and say nothing at all.
  it("explains a click vetoed by the gate instead of silently no-opping", async () => {
    h.status = "stopped";
    h.applySuggestion.mockResolvedValue(false);
    const { onFailure } = setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onFailure.mock.calls[0]![0]).toMatch(/isn't running/i);
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe("ConciergeSuggestions — outcomes", () => {
  // The whole action must be queued, including terminal-kind writes that happen inside
  // applySuggestion rather than through onDeliverPrompt.
  it("runs the entire action through the host queue, terminal-kind included", async () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByText("Yes")); // BUTTON is terminal-kind
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(h.applySuggestion).toHaveBeenCalledTimes(1);
  });

  it("clears the row after a click that actually did something", async () => {
    setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(h.clear).toHaveBeenCalledTimes(1));
  });

  // Every other concierge delivery path reports its outcome; a throwing click was the one that
  // became an unhandled rejection instead.
  it("reports a throwing click into the thread", async () => {
    h.applySuggestion.mockRejectedValue(new Error("boom"));
    const { onFailure } = setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(onFailure.mock.calls[0]![0]).toContain("Kraken Auth");
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe("ConciergeSuggestions — visibility vs the engine", () => {
  // The hook must keep running when the row is hidden: auto-approve, auto-resume and the phone
  // push live inside it, and tying them to "is the concierge showing pills" would silently stop a
  // running agent from being auto-approved while the user looks at the Plan board (roborev 53074).
  it("renders nothing when hidden, but STILL CALLS the hook", () => {
    setup({ visible: false });
    expect(screen.queryByText("Yes")).toBeNull();
    // The real assertion: the engine ran. Auto-approve, auto-resume and the phone push all live
    // inside this hook, so "hidden" must not mean "not running".
    expect(h.useSuggestions).toHaveBeenCalledWith("a1", true);
  });

  it("calls the hook the same way when visible", () => {
    setup({ visible: true });
    expect(h.useSuggestions).toHaveBeenCalledWith("a1", true);
  });
});
