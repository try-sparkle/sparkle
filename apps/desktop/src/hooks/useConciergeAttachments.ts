// Attachment state for the concierge compose box (parity row #21, bead sparkle-4562.3 / CM-U10).
//
// Owns the files staged for the NEXT send. FOUR producers land here — the attach buttons
// (screenshot / image / files), a native file drop ON the compose box, a file drop on the visible
// agent's TERMINAL (hooks/useTerminalDrop, handed over via stores/terminalDropStore), and the
// capture takeover's handoff (stores/composeHandoffStore, via `attachReady`) — and ConciergeHost
// drains the list at send time. That is the point of routing the terminal drop
// through this hook rather than giving it a list of its own: there is exactly ONE way an
// attachment appears on the box, so removal, the send drain, and the restore-on-failed-send all
// work for a dropped file without being written twice. Lives beside useNewBuildAgentDrop rather
// than in components/Concierge, which is a Tauri-free presentational directory.
//
// DROP SCOPING. The webview drag event is window-global and there are two other listeners live
// (useNewBuildAgentDrop, and the Sparkle pane's Composer), so this one hit-tests the concierge
// COLUMN (CONCIERGE_COLUMN_DND_TARGET) and ignores everything else. That is what keeps a drop on
// "+ New Build Agent" going to the new agent, and a drop anywhere else going to the Sparkle pane's
// composer, with no listener-ordering assumption on either side. The target is the whole column
// rather than the compose box because that is what a user aims at — the box is a ~90px strip and
// missing it used to do nothing at all. The box still paints the affordance, so a drop at the top
// of the column visibly shows where the files are headed.
//
// `take()` reads through a REF, not state: a send has to remove exactly the files it is about to
// deliver, in the same tick it reads them, and React state would still hold the pre-clear value.
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  loadAttachmentPaths,
  pickAttachments,
} from "../services/conciergeAttach";
import {
  CONCIERGE_COLUMN_DND_TARGET,
  isOverDndTarget,
} from "../services/dndTargets";
import { useTerminalDropStore } from "../stores/terminalDropStore";
import { safeUnlisten } from "../services/safeUnlisten";
import { log } from "../logger";
import type { Attachment } from "../components/composer/attachments";
import type { ConciergeAttachKind } from "../components/Concierge/types";

export interface ConciergeAttachments {
  /** Staged files, oldest first. */
  attachments: Attachment[];
  /** A file drag is currently over the compose box. */
  dropActive: boolean;
  /** Run the picker for `kind` and stage whatever it returns (a cancel stages nothing). */
  attach: (kind: ConciergeAttachKind) => void;
  /** Stage already-resolved paths (the drop path, and any future handoff). */
  attachPaths: (paths: string[]) => void;
  /** Stage attachments the caller has ALREADY built, with no disk read at all.
   *
   *  For the capture takeover's handoff (stores/composeHandoffStore): the shot arrives over
   *  `capture://shot` carrying its own dataUrl, so it is already in memory by the time the send is
   *  routed. Putting it through `attachPaths` would re-read and re-encode a file we are holding —
   *  and, worse, would make the chip's appearance depend on an async IPC that can fail after the
   *  draft text has already landed, i.e. words on screen with the screenshot silently missing. */
  attachReady: (atts: Attachment[]) => void;
  /** Drop one staged file. */
  remove: (id: string) => void;
  /** Read AND clear the staged list — what a send does, so the next message starts empty. */
  take: () => Attachment[];
  /** Put a taken batch back in front, for a send that did not land. A failed delivery must not
   *  cost the user their files any more than it costs them their words. */
  restore: (atts: Attachment[]) => void;
}

export function useConciergeAttachments(): ConciergeAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  // Mirror of the list that is readable synchronously (see the header note on take()).
  const ref = useRef<Attachment[]>([]);

  const apply = useCallback((fn: (cur: Attachment[]) => Attachment[]) => {
    ref.current = fn(ref.current);
    setAttachments(ref.current);
  }, []);

  const add = useCallback(
    (atts: Attachment[]) => {
      if (atts.length === 0) return;
      apply((cur) => [...cur, ...atts]);
    },
    [apply],
  );

  const attach = useCallback(
    (kind: ConciergeAttachKind) => {
      // pickAttachments never rejects (a refused picker resolves empty), so there is nothing to
      // catch and nothing the user has to acknowledge when they simply cancelled.
      void pickAttachments(kind).then(add);
    },
    [add],
  );

  const attachPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      void loadAttachmentPaths(paths).then(add);
    },
    [add],
  );

  const remove = useCallback(
    (id: string) => apply((cur) => cur.filter((a) => a.id !== id)),
    [apply],
  );

  const take = useCallback(() => {
    const cur = ref.current;
    if (cur.length > 0) apply(() => []);
    return cur;
  }, [apply]);

  const restore = useCallback(
    (atts: Attachment[]) => {
      if (atts.length === 0) return;
      apply((cur) => [...atts, ...cur]);
    },
    [apply],
  );

  // PICKUP for files dropped on an agent's TERMINAL (hooks/useTerminalDrop). That drop is detected
  // per-pane, on the other side of the tree, so it hands its paths to a store and this is where
  // they join the list — the same list, the same chips, the same send-time drain as a picker.
  //
  // Anything ALREADY queued when the column mounts is taken too (the `drain()` below runs before
  // the subscription): a drop can land in the tick before this effect runs, and files that were
  // staged nowhere would be silently lost.
  useEffect(() => {
    const pickUp = (batches: { paths: string[] }[]) => {
      const paths = batches.flatMap((b) => b.paths);
      if (paths.length > 0) attachPaths(paths);
    };
    pickUp(useTerminalDropStore.getState().drain());
    // Subscribing to the whole store rather than a selector: `drain()` empties the queue, so a
    // selector on `queue` would fire a second time for the write that clears it.
    return useTerminalDropStore.subscribe((s) => {
      if (s.queue.length > 0) pickUp(useTerminalDropStore.getState().drain());
    });
  }, [attachPaths]);

  useEffect(() => {
    // The concierge column mounts in the plain-browser dev preview too, where there is no webview
    // API at all — `getCurrentWebview()` throws synchronously there. Drop-to-attach is simply
    // unavailable in that build; the pickers and the rest of the box still work.
    let unlistenPromise: Promise<(() => void) | undefined>;
    try {
      unlistenPromise = getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            setDropActive(isOverDndTarget(p.position, CONCIERGE_COLUMN_DND_TARGET));
          } else if (p.type === "leave") {
            setDropActive(false);
          } else if (p.type === "drop") {
            setDropActive(false);
            if (!isOverDndTarget(p.position, CONCIERGE_COLUMN_DND_TARGET)) return;
            const paths = p.paths ?? [];
            if (paths.length === 0) return;
            log.info("composer", `dropped ${paths.length} file(s) on the concierge box`, paths);
            attachPaths(paths);
          }
        })
        .catch((e) => {
          // A failed listen has no unlisten fn to return; log and let cleanup no-op.
          log.error("composer", "concierge drag-drop listen failed", e);
          return undefined;
        });
    } catch (e) {
      log.error("composer", "concierge drag-drop unavailable", e);
      return;
    }
    return () => {
      setDropActive(false);
      void safeUnlisten(unlistenPromise);
    };
  }, [attachPaths]);

  return {
    attachments,
    dropActive,
    attach,
    attachPaths,
    attachReady: add,
    remove,
    take,
    restore,
  };
}
