// @vitest-environment jsdom
//
// HistorySearch: the debounced full-text search box under the Brainstorm/Build buttons.
// We mock services/history so the store's debounced search never hits Tauri `invoke`, and we
// drive the component through the REAL historyStore (the source of truth for query/results).
// Routing is injected via the `openInWindow` prop so we can assert cross-project vs same-project
// behaviour without a webview.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Order-safe shared seed: `vi.hoisted` runs before the hoisted `vi.mock` factory and the tests,
// so both reference the same handle and the mock can't read `seeded` before it's assigned.
const h = vi.hoisted(() => ({ seeded: [] as HistoryHit[] }));

// Keep the store's debounced search off the Tauri bridge: return our seeded hit instead.
vi.mock("../services/history", async (orig) => {
  const actual = await orig<typeof import("../services/history")>();
  return {
    ...actual,
    recordHistory: vi.fn(async () => {}),
    searchHistory: vi.fn(async () => h.seeded),
    pruneHistory: vi.fn(async () => 0),
  };
});

import { HistorySearch, renderSnippet, relativeTime } from "./HistorySearch";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryHit } from "../services/history";

const hit = (over: Partial<HistoryHit> = {}): HistoryHit => ({
  id: "h1",
  kind: "prompt",
  source: "build",
  projectId: "p1",
  agentId: "a1",
  projectName: "Demo",
  agentName: "Builder",
  snippet: "loving <b>rust</b> lately",
  createdAt: Date.now() - 60_000,
  ...over,
});

beforeEach(() => {
  h.seeded = [hit()];
  useHistoryStore.setState({ query: "", results: [], entitlement: "24h", searching: false });
});
afterEach(() => cleanup());

describe("HistorySearch", () => {
  it("typing updates the store query", () => {
    render(<HistorySearch currentProjectId="p1" openInWindow={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search history/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "rust" } });
    // setQuery writes the query synchronously (the search itself is debounced).
    expect(useHistoryStore.getState().query).toBe("rust");
  });

  it("renders seeded results: snippet, badge, and project · agent label", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded });
    render(<HistorySearch currentProjectId="p1" openInWindow={vi.fn()} />);
    // Snippet match marker rendered as bold text (split safely, not via innerHTML).
    expect(screen.getByText("rust")).toBeTruthy();
    expect(screen.getByText("Demo · Builder")).toBeTruthy();
    expect(screen.getByText(/prompt/i)).toBeTruthy();
  });

  it("renders nothing collapsed when the query is empty", () => {
    useHistoryStore.setState({ query: "", results: [] });
    render(<HistorySearch currentProjectId="p1" openInWindow={vi.fn()} />);
    // The input is always present; no result rows when the query is blank.
    expect(screen.getByPlaceholderText(/search history/i)).toBeTruthy();
    expect(screen.queryByTestId("history-result")).toBeNull();
  });

  it("opens a DIFFERENT project's hit in a new window", () => {
    useHistoryStore.setState({ query: "rust", results: [hit({ projectId: "other" })] });
    const openInWindow = vi.fn();
    render(<HistorySearch currentProjectId="p1" openInWindow={openInWindow} />);
    fireEvent.click(screen.getByTestId("history-result"));
    expect(openInWindow).toHaveBeenCalledWith("other", "new");
  });

  it("does NOT open a new window for a hit in the CURRENT project", () => {
    useHistoryStore.setState({ query: "rust", results: [hit({ projectId: "p1" })] });
    const openInWindow = vi.fn();
    render(<HistorySearch currentProjectId="p1" openInWindow={openInWindow} />);
    fireEvent.click(screen.getByTestId("history-result"));
    expect(openInWindow).not.toHaveBeenCalled();
  });

  it("disables a row whose project is unknown (projectId null)", () => {
    useHistoryStore.setState({ query: "rust", results: [hit({ projectId: null })] });
    const openInWindow = vi.fn();
    render(<HistorySearch currentProjectId="p1" openInWindow={openInWindow} />);
    const row = screen.getByTestId("history-result") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(openInWindow).not.toHaveBeenCalled();
  });

  it("shows the retention caption and an Extend upsell on the free 24h tier", () => {
    useHistoryStore.setState({ query: "rust", results: h.seeded, entitlement: "24h" });
    render(<HistorySearch currentProjectId="p1" openInWindow={vi.fn()} />);
    expect(screen.getByText(/24 hours/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /extend history/i })).toBeTruthy();
  });
});

// Lock the split-on-marker logic: every <b>…</b> run becomes bold, plain text stays plain, and
// leading/trailing/consecutive markers don't produce spurious nodes.
describe("renderSnippet", () => {
  // Render the nodes into a host element and read back which substrings are bold.
  const boldTexts = (snippet: string): string[] => {
    const { container } = render(<div>{renderSnippet(snippet)}</div>);
    return Array.from(container.querySelectorAll("strong")).map((el) => el.textContent ?? "");
  };

  it("bolds a single match and leaves the rest plain", () => {
    const { container } = render(<div>{renderSnippet("loving <b>rust</b> lately")}</div>);
    expect(container.querySelectorAll("strong").length).toBe(1);
    expect(container.querySelector("strong")?.textContent).toBe("rust");
    expect(container.textContent).toBe("loving rust lately");
  });

  it("bolds multiple and adjacent matches", () => {
    expect(boldTexts("<b>a</b> b <b>c</b>")).toEqual(["a", "c"]);
    expect(boldTexts("x<b>y</b><b>z</b>")).toEqual(["y", "z"]);
  });

  it("handles leading and trailing markers without empty nodes", () => {
    const { container } = render(<div>{renderSnippet("<b>lead</b> mid <b>tail</b>")}</div>);
    expect(container.textContent).toBe("lead mid tail");
    // No stray empty <strong>/<span> from the split's empty edge segments.
    expect(Array.from(container.querySelectorAll("strong, span")).every((el) => el.textContent !== "")).toBe(true);
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  it("walks up to the largest fitting unit", () => {
    expect(relativeTime(now - 5_000, now)).toMatch(/second/);
    expect(relativeTime(now - 5 * 60_000, now)).toMatch(/minute/);
    expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/hour/);
    expect(relativeTime(now - 2 * 86_400_000, now)).toMatch(/day/);
    expect(relativeTime(now - 3 * 7 * 86_400_000, now)).toMatch(/week/);
    expect(relativeTime(now - 60 * 86_400_000, now)).toMatch(/month/);
    expect(relativeTime(now - 800 * 86_400_000, now)).toMatch(/year/);
  });
});
