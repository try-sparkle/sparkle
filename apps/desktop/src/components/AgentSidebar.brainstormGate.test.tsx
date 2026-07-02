// @vitest-environment jsdom
//
// Gate test: the Think button (Chief chat; renamed from Brainstorm on main) is shown only when the
// AI "Think" feature flag (aiBrainstorm) is on; the ⚒ Build button is unaffected. Heavy leaf
// components (canvas waveform, status bar) and the Tauri opener are mocked so the sidebar renders.
import { cleanup, render, screen } from "@testing-library/react";
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
  // AI extras now require CREDITS (a positive balance) — default the suite to a funded user
  // (entitledMe has balanceCents: 20000) so the feature-flag behavior is what's under test here.
  useAuthStore.setState({ me: entitledMe, tokenPresent: true, loading: false });
  // Mode now lives in the (singleton) uiStore — reset it to the launch default so these
  // assertions see the Build section, independent of any prior test's tab switch.
  useUiStore.setState({ workMode: "build" });
});
afterEach(() => cleanup());

describe("AgentSidebar — AI Think (Chief) gate", () => {
  it("shows the Think button when the feature is on", () => {
    render(<AgentSidebar project={project} />);
    expect(screen.getByRole("button", { name: "Think" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⚒ Build" })).toBeTruthy();
  });

  it("hides the Think button (and the hint that points at it) when off; Build stays", () => {
    useSettingsStore.getState().setAiFeature("brainstorm", false);
    render(<AgentSidebar project={project} />);
    expect(screen.queryByRole("button", { name: "Think" })).toBeNull();
    // The empty-state hint must not advertise the hidden feature either.
    expect(screen.queryByText(/Think/)).toBeNull();
    expect(screen.getByRole("button", { name: "⚒ Build" })).toBeTruthy();
  });

  it("still SHOWS the Think button during the trial / out of credits (visible-but-locked)", () => {
    // The Think chevron is now gated on the settings flag ONLY (useAiFeatureVisible), so a trial /
    // no-credits user can SEE the feature. The buy-to-use lock is enforced at submit (ThinkPanel),
    // not by hiding the chevron. Anonymous trial: no token, no `me`.
    useSettingsStore.getState().setAllAiFeatures(true);
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false });
    render(<AgentSidebar project={project} />);
    expect(screen.getByRole("button", { name: "Think" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "⚒ Build" })).toBeTruthy();
  });
});
