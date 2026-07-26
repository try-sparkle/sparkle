// @vitest-environment jsdom
//
// The close prompt's copy is a PROMISE about what the buttons do, and CM-U7 made that promise
// cross-project ("stop the agents" now reaches every project with a live agent). These cases pin
// the three shapes of that sentence so it can't drift back into claiming the visible tab is the
// only casualty — or into naming a project whose agents aren't running (roborev 46291-L).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosePrompt } from "./ClosePrompt";

afterEach(cleanup);

const noop = () => {};

function renderPrompt(runningProjectNames: string[]) {
  render(
    <ClosePrompt
      projectName="Alpha"
      runningProjectNames={runningProjectNames}
      onKeep={noop}
      onKill={noop}
      onCancel={noop}
    />,
  );
}

describe("ClosePrompt scope copy", () => {
  it("names the single running project", () => {
    renderPrompt(["Alpha"]);
    expect(screen.getByText(/keep the agents in Alpha running/)).toBeTruthy();
    // No "other projects" clause, and the button doesn't over-claim.
    expect(screen.queryByText(/other project/)).toBeNull();
    expect(screen.getByText("Stop the agents as well")).toBeTruthy();
  });

  it("counts the OTHER running projects in one clause (never the split em-dash phrasing)", () => {
    renderPrompt(["Alpha", "Beta", "Gamma"]);
    expect(screen.getByText(/keep the agents in Alpha and 2 other projects running/)).toBeTruthy();
    expect(screen.getByText("Stop those agents as well")).toBeTruthy();
  });

  it("singularizes one other project", () => {
    renderPrompt(["Alpha", "Beta"]);
    expect(screen.getByText(/Alpha and 1 other project running/)).toBeTruthy();
  });

  it("names the FRONT project only when it is actually running something", () => {
    // The front tab (Alpha) has no live agent, so it must not be named — the list is what the
    // stop actually reaches.
    renderPrompt(["Beta", "Gamma"]);
    expect(screen.getByText(/keep the agents in Beta and 1 other project running/)).toBeTruthy();
    expect(screen.queryByText(/in Alpha/)).toBeNull();
  });

  it("says nothing project-specific when nothing is running", () => {
    renderPrompt([]);
    expect(screen.getByText(/keep the running agents running in the background/)).toBeTruthy();
  });

  it("fires the handler the button promises", () => {
    const onKill = vi.fn();
    render(
      <ClosePrompt
        projectName="Alpha"
        runningProjectNames={["Alpha"]}
        onKeep={noop}
        onKill={onKill}
        onCancel={noop}
      />,
    );
    screen.getByText("Stop the agents as well").click();
    expect(onKill).toHaveBeenCalledTimes(1);
  });
});
