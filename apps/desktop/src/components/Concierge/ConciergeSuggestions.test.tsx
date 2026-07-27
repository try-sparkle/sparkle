// @vitest-environment jsdom
//
// The connected recommended-action row. It was mocked out of every host test, which is how a
// NO_PTY set containing two non-existent statuses went unnoticed (roborev 53074) — so the gate,
// the failure reporting, and "clear only on a real action" are pinned here directly.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

const h = vi.hoisted(() => ({
  buttons: [] as unknown[],
  clear: vi.fn(),
  dismiss: vi.fn(),
  // One entry per HOOK INSTANCE, pushed from a mount effect. Counting `useSuggestions` CALLS
  // instead proves nothing about mounting — the agentId argument is the same string on every call,
  // so a full remount and a re-render are indistinguishable (the inert-assertion class already
  // found once in ConciergeHost.test.tsx, roborev 53086/53590).
  mounts: [] as string[],
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
import { useTerminalOverlayStore } from "../../stores/terminalOverlayStore";

const BUTTON = {
  id: "b1",
  label: "Yes",
  value: "y\n",
  kind: "terminal" as const,
  source: "heuristic" as const,
};

/** Stands in for AgentPane's `position: relative` terminal stage — the node the pill portals into.
 *  Registered in the store exactly as the pane's stage ref does. */
let stage: HTMLDivElement | null = null;

function mountStage() {
  stage = document.createElement("div");
  stage.setAttribute("data-testid", "fake-terminal-stage");
  document.body.appendChild(stage);
  useTerminalOverlayStore.getState().setStage("a1", stage);
}

function setup(
  over: {
    onDeliverPrompt?: () => Promise<boolean>;
    visible?: boolean;
    /** Skip registering a stage, i.e. the pane has no terminal yet (spawning / errored). */
    noStage?: boolean;
  } = {},
) {
  if (!over.noStage) mountStage();
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
  h.mounts.length = 0;
  h.useSuggestions.mockReset();
  // The mock stands in for a real hook, so it may use hooks itself: an empty-dep effect fires once
  // per INSTANCE, which is what "the component did not remount" actually means.
  h.useSuggestions.mockImplementation((agentId: string) => {
    useEffect(() => {
      h.mounts.push(agentId);
    }, []);
    return { buttons: h.buttons, dismiss: h.dismiss, clear: h.clear };
  });
  h.clear.mockReset();
  h.applySuggestion.mockReset();
  h.applySuggestion.mockResolvedValue(true);
  useTerminalOverlayStore.setState({ stages: {}, drafts: {} });
});
afterEach(() => {
  cleanup();
  stage?.remove();
  stage = null;
});

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

describe("ConciergeSuggestions — where it renders", () => {
  // The whole point of the relocation: the pill lives ON the agent's terminal, not in a strip in
  // the concierge column. If it ever renders into the host's own tree again this fails.
  it("renders inside the terminal stage, not in the host's tree", () => {
    setup();
    const pill = screen.getByTestId("suggestion-pill");
    expect(stage!.contains(pill)).toBe(true);
    expect(screen.getByTestId("terminal-suggestion-anchor").parentElement).toBe(stage);
  });

  // No stage → nowhere to render. The hook must still have run: auto-approve and auto-resume live
  // inside it and a spawning pane must not switch them off.
  it("renders nothing when the pane has no terminal stage yet, but STILL CALLS the hook", () => {
    setup({ noStage: true });
    expect(screen.queryByText("Yes")).toBeNull();
    expect(h.useSuggestions).toHaveBeenCalledWith("a1", true);
  });

  // A stage registered after mount (the pane finished spawning) must pull the pill in without the
  // component remounting — the hook instance has to survive it.
  it("appears once the stage is registered later", () => {
    setup({ noStage: true });
    expect(screen.queryByText("Yes")).toBeNull();
    act(() => mountStage());
    expect(screen.getByText("Yes")).toBeTruthy();
    // ONE hook instance across the transition — the portal moved, the component did not remount.
    // This is the assertion that stops someone "simplifying" the portal to the outside of this
    // component (mount it only once a stage exists), which would tie useSuggestions' lifetime —
    // auto-approve, auto-resume, the phone push — to the stage's.
    expect(h.mounts).toEqual(["a1"]);
  });
});

describe("ConciergeSuggestions — the terminal-typing gate", () => {
  // The spec's requirement: typing at the CLI prompt hides the pill, clearing the line restores it.
  // The signal comes from the terminal's own keystroke scanner via terminalOverlayStore — there is
  // no React value to read, the input line is painted by the CLI inside the xterm canvas.
  it("hides while the user has a pending line in the terminal, and restores when it clears", () => {
    setup();
    expect(screen.getByText("Yes")).toBeTruthy();

    act(() => useTerminalOverlayStore.getState().setDraft("a1", true));
    expect(screen.queryByText("Yes")).toBeNull();

    act(() => useTerminalOverlayStore.getState().setDraft("a1", false));
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  // Only THIS agent's typing hides THIS agent's pill.
  it("ignores a pending line in a different agent's terminal", () => {
    setup();
    act(() => useTerminalOverlayStore.getState().setDraft("other", true));
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  // Hiding is presentation only — the engine behind it must keep running while the user types, or
  // an auto-approve would be missed for as long as the line sits unsent.
  it("keeps the hook running while hidden by typing", () => {
    setup();
    h.useSuggestions.mockClear();
    act(() => useTerminalOverlayStore.getState().setDraft("a1", true));
    expect(h.useSuggestions).toHaveBeenCalledWith("a1", true);
  });
});

describe("ConciergeSuggestions — no confirmation step", () => {
  // DELIBERATE, user-confirmed exception to the escape-hatch pattern used everywhere else in the
  // concierge control design: one tap runs it, destructive commands included. No countdown, no
  // confirm dialog, nothing to cancel. If a review asks for one, this test is the answer.
  it("dispatches on the first click, with no confirmation and no second click", async () => {
    setup();
    fireEvent.click(screen.getByText("Yes"));
    await waitFor(() => expect(h.applySuggestion).toHaveBeenCalledTimes(1));
    // Nothing stood between the click and the dispatch: no dialog, no armed/pending affordance.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.applySuggestion.mock.calls[0]![1]).toMatchObject({ id: "b1" });
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
