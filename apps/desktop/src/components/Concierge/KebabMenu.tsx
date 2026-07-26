// Top-right kebab menu for Concierge Mode (CM-U6, bead sparkle-1oa2).
//
// Relocates the chrome the concierge shell (U7) removes from StatusBar/TopBar:
//   - Version ▸ a popover with Check for updates / Open logs in Finder / Changelog
//     (the StatusBar version-popover behavior, including its stale-check session guard)
//   - Support  → the reused SupportModal
//   - Settings → the reused SettingsDialog, including the uiStore.openSettings deep-open
//     seam (AuthStatusButton / BalanceBadge route here once TopBar is gone) and the
//     Manage-accounts hand-off (AccountsScreen → AccountLoginModal)
// plus the adjacent signed-in avatar (the reused AuthStatusButton).
//
// Mount-ready export for the U7 shell: <ConciergeTopRight /> — kebab + avatar cluster,
// styled after the prototype's `.topright` (iconbtn + avatar, gap 8).
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  FiAlertTriangle,
  FiCheck,
  FiChevronLeft,
  FiMoreVertical,
  FiRefreshCw,
} from "react-icons/fi";
import { C } from "../../theme/colors";
import { getAppVersion, getLogDir, revealLogs, log } from "../../logger";
import { checkForUpdates, type CheckOutcome } from "../../services/updaterService";
import { SupportModal } from "../SupportModal";
import { SettingsDialog } from "../SettingsDialog";
import { AuthStatusButton } from "../AuthStatusButton";
import { ModalShell } from "../ModalShell";
import { AccountsScreen } from "../AccountsScreen";
import { AccountLoginModal } from "../AccountLoginModal";
import { invalidateAccountState } from "../../services/accountSelection";
import type { Account } from "../../services/accountStore";
import { useUiStore } from "../../stores/uiStore";

export const CHANGELOG_URL = "https://sparkle.ai/changelog";

/** Manual "Check for updates" feedback, shown inline in the version popover (mirrors StatusBar). */
export type CheckState = "idle" | "checking" | "uptodate" | "error";

/** The exact strings the user reads for each manual-check state — pure so tests pin them. */
export function checkLabel(state: CheckState): string {
  switch (state) {
    case "checking":
      return "Checking for updates…";
    case "uptodate":
      return "You're up to date";
    case "error":
      return "Check failed — retry";
    default:
      return "Check for updates";
  }
}

const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "7px 10px",
  borderRadius: 5,
  color: C.cream,
  fontSize: 12.5,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const menuSurface: CSSProperties = {
  minWidth: 200,
  padding: 6,
  background: C.deepForest,
  border: `1px solid ${C.forest}`,
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
  zIndex: 1000,
};

/** The menuitems a menu container OWNS (excludes items of a nested submenu popover). */
function ownedMenuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (el) => el.closest('[role="menu"]') === container,
  );
}

/** Roving arrow-key focus within one menu container (Home/End jump; wraps at the edges). */
function handleMenuArrows(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = ownedMenuItems(e.currentTarget);
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation(); // a nested submenu handles its own arrows — don't also move the parent's
  const idx = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home"
      ? items[0]
      : e.key === "End"
        ? items[items.length - 1]
        : e.key === "ArrowDown"
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
  next?.focus();
}

/**
 * The 3-dot kebab: trigger + dropdown menu + the surfaces its entries open. Keyboard
 * accessible (arrow-key roving focus, Escape peels one layer and restores focus, outside
 * pointerdown dismisses). The heavy surfaces are the existing components, reused.
 */
export function KebabMenu() {
  const [open, setOpen] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [version, setVersion] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const [supportOpen, setSupportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [loginAccount, setLoginAccount] = useState<Account | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const versionItemRef = useRef<HTMLButtonElement>(null);
  const versionMenuRef = useRef<HTMLDivElement>(null);
  // Bumped on every version-popover open/close so an in-flight manual check whose promise
  // resolves in a DIFFERENT session can't write its stale result (mirrors StatusBar).
  const checkGenRef = useRef(0);

  useEffect(() => {
    getAppVersion()
      .then(setVersion)
      .catch(() => {});
    getLogDir()
      .then(setLogDir)
      .catch(() => {});
  }, []);

  // Each version-popover open/close is a new check session: invalidate any in-flight check's
  // result, and start every OPEN fresh so a prior outcome never lingers on reopen (mirrors
  // StatusBar's semantics, done in the toggle handlers rather than an effect).
  const openVersionPopover = () => {
    checkGenRef.current += 1;
    setCheckState("idle");
    setVersionOpen(true);
  };
  const closeVersionPopover = () => {
    checkGenRef.current += 1;
    setVersionOpen(false);
  };

  const closeAll = () => {
    closeVersionPopover();
    setOpen(false);
  };

  // Dismiss on outside pointerdown; Escape peels the deepest layer first (version popover,
  // then the menu) and hands focus back to what opened it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeAll();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (versionOpen) {
        closeVersionPopover();
        versionItemRef.current?.focus();
      } else {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // The close helpers are stable in behavior (setState + a ref bump); open/versionOpen
    // drive the layers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, versionOpen]);

  // Menus manage focus: entering a layer focuses its first item.
  useEffect(() => {
    if (open && menuRef.current) ownedMenuItems(menuRef.current)[0]?.focus();
  }, [open]);
  useEffect(() => {
    if (versionOpen && versionMenuRef.current) ownedMenuItems(versionMenuRef.current)[0]?.focus();
  }, [versionOpen]);

  const onCheckForUpdates = async () => {
    if (checkState === "checking") return; // guard double-clicks / re-entry
    log.info("kebab", "check for updates clicked");
    setCheckState("checking");
    const gen = checkGenRef.current; // this check belongs to the current popover session
    let outcome: CheckOutcome;
    try {
      outcome = await checkForUpdates();
    } catch {
      outcome = "error"; // checkForUpdates never throws, but belt-and-suspenders
    }
    // The popover closed (and maybe reopened) since this check started — its result is stale.
    if (checkGenRef.current !== gen) return;
    if (outcome === "update-available") {
      // The update banner now surfaces it — close the menu so it isn't covered.
      setCheckState("idle");
      closeAll();
    } else {
      setCheckState(outcome === "up-to-date" ? "uptodate" : "error");
    }
  };

  const onShowLogs = () => {
    log.info("kebab", "open logs in finder clicked");
    closeAll();
    void revealLogs().catch((e) => log.error("kebab", "reveal logs failed", e));
  };

  const onChangelog = () => {
    log.info("kebab", "changelog clicked");
    closeAll();
    void openUrl(CHANGELOG_URL).catch((e) => log.error("kebab", "open changelog failed", e));
  };

  const onSupport = () => {
    log.info("kebab", "support clicked");
    closeAll();
    setSupportOpen(true);
  };

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
    closeAll();
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
        onClick={() => (open ? closeAll() : setOpen(true))}
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
          borderRadius: 8,
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
          <div style={{ position: "relative" }}>
            <button
              ref={versionItemRef}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={versionOpen}
              title="Sparkle version"
              // Only actionable once the version has resolved — nothing useful to show before.
              // aria-disabled (not disabled) keeps it in the roving-focus order (roborev 46081).
              aria-disabled={!version}
              onClick={() =>
                version && (versionOpen ? closeVersionPopover() : openVersionPopover())
              }
              style={menuItemStyle}
            >
              <FiChevronLeft aria-hidden size={13} style={{ flex: "0 0 auto" }} />
              {version ? `Version v${version}` : "Version …"}
            </button>
            {versionOpen && (
              <div
                ref={versionMenuRef}
                role="menu"
                aria-label="Version"
                onKeyDown={handleMenuArrows}
                style={{
                  ...menuSurface,
                  position: "absolute",
                  top: 0,
                  // The kebab hugs the app's right edge, so the popover opens LEFT of the menu.
                  right: "calc(100% + 6px)",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  // aria-disabled keeps the item focusable mid-check so roving focus doesn't
                  // lose its anchor (roborev 46081); onCheckForUpdates re-entry-guards itself.
                  onClick={() => void onCheckForUpdates()}
                  aria-disabled={checkState === "checking"}
                  title="Check for a newer Sparkle version"
                  style={{
                    ...menuItemStyle,
                    cursor: checkState === "checking" ? "default" : "pointer",
                  }}
                >
                  {checkState === "uptodate" ? (
                    <FiCheck aria-hidden size={13} style={{ flex: "0 0 auto" }} />
                  ) : checkState === "error" ? (
                    <FiAlertTriangle aria-hidden size={13} style={{ flex: "0 0 auto" }} />
                  ) : (
                    <FiRefreshCw aria-hidden size={13} style={{ flex: "0 0 auto" }} />
                  )}
                  {checkLabel(checkState)}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={onShowLogs}
                  title={logDir ? `Open ${logDir} in Finder` : "Open the log folder in Finder"}
                  style={menuItemStyle}
                >
                  Open logs in Finder →
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-hint="changelog"
                  onClick={onChangelog}
                  title="Open the Sparkle changelog"
                  style={menuItemStyle}
                >
                  Changelog
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            data-hint="support"
            onClick={onSupport}
            title="Get help or open a support ticket"
            style={menuItemStyle}
          >
            Support
          </button>
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

      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}

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
