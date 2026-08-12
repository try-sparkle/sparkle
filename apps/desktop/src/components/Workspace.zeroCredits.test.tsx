// @vitest-environment jsdom
//
// Pins the "$0 balance" banner's MOUNT POINT in the workspace. ZeroCreditBanner's own tests can
// stay green while a refactor deletes `<ZeroCreditBanner />` from Workspace.tsx, so the feature
// would break with a fully green suite — this is the test that would go red.
//
// It also pins the ORDER against OfflineBanner, which the mount-site comment declares load-bearing:
// when both are up, connectivity is the more urgent explanation, and a top-up can't be bought
// without a network anyway.
//
// Mock header mirrors Workspace.orchestration.test.tsx — all Tauri IO and heavy children stubbed —
// except that OfflineBanner is rendered for real, since its position is what's under test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", () => ({
  useCurrentProjectId: () => null,
  useIsMainWindow: () => false,
  useCurrentWindowLabel: () => "main",
}));
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
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
  shouldWarmSparkleAtLaunch: () => false,
}));
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => null }));
// The concierge header's credit badge calls the REAL authStore.refresh() on mount, which asks the
// keychain for a token over un-mocked Tauri IO, gets "no token", and clears `me` — wiping the
// zero-balance identity these tests seed before the banner can read it. Stubbing it keeps this file
// to its subject (WHERE the banner mounts) and honors its own header: all Tauri IO stubbed. The
// badge's placement and refresh-on-mount are covered in SparkleLogo.placement.test.
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));

import { Workspace } from "./Workspace";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { useConnectionStore } from "../stores/connectionStore";
import type { Me } from "../services/entitlement";

const WARNING = /AI Enhanced features will no longer work/;
const OFFLINE = /Your connection is offline/;

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents: 0,
  tokenVersion: 1,
  ...over,
});

beforeEach(() => {
  useAuthStore.setState({ me: me() });
  useUiStore.setState({ zeroCreditBannerDismissed: false });
  useConnectionStore.setState({ isOnline: true });
});
afterEach(() => cleanup());

describe("Workspace — $0 credit banner mount point", () => {
  it("renders the warning at the top of the app for an entitled user at zero", async () => {
    const { container } = render(<Workspace />);
    await act(async () => {});
    expect(container.textContent).toMatch(WARNING);
  });

  it("renders no warning while the user still has credits", async () => {
    useAuthStore.setState({ me: me({ balanceCents: 500 }) });
    const { container } = render(<Workspace />);
    await act(async () => {});
    expect(container.textContent).not.toMatch(WARNING);
  });

  it("sits BELOW the offline banner when both are up", async () => {
    useConnectionStore.setState({ isOnline: false });
    const { container } = render(<Workspace />);
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toMatch(OFFLINE);
    expect(text).toMatch(WARNING);
    expect(text.search(OFFLINE)).toBeLessThan(text.search(WARNING));
  });
});
