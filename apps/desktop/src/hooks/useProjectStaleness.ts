// Polls how far each open project's OWN checkout lags the branch it tracks, for the tab badge
// (bead sparkle-cuv2h).
//
// WHY A POLL AND NOT A ONE-SHOT. Staleness is not a property of the project, it is a property of
// the moment: `origin/main` moves under a checkout continuously (measured on the founder's machine
// at ~12 fetches an hour from the agent fleet), so a tree that was current when the app launched is
// meaningfully behind an hour later. A mount-time read would show a reassuring absence of badge for
// the rest of the session — the precise failure this badge exists to prevent.
//
// FAIL-CLOSED AT THE BOUNDARY. Only projects that are BOTH measured and stale go in the returned
// map. `unknown` (no remote, unborn HEAD, unresolvable base) and "fresh" are both simply omitted,
// so the UI has no way to render a confident "0 behind" over a tree nobody could verify. The badge
// can only ever mean "measured, and behind" — see ProjectTabs' `stalenessByProject`.
//
// The backend command is no-network by construction, so this never blocks on a partitioned link.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectTabStaleness } from "../components/ProjectTabs";

/** What `repo_root_staleness` returns. `unknown` means "could not measure" — never "fresh". */
export interface RootStaleness {
  behind: number;
  stale: boolean;
  threshold: number;
  headBranch: string;
  base: string;
  unknown: boolean;
}

/** How often to re-measure. Cheap (two local `git rev-parse`/`rev-list` calls per project, no
 *  network), but not free, and staleness moves on the order of minutes — not seconds. */
export const STALENESS_POLL_MS = 60_000;

/** The reading a tab should render, or null if this project has nothing to say. Exported for the
 *  test so the fail-closed rule is pinned as a pure function rather than through a mocked poll. */
export function toBadge(s: RootStaleness | null | undefined): ProjectTabStaleness | null {
  if (!s || s.unknown || !s.stale) return null;
  // A "stale" verdict with no base to name would render a number with nothing to compare it to.
  if (!s.base) return null;
  return { behind: s.behind, base: s.base };
}

export interface StalenessTarget {
  id: string;
  rootPath: string;
}

/**
 * Staleness badges for the given projects, keyed by project id. Only stale projects appear.
 *
 * `targets` is re-derived every render by callers, so this keys its effect off the id/path PAIRS
 * rather than the array identity — otherwise the poll would tear down and restart on every parent
 * render and effectively never complete an interval.
 */
export function useProjectStaleness(
  targets: StalenessTarget[],
  pollMs: number = STALENESS_POLL_MS,
): Record<string, ProjectTabStaleness> {
  const [byProject, setByProject] = useState<Record<string, ProjectTabStaleness>>({});
  // Identity that changes only when the actual set of (id, path) pairs changes.
  const key = targets.map((t) => `${t.id}\u0000${t.rootPath}`).join("");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      const list = targetsRef.current.filter((t) => t.rootPath);
      const entries = await Promise.all(
        list.map(async (t) => {
          try {
            const s = await invoke<RootStaleness>("repo_root_staleness", { root: t.rootPath });
            return [t.id, toBadge(s)] as const;
          } catch {
            // A failed read is an UNKNOWN, and unknown renders nothing. Deliberately silent: this
            // runs on a timer, and a project that is not a git repo would otherwise log forever.
            return [t.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, ProjectTabStaleness> = {};
      for (const [id, badge] of entries) if (badge) next[id] = badge;
      setByProject((prev) => (shallowEqual(prev, next) ? prev : next));
    };

    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `key` IS the content of `targets` (the id/path pairs), so depending on it rather than on the
    // array identity is deliberate: callers rebuild `targets` every render, and depending on that
    // would restart the interval each time and never complete a poll. `targetsRef` supplies the
    // current values to the effect body.
  }, [key, pollMs]);

  return byProject;
}

/** Keep the previous object when nothing changed, so the tab strip does not re-render every tick. */
function shallowEqual(
  a: Record<string, ProjectTabStaleness>,
  b: Record<string, ProjectTabStaleness>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return !!x && !!y && x.behind === y.behind && x.base === y.base;
  });
}

/** Stable `targets` for the hook from a project list, memoized on the id/path pairs. */
export function useStalenessTargets(
  projects: readonly { id: string; rootPath: string }[],
): StalenessTarget[] {
  const key = projects.map((p) => `${p.id}\u0000${p.rootPath}`).join("");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the content of `projects`.
  return useMemo(() => projects.map((p) => ({ id: p.id, rootPath: p.rootPath })), [key]);
}
