// @vitest-environment jsdom
//
// The "chat" settings category: that it exists as its OWN rail entry, that the three words a person
// actually searches for resolve to it, and that the decoupling event opens Settings straight onto
// it from a CLOSED dialog.
//
// Kept out of SettingsDialog.test.tsx deliberately — that file is a multi-branch collision hotspot
// and this is an additive category with its own concerns.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panes the dialog mounts reach for config/IPC on mount; mirror the shell test's stubs so
// nothing shells out under jsdom. PARTIAL, for the reason that file states: an exhaustive factory
// silently undefines every export it forgot.
vi.mock("../services/configActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/configActions")>()),
  setAiFeature: vi.fn().mockResolvedValue(undefined),
  setAllAiFeatures: vi.fn().mockResolvedValue(undefined),
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
  refreshPluginInstallState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("../services/trialApi", () => ({ fetchTrial: vi.fn().mockResolvedValue(null) }));
vi.mock("./CreditsPanel", () => ({ CreditsPanel: () => null }));

import { useUiStore } from "../stores/uiStore";
import { useSocialStore, EMPTY_PROFILE } from "../stores/socialStore";
import { SettingsDialog, OPEN_SOCIAL_SETTINGS_EVENT } from "./SettingsDialog";

/**
 * A stand-in for `KebabMenu`, which owns the real dialog and is outside this change's file set.
 *
 * It copies exactly ONE line of that owner — `settingsVisible = settingsRequest !== null` — because
 * the thing under test is "a CLOSED dialog opens", and asserting that requires something that
 * mounts the dialog in response to the store. The production seam (`settingsRequest`) is asserted
 * directly as well, so a drift in this harness cannot make the test pass on its own.
 */
function SettingsHost() {
  const request = useUiStore((s) => s.settingsRequest);
  if (request === null) return null;
  return (
    <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory={request} />
  );
}

const heading = (name: string) => screen.queryByRole("heading", { name });
const railButton = (name: string) => screen.queryByRole("button", { name });
const search = () => screen.getByLabelText("Search settings") as HTMLInputElement;

beforeEach(() => {
  useUiStore.setState({ settingsRequest: null });
  useSocialStore.setState({ me: EMPTY_PROFILE });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ settingsRequest: null });
});

describe("SettingsDialog — the Chat category", () => {
  it("is its own rail entry that opens the Chat pane", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(heading("Chat")).toBeTruthy();
    // The pane itself, not just the heading — a category routing to the wrong body would still
    // paint the heading, since that comes from the rail entry.
    expect(screen.getByRole("radiogroup", { name: "Availability" })).toBeTruthy();
    expect(screen.getByTestId("chat-username-input")).toBeTruthy();
  });

  it("resolves a deep link straight to the pane (the seam the [+] and the avatar take)", () => {
    render(
      <SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} initialCategory="chat" />,
    );
    expect(heading("Chat")).toBeTruthy();
    expect(heading("AI features")).toBeNull();
  });

  // THE RAIL IS SEARCHABLE, AND THIS IS WHY IT IS NOT PART OF ACCOUNTS (§10). Accounts' keywords
  // are every sign-in word and none of these three; a user looking for "username" would land on a
  // pane about signing in.
  it.each(["username", "discoverable", "availability"])(
    "searching %s resolves to Chat and NOT to Accounts",
    (query) => {
      render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
      fireEvent.change(search(), { target: { value: query } });
      expect(railButton("Chat"), `"${query}" must surface Chat`).toBeTruthy();
      expect(railButton("Accounts"), `"${query}" must not surface Accounts`).toBeNull();
    },
  );

  it("does not swallow searches that belong to other categories", () => {
    render(<SettingsDialog onClose={vi.fn()} onManageAccounts={vi.fn()} />);
    fireEvent.change(search(), { target: { value: "sign out" } });
    expect(railButton("Accounts")).toBeTruthy();
    expect(railButton("Chat")).toBeNull();
  });
});

// The decoupling event. A parallel worker lands the `[+]` that dispatches it; nothing here imports
// from that side, which is the entire point of using an event rather than a call.
describe("SettingsDialog — sparkle:open-social-settings", () => {
  it("OPENS a closed dialog onto the Chat category", () => {
    render(<SettingsHost />);
    // Closed: the host renders nothing at all.
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

    // Dispatched on `window`, which is where the listener is registered — the two must be the same
    // EventTarget or the listener never runs and this test proves nothing.
    fireEvent(window, new CustomEvent(OPEN_SOCIAL_SETTINGS_EVENT));

    // The production seam…
    expect(useUiStore.getState().settingsRequest).toBe("chat");
    // …and what the owner does with it.
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(heading("Chat")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Availability" })).toBeTruthy();
  });

  it("switches an ALREADY-OPEN dialog to the Chat category", () => {
    useUiStore.setState({ settingsRequest: "credits" });
    render(<SettingsHost />);
    expect(heading("Credits")).toBeTruthy();

    fireEvent(window, new CustomEvent(OPEN_SOCIAL_SETTINGS_EVENT));

    expect(heading("Chat")).toBeTruthy();
    expect(heading("Credits")).toBeNull();
  });

  it("ignores an unrelated window event", () => {
    render(<SettingsHost />);
    fireEvent(window, new CustomEvent("sparkle:some-other-thing"));
    expect(useUiStore.getState().settingsRequest).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
