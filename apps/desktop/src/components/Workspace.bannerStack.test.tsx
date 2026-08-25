// @vitest-environment jsdom
//
// THE BANNER STACK IS ONE COLUMN, AND EVERY BANNER IS IN IT (bead sparkle-kk9dg.6).
//
// UpdateBanner and StaleBuildBanner used to be mounted in App.tsx as siblings of <Workspace/>, each
// styled `position: fixed; top: 0; left: 0; right: 0; z-index: 1000` with an OPAQUE background. A
// fixed bar is out of flow: it does not push the shell down, it paints over it. So whenever a shell
// banner was up — OfflineBanner, ZeroCreditBanner, BlockedAgentsBanner, ProviderUnavailableBanner,
// AiServiceBanner, DictationEngineBanner — the user read the bottom half of a sentence about being
// offline or out of credits, with the top of it covered. That is the one shape in the shipped tree
// that genuinely CAN hide the top of a shell banner.
//
// WHAT THESE ASSERT, and why each would go red on a revert:
//   * MOUNT POINT — the update/stale bars render as part of <Workspace/>. Put them back in App.tsx
//     and <Workspace/> renders neither, so every test here fails. UpdateBanner.test.tsx renders the
//     component in isolation and would stay green through exactly that regression.
//   * SAME PARENT — the update bar and the offline bar are children of the SAME element. A portal,
//     a fixed overlay, or a private wrapper of its own all break this, and all of them are ways to
//     reintroduce an overlay while keeping both strings on screen.
//   * NOT OUT OF FLOW — the bar's own computed `position` is never `fixed` or `absolute`, and it
//     carries no z-index. Restore the old `bar` style object and this fails on the style alone,
//     even if the mount point were somehow preserved.
//
// jsdom does no layout, so there is nothing useful in getBoundingClientRect here (every rect is
// 0×0 at 0,0 — a fixed overlay and a flow child are indistinguishable by it). Structure and
// computed style are the observable facts, and they are the ones that decide overlap.
//
// Mock header mirrors Workspace.zeroCredits.test.tsx — all Tauri IO and heavy children stubbed —
// except that the banners under test are rendered for real, since their position is the subject.

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
vi.mock("./BalanceBadge", () => ({ BalanceBadge: () => null }));
vi.mock("./AgentPane", () => ({ AgentPane: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));

import { Workspace } from "./Workspace";
import { UPDATE_BANNER_TESTID } from "./UpdateBanner";
import { STALE_BUILD_BANNER_TESTID } from "./StaleBuildBanner";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useUpdaterStore } from "../services/updaterService";
import { useStaleBuildStore } from "../services/staleBuildService";
import type { Me } from "../services/entitlement";

const OFFLINE = /Your connection is offline/;

const me = (over: Partial<Me> = {}): Me => ({
  clerkUserId: "u1",
  entitled: true,
  balanceCents: 5000,
  tokenVersion: 1,
  ...over,
});

/** Everything a banner needs to be OUT of the flow, i.e. able to paint over a sibling. */
function outOfFlow(el: HTMLElement): { position: string; zIndex: string } {
  const cs = getComputedStyle(el);
  return { position: cs.position, zIndex: cs.zIndex };
}

async function renderShell() {
  const view = render(<Workspace />);
  await act(async () => {});
  return view;
}

beforeEach(() => {
  useAuthStore.setState({ me: me() });
  useUiStore.setState({ zeroCreditBannerDismissed: false });
  useConnectionStore.setState({ isOnline: true });
  useUpdaterStore.getState().reset();
  useStaleBuildStore.getState().clear();
});
afterEach(() => cleanup());

describe("Workspace — the update banner joins the shell banner stack", () => {
  it("renders the update bar as part of the shell, not as a sibling overlay of it", async () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    const { getByTestId } = await renderShell();

    // MUTATION THIS PINS: move <UpdateBanner /> back to App.tsx. <Workspace /> then renders it
    // nowhere, and UpdateBanner.test.tsx — which mounts the component on its own — stays green.
    expect(getByTestId(UPDATE_BANNER_TESTID).textContent).toMatch(/0\.129\.0/);
  });

  it("puts the update bar and the offline bar in the SAME stack container", async () => {
    useConnectionStore.setState({ isOnline: false });
    useUpdaterStore.getState().setReady("0.129.0", null);
    const { getByTestId, getByText } = await renderShell();

    const update = getByTestId(UPDATE_BANNER_TESTID);
    const offline = getByText(OFFLINE);

    // Both on screen AND siblings: a shared parent is what makes them stack vertically. A portal or
    // a fixed overlay would satisfy "both strings are present" while still covering one of them.
    expect(offline.textContent).toMatch(OFFLINE);
    expect(update.parentElement).not.toBeNull();
    expect(update.parentElement).toBe(offline.parentElement);
  });

  it("never takes the update bar out of flow, so it cannot paint over the banner below it", async () => {
    useConnectionStore.setState({ isOnline: false });
    useUpdaterStore.getState().setReady("0.129.0", null);
    const { getByTestId } = await renderShell();

    // MUTATION THIS PINS: restore `position: fixed; top: 0; left: 0; right: 0; zIndex: 1000` on the
    // bar. That is precisely the defect — an opaque out-of-flow bar clipping the offline sentence.
    const { position, zIndex } = outOfFlow(getByTestId(UPDATE_BANNER_TESTID));
    expect(position).not.toBe("fixed");
    expect(position).not.toBe("absolute");
    expect(zIndex === "" || zIndex === "auto").toBe(true);
  });

  it("orders the update bar above the offline bar in the stack, not on top of it", async () => {
    useConnectionStore.setState({ isOnline: false });
    useUpdaterStore.getState().setReady("0.129.0", null);
    const { getByTestId, getByText, container } = await renderShell();

    const stack = getByTestId(UPDATE_BANNER_TESTID).parentElement!;
    const kids = Array.from(stack.children);
    expect(kids.indexOf(getByTestId(UPDATE_BANNER_TESTID))).toBeLessThan(
      kids.indexOf(getByText(OFFLINE)),
    );
    // …and the sentence below it is whole: nothing between them consumes vertical space by
    // overlapping. Reading order in the DOM is what the flow column paints top-to-bottom.
    const text = container.textContent ?? "";
    expect(text.search(/0\.129\.0/)).toBeLessThan(text.search(OFFLINE));
  });

  it("still renders correctly when the update bar is the ONLY banner showing", async () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    const { getByTestId, queryByText } = await renderShell();

    expect(queryByText(OFFLINE)).toBeNull();
    const bar = getByTestId(UPDATE_BANNER_TESTID);
    expect(bar.textContent).toMatch(/restart/i);
    expect(outOfFlow(bar).position).not.toBe("fixed");
  });

  it("renders no update bar at all while the updater is idle", async () => {
    const { queryByTestId } = await renderShell();
    expect(queryByTestId(UPDATE_BANNER_TESTID)).toBeNull();
  });
});

describe("Workspace — the stale-build banner joins the same stack", () => {
  it("mounts inside the shell, in flow, beside the offline bar", async () => {
    useConnectionStore.setState({ isOnline: false });
    useStaleBuildStore.getState().setStale("0.130.0");
    const { getByTestId, getByText } = await renderShell();

    const stale = getByTestId(STALE_BUILD_BANNER_TESTID);
    expect(stale.textContent).toMatch(/0\.130\.0/);
    expect(stale.parentElement).toBe(getByText(OFFLINE).parentElement);

    // MUTATION THIS PINS: restore the fixed/z-index bar style on StaleBuildBanner.
    const { position, zIndex } = outOfFlow(stale);
    expect(position).not.toBe("fixed");
    expect(position).not.toBe("absolute");
    expect(zIndex === "" || zIndex === "auto").toBe(true);
  });

  it("stacks BOTH updater bars and a shell banner without any of them overlapping", async () => {
    useConnectionStore.setState({ isOnline: false });
    useUpdaterStore.getState().setReady("0.129.0", null);
    useStaleBuildStore.getState().setStale("0.130.0");
    const { getByTestId, getByText } = await renderShell();

    const update = getByTestId(UPDATE_BANNER_TESTID);
    const stale = getByTestId(STALE_BUILD_BANNER_TESTID);
    const offline = getByText(OFFLINE);
    const stack = update.parentElement!;

    expect(stale.parentElement).toBe(stack);
    expect(offline.parentElement).toBe(stack);
    for (const el of [update, stale, offline]) {
      expect(outOfFlow(el).position).not.toBe("fixed");
    }
    const kids = Array.from(stack.children);
    expect(kids.indexOf(update)).toBeLessThan(kids.indexOf(stale));
    expect(kids.indexOf(stale)).toBeLessThan(kids.indexOf(offline));
  });

  it("renders nothing while the running build is current", async () => {
    const { queryByTestId } = await renderShell();
    expect(queryByTestId(STALE_BUILD_BANNER_TESTID)).toBeNull();
  });
});
