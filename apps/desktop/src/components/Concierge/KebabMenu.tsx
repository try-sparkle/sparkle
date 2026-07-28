// Top-right kebab menu for Concierge Mode (CM-U6, bead sparkle-1oa2).
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
// changelog + reveal-logs, and this menu's own roving-focus helpers) lives in components/appChrome.ts.
//
// Mount-ready export for the U7 shell: <ConciergeTopRight /> — kebab + avatar cluster,
// styled after the prototype's `.topright` (iconbtn + avatar, gap 8).
import { useEffect, useRef, useState } from "react";
import { FiMoreVertical } from "react-icons/fi";
import { C } from "../../theme/colors";
import { log } from "../../logger";
import { handleMenuArrows, menuItemStyle, menuSurface, ownedMenuItems } from "../appChrome";
import { SettingsDialog } from "../SettingsDialog";
import { AuthStatusButton } from "../AuthStatusButton";
import { ModalShell } from "../ModalShell";
import { AccountsScreen } from "../AccountsScreen";
import { AccountLoginModal } from "../AccountLoginModal";
import { invalidateAccountState } from "../../services/accountSelection";
import type { Account } from "../../services/accountStore";
import { useUiStore } from "../../stores/uiStore";

/**
 * The 3-dot kebab: trigger + dropdown menu + the surfaces its entries open. Keyboard
 * accessible (arrow-key roving focus, Escape closes and restores focus, outside pointerdown
 * dismisses). The heavy surfaces are the existing components, reused.
 */
export function KebabMenu() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointerdown; Escape closes the menu and hands focus back to the trigger.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Menus manage focus: opening one focuses its first item.
  useEffect(() => {
    if (open && menuRef.current) ownedMenuItems(menuRef.current)[0]?.focus();
  }, [open]);

  // Settings deep-open seam: other components request a category via uiStore.openSettings
  // (AuthStatusButton → "accounts", BalanceBadge → "credits"). Once the U7 shell replaces
  // TopBar, this component owns the SettingsDialog, so it honors those requests here. Every
  // close path clears the request so a later request for the SAME category re-triggers.
  const settingsRequest = useUiStore((s) => s.settingsRequest);
  const clearSettingsRequest = useUiStore((s) => s.clearSettingsRequest);
  // A pending request shows the dialog directly (derived, not mirrored into state).
  const settingsVisible = settingsOpen || settingsRequest !== null;
  const closeSettings = () => {
    // For the menu-initiated path, hand focus back to the kebab trigger so keyboard users
    // aren't left with detached focus (roborev 46081). Deep-open requests (settingsRequest)
    // came from another component's trigger, so only restore when WE opened the dialog.
    if (settingsOpen) triggerRef.current?.focus();
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

  const onSettings = () => {
    log.info("kebab", "settings clicked");
    setOpen(false);
    setSettingsOpen(true);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Sparkle menu"
        title="Sparkle menu"
        // Keyboard-hint mnemonic — inherited from the TopBar ⋯ this menu replaces, so a clean ⌘
        // tap still puts the "." chiclet on the app's overflow menu (keyboardHints/hintTargets).
        data-hint="menu"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          // ArrowDown on the closed trigger opens the menu (Enter/Space are native click).
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
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

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Sparkle menu"
          onKeyDown={handleMenuArrows}
          style={{
            ...menuSurface,
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={onSettings}
            title="Open settings"
            style={menuItemStyle}
          >
            Settings
          </button>
        </div>
      )}

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
