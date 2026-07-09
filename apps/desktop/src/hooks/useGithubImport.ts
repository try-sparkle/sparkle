// Drives the "From GitHub" tab of NewProjectDialog: connection status, the searchable repo
// browser (debounced query + paged "Load more"), and the clone → open handoff. All IO goes
// through the Rust tauri commands (owned by another unit) via the app's `invoke` wrapper, so
// tests mock `@tauri-apps/api/core`. The hook owns only GitHub data + the clone invoke; the
// dialog wires a successful clone into addProject/route (the same path TopBar.resolveAndRoute
// uses) so the new project becomes selected.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface GithubStatus {
  connected: boolean;
  login: string | null;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  cloneUrl: string;
  pushedAt: string;
}

export interface RepoPage {
  repos: GithubRepo[];
  hasMore: boolean;
}

/** Thin typed wrappers over the Rust tauri commands. Kept separate so tests can assert the exact
 *  command names/args and so the hook body reads without invoke noise. Arg keys are camelCase —
 *  Tauri maps them to the snake_case Rust params (see other invoke call sites). */
export const githubApi = {
  status: () => invoke<GithubStatus>("github_status"),
  listRepos: (query: string, page: number) =>
    invoke<RepoPage>("github_list_repos", {
      // Send undefined (not "") so the backend treats an empty box as "no filter".
      query: query.trim() ? query.trim() : undefined,
      page,
    }),
  cloneRepo: (cloneUrl: string, dest: string) =>
    invoke<string>("github_clone_repo", { cloneUrl, dest }),
  defaultProjectDir: () => invoke<string>("github_default_project_dir"),
};

/** git-missing gets its own friendly install prompt; everything else surfaces the (already
 *  token-redacted) message inline. */
export type CloneError = { kind: "git_missing" } | { kind: "other"; message: string };

export type GithubPhase = "loading" | "signed-out" | "connected";

/** Last path segment of `owner/name` (or of an absolute path) — the default project folder name. */
export function repoName(fullName: string): string {
  const parts = fullName.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || fullName;
}

/** Tauri rejects a `Result<_, String>` command with the raw string; be defensive about shape. */
export function errMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}

/** Debounce (ms) for the repo search box. */
const SEARCH_DEBOUNCE_MS = 300;

export interface UseGithubImport {
  phase: GithubPhase;
  login: string | null;
  recheckStatus: () => Promise<void>;

  repos: GithubRepo[];
  query: string;
  setQuery: (q: string) => void;
  hasMore: boolean;
  loadingRepos: boolean;
  reposError: string | null;
  loadMore: () => void;

  selected: GithubRepo | null;
  select: (repo: GithubRepo) => void;
  clearSelected: () => void;

  dest: string;
  setDest: (d: string) => void;

  cloning: boolean;
  cloneError: CloneError | null;
  /** Clone the selected repo into `dest`. Resolves to the local path on success, else null
   *  (with `cloneError` set). */
  clone: () => Promise<string | null>;
}

/** @param active whether the GitHub tab is currently shown (gates status polling + loads). */
export function useGithubImport(active: boolean): UseGithubImport {
  const [phase, setPhase] = useState<GithubPhase>("loading");
  const [login, setLogin] = useState<string | null>(null);

  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [query, setQueryState] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [selected, setSelected] = useState<GithubRepo | null>(null);
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [dest, setDest] = useState("");
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<CloneError | null>(null);

  // Skip state updates after the tab unmounts (switching away mid-request). Kept as a ref so the
  // async callbacks below always read the live value.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const recheckStatus = useCallback(async () => {
    try {
      const s = await githubApi.status();
      if (!mounted.current) return;
      setPhase(s.connected ? "connected" : "signed-out");
      setLogin(s.login);
    } catch {
      // status must never hard-fail the tab; treat any error as "not connected".
      if (!mounted.current) return;
      setPhase("signed-out");
      setLogin(null);
    }
  }, []);

  // Editing the query invalidates the current paging: hide "Load more" until the debounced page‑1
  // reload returns fresh results, so a click during the debounce can't append a stale next page.
  // Also re-anchor `page` to 1 so that, even if the page‑1 reload errors (leaving `page` untouched
  // in `load`), a later `loadMore` fetches page 2 of the NEW query rather than of the old one.
  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setHasMore(false);
    setPage(1);
  }, []);

  // Check status when the tab becomes active, and re-poll whenever the window regains focus (the
  // user connects GitHub in the system browser, then returns).
  useEffect(() => {
    if (!active) return;
    void recheckStatus();
    const onFocus = () => void recheckStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, recheckStatus]);

  const load = useCallback(async (q: string, p: number, append: boolean) => {
    setLoadingRepos(true);
    setReposError(null);
    try {
      const res = await githubApi.listRepos(q, p);
      if (!mounted.current) return;
      setRepos((prev) => (append ? [...prev, ...res.repos] : res.repos));
      setHasMore(res.hasMore);
      setPage(p);
    } catch (e) {
      if (!mounted.current) return;
      setReposError(errMessage(e));
      if (!append) {
        setRepos([]);
        setHasMore(false);
      }
    } finally {
      if (mounted.current) setLoadingRepos(false);
    }
  }, []);

  // Initial load fires immediately on connect; subsequent query edits are debounced. A ref tracks
  // the first connected load so the browser doesn't wait 300ms before showing anything.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (phase !== "connected") {
      firstLoad.current = true;
      return;
    }
    const delay = firstLoad.current ? 0 : SEARCH_DEBOUNCE_MS;
    firstLoad.current = false;
    const t = setTimeout(() => void load(query, 1, false), delay);
    return () => clearTimeout(t);
  }, [phase, query, load]);

  const loadMore = useCallback(() => {
    if (loadingRepos || !hasMore) return;
    void load(query, page + 1, true);
  }, [loadingRepos, hasMore, load, query, page]);

  const select = useCallback(
    (repo: GithubRepo) => {
      setSelected(repo);
      setCloneError(null);
      const name = repoName(repo.fullName);
      if (defaultDir) {
        setDest(`${defaultDir.replace(/[/\\]+$/, "")}/${name}`);
        return;
      }
      // Fetch the default project dir lazily on first selection; fall back to a bare name so the
      // field is never empty while it resolves.
      setDest(name);
      void githubApi
        .defaultProjectDir()
        .then((dir) => {
          setDefaultDir(dir);
          setDest(`${dir.replace(/[/\\]+$/, "")}/${name}`);
        })
        .catch(() => {
          /* leave the bare-name fallback in place */
        });
    },
    [defaultDir],
  );

  const clearSelected = useCallback(() => {
    setSelected(null);
    setCloneError(null);
  }, []);

  // A ref (not the `cloning` state) guards against a rapid double-click firing two clones before
  // the cloning-state re-render disables the button.
  const cloningRef = useRef(false);
  const clone = useCallback(async (): Promise<string | null> => {
    if (!selected || cloningRef.current) return null;
    cloningRef.current = true;
    setCloning(true);
    setCloneError(null);
    try {
      const path = await githubApi.cloneRepo(selected.cloneUrl, dest);
      // If the tab/dialog was dismissed mid-clone, don't let a late success drive project routing.
      if (!mounted.current) return null;
      return path;
    } catch (e) {
      const msg = errMessage(e);
      if (mounted.current) {
        setCloneError(msg === "git_missing" ? { kind: "git_missing" } : { kind: "other", message: msg });
      }
      return null;
    } finally {
      cloningRef.current = false;
      if (mounted.current) setCloning(false);
    }
  }, [selected, dest]);

  return {
    phase,
    login,
    recheckStatus,
    repos,
    query,
    setQuery,
    hasMore,
    loadingRepos,
    reposError,
    loadMore,
    selected,
    select,
    clearSelected,
    dest,
    setDest,
    cloning,
    cloneError,
    clone,
  };
}
