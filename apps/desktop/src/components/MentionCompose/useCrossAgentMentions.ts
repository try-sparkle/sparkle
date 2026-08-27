// DETECTION: watch a shared "thread" bead for @improve ↔ @sparkle comments and surface them.
//
// Beads is the message; the inbox is only a doorbell — so the content lives in the thread bead's
// COMMENTS, and this hook reads them. Comments are NOT on the 5s board poll (beadsCommands.ts:291),
// so it fetches the one thread bead's detail on its own interval and decodes each comment through the
// single seam `parseCrossAgentComment`. The parse and the render are tested apart from this glue; the
// hook's own job is only "fetch on a beat, keep the parsed list".
//
// The fetcher is INJECTABLE so the hook drives in a test with no store behind it, and the production
// default (`createBeadCommentsFetcher`) is a thin `beadsDetail` call, tested on its own.
import { useEffect, useRef, useState } from "react";
import { beadsDetail, type BeadComment } from "../../services/beadsCommands";
import { parseCrossAgentComment } from "./crossAgentComment";
import type { CrossAgentMention } from "./crossAgentNotice";

/** Fetch the current comment thread of the watched bead. */
export type CommentsFetcher = () => Promise<BeadComment[]>;

/** The production fetcher: the watched bead's comments via `beadsDetail`. Kept tiny and separate so
 *  the seam the hook defaults to is itself covered by a test. */
export function createBeadCommentsFetcher(projectPath: string, beadId: string): CommentsFetcher {
  return async () => {
    const detail = await beadsDetail(projectPath, beadId);
    return detail.comments;
  };
}

export interface UseCrossAgentMentionsOptions {
  /** The bead the two agents coordinate on — the click-target and the "on <bead-id>" subject. */
  beadId: string;
  /** The project the bead lives in (needed by `beadsDetail`). */
  projectPath: string;
  /** Override the fetcher (tests inject a fake; production uses `createBeadCommentsFetcher`). */
  fetchComments?: CommentsFetcher;
  /** Poll cadence in ms. Defaults to 5s, the beads poll floor. `0` disables polling (fetch once). */
  intervalMs?: number;
}

/**
 * The cross-agent mentions on the watched bead, oldest-first, refreshed on a beat.
 *
 * Returns every cross-agent comment currently on the thread (a transcript), so a NEW comment appears
 * on the next fetch without any per-comment "seen" bookkeeping — re-fetch IS the detection. Comments
 * that are not from either agent are dropped by `parseCrossAgentComment`.
 */
export function useCrossAgentMentions(opts: UseCrossAgentMentionsOptions): {
  mentions: readonly CrossAgentMention[];
} {
  const { beadId, projectPath, intervalMs = 5000 } = opts;
  const [mentions, setMentions] = useState<readonly CrossAgentMention[]>([]);

  // Read deps at call time so a prop change does not re-arm the interval mid-cycle.
  const ref = useRef({ beadId, projectPath, fetch: opts.fetchComments });
  ref.current = { beadId, projectPath, fetch: opts.fetchComments };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { beadId: id, projectPath: path, fetch } = ref.current;
      const fetcher = fetch ?? createBeadCommentsFetcher(path, id);
      try {
        const comments = await fetcher();
        if (!alive) return;
        const parsed = comments
          .map((c) => parseCrossAgentComment(c, id))
          .filter((m): m is CrossAgentMention => m !== null);
        setMentions(parsed);
      } catch {
        // A failed fetch leaves the last good list in place rather than blanking the pane.
      }
    };
    void load();
    if (intervalMs <= 0) return () => { alive = false; };
    const t = setInterval(() => void load(), intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // Re-arm only when the WATCHED bead or cadence changes; the fetcher is read through the ref.
  }, [beadId, projectPath, intervalMs]);

  return { mentions };
}
