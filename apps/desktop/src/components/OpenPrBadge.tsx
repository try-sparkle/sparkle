// "N PRs waiting" in the TopBar, left of the Recent/Open cluster.
//
// The problem it solves: work that reaches a pull request can stall invisibly. The per-agent CTA
// already offers "Merge PR", but it lives on the agent's row — and every agent runs in its own
// worktree and leaves the sidebar when its session ends, taking the signal with it. So a PR is
// visible only during the session that opened it, which is exactly when it is NOT yet ready to
// merge. This badge is repo-scoped and agent-independent, which is the whole point.
//
// See PRD/sparkle-pr-awaiting-merge-badge.md.
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../theme/colors";
import { fetchOpenPrCount, formatPrBadge, OPEN_PR_POLL_MS } from "../services/openPrs";
import { log } from "../logger";

export function OpenPrBadge({ rootPath }: { rootPath: string | null }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setCount(null);
      return;
    }
    // Clear on switch. `alive` stops the OLD project's resolved value painting onto the new one,
    // but without this the old COUNT stays on screen until the new probe returns — up to the
    // network timeout — so one repo's number is briefly displayed under another repo's name.
    setCount(null);
    let alive = true;
    const tick = () => {
      void fetchOpenPrCount(rootPath).then((n) => {
        // Guard the async result against unmount AND against a project switch mid-flight, so a
        // slow probe for the previous project can't paint its count onto the new one.
        if (alive) setCount(n);
      });
    };
    tick();
    const id = window.setInterval(tick, OPEN_PR_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [rootPath]);

  const label = formatPrBadge(count);
  if (!label) return null; // nothing waiting, or we couldn't find out — both render nothing

  return (
    <button
      data-testid="open-pr-badge"
      title="Open pull requests you have waiting. Click to review them on GitHub."
      onClick={() => {
        // `gh` resolves the repo from the working directory, so the browser hand-off goes through
        // the same Rust command rather than a URL assembled here from a guessed remote.
        void openPrListInBrowser(rootPath).catch((e) =>
          log.warn("[open-pr-badge] could not open the PR list", e),
        );
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: `1px solid ${C.violet}`,
        borderRadius: 6,
        color: C.violet,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: FONT_WEIGHT.semibold,
        padding: "3px 8px",
        whiteSpace: "nowrap",
      }}
    >
      {/* The git-branch glyph, matching the "In PR" stage colour (violet) used by WorkflowLine. */}
      <span aria-hidden>⑂</span>
      {label}
    </button>
  );
}

/** Open the repo's PR list in the browser. Kept out of the component so the click path is a plain
 *  function the component test can stub. */
async function openPrListInBrowser(rootPath: string | null): Promise<void> {
  if (!rootPath) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const url = await invoke<string | null>("project_pr_list_url", { root: rootPath });
  if (url) await openUrl(url);
}
