// Shared app-chrome primitives — the bits the top-right kebab (Concierge/KebabMenu) and the
// bottom-right status strip (StatusStrip) both stand on.
//
// This module exists so the version/update/changelog behavior has exactly ONE home. It used to be
// inlined in KebabMenu (which itself inherited it from the deleted StatusBar); a second consumer
// would have meant a second copy of the stale-check session guard, which is precisely the drift
// this repo keeps paying for. Pure logic + styles only — no JSX, so it unit-tests in isolation.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C } from "../theme/colors";
import { getAppVersion, getLogDir, revealLogs, log } from "../logger";
import { checkForUpdates, type CheckOutcome } from "../services/updaterService";
import { FONT_UI } from "../theme/scale";

export const CHANGELOG_URL = "https://sparkle.ai/changelog";

/** Manual "Check for updates" feedback, shown inline wherever the version popover renders. */
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

/** The app version + log directory, resolved once from Rust. Empty strings until they land. */
export function useAppInfo(): { version: string; logDir: string } {
  const [version, setVersion] = useState<string>("");
  const [logDir, setLogDir] = useState<string>("");
  useEffect(() => {
    getAppVersion()
      .then((v) => setVersion(v ?? ""))
      .catch(() => {});
    getLogDir()
      .then((d) => setLogDir(d ?? ""))
      .catch(() => {});
  }, []);
  return { version, logDir };
}

/**
 * The manual update-check state machine, with the session guard the StatusBar introduced: every
 * open/close of the surface hosting it bumps a generation, so a check whose promise resolves in a
 * DIFFERENT session can never write its stale outcome into the fresh one (and a reopen always
 * starts at "idle" rather than showing the previous session's verdict).
 *
 * `scope` only tags the log lines, so each caller's clicks stay attributable.
 */
export function useVersionCheck(scope: string) {
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const genRef = useRef(0);

  /** Call when the surface OPENS: invalidates any in-flight check and starts fresh. */
  const beginSession = useCallback(() => {
    genRef.current += 1;
    setCheckState("idle");
  }, []);
  /** Call when the surface CLOSES: invalidates any in-flight check. */
  const endSession = useCallback(() => {
    genRef.current += 1;
  }, []);

  /**
   * Run a manual check. Resolves to true when an update is available — the caller closes its
   * surface then, because the update banner takes over the telling.
   */
  const runCheck = useCallback(async (): Promise<boolean> => {
    if (checkState === "checking") return false; // guard double-clicks / re-entry
    log.info(scope, "check for updates clicked");
    setCheckState("checking");
    const gen = genRef.current; // this check belongs to the current session
    let outcome: CheckOutcome;
    try {
      outcome = await checkForUpdates();
    } catch {
      outcome = "error"; // checkForUpdates never throws, but belt-and-suspenders
    }
    // The surface closed (and maybe reopened) since this check started — its result is stale.
    if (genRef.current !== gen) return false;
    if (outcome === "update-available") {
      setCheckState("idle");
      return true;
    }
    setCheckState(outcome === "up-to-date" ? "uptodate" : "error");
    return false;
  }, [checkState, scope]);

  return { checkState, beginSession, endSession, runCheck };
}

/** Open the changelog in the system browser (never in the webview). */
export function openChangelog(scope: string): void {
  log.info(scope, "changelog clicked");
  void openUrl(CHANGELOG_URL).catch((e) => log.error(scope, "open changelog failed", e));
}

/** Reveal the log folder in Finder — the capability the version popover exists to expose. */
export function openLogsInFinder(scope: string): void {
  log.info(scope, "open logs in finder clicked");
  void revealLogs().catch((e) => log.error(scope, "reveal logs failed", e));
}

export const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "7px 10px",
  borderRadius: 4,
  color: C.cream,
  fontSize: 12,
  fontFamily: FONT_UI,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const menuSurface: CSSProperties = {
  minWidth: 200,
  padding: 6,
  background: C.deepForest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
  zIndex: 1000,
};

/** The menuitems a menu container OWNS (excludes items of a nested submenu popover). */
export function ownedMenuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]')).filter(
    (el) => el.closest('[role="menu"]') === container,
  );
}

/** Roving arrow-key focus within one menu container (Home/End jump; wraps at the edges). */
export function handleMenuArrows(e: ReactKeyboardEvent<HTMLDivElement>) {
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
