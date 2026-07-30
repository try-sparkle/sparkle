// @vitest-environment jsdom
//
// The top-right kebab (CM-U6). It is NOT a menu any more: one click opens Settings directly, and
// this suite pins that from both ends — the dialog appears on a single click, and no intermediate
// menu is rendered at any point. Version / Support / Changelog moved OUT into the bottom-right
// StatusStrip (see ../StatusStrip.test.tsx), which is what left the dropdown with a single entry
// and made it pure friction.
//
// Everything else the component owns is still pinned here, because a "just remove the menu" change
// is exactly the kind that quietly takes a seam with it: the uiStore deep-open seam, the
// Manage-accounts hand-off, Escape-to-dismiss, and focus returning to the trigger.
import { useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// THE MOCK TAKES FOCUS ON MOUNT, and its scrim dismisses — because the real one does both, and every
// focus row in this file is a claim about what the REAL layering leaves behind.
//
// `SettingsDialog` runs `dialogRef.current?.focus()` in a mount effect on a `tabIndex={-1}` container,
// and portals an `inset: 0` scrim whose `onClick` is `onClose`. A mock that renders neither made two
// rows here test a situation production never reaches: one asserted "focus never moved" and passed
// only because nothing had taken it, hiding the detached-focus gap on every deep-open path; the other
// measured a click route the real scrim intercepts (roborev 55563). Reproducing just those two
// behaviours is what makes the rows below mean what they say.
vi.mock("../SettingsDialog", () => ({
  SettingsDialog: ({
    onClose,
    onManageAccounts,
    initialCategory,
  }: {
    onClose: () => void;
    onManageAccounts: () => void;
    initialCategory?: string;
  }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      ref.current?.focus();
    }, []);
    return (
      <div ref={ref} tabIndex={-1} data-testid="settings-dialog" data-category={initialCategory ?? ""}>
        <div data-testid="settings-backdrop" onClick={onClose} />
        <button onClick={onClose}>close settings</button>
        <button onClick={onManageAccounts}>manage accounts</button>
      </div>
    );
  },
}));

vi.mock("../AuthStatusButton", () => ({
  AuthStatusButton: () => <button data-testid="auth-status">avatar</button>,
}));

vi.mock("../ModalShell", () => ({
  ModalShell: ({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) => (
    <div data-testid="modal-shell">
      {children}
      <button onClick={onCancel}>cancel shell</button>
    </div>
  ),
}));

vi.mock("../AccountsScreen", () => ({
  AccountsScreen: ({ onLogin }: { onLogin: (a: { id: string }) => void }) => (
    <div data-testid="accounts-screen">
      <button onClick={() => onLogin({ id: "acct-1" })}>login acct-1</button>
    </div>
  ),
}));

vi.mock("../AccountLoginModal", () => ({
  AccountLoginModal: ({
    account,
    onClose,
  }: {
    account: { id: string };
    onClose: () => void;
  }) => (
    <div data-testid="login-modal" data-account={account.id}>
      <button onClick={onClose}>close login</button>
    </div>
  ),
}));

const invalidateAccountStateMock = vi.fn();
vi.mock("../../services/accountSelection", () => ({
  invalidateAccountState: () => invalidateAccountStateMock(),
}));

import { ConciergeTopRight, KebabMenu } from "./KebabMenu";
import { useUiStore } from "../../stores/uiStore";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  act(() => useUiStore.getState().clearSettingsRequest());
});

const trigger = () => screen.getByRole("button", { name: "Settings" });

describe("KebabMenu — ONE CLICK, no menu in between", () => {
  // The precondition is stated on its own line so the "opens on one click" assertion below cannot
  // be read as vacuous: the dialog must be genuinely absent before the click for the click to be
  // what produced it.
  it("renders no dialog until it is clicked, then opens Settings on a SINGLE click", () => {
    render(<KebabMenu />);
    expect(screen.queryByTestId("settings-dialog")).toBeNull();

    fireEvent.click(trigger());

    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
  });

  // THE ACTUAL POINT OF THE CHANGE. A one-item dropdown between the click and Settings was two
  // clicks to reach the only thing behind it. Asserted at BOTH moments — before the click (nothing
  // latent) and after it (the click went straight to the dialog, not to a menu).
  it("never renders an intermediate menu, before or after the click", () => {
    render(<KebabMenu />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);

    fireEvent.click(trigger());

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  // …and it must not ADVERTISE a popup it no longer has. These attributes are what tell a screen
  // reader to expect a menu; leaving them behind would be a worse lie than the menu itself was.
  it("carries no popup semantics on the trigger", () => {
    render(<KebabMenu />);
    const btn = trigger();
    expect(btn.getAttribute("aria-haspopup")).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBeNull();
  });

  // The ⌘-tap mnemonic inherited from the TopBar ⋯ this control replaces. It names the shell slot,
  // so it survives the dropdown's removal — hooks/keyboardHints binds to it.
  it("keeps the keyboard-hint target", () => {
    render(<KebabMenu />);
    expect(trigger().getAttribute("data-hint")).toBe("menu");
  });

  // THE KEYBOARD DISMISS THE DROPDOWN'S REMOVAL TOOK WITH IT.
  //
  // A second press on ⋯ used to close the dropdown; collapsing the menu into the trigger made that
  // press a no-op that still logged (roborev 55477). Scoped to the KEYBOARD deliberately: the real
  // dialog portals a full-window scrim that dismisses on click, so the second MOUSE click never
  // reaches this trigger and that route was never broken (roborev 55563). A scrim does not remove
  // tabbability of what it covers, so Tab-back + Enter does land here — and Enter on a button IS a
  // click event, which is what this drives, with focus on the trigger the way the keyboard leaves it.
  //
  // Asserted on the second AND third press, because a toggle that only ever closes is the same bug
  // facing the other way.
  it("Enter on the focused trigger DISMISSES the dialog it opened, and re-opens it", () => {
    render(<KebabMenu />);
    const press = () => {
      trigger().focus();
      fireEvent.click(trigger());
    };
    press();
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    press();
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    press();
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
  });

  // …and that dismiss goes through the SAME close path, so it clears the deep-open request too.
  // A second close path with its own rules is how the two drift apart: leave the request latched and
  // `settingsVisible` stays true, so the dialog the user just dismissed reappears immediately.
  it("the keyed dismiss clears a deep-open request rather than leaving it latched", () => {
    render(<KebabMenu />);
    act(() => useUiStore.getState().openSettings("credits"));
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    trigger().focus();
    fireEvent.click(trigger());
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(useUiStore.getState().settingsRequest).toBeNull();
  });

  // NO ROW HERE FOR THE SCRIM, deliberately — and the previous commit's attempt is why it is worth
  // stating. `SettingsDialog` is MOCKED in this file, so a row clicking `settings-backdrop` asserts
  // the mock's own `onClick` (authored in that same commit) rather than the real wiring: delete the
  // real backdrop's `onClick` and it stays green, which is exactly the claim it made. jsdom does no
  // hit-testing either, and the mock's backdrop is a CHILD of the dialog rather than a `fixed; inset:
  // 0` portal sibling, so nothing here can observe the covering that makes the mouse route the
  // scrim's (roborev 55595).
  //
  // It was already covered where it can fail: `SettingsDialog.test.tsx`'s "fires onClose when the
  // backdrop is clicked" predates all of this, and removing the real `onClick` reddens it. So the
  // replacement row this file briefly grew was deleted rather than moved — the mock keeps its backdrop
  // only so the focus rows above sit in production's DOM shape.
});

describe("KebabMenu — reused surfaces", () => {
  it("its onClose unmounts the dialog and hands focus back to the trigger", () => {
    render(<KebabMenu />);
    fireEvent.click(trigger());
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("close settings"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    // Focus must not be left detached on a removed node (roborev 46081).
    expect(document.activeElement).toBe(trigger());
  });

  // THE OTHER HALF OF THAT RULE — and the first version of this row asserted the wrong thing.
  //
  // It claimed a deep-open close leaves focus WHERE IT WAS, and passed only because the old mock never
  // took focus. The real dialog focuses itself on mount, so by close time focus is INSIDE it and the
  // unmount drops it on `<body>` — detached focus, the very defect roborev 46081 fixed for the menu
  // path, live on every deep-open caller (BalanceBadge, AuthStatusButton, OutOfCreditsNotice, ⌘,).
  // The row locked that gap in as intended behaviour (roborev 55563).
  //
  // So it asserts the RESTORE now, not the absence of movement: back to the element the user was on,
  // which is neither `<body>` nor a kebab they never touched. The mock takes focus on mount, so this
  // is the same situation production is in.
  it("restores focus to where the user WAS when someone else opened the dialog", () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <KebabMenu />
      </>,
    );
    const other = screen.getByRole("button", { name: "elsewhere" });
    other.focus();
    act(() => useUiStore.getState().openSettings("credits"));
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    // The dialog really did take focus — otherwise the restore below proves nothing.
    expect(document.activeElement).toBe(screen.getByTestId("settings-dialog"));

    fireEvent.click(screen.getByText("close settings"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(document.activeElement).toBe(other);
    // Not the kebab (whose trigger the user never touched) and not `<body>`.
    expect(document.activeElement).not.toBe(trigger());
    expect(document.activeElement).not.toBe(document.body);
  });

  // …AND WHEN THAT ELEMENT IS GONE BY THEN, which is the case the first version of the restore missed.
  //
  // The node is captured at open and used at close, an arbitrary interval later, and `.focus()` on a
  // removed node is a SILENT no-op — so focus stays in the dialog and its unmount drops it on `<body>`:
  // the defect the restore exists to fix, reintroduced invisibly. Not hypothetical for a caller this
  // component names — `RefillLink` sits in the mic out-of-credits notice, which auto-deactivates after
  // 5s, so the trigger is gone well before the user finishes with the Credits pane (roborev 55595).
  // The row above cannot see it, because it keeps `other` mounted for the whole test.
  it("falls back to the trigger when the element it would restore to has since unmounted", () => {
    function Host({ showOther }: { showOther: boolean }) {
      return (
        <>
          {showOther && <button type="button">elsewhere</button>}
          <KebabMenu />
        </>
      );
    }
    const { rerender } = render(<Host showOther />);
    screen.getByRole("button", { name: "elsewhere" }).focus();
    act(() => useUiStore.getState().openSettings("credits"));
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();

    // The deep-open trigger goes away WHILE the dialog is up — the 5s notice expiring.
    act(() => rerender(<Host showOther={false} />));
    expect(screen.queryByRole("button", { name: "elsewhere" })).toBeNull();

    fireEvent.click(screen.getByText("close settings"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    // The whole point: focus is somewhere REAL, not stranded on the body.
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(trigger());
  });

  it("Escape dismisses the settings dialog", () => {
    render(<KebabMenu />);
    fireEvent.click(trigger());
    expect(screen.getByTestId("settings-dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
  });

  it("honors the uiStore deep-open seam (AuthStatusButton → accounts pane)", async () => {
    render(<KebabMenu />);
    act(() => useUiStore.getState().openSettings("accounts"));
    const dialog = await screen.findByTestId("settings-dialog");
    expect(dialog.getAttribute("data-category")).toBe("accounts");
    // Closing clears the request so the SAME category re-triggers later.
    fireEvent.click(screen.getByText("close settings"));
    expect(useUiStore.getState().settingsRequest).toBeNull();
    act(() => useUiStore.getState().openSettings("accounts"));
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("Manage accounts hands off to AccountsScreen, then onLogin to AccountLoginModal", () => {
    render(<KebabMenu />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByText("manage accounts"));
    expect(screen.queryByTestId("settings-dialog")).toBeNull();
    expect(screen.getByTestId("accounts-screen")).toBeTruthy();
    fireEvent.click(screen.getByText("login acct-1"));
    expect(screen.queryByTestId("accounts-screen")).toBeNull();
    const login = screen.getByTestId("login-modal");
    expect(login.getAttribute("data-account")).toBe("acct-1");
    // Closing the login modal invalidates the account-selection cache (badge refresh).
    fireEvent.click(screen.getByText("close login"));
    expect(screen.queryByTestId("login-modal")).toBeNull();
    expect(invalidateAccountStateMock).toHaveBeenCalledOnce();
  });
});

describe("ConciergeTopRight — mount-ready cluster", () => {
  it("renders the kebab with the adjacent reused AuthStatusButton avatar", () => {
    render(<ConciergeTopRight />);
    expect(trigger()).toBeTruthy();
    expect(screen.getByTestId("auth-status")).toBeTruthy();
  });
});
