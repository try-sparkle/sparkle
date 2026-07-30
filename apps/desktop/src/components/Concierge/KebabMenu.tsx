// Top-right kebab control for Concierge Mode (CM-U6, bead sparkle-1oa2).
//
// It owns:
//   - Settings → the reused SettingsDialog, including the uiStore.openSettings deep-open
//     seam (AuthStatusButton / BalanceBadge route here once TopBar is gone) and the
//     Manage-accounts hand-off (AccountsScreen → AccountLoginModal)
// plus the adjacent signed-in avatar (the reused AuthStatusButton).
//
// It NO LONGER owns Version / Support / Changelog. Those moved to the always-visible bottom-right
// StatusStrip (components/StatusStrip.tsx) — one home per capability, rather than a copy in a
// collapsed menu and a copy in the strip. The shared machinery they need (version + update check +
// changelog + reveal-logs) lives in components/appChrome.ts.
//
// ── AND IT IS NO LONGER A MENU AT ALL ───────────────────────────────────────────────────────────
// Once Version / Support / Changelog left, the dropdown had exactly ONE entry in it: "Settings".
// A one-item menu is pure friction — two clicks, a roving-focus ring, an Escape layer and an
// outside-pointerdown listener, all to reach the only thing behind it. So the trigger IS the
// Settings button now: one click opens the dialog.
//
// What that deliberately did NOT change — every one of these is a seam something else depends on:
//   • `uiStore.settingsRequest`, the deep-open seam (AuthStatusButton → "accounts", BalanceBadge →
//     "credits", and hooks/useSettingsShortcut's ⌘, ). This component still honours it, and every
//     close path still CLEARS it so a later request for the same category re-triggers.
//   • the Manage-accounts hand-off to AccountsScreen → AccountLoginModal.
//   • Escape dismisses the dialog, and focus returns to this trigger when WE were the one that
//     opened it (a deep-open request came from someone else's trigger — see closeSettings).
//   • `data-hint="menu"`, the ⌘-tap mnemonic inherited from the TopBar ⋯ this replaced.
// The roving-focus helpers in appChrome are still used by StatusStrip, so they stay there.
import { useEffect, useRef, useState } from "react";
import { FiMoreVertical } from "react-icons/fi";
import { C } from "../../theme/colors";
import { log } from "../../logger";
import { SettingsDialog } from "../SettingsDialog";
import { AuthStatusButton } from "../AuthStatusButton";
import { ModalShell } from "../ModalShell";
import { AccountsScreen } from "../AccountsScreen";
import { AccountLoginModal } from "../AccountLoginModal";
import { invalidateAccountState } from "../../services/accountSelection";
import type { Account } from "../../services/accountStore";
import { useUiStore } from "../../stores/uiStore";

/**
 * The 3-dot control: ONE CLICK opens Settings, plus the surfaces that dialog hands off to. There is
 * deliberately no dropdown between the two — see the header for what that removal did and did not
 * change. The heavy surfaces are the existing components, reused.
 */
export function KebabMenu() {
  const [hover, setHover] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);

  // Settings deep-open seam: other components request a category via uiStore.openSettings
  // (AuthStatusButton → "accounts", BalanceBadge → "credits"). Once the U7 shell replaces
  // TopBar, this component owns the SettingsDialog, so it honors those requests here. Every
  // close path clears the request so a later request for the SAME category re-triggers.
  const settingsRequest = useUiStore((s) => s.settingsRequest);
  const clearSettingsRequest = useUiStore((s) => s.clearSettingsRequest);
  // A pending request shows the dialog directly (derived, not mirrored into state).
  const settingsVisible = settingsOpen || settingsRequest !== null;

  // WHERE FOCUS WAS BEFORE THE DIALOG TOOK IT — captured in render, which is the only moment that
  // still knows.
  //
  // `SettingsDialog` focuses itself on mount (`dialogRef.current?.focus()`), and React runs a child's
  // effects BEFORE its parent's, so an effect here always looks too late: `document.activeElement` is
  // already inside the dialog. Render runs first, so this is where the pre-open element still exists.
  // (Reading the DOM in render is safe — nothing is set or mutated — and a double-invoked render is
  // idempotent because `wasVisible` is already true on the second pass.)
  //
  // It exists because "only restore when WE opened it" left every DEEP-OPEN path with DETACHED FOCUS,
  // which is the exact defect roborev 46081 fixed for the menu path. The dialog has focus, so when it
  // unmounts `activeElement` falls to `<body>`; none of the deep-open callers (BalanceBadge,
  // AuthStatusButton, OutOfCreditsNotice, ⌘,) restore anything. It looked fine only because the test's
  // mock never took focus, so a row could assert "focus never moved" and pass (roborev 55563).
  const wasVisible = useRef(false);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);
  if (settingsVisible && !wasVisible.current) {
    focusBeforeOpen.current = document.activeElement as HTMLElement | null;
  }
  wasVisible.current = settingsVisible;

  const closeSettings = () => {
    // WE opened it → the kebab trigger, as before (roborev 46081). Someone ELSE opened it → back to
    // whatever they were on, rather than either stranding focus on `<body>` or yanking it to a control
    // the user never touched.
    //
    // CHECKED FOR STILL BEING ATTACHED, which is not defensive tidiness — a captured node is
    // dereferenced an arbitrary interval later, and `.focus()` on a removed node is a silent no-op in
    // both browsers and jsdom, so focus stays in the dialog and the unmount two lines down drops it on
    // `<body>`. That is the very defect this restore exists to fix, reintroduced invisibly. It is
    // reachable from a caller this code names: `RefillLink` lives in the mic out-of-credits notice,
    // which auto-deactivates after 5s, so the button that deep-opened the Credits pane is gone long
    // before the user finishes reading it (roborev 55595). The trigger is the one node guaranteed to
    // still be here, so it is the fallback.
    // ATTACHED IS NOT FOCUSABLE, and `<body>` is the case that matters. `focusBeforeOpen` is
    // `document.activeElement` at open time, which is `document.body` whenever nothing focusable held
    // focus — click any non-interactive area and press ⌘, and that is exactly what we captured. Also
    // note WKWebView (which Tauri on macOS is) does not focus a button on click, so the deep-open
    // triggers routinely leave `<body>` active. `document.contains(document.body)` is `true`, so an
    // attachment-only check hands back `<body>`, `body.focus()` is a silent no-op, and the unmount two
    // lines down strands focus there — the very defect this restore exists to fix, on the most common
    // path. Same for a node still attached but since hidden/`display:none`/`disabled`.
    //
    // So: reject `<body>` up front, then VERIFY THE OUTCOME rather than trusting `.focus()` to have
    // worked. `.focus()` reports nothing, so checking `activeElement` afterwards is the only way to
    // know, and the trigger is the one node guaranteed to still be here and focusable.
    const prev = focusBeforeOpen.current;
    const stillThere =
      prev !== null && prev !== document.body && document.contains(prev) ? prev : null;
    const restore = (settingsOpen ? triggerRef.current : null) ?? stillThere ?? triggerRef.current;
    // Before the unmount, while the dialog still holds focus — moving it out first is what keeps the
    // removal from dropping focus on the floor.
    restore?.focus?.();
    // Did it actually take? `.focus()` is a silent no-op on anything unfocusable, so it has to be
    // checked rather than assumed — but the check must compare against the INTENDED TARGET, not
    // against "nowhere". At this point the dialog is still mounted and still holds focus
    // (`setSettingsOpen(false)` is the next line), so a failed restore leaves `activeElement` on the
    // dialog container — never `null` and never `<body>`. Testing for "nowhere" here therefore never
    // fires in the case that matters (an attached-but-hidden/`display:none`/`disabled` node), which
    // is exactly the hole roborev 55781 found in the first version of this guard.
    //
    // `contains` tolerates a target that forwards focus to a descendant.
    if (
      !restore ||
      (document.activeElement !== restore && !restore.contains(document.activeElement))
    ) {
      triggerRef.current?.focus?.();
    }
    setSettingsOpen(false);
    clearSettingsRequest();
  };
  // The settings modal is a centered dialog — Escape must dismiss it for keyboard users.
  useEffect(() => {
    if (!settingsVisible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeSettings is stable in behavior (setState + store action).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsVisible]);

  // A TOGGLE, not a one-way open — and it is the KEYBOARD route that needs it.
  //
  // Collapsing the menu into the trigger took a dismiss with it: a second press on ⋯ used to close the
  // dropdown, and `onClick={() => setSettingsOpen(true)}` makes it a no-op that still logs and
  // re-asserts `settingsOpen` (roborev 55477).
  //
  // BUT NOT FOR THE MOUSE, and the first version of this comment claimed otherwise. `SettingsDialog`
  // portals a full-window `inset: 0` scrim through `ModalLayer` whose own `onClick` is `onClose`, and
  // this control sits below it at the concierge column's layer — so a second CLICK lands on the scrim
  // and the scrim dismisses. The mouse dismiss was never broken and is not this branch's (roborev
  // 55563). What is reachable is Tab-back-to-the-trigger + Enter: a scrim does not remove tabbability
  // of what it covers, so the keyboard can still land here, and without this branch that press is the
  // dead no-op described above.
  //
  // Routed through `closeSettings` so it clears `settingsRequest` and restores focus exactly like
  // Escape and the scrim do — a second close path with its own rules is how those drift apart.
  const onSettings = () => {
    if (settingsVisible) {
      log.info("kebab", "settings dismissed");
      closeSettings();
      return;
    }
    log.info("kebab", "settings clicked");
    setSettingsOpen(true);
  };

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        // NO `aria-haspopup` / `aria-expanded`: there is no popup to promise any more. Leaving them
        // would tell a screen-reader user to expect a menu that never opens, which is a worse lie
        // than the one-item menu was.
        aria-label="Settings"
        title="Settings"
        // Keyboard-hint mnemonic — inherited from the TopBar ⋯ this control replaces, so a clean ⌘
        // tap still puts the "." chiclet on the app's overflow control (keyboardHints/hintTargets).
        // The hint KEY stays "menu" even though the dropdown is gone: it names the shell SLOT, and
        // hooks/keyboardHints binds to it. There is no user-visible label on that slot to correct —
        // the chiclet shows only the "." key, and the pun it puns on is the ⋯ GLYPH, which is still
        // what is on screen. So `.` reaching Settings directly is the feature, not stale copy; what
        // WAS stale is the prose calling this an overflow menu, corrected here and in hintTargets.
        data-hint="menu"
        onClick={onSettings}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          // The prototype's `.iconbtn`: quiet at rest, lifts on hover.
          display: "inline-flex",
          background: hover ? "rgba(255,255,255,0.05)" : "transparent",
          border: "none",
          color: hover ? C.cream : C.muted,
          padding: 6,
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        <FiMoreVertical size={16} aria-hidden />
      </button>

      {settingsVisible && (
        <SettingsDialog
          initialCategory={settingsRequest ?? undefined}
          onClose={closeSettings}
          onManageAccounts={() => {
            closeSettings();
            setAccountsOpen(true);
          }}
        />
      )}

      {/* Claude accounts settings (multi Claude Max support), handed off from the settings
          dialog — the same wiring TopBar owns today. Closing invalidates the selection cache
          so per-agent badges pick up any add/rename/remove. */}
      {accountsOpen && (
        <ModalShell
          width={520}
          onCancel={() => {
            setAccountsOpen(false);
            invalidateAccountState();
          }}
        >
          <AccountsScreen
            onLogin={(account) => {
              setAccountsOpen(false);
              setLoginAccount(account);
            }}
          />
        </ModalShell>
      )}

      {/* Interactive `claude login` PTY for a just-added account (AccountsScreen onLogin seam). */}
      {loginAccount && (
        <AccountLoginModal
          account={loginAccount}
          onClose={() => {
            setLoginAccount(null);
            invalidateAccountState();
          }}
        />
      )}
    </div>
  );
}

/**
 * Mount-ready top-right cluster for the U7 shell: the kebab + the signed-in avatar
 * (AuthStatusButton reused as-is — signed in → avatar, returning → "Log in", new → "Sign up").
 */
export function ConciergeTopRight() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <KebabMenu />
      <AuthStatusButton />
    </div>
  );
}
