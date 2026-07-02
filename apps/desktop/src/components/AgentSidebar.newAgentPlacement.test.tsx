// @vitest-environment jsdom
//
// Placement test for the "+ New … Agent" button: when the agent list fits its viewport the button
// renders BELOW the last row; when the list overflows (scrollHeight > clientHeight) it pins to the
// top inside a sticky wrapper so it stays visible while scrolling. Both slots use the same
// flex-column wrapper (identical flow height) — only the sticky pinning differs. jsdom has no
// layout (both heights are 0 → "fits"), so overflow is simulated by defining the two heights on
// the scroll container and forcing a re-render (the dep-less measuring layout-effect re-checks on
// every render).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../services/workerSpawn", () => ({ spawnWorker: vi.fn() }));

import { AgentSidebar } from "./AgentSidebar";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import type { Project } from "../types";

const entitledMe = { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 1 };

const project: Project = {
  id: "p1",
  name: "Demo",
  rootPath: "/tmp/demo",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null,
  agents: [],
};

beforeEach(() => {
  useSettingsStore.getState().setAllAiFeatures(true);
  useAuthStore.setState({ me: entitledMe, tokenPresent: true, loading: false });
  useUiStore.setState({ workMode: "build" });
});
afterEach(() => cleanup());

// Simulate the list's measured heights, then re-render so the measuring effect re-checks.
function setListHeights(
  rerender: (ui: React.ReactElement) => void,
  scrollHeight: number,
  clientHeight: number,
) {
  const sc = screen.getByTestId("agent-list-scroll");
  Object.defineProperty(sc, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(sc, "clientHeight", { value: clientHeight, configurable: true });
  act(() => rerender(<AgentSidebar project={{ ...project }} />));
}

// The button's placement wrapper. Both slots wrap it in a flex column; only the sticky slot pins.
function wrapperOf(name: RegExp) {
  return screen.getByRole("button", { name }).parentElement!;
}

describe("AgentSidebar — new-agent button placement", () => {
  it("renders + New Build Agent below the list (non-sticky wrapper) when the list fits", () => {
    render(<AgentSidebar project={project} />);
    const wrapper = wrapperOf(/New Build Agent/);
    const sc = screen.getByTestId("agent-list-scroll");
    expect(wrapper.parentElement).toBe(sc);
    expect(wrapper.style.position).not.toBe("sticky");
    // Bottom slot: renders after the (empty) row list, directly above the empty-state hint.
    expect(wrapper.nextElementSibling?.textContent).toMatch(/No Build agents yet/);
  });

  it("pins + New Build Agent to a sticky top wrapper when the list overflows", () => {
    const { rerender } = render(<AgentSidebar project={project} />);
    setListHeights(rerender, 500, 100);
    const wrapper = wrapperOf(/New Build Agent/);
    const sc = screen.getByTestId("agent-list-scroll");
    expect(wrapper.style.position).toBe("sticky");
    expect(wrapper.style.top).toBe("0px");
    // Above the rows' drag drop-target overlays (zIndex 2).
    expect(Number(wrapper.style.zIndex)).toBeGreaterThan(2);
    // The sticky slot leads the scroll content so it pins at the very top.
    expect(wrapper.parentElement).toBe(sc);
    expect(sc.firstElementChild).toBe(wrapper);
  });

  it("returns below the list when the overflow goes away again", () => {
    const { rerender } = render(<AgentSidebar project={project} />);
    setListHeights(rerender, 500, 100); // overflow → pinned
    expect(wrapperOf(/New Build Agent/).style.position).toBe("sticky");
    setListHeights(rerender, 100, 500); // fits again → back below the last row
    const wrapper = wrapperOf(/New Build Agent/);
    expect(wrapper.style.position).not.toBe("sticky");
    expect(wrapper.nextElementSibling?.textContent).toMatch(/No Build agents yet/);
  });

  it("applies the same placement rules to + New Think Agent in Think mode", () => {
    useUiStore.setState({ workMode: "think" });
    const { rerender } = render(<AgentSidebar project={project} />);
    const sc = screen.getByTestId("agent-list-scroll");
    // Fits → below the list.
    expect(wrapperOf(/New Think Agent/).style.position).not.toBe("sticky");
    expect(wrapperOf(/New Think Agent/).parentElement).toBe(sc);
    // Overflows → sticky at the top.
    setListHeights(rerender, 500, 100);
    const wrapper = wrapperOf(/New Think Agent/);
    expect(wrapper.style.position).toBe("sticky");
    expect(wrapper.parentElement).toBe(sc);
    expect(sc.firstElementChild).toBe(wrapper);
  });
});
