// @vitest-environment jsdom
//
// The expanded open-tickets list under the sidebar's support banner. Its ONE assertion is a
// contrast one: the per-ticket row separators used to be `1px solid ${C.forest}` drawn on
// `C.deepForest` rows — one near-black plane ruled onto another at 1.08:1, i.e. the exact "plane
// used as a divider" defect the `hairline` token exists to remove. That site was not in the
// repaint sweep's stated exclusion list; it was simply missed, and nothing failed when it went
// invisible. `hairline`'s floor against every plane lives in theme/chromeContrast.test.ts.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// TWO open tickets, which is what makes the banner expandable (one ticket opens its thread
// directly and renders no list at all).
vi.mock("../services/supportApi", async (orig) => ({
  ...(await orig<typeof import("../services/supportApi")>()),
  listMyTickets: vi.fn(async () => [
    { id: "t1", token: "tok-1", subject: "First ticket", status: "awaiting_user" as const },
    { id: "t2", token: "tok-2", subject: "Second ticket", status: "awaiting_support" as const },
  ]),
}));
vi.mock("./LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));

import { AgentSidebar } from "./AgentSidebar";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import type { Project } from "../types";

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
  useRuntimeStore.setState({ branchStatus: {}, status: {} });
  useUiStore.setState({ workModeBySide: { left: "build", right: "build" } });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("AgentSidebar — the expanded open-tickets list", () => {
  it("separates ticket rows with a hairline, not with the plane the rows are painted in", async () => {
    render(<AgentSidebar project={project} />);
    // The banner only appears once the ticket poll resolves; >1 open ticket makes it a toggle.
    const banner = await screen.findByTitle(/open support tickets/);
    fireEvent.click(banner);

    const second = await waitFor(() => screen.getByTitle("Second ticket"));
    // First row: no top border at all (it butts against the banner) — jsdom serializes the
    // `none` shorthand back as the empty string. Second row: the separator under test.
    const first = screen.getByTitle("First ticket");
    expect(["", "none"]).toContain(first.style.borderTop);
    expect(second.style.background).toBe("var(--c-deep-forest)");
    expect(second.style.borderTop).toContain("var(--c-hairline)");
    expect(second.style.borderTop).not.toContain("var(--c-forest)");
  });
});
