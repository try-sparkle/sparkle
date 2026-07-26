// Resolve a project's clone URL for a cloud agent (Service B, W5b). The sandbox clones the repo
// over HTTPS with a short-lived GitHub token the server injects (`authedCloneUrl` in the runner),
// so what we need here is the repo's canonical https URL — the same one `gh repo view` reports.
//
// Rather than add another Rust command, this reuses the EXISTING `project_pr_list_url` command,
// which already asks `gh repo view --json url` (so SSH remotes, enterprise hosts and renamed repos
// all resolve the same way the rest of the PR machinery resolves them) and returns
// `<repo url>/pulls`. Stripping that one known suffix is exact, not a guess: the Rust side builds
// the string as `format!("{url}/pulls")` and already guarantees an `https://` prefix.
//
// Best-effort by contract: `null` means "we couldn't determine it" (no gh, not a GitHub repo, no
// remote), and the caller must refuse to start a cloud agent rather than send a bad URL.

import { invoke } from "@tauri-apps/api/core";

const PULLS_SUFFIX = "/pulls";

/** Turn the `project_pr_list_url` answer into a clone URL. Exported for tests. */
export function repoUrlFromPrListUrl(prListUrl: string | null | undefined): string | null {
  if (!prListUrl) return null;
  const trimmed = prListUrl.trim();
  if (!trimmed.endsWith(PULLS_SUFFIX)) return null; // not the shape we know how to read — don't guess
  const url = trimmed.slice(0, -PULLS_SUFFIX.length);
  // The Rust probe only ever returns https URLs; re-check here so a future change on that side
  // can't quietly hand a cloud sandbox an ssh:// or file:// URL to clone.
  return url.startsWith("https://") && url.length > "https://".length ? url : null;
}

/** The project's https clone URL, or null when it can't be determined. Never throws. */
export async function projectRepoUrl(rootPath: string): Promise<string | null> {
  try {
    const prListUrl = await invoke<string | null>("project_pr_list_url", { root: rootPath });
    return repoUrlFromPrListUrl(prListUrl);
  } catch {
    return null;
  }
}
