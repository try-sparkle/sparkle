// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const checkPrereqs = vi.fn();
const checkClaudeSignedIn = vi.fn();
vi.mock("../preflight", () => ({
  checkPrereqs: () => checkPrereqs(),
  checkClaudeSignedIn: () => checkClaudeSignedIn(),
}));

// Stub the (heavy, xterm-backed) checklist so the gate test stays about the DECISION, not the engine.
vi.mock("./SetupChecklist", () => ({
  SetupChecklist: ({ onReady }: { onReady: () => void }) => (
    <button onClick={onReady}>SETUP CHECKLIST</button>
  ),
}));

import { ReadinessGate } from "./ReadinessGate";

const report = (over: Partial<Record<"git" | "node" | "claude", boolean>> = {}) => {
  const f = (installed: boolean) => ({ installed, path: installed ? "/x" : null });
  return { git: f(over.git ?? true), node: f(over.node ?? true), claude: f(over.claude ?? true) };
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("ReadinessGate", () => {
  it("all prereqs present + signed in → renders children, NEVER shows the checklist (invisible)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeSignedIn.mockResolvedValue(true);
    render(
      <ReadinessGate>
        <div>APP</div>
      </ReadinessGate>,
    );
    // Children paint immediately.
    expect(screen.getByText("APP")).toBeTruthy();
    // Give the async probe time to resolve, then assert the checklist never mounted.
    await waitFor(() => expect(checkClaudeSignedIn).toHaveBeenCalled());
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
  });

  it("a missing dependency → overlays the setup checklist over the app", async () => {
    checkPrereqs.mockResolvedValue(report({ claude: false }));
    checkClaudeSignedIn.mockResolvedValue(false);
    render(
      <ReadinessGate>
        <div>APP</div>
      </ReadinessGate>,
    );
    // The checklist is code-split; wait for the dynamic import + probe.
    expect(await screen.findByText("SETUP CHECKLIST")).toBeTruthy();
    // Children stay mounted underneath so the app reveals cleanly once setup completes.
    expect(screen.getByText("APP")).toBeTruthy();
    // claude absent → we don't bother probing sign-in.
    expect(checkClaudeSignedIn).not.toHaveBeenCalled();
  });

  it("installed-but-not-signed-in → still shows the checklist (login step pending)", async () => {
    checkPrereqs.mockResolvedValue(report());
    checkClaudeSignedIn.mockResolvedValue(false);
    render(
      <ReadinessGate>
        <div>APP</div>
      </ReadinessGate>,
    );
    expect(await screen.findByText("SETUP CHECKLIST")).toBeTruthy();
  });

  it("onReady dismisses the overlay, revealing the app", async () => {
    checkPrereqs.mockResolvedValue(report({ node: false }));
    checkClaudeSignedIn.mockResolvedValue(false);
    render(
      <ReadinessGate>
        <div>APP</div>
      </ReadinessGate>,
    );
    const btn = await screen.findByText("SETUP CHECKLIST");
    btn.click();
    await waitFor(() => expect(screen.queryByText("SETUP CHECKLIST")).toBeNull());
    expect(screen.getByText("APP")).toBeTruthy();
  });

  it("a broken probe does NOT block the app (fails open to the normal flow)", async () => {
    checkPrereqs.mockRejectedValue(new Error("ipc down"));
    render(
      <ReadinessGate>
        <div>APP</div>
      </ReadinessGate>,
    );
    await waitFor(() => expect(checkPrereqs).toHaveBeenCalled());
    // Never surfaces the checklist on a probe failure — the post-spawn no-claude branch is the backstop.
    expect(screen.queryByText("SETUP CHECKLIST")).toBeNull();
    expect(screen.getByText("APP")).toBeTruthy();
  });
});
