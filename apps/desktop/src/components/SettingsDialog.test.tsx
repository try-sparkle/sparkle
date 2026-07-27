// @vitest-environment jsdom
//
// The redesigned settings dialog (the ⋯ menu): a left rail of categories driving a single
// right pane. We assert the default pane, that clicking a category swaps the pane, and that
// the close affordance fires onClose. The individual controls have their own tests; here we
// only care about the rail/pane shell.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Controls inside the panes persist to config.toml via these actions; mock so no IPC fires
// when a pane mounts or a control is touched. PARTIAL (spreads the real module) because this
// dialog renders whole panes: an exhaustive factory silently makes every export it forgot
// `undefined`, and the Tools pane calls one of them in a mount effect — so a forgotten name is a
// crash on render in a file that is not even about that pane.
vi.mock("../services/configActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/configActions")>()),
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  // Every OTHER writer the rendered panes can reach, too. The spread protects against a name this
  // file forgot; these protect against the real writer RUNNING — setPluginEnabled and
  // setRoborevEnabled kick installers, not just a config write, so a future test that clicks one
  // of those switches would shell out for real and fail as a swallowed rejection.
  setPluginEnabled: vi.fn().mockResolvedValue(undefined),
  setRoborevEnabled: vi.fn().mockResolvedValue(undefined),
  setBuilderIndexEnabled: vi.fn().mockResolvedValue(undefined),
  refreshPluginInstallState: vi.fn().mockResolvedValue(undefined),
}));
// (The notification and auto-update toggles are settingsStore actions, not configActions exports —
// store-only, no IPC — so there is nothing to stub for them.)

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

// The 1Password pane probes the `op` CLI and lists vaults over IPC on mount. It has its own
// component tests; the shell test only cares that the category routes to it, so keep it inert.
vi.mock("./OnePasswordPane", () => ({
  OnePasswordPane: () => <div data-testid="onepassword-pane" />,
}));

import { openSignIn, signOut } from "../services/sparkleApi";
import { fetchTrial } from "../services/trialApi";
import { useAuthStore } from "../stores/authStore";
import { useSettingsStore } from "../stores/settingsStore";
import { SettingsDialog } from "./SettingsDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuthStore.setState({ me: null, tokenPresent: false, loading: true });
  useSettingsStore.setState({ onepasswordEnabled: false });
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

// The 1Password category follows its Tools switch. Without this pane the feature is unreachable:
// the vault picker, the per-file backup table and the worktree-seeding consent all live here, so
// "the switch is on but the pane never mounts" is the shipping failure these pin.
describe("SettingsDialog — 1Password category (follows the Tools switch)", () => {
  const OP_LABEL = "1Password";
  const enableOp = () => useSettingsStore.setState({ onepasswordEnabled: true });

  it("is absent from the rail, from search, and from deep-linking while the tool is off", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="onepassword" />);
    expect(screen.queryByRole("button", { name: OP_LABEL })).toBeNull();
    // A deep link to a category this install doesn't have falls back to the first pane.
    expect(heading("AI features")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "vault" } });
    expect(screen.queryByRole("button", { name: OP_LABEL })).toBeNull();
  });

  it("appears and renders the 1Password pane once the tool is switched on", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: OP_LABEL }));
    expect(heading(OP_LABEL)).toBeTruthy();
    expect(screen.getByTestId("onepassword-pane")).toBeTruthy();
  });

  it("resolves a onepassword DEEP LINK straight to the pane", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="onepassword" />);
    expect(heading(OP_LABEL)).toBeTruthy();
    expect(screen.getByTestId("onepassword-pane")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("is reachable by searching for what it does ('dotenv', 'secrets') when enabled", () => {
    enableOp();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "dotenv" } });
    expect(screen.getByRole("button", { name: OP_LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
  });
});

// Cloud Agents (Service B) ships dark: the "Claude auth for cloud agents" category exists ONLY for
// an account the server advertised `cloudAgentsEnabled` to. These pin both halves — invisible by
// default (the local-only user's experience is unchanged) and reachable by deep link when on.
describe("SettingsDialog — cloudauth category (server-gated)", () => {
  const CLOUD_LABEL = "Claude auth for cloud agents";
  const enableCloud = () =>
    useAuthStore.setState({
      tokenPresent: true,
      loading: false,
      me: {
        clerkUserId: "user_1",
        entitled: true,
        balanceCents: 5000,
        tokenVersion: 1,
        cloudAgentsEnabled: true,
      },
    });

  it("is absent from the rail, from search, and from deep-linking when the server hasn't enabled it", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="cloudauth" />);
    expect(screen.queryByRole("button", { name: CLOUD_LABEL })).toBeNull();
    // A deep link to a category this account doesn't have falls back to the first pane rather than
    // rendering an empty dialog.
    expect(heading("AI features")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "cloud" } });
    expect(screen.queryByRole("button", { name: CLOUD_LABEL })).toBeNull();
  });

  it("appears and renders the Claude-auth pane once the server advertises the capability", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: CLOUD_LABEL }));
    expect(heading(CLOUD_LABEL)).toBeTruthy();
    expect(screen.getByTestId("cloudauth-current")).toBeTruthy();
  });

  it("resolves a cloudauth DEEP LINK straight to the pane (gating.ts's deepLink target)", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="cloudauth" />);
    expect(heading(CLOUD_LABEL)).toBeTruthy();
    expect(screen.getByTestId("cloudauth-current")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  it("is reachable by searching for 'byok' / 'sandbox' when enabled", () => {
    enableCloud();
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "byok" } });
    expect(screen.getByRole("button", { name: CLOUD_LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workers" })).toBeNull();
  });

  it("stays hidden for a signed-OUT user even if a stale capability sits in the store", () => {
    useAuthStore.setState({
      tokenPresent: false,
      loading: false,
      me: {
        clerkUserId: "user_1",
        entitled: true,
        balanceCents: 5000,
        tokenVersion: 1,
        cloudAgentsEnabled: true,
      },
    });
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    expect(screen.queryByRole("button", { name: CLOUD_LABEL })).toBeNull();
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

  it("matches a MULTI-WORD query per term, not as one adjacent phrase", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // "wake" and "microphone" both live in Voice controls' keywords but not next to each other, so
    // the old raw-substring match found nothing and the user got "No settings match" for a query
    // that describes exactly one category.
    fireEvent.change(search(), { target: { value: "wake microphone" } });
    expect(railButton("Voice controls")).toBeTruthy();
    expect(railButton("Workers")).toBeNull();
    // Every term is still REQUIRED — this is a filter, not a fuzzy any-of.
    fireEvent.change(search(), { target: { value: "wake keyboard" } });
    expect(railButton("Voice controls")).toBeNull();
  });

  it("matches a query that mixes a category's LABEL with one of its keywords", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // The natural way to search: name the thing, then the detail. These span label and keywords,
    // which a strictly per-entry match would split apart — and did, for a while, on every category
    // whose pane doesn't filter rows.
    for (const [q, label] of [
      ["mobile pair", "Mobile"],
      ["voice wake", "Voice controls"],
      ["shortcuts hotkeys", "Shortcuts"],
    ] as const) {
      fireEvent.change(search(), { target: { value: q } });
      expect(railButton(label), `searching "${q}" must still find ${label}`).toBeTruthy();
    }
  });

  it("does NOT surface Tools for terms that live in different rows", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    // Tools is the one category whose pane filters its own rows, so the rail has to ask the pane's
    // question: is there ONE row with all these terms? "deepgram" and "beads" are different rows —
    // surfacing Tools here would open a pane that immediately renders "No tools match".
    fireEvent.change(search(), { target: { value: "deepgram beads" } });
    expect(railButton("Tools")).toBeNull();
    // …while a query inside a single row still surfaces it.
    fireEvent.change(search(), { target: { value: "deepgram dictation" } });
    expect(railButton("Tools")).toBeTruthy();
  });

  /** Rows currently rendered by the Tools pane, counted from the DOM. */
  const toolRows = () => screen.queryAllByTestId("tool-row").length;

  it("searching a category's NAME opens its pane with EVERY row, not an empty one", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();
    expect(unfiltered).toBeGreaterThan(0);

    // No Tools row contains the word "tools" — it is the category's LABEL, not row text. The rail
    // surfaces Tools (right), and the pane must then show its rows rather than filtering them all
    // away, which is what forwarding the query verbatim did.
    fireEvent.change(search(), { target: { value: "tools" } });
    expect(railButton("Tools")).toBeTruthy();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    // EVERY row, counted — "some switch exists" would also pass for a partial-clear regression.
    expect(toolRows()).toBe(unfiltered);
  });

  it("narrows inside a category when the query names it AND a row", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    // "tools github" is how people actually search: name the category, then narrow inside it. The
    // rail has to keep the category (dropping it is worse than an empty pane — the user loses the
    // route entirely) and the pane has to filter by the part that isn't the label.
    fireEvent.change(search(), { target: { value: "tools github" } });
    expect(railButton("Tools"), 'the rail must still offer Tools for "tools github"').toBeTruthy();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    expect(toolRows()).toBeGreaterThan(0);
    expect(toolRows(), "the row filter must still apply to the non-label terms").toBeLessThan(unfiltered);
  });

  it("keeps narrowing when the query matches NOTHING, instead of swinging back to every row", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    fireEvent.change(search(), { target: { value: "deepgram" } });
    const narrowed = toolRows();
    expect(narrowed).toBeLessThan(unfiltered);

    // One more character and the query matches nothing anywhere. That is still a query about THIS
    // pane — the user narrowed past the last row — so it must show its empty state, not swing back
    // to every row. Standing down on "the filter came back empty" did exactly that.
    fireEvent.change(search(), { target: { value: "deepgramx" } });
    expect(screen.getByText(/No settings match/)).toBeTruthy();
    expect(toolRows(), "the pane must not expand when a query stops matching").toBeLessThanOrEqual(narrowed);
    expect(screen.queryByText(/No tools match/)).toBeTruthy();

    // Same in the label form, where the label terms are stripped before filtering.
    fireEvent.change(search(), { target: { value: "tools deepgramx" } });
    expect(toolRows()).toBeLessThanOrEqual(narrowed);
  });

  it("leaves the pane you're standing in alone when the query is about a different category", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    const unfiltered = toolRows();

    // Typing "credits" while on Tools narrows the rail to Credits — correct — but the Tools pane is
    // still mounted. The query was never about its rows, so filtering them to nothing and rendering
    // "No tools match" would be a dead end in the pane the user is actually looking at.
    fireEvent.change(search(), { target: { value: "credits" } });
    expect(railButton("Credits")).toBeTruthy();
    expect(railButton("Tools")).toBeNull();
    expect(screen.queryByText(/No tools match/)).toBeNull();
    expect(toolRows()).toBe(unfiltered);
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
