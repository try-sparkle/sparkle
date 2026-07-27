// Attachment state for the concierge compose box (parity row #21, bead sparkle-4562.3 / CM-U10).
//
// Owns the files staged for the NEXT send: the three attach buttons (screenshot / image / files)
// and a native file drop ON the compose box both land here, and ConciergeHost drains the list at
// send time. Lives beside useNewBuildAgentDrop / useDragVisionHint rather than in components/
// Concierge, which is a Tauri-free presentational directory.
//
// DROP SCOPING. The webview drag event is window-global and there are two other listeners live
// (useNewBuildAgentDrop, and the Sparkle pane's Composer), so this one hit-tests the compose box
// itself (CONCIERGE_COMPOSE_DND_TARGET) and ignores everything else. That is what keeps a drop on
// "+ New Build Agent" going to the new agent, and a drop anywhere else going to the Sparkle pane's
// composer, with no listener-ordering assumption on either side.
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
  CONCIERGE_COMPOSE_DND_TARGET,
  isOverDndTarget,
} from "../services/dndTargets";
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
            setDropActive(isOverDndTarget(p.position, CONCIERGE_COMPOSE_DND_TARGET));
          } else if (p.type === "leave") {
            setDropActive(false);
          } else if (p.type === "drop") {
            setDropActive(false);
            if (!isOverDndTarget(p.position, CONCIERGE_COMPOSE_DND_TARGET)) return;
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
    remove,
    take,
    restore,
  };
}
