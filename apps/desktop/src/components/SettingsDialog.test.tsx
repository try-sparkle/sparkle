// @vitest-environment jsdom
//
// The redesigned settings dialog (the ⋯ menu): a left rail of categories driving a single
// right pane. We assert the default pane, that clicking a category swaps the pane, and that
// the close affordance fires onClose. The individual controls have their own tests; here we
// only care about the rail/pane shell.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Controls inside the panes persist to config.toml via these actions; mock so no IPC fires
// when a pane mounts or a control is touched.
vi.mock("../services/configActions", () => ({
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
  setAutoApplyUpdates: vi.fn().mockResolvedValue(undefined),
  setNotifyStatus: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
}));

// The Tools pane's Learn-more links open the system browser via plugin-opener; mock so no IPC
// fires when that pane mounts or a link is clicked.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

// The Accounts pane's Sparkle-account block calls these (Tauri IPC / system browser); mock
// the two it fires so no IPC or browser launch happens under jsdom.
vi.mock("../services/sparkleApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/sparkleApi")>();
  return {
    ...actual,
    openSignIn: vi.fn().mockResolvedValue(true),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
});

// The Credits pane has its own component tests (CreditsPanel.test.tsx); the shell test only
// cares that deep-open lands on the right category, so keep the pane body inert here.
vi.mock("./CreditsPanel", () => ({ CreditsPanel: () => null }));

// The Accounts pane's Install ID row calls the Rust trial meter over IPC. Mock it so no IPC
// fires under jsdom; each test drives the resolved/rejected value it needs.
vi.mock("../services/trialApi", () => ({ fetchTrial: vi.fn() }));

import { openSignIn, signOut } from "../services/sparkleApi";
import { fetchTrial } from "../services/trialApi";
import { useAuthStore } from "../stores/authStore";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ me: null, tokenPresent: false, loading: true });
});

const heading = (name: string) => screen.queryByRole("heading", { name });

describe("SettingsDialog", () => {
  it("opens on the AI features pane by default", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    expect(heading("Notifications")).toBeNull();
  });

  it("opens on the requested pane when initialCategory is given (deep-open)", () => {
    render(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("follows an initialCategory change while already open (deep-open into an open dialog)", () => {
    const { rerender } = render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(heading("AI features")).toBeTruthy();
    rerender(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="credits" />,
    );
    expect(heading("Credits")).toBeTruthy();
  });

  it("swaps the pane when a rail category is clicked", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(heading("Notifications")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("marks the selected rail item with aria-current", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByRole("button", { name: "Appearance" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "AI features" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it("fires onClose from the close button", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("fires onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("routes the Accounts pane button to onManageAccounts", () => {
    const onManageAccounts = vi.fn();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={onManageAccounts} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    fireEvent.click(screen.getByRole("button", { name: /Manage accounts/ }));
    expect(onManageAccounts).toHaveBeenCalledTimes(1);
  });

  it("has a Tools category that opens the Tools pane", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(heading("Tools")).toBeTruthy();
    // The pane renders both groups.
    expect(screen.getByText("Your tools")).toBeTruthy();
    expect(screen.getByText("Built into Sparkle")).toBeTruthy();
  });
});

// The rail search: filters the CATEGORIES by label OR their keyword set. A category with no
// visible name match still surfaces via a contained tool's keyword (e.g. "github" → Tools).
describe("SettingsDialog — rail search", () => {
  const search = () => screen.getByLabelText("Search settings") as HTMLInputElement;
  const railButton = (name: string) => screen.queryByRole("button", { name });

  it("filters the rail to categories whose LABEL matches", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "notif" } });
    expect(railButton("Notifications")).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
    expect(railButton("Workers")).toBeNull();
  });

  it("surfaces a category via a CONTAINED item keyword, not just its label", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // "github" isn't any category's label — it's a tool inside Tools. It must still surface Tools.
    fireEvent.change(search(), { target: { value: "github" } });
    expect(railButton("Tools")).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
  });

  it("surfaces BOTH Voice controls and Tools for 'voice' (label + keyword)", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "voice" } });
    expect(railButton("Voice controls")).toBeTruthy(); // label match
    expect(railButton("Tools")).toBeTruthy(); // Deepgram keyword match
    expect(railButton("Workers")).toBeNull();
  });

  it("shows an empty state when nothing matches", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "zzzzznope" } });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
    expect(railButton("AI features")).toBeNull();
  });

  it("restores the full rail when the query is cleared", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "notif" } });
    expect(railButton("AI features")).toBeNull();
    fireEvent.change(search(), { target: { value: "" } });
    expect(railButton("AI features")).toBeTruthy();
    expect(railButton("Tools")).toBeTruthy();
  });
});

// The Sparkle-account block in the Accounts pane. State is driven by the real zustand auth
// store (set directly per test); the sparkleApi calls it fires are mocked above.
describe("SettingsDialog — Sparkle account", () => {
  const openAccountsPane = () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  };
  const me = {
    clerkUserId: "user_123",
    entitled: true,
    balanceCents: 500,
    tokenVersion: 1,
    email: "ada@example.com",
    name: "Ada Lovelace",
  };

  it("shows the signed-in identity (name, via the shared authIdentity) and signs out via sparkleApi + store reset", async () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    // Uses the SAME authIdentity source as the TopBar avatar/label (name → email), so the pane and
    // the top bar can't disagree; with a name present it shows the name, not the email.
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(useAuthStore.getState().tokenPresent).toBe(false));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().me).toBeNull();
    // The pane flips to the signed-out state after the reset.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("disables the button and shows progress while sign-out is in flight", async () => {
    let resolveSignOut!: () => void;
    vi.mocked(signOut).mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveSignOut = resolve)),
    );
    useAuthStore.setState({ loading: false, tokenPresent: true, me });
    openAccountsPane();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const inFlight = screen.getByRole("button", { name: "Signing out…" }) as HTMLButtonElement;
    expect(inFlight.disabled).toBe(true);
    resolveSignOut();
    // The pane flips to the signed-out UI, not just the store.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy());
    expect(useAuthStore.getState().tokenPresent).toBe(false);
  });

  it("re-enables Sign out (still signed in) when signOut rejects — no wedge, no reset", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(signOut).mockRejectedValueOnce(new Error("keychain locked"));
      useAuthStore.setState({ loading: false, tokenPresent: true, me });
      openAccountsPane();
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      const btn = await screen.findByRole("button", { name: "Sign out" });
      await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
      // The failed sign-out must not pretend to have signed out.
      expect(useAuthStore.getState().tokenPresent).toBe(true);
      // Pin the catch block specifically — React also routes noise through console.error.
      expect(consoleError).toHaveBeenCalledWith("Sign out failed:", expect.any(Error));
    } finally {
      consoleError.mockRestore(); // even on assertion failure, don't mask later tests' errors
    }
  });

  it("falls back to email when name missing; shows plain 'Signed in' (never the raw clerkUserId) when neither resolves", () => {
    // name blank → email is the next candidate.
    useAuthStore.setState({
      loading: false,
      tokenPresent: true,
      me: { ...me, name: null },
    });
    openAccountsPane();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    cleanup();
    // Neither name nor email (a degraded /me profile lookup) → NEVER surface the opaque `user_…`
    // clerkUserId; the pane reads a clean "Signed in".
    useAuthStore.setState({
      loading: false,
      tokenPresent: true,
      me: { ...me, email: null, name: null },
    });
    openAccountsPane();
    expect(screen.queryByText("user_123")).toBeNull();
    expect(screen.getByText("Signed in")).toBeTruthy();
  });

  it("still offers Sign out when the token is present but /me failed (offline)", () => {
    useAuthStore.setState({ loading: false, tokenPresent: true, me: null });
    openAccountsPane();
    expect(screen.getByText("Signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("shows the trial line and launches the browser sign-in when signed out", () => {
    useAuthStore.setState({ loading: false, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText(/limited free-trial mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(openSignIn).toHaveBeenCalledTimes(1);
  });

  it("shows a loading line while the auth store is still resolving", () => {
    useAuthStore.setState({ loading: true, tokenPresent: false, me: null });
    openAccountsPane();
    expect(screen.getByText("Checking sign-in status…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});

// The Install ID row in the Accounts pane. It is the identifier on every crash report and usage
// event, so "does it render, and does Copy put the exact value on the clipboard" is the contract.
describe("SettingsDialog — Install ID", () => {
  const INSTALL_ID = "6dacbaa360a5f6f294118408c598f1c8";
  const openAccountsPane = () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
  };
  /** A full TrialMeter (main widened fetchTrial's return type); only installId matters here. */
  const meter = (installId: string) => ({
    installId,
    started: true,
    promptsUsed: 0,
    remaining: null,
    cap: null,
    blocked: false,
    serverConfirmed: false,
  });
  /** Pretend we're inside the real Tauri webview — the row's guard keys on this exact global. */
  const inTauri = () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  };

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(fetchTrial).mockReset();
  });

  it("renders the install id and copies the EXACT value to the clipboard", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(INSTALL_ID));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    openAccountsPane();
    await waitFor(() => expect(screen.getByTestId("install-id").textContent).toBe(INSTALL_ID));

    fireEvent.click(screen.getByRole("button", { name: "Copy install ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTALL_ID));
    // The button confirms rather than silently succeeding.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
  });

  it("says UNAVAILABLE (not 'preview') when the trial command throws inside the real app", async () => {
    // Inside the app the browser-preview wording would be factually wrong, and it would mislead
    // exactly the user who has been asked to read their install ID out to support.
    inTauri();
    vi.mocked(fetchTrial).mockRejectedValue(new Error("no IPC"));
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Install ID unavailable/)).toBeTruthy());
    expect(screen.queryByText(/in this preview/)).toBeNull();
    expect(screen.queryByTestId("install-id")).toBeNull();
  });

  it("degrades when the command resolves an EMPTY id rather than rendering a blank box", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(""));
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Install ID unavailable/)).toBeTruthy());
    expect(screen.queryByTestId("install-id")).toBeNull();
  });

  it("survives a clipboard rejection without throwing or falsely confirming", async () => {
    inTauri();
    vi.mocked(fetchTrial).mockResolvedValue(meter(INSTALL_ID));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    openAccountsPane();
    await waitFor(() => expect(screen.getByTestId("install-id")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Copy install ID" }));

    await waitFor(() => expect(err).toHaveBeenCalled());
    // It must NOT claim success — the id is still on screen and selectable for a manual copy.
    expect(screen.getByRole("button", { name: "Copy install ID" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    err.mockRestore();
  });

  it("does not touch IPC at all outside the Tauri webview (plain-browser dev preview)", async () => {
    // No __TAURI_INTERNALS__ on window.
    openAccountsPane();
    await waitFor(() => expect(screen.getByText(/Not available in this preview/)).toBeTruthy());
    expect(fetchTrial).not.toHaveBeenCalled();
  });
});
