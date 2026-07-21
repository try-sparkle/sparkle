// @vitest-environment jsdom
// Component-level coverage for the badge. roborev caught that the source comment referenced "the
// component test" while no such test existed — the pure helpers were covered on both sides, but
// render/hide, the click-through, and unmount cleanup were not.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => h.openUrl(u) }));

import { OpenPrBadge } from "./OpenPrBadge";

/** Route each Tauri command to its own canned reply, so a test can vary one without the other. */
function stub(opts: { count?: number | null; url?: string | null }) {
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "project_open_pr_count") return Promise.resolve(opts.count ?? null);
    if (cmd === "project_pr_list_url") return Promise.resolve(opts.url ?? null);
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  h.invoke.mockReset();
  h.openUrl.mockReset();
});
afterEach(cleanup);

describe("OpenPrBadge", () => {
  it("renders the count when PRs are waiting", async () => {
    stub({ count: 3 });
    render(<OpenPrBadge rootPath="/repo" />);
    await waitFor(() =>
      expect(screen.getByTestId("open-pr-badge").textContent).toContain("3 PRs waiting"),
    );
  });

  it("renders NOTHING at zero", async () => {
    stub({ count: 0 });
    render(<OpenPrBadge rootPath="/repo" />);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
  });

  it("renders NOTHING when the probe couldn't run — never a confident zero", async () => {
    // gh absent / unauthed / offline / no remote all arrive here as null. Showing "0 PRs waiting"
    // would be the exact false reassurance this feature exists to prevent.
    stub({ count: null });
    render(<OpenPrBadge rootPath="/repo" />);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
  });

  it("renders nothing, and probes nothing, with no project open", () => {
    stub({ count: 5 });
    render(<OpenPrBadge rootPath={null} />);
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("clicking resolves the repo's PR list and opens it", async () => {
    stub({ count: 2, url: "https://github.com/owner/repo/pulls" });
    render(<OpenPrBadge rootPath="/repo" />);
    const btn = await screen.findByTestId("open-pr-badge");
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() =>
      expect(h.openUrl).toHaveBeenCalledWith("https://github.com/owner/repo/pulls"),
    );
  });

  it("clicking does NOT navigate when the URL can't be resolved", async () => {
    // The Rust decoder refuses anything that isn't a plausible https URL, so null reaches here for
    // a repo with no gh/remote. Doing nothing beats opening a guessed page.
    stub({ count: 2, url: null });
    render(<OpenPrBadge rootPath="/repo" />);
    const btn = await screen.findByTestId("open-pr-badge");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("clears the count when the project changes, rather than showing the old repo's number", async () => {
    stub({ count: 4 });
    const { rerender } = render(<OpenPrBadge rootPath="/repo-a" />);
    await waitFor(() =>
      expect(screen.getByTestId("open-pr-badge").textContent).toContain("4 PRs"),
    );

    // Switch to a project whose probe never settles during this assertion window.
    h.invoke.mockImplementation(() => new Promise(() => {}));
    rerender(<OpenPrBadge rootPath="/repo-b" />);
    // The old count must be gone IMMEDIATELY — not lingering under the new project's name until
    // the new probe returns (which can take up to the network timeout).
    expect(screen.queryByTestId("open-pr-badge")).toBeNull();
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    stub({ count: 1 });
    const { unmount } = render(<OpenPrBadge rootPath="/repo" />);
    const afterMount = h.invoke.mock.calls.length;
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000); // several poll intervals
    });
    expect(h.invoke.mock.calls.length).toBe(afterMount);
    vi.useRealTimers();
  });
});
