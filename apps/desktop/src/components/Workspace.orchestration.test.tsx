// @vitest-environment jsdom
//
// Workspace startup wiring for the orchestration listener (sparkle-2bC task 3).
// Verifies that startOrchestrationListener is called exactly once when Workspace mounts
// and its cleanup fn is invoked on unmount. All Tauri I/O and child components are
// mocked so only the effect wiring under test is exercised.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

// --- Tauri APIs used directly by Workspace ---
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
  getAllWindows: () => Promise.resolve([{}]),
}));
// Workspace also mounts the "+ New Build Agent" drop-target listener (useNewBuildAgentDrop),
// which registers on the current webview.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

// --- window context hooks: return stable stub values so Workspace renders without a provider ---
vi.mock("../windowContext", () => ({
  useCurrentProjectId: () => null,
  useIsMainWindow: () => false, // false avoids the SPARKLE_AGENT_ID open() call
  useCurrentWindowLabel: () => "main",
}));

// --- KEY MOCK: the orchestration listener singleton ---
const mockCleanup = vi.fn();
const startOrchestrationListenerMock = vi.fn<() => Promise<() => void>>();
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => startOrchestrationListenerMock(),
}));

// --- other services wired in Workspace startup effects ---
vi.mock("../services/crossWindowSync", () => ({
  subscribeToCrossWindowSync: () => () => {},
}));
vi.mock("../services/windowClose", () => ({
  killProjectAgents: vi.fn(() => Promise.resolve()),
  planWindowClose: vi.fn(() => ({ killAgents: false, clearRegistry: false, hide: true })),
}));
vi.mock("../services/windowRegistry", () => ({
  clearWindowProject: vi.fn(),
  setWindowProject: vi.fn(),
  resetWindowRegistry: vi.fn(),
}));
vi.mock("../services/sparkleAgent", () => ({
  SPARKLE_AGENT_ID: "sparkle",
  sparkleAgentIdFor: (label: string) => (label === "main" ? "sparkle" : `sparkle-${label}`),
  sparkleOpenSetWhitelist: (o: { ownId: string }) => [o.ownId],
  // This suite is about the orchestration listener, not launch-warm: never warm, so boot doesn't
  // mount the Sparkle pane here. The gate itself is covered in services/sparkleAgent.test.ts.
  shouldWarmSparkleAtLaunch: () => false,
}));

// --- child components: stub out so their own Tauri/API calls don't interfere ---
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => null }));
vi.mock("./TopBar", () => ({ TopBar: () => null }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));

import { Workspace } from "./Workspace";

beforeEach(() => {
  startOrchestrationListenerMock.mockClear();
  mockCleanup.mockClear();
  startOrchestrationListenerMock.mockResolvedValue(mockCleanup);
});
afterEach(() => cleanup());

describe("Workspace — orchestration listener startup wiring", () => {
  it("starts the listener exactly once on mount", async () => {
    render(<Workspace />);
    // Flush microtasks so the .then(c => { cleanup = c }) resolves.
    await act(async () => {});
    expect(startOrchestrationListenerMock).toHaveBeenCalledOnce();
  });

  it("calls the cleanup fn returned by the listener on unmount", async () => {
    const { unmount } = render(<Workspace />);
    // Wait for the Promise to resolve so the cleanup fn is captured inside the effect.
    await act(async () => {});
    unmount();
    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  it("logs (and swallows) a rejected start instead of leaving an unhandled rejection", async () => {
    const err = new Error("tauri event bus not ready");
    startOrchestrationListenerMock.mockReturnValueOnce(Promise.reject(err));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw / surface an unhandled rejection.
    render(<Workspace />);
    await act(async () => {});

    expect(consoleError).toHaveBeenCalledWith(
      "[orchestration] listener failed to start:",
      err,
    );
    consoleError.mockRestore();
  });

  it("still calls cleanup when unmount races ahead of the listener promise resolving", async () => {
    // Simulate a slow start: hold the promise unresolved until after unmount.
    let resolveStart!: (fn: () => void) => void;
    const deferred = new Promise<() => void>((res) => {
      resolveStart = res;
    });
    startOrchestrationListenerMock.mockReturnValueOnce(deferred);

    const { unmount } = render(<Workspace />);
    // Unmount BEFORE the deferred promise settles — cleanup variable is still undefined.
    unmount();

    // Now let the start promise resolve. The effect must still invoke cleanup.
    await act(async () => {
      resolveStart(mockCleanup);
    });

    expect(mockCleanup).toHaveBeenCalledOnce();
  });
});
