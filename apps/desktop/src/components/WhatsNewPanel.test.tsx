// @vitest-environment jsdom
//
// The in-app What's New panel. The founder restarted onto v0.102.0, asked "what's different?", and
// the app could not answer — its only changelog affordance sent him to a website 35 releases stale.
// This suite pins the answer.
//
// It drives the REAL data path: only the HTTP seam is mocked, so a payload goes through
// changelogService's parse → semantic sort → partition and out into the DOM. That matters, because
// the failure this feature is most likely to ship is a panel that mounts, fetches, and renders
// NOTHING — every assertion below is therefore on rendered ENTRY CONTENT, never on "a fetch
// happened" or "the store flipped".
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));

const openUrlMock = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrlMock(url) }));

let appVersion = "0.102.0";
vi.mock("../logger", () => ({
  getAppVersion: () => Promise.resolve(appVersion),
  getLogDir: () => Promise.resolve("/tmp/sparkle-logs"),
  revealLogs: () => Promise.resolve(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/updaterService", () => ({ checkForUpdates: () => Promise.resolve("up-to-date") }));

import { WhatsNewPanel } from "./WhatsNewPanel";
import { openChangelog } from "./appChrome";
import { useWhatsNewStore } from "../stores/whatsNewStore";
import { useSettingsStore } from "../stores/settingsStore";
import { CHANGELOG_CACHE_KEY } from "../services/changelogService";

/** A wire-shaped row. `releaseVersion` is explicitly nullable — see the null-version test below. */
function wireEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    slug: "abc1234-a-title",
    shippedAt: "2026-08-12T21:53:18-07:00",
    title: "A title",
    summary: "A summary.",
    bullets: [],
    changeType: "feature",
    categories: ["desktop"],
    links: [],
    surfaces: ["desktop"],
    releaseVersion: "v0.102.0",
    ...over,
  };
}

const RELEASES = [
  wireEntry({
    id: "r102",
    title: "Prompt-free agents",
    summary: "Spawn an agent without typing a prompt first.",
    bullets: ["Spawn with no prompt", "The attention dot tells the truth"],
    releaseVersion: "v0.102.0",
    shippedAt: "2026-08-12T21:53:18-07:00",
  }),
  wireEntry({
    id: "r101",
    title: "Faster project switching",
    summary: "Switching projects no longer stalls.",
    bullets: ["Column state is cached"],
    releaseVersion: "v0.101.0",
    shippedAt: "2026-08-12T18:42:09-07:00",
  }),
  wireEntry({
    id: "r100",
    title: "Plan board polish",
    summary: "The board reads better at a glance.",
    bullets: ["Tighter rows"],
    releaseVersion: "v0.100.0",
    shippedAt: "2026-08-12T15:13:28-07:00",
  }),
];

function respondWith(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Titles currently rendered, in DOM order — the thing the user actually sees. */
function renderedTitles(): string[] {
  return screen
    .queryAllByTestId("whats-new-entry")
    .map((el) => el.querySelector("button span span:nth-of-type(2)")?.textContent ?? "");
}

/** Versions of the entries inside one section, in DOM order. */
function versionsIn(testId: string): string[] {
  const section = screen.queryByTestId(testId);
  if (!section) return [];
  return Array.from(section.querySelectorAll("[data-testid='whats-new-entry']")).map(
    (el) => el.getAttribute("data-version") ?? "",
  );
}

beforeEach(() => {
  appVersion = "0.102.0";
  localStorage.clear();
  useWhatsNewStore.setState({ open: false });
  useSettingsStore.setState({ lastSeenChangelogVersion: null });
  respondWith({ entries: RELEASES });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhatsNewPanel — it renders the FETCHED entries", () => {
  it("auto-opens after an update and shows what shipped in the running version", async () => {
    // The user was on v0.99.0 and the app has relaunched onto v0.102.0.
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);

    expect(await screen.findByTestId("whats-new-panel")).toBeTruthy();
    // The real payload's content is on screen — not a placeholder, not an empty shell.
    expect(await screen.findByText("Prompt-free agents")).toBeTruthy();
    expect(screen.getByText("Spawn an agent without typing a prompt first.")).toBeTruthy();
  });

  it("leads with EVERY release the user skipped, not merely the newest", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-current");
    await waitFor(() =>
      expect(versionsIn("whats-new-current")).toEqual(["v0.102.0", "v0.101.0", "v0.100.0"]),
    );
    expect(screen.getByText("Faster project switching")).toBeTruthy();
    expect(screen.getByText("Plan board polish")).toBeTruthy();
  });

  it("orders releases SEMANTICALLY — v0.102.0 above v0.99.0, which a string sort inverts", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.98.0" });
    respondWith({
      entries: [
        // Deliberately fed newest-LAST, and chosen so lexicographic order is the reverse of correct.
        wireEntry({ id: "a", title: "Older", releaseVersion: "v0.99.0", shippedAt: "" }),
        wireEntry({ id: "b", title: "Newer", releaseVersion: "v0.102.0", shippedAt: "" }),
      ],
    });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-current");
    await waitFor(() => expect(versionsIn("whats-new-current")).toEqual(["v0.102.0", "v0.99.0"]));
  });

  it("a NULL releaseVersion does not blank the list — every row still renders", async () => {
    // serde emits `"releaseVersion": null` for a Rust Option::None. An all-or-nothing parser that
    // rejects it renders an EMPTY panel forever with nothing logged; that has shipped here before.
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    respondWith({
      entries: [
        wireEntry({ id: "unstamped", title: "Not yet released", releaseVersion: null }),
        ...RELEASES,
      ],
    });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-panel");
    await waitFor(() => expect(renderedTitles()).toHaveLength(4));
    expect(screen.getByText("Not yet released")).toBeTruthy();
    expect(screen.getByText("Prompt-free agents")).toBeTruthy();
    // The unstamped entry is never claimed as part of a release the user could have been running.
    expect(versionsIn("whats-new-current")).toEqual(["v0.102.0", "v0.101.0", "v0.100.0"]);
  });

  it("renders a payload delivered as a BARE ARRAY, not just the wrapped form", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    respondWith(RELEASES);
    render(<WhatsNewPanel />);
    expect(await screen.findByText("Prompt-free agents")).toBeTruthy();
  });
});

describe("WhatsNewPanel — the first run must not dump the backlog", () => {
  it("does NOT auto-open when nothing has been recorded, and seeds the running version", async () => {
    render(<WhatsNewPanel />);
    await waitFor(() =>
      expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0"),
    );
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });

  it("shows ONLY the current release as new when opened by hand on a first run", async () => {
    render(<WhatsNewPanel />);
    await waitFor(() =>
      expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0"),
    );
    act(() => openChangelog("test"));
    await screen.findByTestId("whats-new-current");
    // One release is "new to you". The other 2 are still readable, as scrollable history.
    await waitFor(() => expect(versionsIn("whats-new-current")).toEqual(["v0.102.0"]));
    expect(versionsIn("whats-new-history")).toEqual(["v0.101.0", "v0.100.0"]);
  });
});

describe("WhatsNewPanel — auto-open fires once per new version", () => {
  it("does not re-open on the next launch once it has been dismissed", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    const first = render(<WhatsNewPanel />);
    expect(await screen.findByTestId("whats-new-panel")).toBeTruthy();

    // Dismiss it, the way the user does.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();

    // Relaunch onto the SAME version: the panel must stay shut.
    first.unmount();
    render(<WhatsNewPanel />);
    await waitFor(() =>
      expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0"),
    );
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });

  it("opens again on the NEXT new version", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.102.0" });
    const first = render(<WhatsNewPanel />);
    await waitFor(() => expect(screen.queryByTestId("whats-new-panel")).toBeNull());
    first.unmount();

    appVersion = "0.103.0";
    render(<WhatsNewPanel />);
    expect(await screen.findByTestId("whats-new-panel")).toBeTruthy();
  });

  it("stays shut on a DOWNGRADE (a lexicographic compare would open here)", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.102.0" });
    appVersion = "0.99.0";
    render(<WhatsNewPanel />);
    // Give the version resolution a chance to land before asserting the absence.
    await waitFor(() => expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0"));
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });
});

describe("WhatsNewPanel — title + summary visible, bullets on expand", () => {
  it("keeps an earlier release's bullets hidden until its row is opened", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.101.0" });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-history");

    // v0.101.0 sits in history, collapsed: its summary reads, its bullets don't.
    await waitFor(() => expect(screen.getByText("Switching projects no longer stalls.")).toBeTruthy());
    expect(screen.queryByText("Column state is cached")).toBeNull();

    const row = screen.getByText("Faster project switching").closest("button")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Column state is cached")).toBeTruthy();
  });

  it("opens the new-to-you release already expanded — it is what the user came for", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.101.0" });
    render(<WhatsNewPanel />);
    expect(await screen.findByText("Spawn with no prompt")).toBeTruthy();
  });
});

describe("WhatsNewPanel — offline is a quiet note, never an error wall", () => {
  it("shows the CACHED releases with a 'may be out of date' note when the fetch fails", async () => {
    // A previous successful run left a cache behind.
    localStorage.setItem(
      CHANGELOG_CACHE_KEY,
      JSON.stringify({
        fetchedAt: 1,
        entries: [wireEntry({ id: "r102", title: "Prompt-free agents", releaseVersion: "v0.102.0" })],
      }),
    );
    fetchMock.mockRejectedValue(new Error("offline"));
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);

    expect(await screen.findByText("Prompt-free agents")).toBeTruthy();
    expect(screen.getByTestId("whats-new-stale-note")).toBeTruthy();
  });

  it("shows no stale note on a healthy fetch", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);
    await screen.findByText("Prompt-free agents");
    expect(screen.queryByTestId("whats-new-stale-note")).toBeNull();
  });

  it("notes the server's own degraded answer while still rendering the rows", async () => {
    respondWith({ entries: RELEASES, databaseUnavailable: true });
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);
    expect(await screen.findByText("Prompt-free agents")).toBeTruthy();
    expect(screen.getByTestId("whats-new-stale-note")).toBeTruthy();
  });

  it("offers 'View online' instead of an error when there is nothing at all to show", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-panel");
    const online = await screen.findByRole("button", { name: /View online/ });
    fireEvent.click(online);
    expect(openUrlMock).toHaveBeenCalledWith("https://sparkle.ai/changelog");
  });
});

describe("WhatsNewPanel — dismissal", () => {
  it("Escape closes it", async () => {
    useSettingsStore.setState({ lastSeenChangelogVersion: "0.99.0" });
    render(<WhatsNewPanel />);
    await screen.findByTestId("whats-new-panel");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });

  it("renders nothing at all while closed", () => {
    render(<WhatsNewPanel />);
    expect(screen.queryByTestId("whats-new-panel")).toBeNull();
  });

  it("does not fetch until it is opened — a launch that never shows it costs no network", async () => {
    render(<WhatsNewPanel />);
    await waitFor(() =>
      expect(useSettingsStore.getState().lastSeenChangelogVersion).toBe("0.102.0"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => openChangelog("test"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
