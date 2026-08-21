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
import { autoFastForwardEnabled, diagnoseStale, remedyStale } from "../services/staleness";
import { noteStaleDecline, noteStaleResolved } from "../services/stalenessEscalation";

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
  const key = targets.map((t) => `${t.id}\u0000${t.rootPath}`).join("\u0001");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  // Roots with an auto-fix already in flight. A poll every `pollMs` must not stack a second
  // fast-forward on top of one that is still running — git would be operating on a tree the first
  // call is mid-way through moving.
  const autoFixing = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;

    const read = async (autoFix: boolean) => {
      const list = targetsRef.current.filter((t) => t.rootPath);
      const entries = await Promise.all(
        list.map(async (t) => {
          try {
            const s = await invoke<RootStaleness>("repo_root_staleness", { root: t.rootPath });
            // A MEASURED, NOT-STALE READING ENDS ANY DECLINE STREAK. Not merely bookkeeping: a
            // checkout someone fixed by hand would otherwise leave a primed counter behind and
            // escalate on the next unrelated hiccup. Only a real reading counts — an `unknown` is
            // "we could not look", which is no evidence that the wedge cleared.
            if (!s.unknown && !s.stale) noteStaleResolved(t.rootPath);
            return [t.id, toBadge(s)] as const;
          } catch {
            // A failed read is an UNKNOWN, and unknown renders nothing. Deliberately silent: this
            // runs on a timer, and a project that is not a git repo would otherwise log forever.
            // NOT counted as a decline either — nothing was declined, we never got as far as asking.
            return [t.id, null] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, ProjectTabStaleness> = {};
      for (const [id, badge] of entries) if (badge) next[id] = badge;
      setByProject((prev) => (shallowEqual(prev, next) ? prev : next));
      if (autoFix) {
        const stale = list.filter((t) => next[t.id]);
        if (stale.length > 0) void autoFastForward(stale);
      }
    };

    /**
     * FIX THE ONES THAT CANNOT POSSIBLY LOSE ANYTHING, WITHOUT ASKING (bead sparkle-7h01z).
     *
     * The founder's ruling: automation is allowed exactly where it is provably safe and nowhere
     * else. `autoSafe` is the backend's name for that shape — NO PATH THE MERGE WOULD COLLIDE WITH,
     * on the default branch, a strict ancestor of the base — so a `--ff-only` merge cannot destroy
     * work, cannot produce a conflict, and cannot change which branch the user is on. Note what
     * that no longer says: "clean tree". Dirt the fast-forward would not touch blocks nothing, so a
     * `fast-forward-dirty` verdict whose blocking set is empty AND known is automatic; one with a
     * real collision in it is the user's call and WAITS FOR A CLICK, along with everything else.
     *
     * ONLY STALE PROJECTS ARE DIAGNOSED, and that is what keeps this affordable on a 60s timer. The
     * badge map has already filtered to "measured, and behind" — usually 0–3 projects — so a fresh
     * checkout costs nothing beyond the `repo_root_staleness` call it was already paying.
     *
     * IT IS NO LONGER SILENT ON FAILURE, AND THAT WAS THE BUG (bead sparkle-v38y1n). This used to
     * end "a remedy that could not be applied simply leaves the badge exactly where it was" — which
     * is why the founder's shared checkout could refuse this fast-forward every 60 seconds for ten
     * days and fall 1,175 commits behind without ever producing an escalation. The badge was never
     * the missing signal; it read "behind" the whole time. What was missing is that something had
     * been TRYING and failing, and which path was in the way.
     *
     * So every path that declines now reports it to `services/stalenessEscalation`, which counts
     * CONSECUTIVE declines per root and speaks ONCE per streak — see that module for why once, and
     * why three. A throw still does not escape (this is a timer), and one project's failure still
     * does not stop the others; what changed is that the failure is recorded instead of swallowed.
     */
    const autoFastForward = async (stale: StalenessTarget[]) => {
      await Promise.all(
        stale.map(async (t) => {
          if (autoFixing.current.has(t.rootPath)) return;
          autoFixing.current.add(t.rootPath);
          try {
            const d = await diagnoseStale(t.rootPath);
            // THE PER-REPO SWITCH IS READ FIRST, and it moved above the `autoSafe` guard when the
            // escalation landed. With unattended fast-forwarding turned off, nothing was ever going
            // to be attempted here — so there is no merge to run AND no decline to report, and a
            // notice saying "Sparkle has not been able to fast-forward this" would be telling the
            // user about a decision they made themselves. Cheap: only STALE roots reach this line.
            if (!(await autoFastForwardEnabled(t.rootPath))) {
              // …AND OPTING OUT ENDS ANY STREAK THAT WAS STANDING (roborev 66891). Without this a
              // root that had already escalated kept its counter and its notice: the panel went on
              // saying Sparkle could not fast-forward this checkout, about a checkout Sparkle is no
              // longer trying to fast-forward. Turning the automation off is an answer, not a wedge.
              noteStaleResolved(t.rootPath);
              return;
            }
            // THE GUARD. Without it a dirty or diverged checkout would be touched unattended, which
            // is the one thing this feature is not allowed to do. `autoSafe` is now a question about
            // COLLISIONS rather than about cleanliness (see `repo_freshness.rs`), so a tree that is
            // dirty in ways the fast-forward cannot touch passes it — but everything that fails it
            // is a real decline, and a real decline is now counted rather than dropped.
            if (!d.autoSafe) {
              noteStaleDecline(t.rootPath, { diagnosis: d });
              return;
            }
            // …AND THE GUARD AGAIN, DOWN WHERE IT IS DECIDED. The check above reads a diagnosis that
            // is already at least one `await` old by the time the merge runs, and `remedy_at`
            // deliberately ignores it and re-classifies. So the reading that MATTERS is the backend's
            // own, and `unattended` is what makes it apply this same rule to it. Not belt-and-braces:
            // without the flag a tree that went dirty in this window is re-classified as
            // `FastForwardDirty` and merged by a timer (knightwatch 5207191879#1, 5209038072#1).
            const out = await remedyStale(t.rootPath, { unattended: true });
            if (!out.ok) {
              // `out.reason` is the backend's own sentence — git's refusal text where git refused,
              // already peeled out of the wrapped error by `git_words()`. Passed through verbatim.
              noteStaleDecline(t.rootPath, { diagnosis: d, reason: out.reason });
              return;
            }
            if (cancelled) return;
            // The streak is over. Cleared HERE, on the success itself, rather than waiting for the
            // re-read below to notice — a re-read that returns `unknown` would otherwise leave a
            // counter primed behind a fast-forward that actually worked.
            noteStaleResolved(t.rootPath);
            // Re-read through the SAME fail-closed mapping rather than patching the entry by hand,
            // so a post-remedy reading can no more produce a bogus badge than the first one could.
            await read(false);
          } catch (e) {
            // A THROW IS A DECLINE TOO, and the least explicable one — the checkout is behind and we
            // could not even establish why. Left uncounted, this was the quietest way for the whole
            // mechanism to be dead: an IPC failure every 60 seconds looks exactly like nothing.
            noteStaleDecline(t.rootPath, { reason: e instanceof Error ? e.message : String(e) });
          } finally {
            autoFixing.current.delete(t.rootPath);
          }
        }),
      );
    };

    void read(true);
    const timer = setInterval(() => void read(true), pollMs);
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
  const key = projects.map((p) => `${p.id}\u0000${p.rootPath}`).join("\u0001");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the content of `projects`.
  return useMemo(() => projects.map((p) => ({ id: p.id, rootPath: p.rootPath })), [key]);
}
