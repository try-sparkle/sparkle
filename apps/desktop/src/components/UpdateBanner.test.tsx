// @vitest-environment jsdom
//
// UpdateBanner — the one place the auto-updater speaks to the user, and therefore part of the fix
// for bead sparkle-1ueh3 rather than decoration.
//
// WHY THIS FILE EXISTS AT ALL: nothing in the repo pinned this string. The banner used to say the
// update was "ready — restart to apply now, or it'll apply on next launch" and label its dismiss
// button "On next launch", both of which described the OLD design where `downloadAndInstall()` had
// ALREADY replaced /Applications/Sparkle.app under the running process. That swap is the bug — it
// silently kills the running process's microphone — so the copy had to change with the mechanism.
//
// WHAT THESE ASSERT is narrower than "the string is X": they assert the banner makes no claim the
// implementation cannot keep. The install now happens on restart, or on a quit that reaches the
// Rust exit hook — ⌘Q included since the app menu's Quit item routes through `AppHandle::exit`, but
// NOT a Force Quit, a logout, or a last-window-destroyed quit (see updaterService's header,
// verified against the locked tauri/tao/muda sources). So any promise of an automatic apply is
// still false for some quits, and the negative assertions below are the load-bearing half.
//
// THE QUIT-TIME BAR IS THE OTHER HALF, and it is a safety feature: installing on the way out freezes
// the visible window for seconds, and a user who thinks the app has hung presses ⌘Q again — which,
// before Rust learned to refuse that second exit, killed the process mid-rename and left
// /Applications/Sparkle.app deleted.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applySpy = vi.fn(() => Promise.resolve());
vi.mock("../services/updaterService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/updaterService")>();
  return { ...actual, applyUpdateAndRestart: () => applySpy() };
});

import { UpdateBanner } from "./UpdateBanner";
import { useUpdaterStore, DISMISS_TTL_MS } from "../services/updaterService";

/** Every claim of automatic application, in the shapes someone would plausibly write it. */
const AUTOMATIC_APPLY_CLAIM = /next launch|automatic|by itself|when you quit|on quit|later anyway/i;

beforeEach(() => {
  applySpy.mockClear();
  useUpdaterStore.getState().reset();
});

afterEach(cleanup);

describe("the ready-phase copy makes only claims the implementation can keep", () => {
  it("says the update is DOWNLOADED and that restarting installs it", () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    render(<UpdateBanner />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("0.129.0");
    expect(text).toMatch(/downloaded/i);
    expect(text).toMatch(/restart/i);
    expect(screen.getByRole("button", { name: /restart now/i })).toBeTruthy();
  });

  it("never promises the update will apply on its own", () => {
    // MUTATION THIS PINS: restore `Update ${version} ready — restart to apply now, or it'll apply
    // on next launch.` Nothing else in the repo would notice, and the sentence would be false for
    // every user who quits with ⌘Q — the founder's own habit, and the reason this bead exists.
    useUpdaterStore.getState().setReady("0.129.0", null);
    render(<UpdateBanner />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(AUTOMATIC_APPLY_CLAIM);
  });

  it("does not claim anything is already installed", () => {
    // The payload is in memory; /Applications is untouched until the user restarts. "installed" in
    // the past tense would be the same false claim `staleBuildService` refuses to make.
    useUpdaterStore.getState().setReady("0.129.0", null);
    render(<UpdateBanner />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/is installed|already installed|has been installed/i);
  });

  it("labels the dismiss button with a promise-free 'Later'", () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    render(<UpdateBanner />);

    const dismiss = screen.getByRole("button", { name: /later/i });
    expect(dismiss).toBeTruthy();
    expect(dismiss.getAttribute("aria-label")).not.toMatch(AUTOMATIC_APPLY_CLAIM);
  });
});

describe("the available phase (auto-apply off) still reads correctly", () => {
  it("offers 'Restart to apply' and claims nothing about a download", () => {
    useUpdaterStore.getState().setAvailable("0.129.0", null);
    render(<UpdateBanner />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("0.129.0");
    expect(text).not.toMatch(/downloaded/i);
    expect(text).not.toMatch(AUTOMATIC_APPLY_CLAIM);
    expect(screen.getByRole("button", { name: /restart to apply/i })).toBeTruthy();
  });
});

describe("visibility", () => {
  it("renders nothing while idle", () => {
    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("dismissing hides it, and a decayed dismissal brings it back", () => {
    // MUTATION THIS PINS: make the dismissal permanent again (a boolean nothing clears). The
    // updater's phase guard stops `setReady` ever firing twice, so a permanent dismissal is a
    // silent kill switch for the whole session — see updaterService's DISMISS_TTL_MS.
    useUpdaterStore.getState().setReady("0.129.0", null);
    const view = render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: /later/i }));
    expect(view.container.firstChild).toBeNull();
    expect(useUpdaterStore.getState().dismissedAt).not.toBeNull();

    // What the updater's next poll does once the dismissal is older than one interval. Wrapped in
    // act() because the store write happens outside React's event pipeline, exactly as it does in
    // production (the poll is a timer callback) — without it React never flushes the re-render and
    // the assertion would report "still hidden" for a store that had already been cleared.
    act(() => {
      useUpdaterStore.setState({ dismissedAt: Date.now() - DISMISS_TTL_MS - 1 });
      useUpdaterStore.getState().expireDismissal();
    });
    expect(useUpdaterStore.getState().dismissedAt).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("the primary button drives the real apply+restart path", () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    render(<UpdateBanner />);
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  it("shows a busy state and refuses a second click while restarting", () => {
    useUpdaterStore.getState().setReady("0.129.0", null);
    useUpdaterStore.getState().setBusy(true);
    render(<UpdateBanner />);

    const btn = screen.getByRole("button", { name: /restarting/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("the quit-time install bar (the UI half of the second-⌘Q fix)", () => {
  it("shows the install THROUGH a dismissal — 'Later' was about a banner, not about a freeze", () => {
    // MUTATION THIS PINS: move the `quitInstalling` branch below the `dismissedAt` guard, or drop
    // it entirely. Either way the user who ever clicked "Later" quits into a window that says
    // nothing for the whole multi-second bundle swap — the exact state that produces the second
    // ⌘Q this whole change exists to survive.
    useUpdaterStore.getState().setReady("0.129.0", null);
    useUpdaterStore.getState().dismiss();
    const view = render(<UpdateBanner />);
    expect(view.container.firstChild).toBeNull(); // dismissed, as before

    act(() => {
      useUpdaterStore.getState().setQuitInstalling(true);
    });

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/installing/i);
    expect(text).toContain("0.129.0");
  });

  it("tells the user NOT to force the quit, and offers no button to press", () => {
    // MUTATION THIS PINS: render the ordinary ready-phase bar (with its "Restart now" / "Later"
    // buttons) while quitting. The one gesture that must not be invited here is another quit, and a
    // button is an invitation to press something.
    useUpdaterStore.getState().setReady("0.129.0", null);
    useUpdaterStore.getState().setQuitInstalling(true);
    render(<UpdateBanner />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/quit on its own|don't force|do not force/i);
  });

  it("goes away again if the quit is somehow not completed", () => {
    // The bar must not outlive the install it describes: the exit is resumed in a `finally`, and a
    // process that is still alive after that must not keep claiming a bundle swap is running.
    useUpdaterStore.getState().setReady("0.129.0", null);
    useUpdaterStore.getState().setQuitInstalling(true);
    render(<UpdateBanner />);
    expect(screen.getByRole("status").textContent).toMatch(/installing/i);

    act(() => {
      useUpdaterStore.getState().setQuitInstalling(false);
    });
    expect(screen.getByRole("status").textContent).not.toMatch(/installing/i);
  });
});
