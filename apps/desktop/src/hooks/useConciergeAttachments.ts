// Attachment state for the concierge compose box (parity row #21, bead sparkle-4562.3 / CM-U10).
//
// Owns the files staged for the NEXT send. THREE producers land here — the attach buttons
// (screenshot / image / files), a native file drop on the concierge COLUMN, and the capture
// takeover's handoff (stores/composeHandoffStore, via `attachReady`) — and ConciergeHost drains the
// list at send time. There is exactly ONE way an attachment appears on the box, so removal, the
// send drain, and the restore-on-failed-send are each written once. Lives beside
// useNewBuildAgentDrop rather than in components/Concierge, which is a Tauri-free presentational
// directory.
//
// A drop on an agent's TERMINAL is NOT one of these producers. It used to be — the paths came in
// through stores/terminalDropStore and turned into chips here — which meant a file dropped on a
// terminal appeared in the Sparkle box on the far side of the window and only reached the agent if
// the auto-router later aimed a send that way. A drop belongs to the surface it was dropped on, so
// that path now pastes straight into the terminal it was dropped on (hooks/useTerminalDrop) and the
// hand-off store is gone.
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
  type AttachOutcome,
} from "../services/conciergeAttach";
import {
  CONCIERGE_COLUMN_DND_TARGET,
  isOverDndTarget,
  noteDropArrived,
  reportDropWithNoTarget,
} from "../services/dndTargets";
import { describePaths } from "../services/logSafePaths";
import { withDropPaths } from "../services/dropPaths";
import { safeUnlisten } from "../services/safeUnlisten";
import {
  publishComposerAttachmentPaths,
  clearComposerAttachmentPaths,
} from "../stores/composerAttachmentsMirror";
import { log } from "../logger";
import type { Attachment } from "../components/composer/attachments";
import type { ConciergeAttachKind } from "../components/Concierge/types";

export interface ConciergeAttachments {
  /** Staged files, oldest first. */
  attachments: Attachment[];
  /**
   * How many times the user has STAGED something here, counting up from 0. Bumped once per batch
   * that actually landed, never decremented.
   *
   * The auto-send countdown's reset signal for two of its three cases (bead sparkle-3kqg2v):
   * *"reset the countdown if I paste something in or if I drop in an image or upload a file."* The
   * host feeds it to `useAutoSend` as `draftGrewSeq`; the paste is the box's own to report.
   *
   * ── A COUNTER, NOT `attachments.length`, AND THAT IS THE WHOLE POINT ─────────────────────────
   * The length is a STATE and this is a count of EVENTS, and they disagree in both directions.
   * Watching the length would fire on {@link restore} — a send that failed putting the user's files
   * back, which is not a gesture they made and must not buy the draft a fresh countdown — and would
   * miss a drop of two files replacing two just removed. It is bumped inside `add`, the one funnel
   * all three producers reach (picker, drop, capture handoff) and the one `restore`, `remove` and
   * `take` all bypass, so the distinction is structural rather than remembered at four call sites.
   *
   * A batch that staged NOTHING does not bump: a cancelled picker and a drop whose every file
   * failed both resolve empty, and neither put anything in the box to read.
   */
  stagedSeq: number;
  /**
   * A native picker this hook opened is ON SCREEN right now — the screenshot crosshairs, or the
   * Finder open panel. False the instant it closes, whether the user picked something or cancelled.
   *
   * The auto-send countdown's PAUSE signal (the founder: *"pause the countdown while those are
   * active … because it means that I'm taking an action, basically"*). The host feeds it to
   * `useAutoSend` beside `composingMention`, which is the same shape of fact: a condition that is
   * true for a stretch of time rather than an instant.
   *
   * ── DISTINCT FROM `stagedSeq`, AND BOTH ARE NEEDED ───────────────────────────────────────────
   * `stagedSeq` fires AFTER files land and restarts the clock from full. It cannot help here: it
   * has nothing to say during the seconds the picker is open, which is the entire interval the send
   * must not fire in — and it never fires at all for a cancelled picker, which must still not have
   * had a message sent out from under it. This is the *while*; that is the *after*.
   *
   * ── A COUNTER UNDERNEATH, NOT A BOOLEAN ──────────────────────────────────────────────────────
   * Two picks can overlap (click Upload, then Screenshot before the panel returns). With a boolean,
   * whichever resolves first clears the flag while the other panel is still on screen, and the
   * countdown resumes underneath it — the exact bug, one click later. The counter only reaches zero
   * when the last one closes.
   */
  pickerOpen: boolean;
  /** A file drag is currently over the compose box. */
  dropActive: boolean;
  /** Set when an attach attempt lost files, cleared on the next attempt or by `dismissNotice`.
   *
   *  A drop that fails MUST say so. This surface promised the user their file was coming — the box
   *  lights up under the drag — and then discarded it, leaving them to notice an absence (bead
   *  sparkle-zviq). Whatever else fails here, it fails out loud. */
  attachNotice: string | null;
  /** Clear the failure notice (the user acknowledged it). */
  dismissNotice: () => void;
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

/** What the user reads when files were lost — the NAME and the REASON.
 *
 *  Both halves are load-bearing. The name says which file to retry; the reason is what the app
 *  already knew and withheld. "Couldn't attach notes.txt — Sparkle isn't allowed to read that
 *  folder" would have ended this bug report in seconds, and it was sitting in an ERROR log line
 *  nobody reads. A bare "couldn't attach it" reproduces the silence in a louder font.
 *
 *  Failures are grouped BY REASON rather than listed one per line: a multi-file drop usually fails
 *  for one cause, and repeating it per file buries the cause in the names. */
function noticeFor(outcome: AttachOutcome): string | null {
  if (outcome.error) return outcome.error;
  const { failed } = outcome;
  if (failed.length === 0) return null;
  if (failed.length === 1) return `Couldn't attach ${failed[0]!.name} — ${failed[0]!.reason}.`;

  const byReason = new Map<string, string[]>();
  for (const f of failed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.name]);
  return [...byReason]
    .map(([reason, names]) => `Couldn't attach ${names.join(", ")} — ${reason}.`)
    .join(" ");
}

export function useConciergeAttachments(): ConciergeAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [stagedSeq, setStagedSeq] = useState(0);
  // Mirror of the list that is readable synchronously (see the header note on take()).
  const ref = useRef<Attachment[]>([]);
  // This box's identity in `stores/composerAttachmentsMirror` — never inspected, only compared, so
  // an outgoing instance's cleanup cannot wipe the incoming one's reading. Stable for this mount.
  const mirrorOwner = useRef({}).current;
  // Is THIS box still mounted? The mirror publish is gated on it — see `apply`.
  const mirrorAlive = useRef(true);

  // ── HOW MANY NATIVE PICKERS ARE OPEN ────────────────────────────────────────────────────────
  //
  // The REF is the truth and the state is the render of it, rather than the other way round. Two
  // clicks in one tick both read the same stale state under a functional-update-free boolean, and
  // even `setOpen(n => n + 1)` cannot be READ back synchronously by the second `attach` call — so
  // the count lives in a ref that is written immediately, and the state exists only so that a
  // change re-renders the host and reaches `useAutoSend`. See `pickerOpen` for why a bare boolean
  // is wrong regardless of how it is stored.
  const openPickers = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const openPicker = useCallback(() => {
    openPickers.current += 1;
    setPickerOpen(true);
  }, []);
  const closePicker = useCallback(() => {
    // Floored at zero so an unmatched close — a double-settle, a future caller that closes twice —
    // cannot drive the count negative and leave the rail permanently paused with no picker on
    // screen. Failing toward "the countdown runs" is the right direction for a bug in this
    // bookkeeping: the worst case is the old behaviour, not a rail that never sends again.
    openPickers.current = Math.max(0, openPickers.current - 1);
    if (openPickers.current === 0) setPickerOpen(false);
  }, []);

  const apply = useCallback((fn: (cur: Attachment[]) => Attachment[]) => {
    ref.current = fn(ref.current);
    setAttachments(ref.current);
    // Publish the chip paths where a SERVICE can read them (stores/composerAttachmentsMirror).
    //
    // This is inside `apply` rather than in a `useEffect` on `attachments` for two reasons, and
    // both are load-bearing. (1) `apply` is the single funnel all four mutators go through — add,
    // remove, take, restore — so nothing can change the box without this running; an effect would
    // have to re-derive that guarantee from a dependency array. (2) It is SYNCHRONOUS with the
    // ref, so a tool call landing in the same tick as a stage sees the file, which an effect
    // (running after paint) would miss.
    //
    // See that store's header for why a mirror is not the "second staging queue" that
    // `conciergeTools/attachments.ts` rejects: nothing is staged into it and it is never drained.
    //
    // GATED ON LIVENESS, and that guard is the load-bearing half. `apply` is reachable AFTER the
    // unmount cleanup has run: both async producers are uncancelled — `attach` resolves
    // `pickAttachments(kind).then(settle)` and `attachPaths` resolves
    // `loadAttachmentPaths(paths).then(settle)`, and `settle -> add -> apply`. So a human who
    // clicks Upload (or drops a large image still being read) and then closes the project would
    // otherwise have the dead hook's late resolve RE-TAKE ownership after the clear, and that
    // cleanup has already run and never runs again — the phantom would stand for the life of the
    // window, and would poison the next mount too, since the live box's identity-checked cleanup
    // would then decline to clear a store owned by the dead token (roborev 68221).
    if (!mirrorAlive.current) return;
    publishComposerAttachmentPaths(mirrorOwner, ref.current.map((a) => a.path));
    // `mirrorOwner` is a ref's `.current`, stable for this mount, so listing it changes nothing at
    // runtime — it is here so the dependency list stays honest rather than silenced.
  }, [mirrorOwner]);

  // OWN the mirror for as long as this box is mounted, and HAND IT BACK on the way out.
  //
  // `apply` above is the live update, but it runs only on a mutation of a MOUNTED box — so on its
  // own it would leave the last reading standing forever once `ConciergeHost` unmounts (which it
  // does: "ConciergeHost unmounts when no project is open", App.tsx). That phantom would be read by
  // `publish_attach_media` as a legitimately staged file, and it is the SOLE gate on a model-supplied
  // path reaching a public upload — so a file the human dropped, never sent, and closed the project
  // on could be published with no box, no chip and no human gesture (roborev 68186).
  //
  // The clear is identity-checked because React mounts the NEW instance before running the OLD
  // one's cleanup: without it, a remount's survivor is the dead instance's clear. Empty deps — this
  // owns the mount/unmount edges only; `apply` carries every change in between.
  useEffect(() => {
    // Set on ENTRY, not just cleared on exit: under strict mode's double-invoke the effect runs,
    // cleans up, and runs again, so a flag only ever cleared would leave a live box marked dead.
    mirrorAlive.current = true;
    publishComposerAttachmentPaths(mirrorOwner, ref.current.map((a) => a.path));
    return () => {
      mirrorAlive.current = false;
      clearComposerAttachmentPaths(mirrorOwner);
    };
  }, [mirrorOwner]);

  const add = useCallback(
    (atts: Attachment[]) => {
      if (atts.length === 0) return;
      apply((cur) => [...cur, ...atts]);
      // ONE bump per batch, not one per file: a three-file drop is one gesture, and the countdown
      // it restarts is owed one fresh threshold rather than three. See `stagedSeq`.
      setStagedSeq((n) => n + 1);
    },
    [apply],
  );

  const dismissNotice = useCallback(() => setAttachNotice(null), []);

  /** Stage what loaded and report what didn't. The notice is set from EVERY attempt, including the
   *  successful ones (where it clears) — so a retry that works visibly retracts the complaint. */
  const settle = useCallback(
    (outcome: AttachOutcome) => {
      add(outcome.attachments);
      setAttachNotice(noticeFor(outcome));
    },
    [add],
  );

  const attach = useCallback(
    (kind: ConciergeAttachKind) => {
      // THE FLAG GOES UP ON THE CLICK, NOT WHEN THE PANEL IS CONFIRMED VISIBLE.
      //
      // A native picker takes a few hundred ms to appear and the countdown's tick is 100ms, so a
      // clock near its deadline fires in that gap — which is the founder's bug arriving slightly
      // earlier rather than being fixed. There is no event for "the crosshairs are now on screen"
      // and there does not need to be: `openPicker` is called synchronously in the click handler,
      // before `pickAttachments` is even entered, so no tick can land between the gesture and the
      // pause. Erring long is free here (the clock is frozen, not cancelled); erring short sends
      // the message.
      openPicker();
      // pickAttachments never rejects (a refused picker resolves an outcome carrying `error`), so
      // there is nothing to catch here — but a cancel resolves empty and must stay silent, which
      // is why the empty outcome produces no notice.
      //
      // A CANCEL RESOLVES TOO, and that is what stops a dismissed panel wedging the rail. There is
      // no rejection path to also close: every outcome — files, a cancel, an error — arrives as a
      // resolved outcome, so one `closePicker` here covers all three. `finally` rather than a call
      // inside `settle` so a throw in `settle` itself cannot leave the countdown paused forever;
      // a wedged rail is a countdown that never fires dressed up as one that does.
      void pickAttachments(kind).then(settle).finally(closePicker);
    },
    [settle, openPicker, closePicker],
  );

  const attachPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      void loadAttachmentPaths(paths).then(settle);
    },
    [settle],
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
            setDropActive(isOverDndTarget(p.position, CONCIERGE_COLUMN_DND_TARGET));
          } else if (p.type === "leave") {
            setDropActive(false);
          } else if (p.type === "drop") {
            setDropActive(false);
            noteDropArrived(p.position, p.paths);
            if (!isOverDndTarget(p.position, CONCIERGE_COLUMN_DND_TARGET)) {
              // Silent when another target owns the drop; speaks only for a drop that matched no
              // target at all (services/dndTargets.reportDropWithNoTarget).
              reportDropWithNoTarget(p.position);
              return;
            }
            // NOT `p.paths ?? []` with a silent early return any more. A drag whose source
            // publishes only the modern file-URL pasteboard type arrives with NO paths, and the
            // bare length check discarded it without a log line — see services/dropPaths.
            withDropPaths(p.paths, "concierge-box", (paths) => {
              // Kinds and counts, never paths — this line used to write the RAW absolute paths,
              // which carry the account name and the file's own title into a log that ships with
              // support tickets and crash reports (see services/logSafePaths).
              log.info("composer", `dropped ${paths.length} file(s) on the concierge box`, {
                ...describePaths(paths),
              });
              attachPaths(paths);
            });
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
    stagedSeq,
    pickerOpen,
    dropActive,
    attachNotice,
    dismissNotice,
    attach,
    attachPaths,
    attachReady: add,
    remove,
    take,
    restore,
  };
}
