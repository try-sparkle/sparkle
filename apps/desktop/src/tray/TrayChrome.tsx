// The fixed top/bottom chrome of the menu-bar popover, around the scrollable agent dashboard:
//   - TrayHeader: the Sparkle logo + the $ balance pill, then a Recent / Open / New action row
//     that opens project windows (the same actions as the in-app TopBar, driven from the tray).
//   - TrayFooter: a pinned "Quit Sparkle" button — the in-app way to fully exit (closing the
//     main window only hides it behind the tray).
//
// The tray webview is its own JS context, but the Zustand projectStore hydrates from the same
// localStorage, so the Recent list here matches the app's.
import { useState } from "react";
import { C } from "@sparkle/ui";
import { BalanceBadge } from "../components/BalanceBadge";
import { useProjectStore } from "../stores/projectStore";
import { openProjectInWindow, defaultDeps } from "../services/projectWindows";
import { pickProjectFolder, basename } from "../services/dialog";
import { resolveOpenTarget } from "../services/openTarget";
import { quitApp } from "../services/attention";

// Tray opens are always "new window or focus existing" — the tray has no project of its own to
// replace, so replaceCurrent is a no-op (the "new" path never calls it). Label "tray" is this
// popover window; createWindow mints its own opaque label for the project window.
function trayDeps() {
  return defaultDeps(() => {}, useProjectStore.getState().touchProjectOpened, "tray");
}

async function openExisting(projectId: string, afterOpen: () => void) {
  // finally: always close the popover after an open attempt (matches the click → "something
  // happens" expectation); swallow + log a failed open rather than leaving an unhandled rejection
  // and a stuck-open popover.
  try {
    await openProjectInWindow(projectId, "new", trayDeps());
  } catch (e) {
    console.debug("tray: open recent project failed", e);
  } finally {
    afterOpen();
  }
}

// Open / New both pop the folder picker; resolveOpenTarget decides whether the chosen folder is an
// already-known project (reuse) or a new one (create on commit) — same logic as TopBar.startOpen.
async function pickAndOpen(title: string, afterOpen: () => void) {
  const picked = await pickProjectFolder(title);
  if (!picked) return; // user cancelled the picker — take no action, leave the popover as-is
  try {
    const { projects, addProject } = useProjectStore.getState();
    const target = resolveOpenTarget(picked, projects, basename);
    const id = target.kind === "existing" ? target.id : addProject(target.name, target.path);
    await openProjectInWindow(id, "new", trayDeps());
  } catch (e) {
    console.debug("tray: open/new project failed", e);
  } finally {
    afterOpen();
  }
}

const actionBtn = {
  all: "unset" as const,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontSize: 13,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "5px 12px",
  textAlign: "center" as const,
};

/** Logo + balance pill, plus the Recent / Open / New action row. `onAction` fires after any
 *  action so the caller can hide the popover. */
export function TrayHeader({ onAction }: { onAction: () => void }) {
  const projects = useProjectStore((s) => s.projects);
  const [recentOpen, setRecentOpen] = useState(false);
  // Most-recently-opened first, mirroring TopBar's Recent ordering.
  const recent = [...projects].sort((a, b) =>
    (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
  );
  // After any open, collapse the Recent list as well as hiding the popover — the tray window stays
  // mounted while hidden, so a left-open Recent list would still be expanded on the next show.
  const close = () => {
    setRecentOpen(false);
    onAction();
  };

  return (
    <div style={{ background: C.deepForest, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        {/* Same asset the sidebar uses; served from the public root, so the tray webview gets it too. */}
        <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height: 22 }} />
        <BalanceBadge />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button style={{ ...actionBtn, flex: 1 }} onClick={() => setRecentOpen((v) => !v)}>
          Recent ▾
        </button>
        <button style={{ ...actionBtn, flex: 1 }} onClick={() => void pickAndOpen("Open a project — choose its folder", close)}>
          Open
        </button>
        <button
          style={{ ...actionBtn, flex: 1, borderColor: C.teal, background: C.teal }}
          onClick={() => void pickAndOpen("New project — choose or create its folder", close)}
        >
          New
        </button>
      </div>
      {recentOpen && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {recent.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 12, padding: "4px 2px" }}>No recent projects.</div>
          ) : (
            recent.slice(0, 8).map((p) => (
              <button
                key={p.id}
                title={p.rootPath}
                style={{ all: "unset", cursor: "pointer", color: C.cream, fontSize: 13, padding: "6px 8px", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                onClick={() => void openExisting(p.id, close)}
              >
                {p.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Pinned "Quit Sparkle" footer — the in-app full exit. */
export function TrayFooter() {
  return (
    <div style={{ background: C.deepForest, padding: 10, borderTop: `1px solid ${C.forest}` }}>
      <button
        style={{ ...actionBtn, width: "100%", color: C.sienna, borderColor: "rgba(224,83,63,0.5)", boxSizing: "border-box" }}
        onClick={() => quitApp()}
      >
        Quit Sparkle
      </button>
    </div>
  );
}
