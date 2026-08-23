// A READ-ONLY MIRROR of the concierge compose box's attachment chips — so a SERVICE can see what
// the human can see. Bead `sparkle-131ms.8`; opened by roborev 68164, lifecycle by roborev 68186.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS NOT A SECOND STAGING QUEUE, AND THAT DISTINCTION IS THE WHOLE REVIEW SURFACE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `conciergeTools/attachments.ts` considered exactly this gap and refused one specific remedy, in
// words worth quoting because a reader who skims will think this file is that remedy:
//
//   "Inventing a second store to close that gap would have given the app two staging queues for one
//    compose box, and the one nobody remembers to drain is the one that strands files."
//
// That objection is about a QUEUE — something files are put INTO and must later be taken OUT of,
// where a missed drain strands them. This store has neither half of that shape:
//
//   • Nothing is ever staged INTO it. Its only writer is `useConciergeAttachments`, and the live
//     path is `apply` — the single funnel every mutation of the box already goes through (add /
//     remove / take / restore). No caller can put a file here that is not already a chip.
//   • It is never DRAINED. A publish REPLACES the whole list, so it cannot accumulate, cannot go
//     stale behind the box, and has no "remember to empty it" step to forget.
//
// So there is exactly one staging queue in the app, still. This is a projection of the box's React
// state, which is the thing `attachments.ts` correctly says is "unreachable from a service" — it
// makes it reachable WITHOUT giving anyone a second place to put a file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A SERVICE NEEDS IT AT ALL: `pendingAttachmentsStore` IS DRAINED BEFORE ANYONE CAN READ IT.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The first cut of `publish_attach_media` vetted the model's path against
// `pendingAttachmentsStore`, which reads as the obvious "what is staged" source and is not one.
// `ConciergeHost` SUBSCRIBES to that store and drains the target agent's entry on any write — a
// subscription added deliberately (roborev 55403) so that an `attach_to_message` add reaches the
// compose box immediately rather than waiting for the target to change. The consequence is that by
// the time any later tool call looks, the entry is gone: every real invocation refused
// `media-not-staged` and the happy path could never run, with a green suite over it because the
// tests wrote the store directly and never modelled the drain.
//
// A human's own drop never touches that store at all — that path goes straight to
// `useConciergeAttachments.attachPaths` local state — so the refusal's advice to "drop it on the
// compose box" named a route that provably could not satisfy the check. This store is what makes
// that sentence true.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OWNED LIFECYCLE IS MANDATORY, BECAUSE A PHANTOM READING HERE IS A PUBLIC UPLOAD.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Exactly the rule `stores/conciergeQueueStore` states for its own reading, arrived at the same
// way and worth restating because the STAKES here are higher than a wrong count.
//
// `ConciergeHost` genuinely unmounts — `App.tsx` says so in words ("ConciergeHost unmounts when no
// project is open"). A mirror written ONLY from `apply` would never run again after that teardown,
// so its last reading would stand for the life of the window. That is not cosmetic staleness:
// `stagedAttachmentPaths` is the SOLE gate on a model-supplied path reaching a public upload, so a
// phantom entry means the model can name a file the human dropped, never sent, and closed the
// project on — and it is uploaded to a public site with no compose box, no chip, and no human
// gesture anywhere in the sequence (roborev 68186). Hence: publish on mount, CLEAR ON UNMOUNT.
//
// AND THE CLEAR IS CHECKED AGAINST THE WRITER'S IDENTITY. React mounts the NEW instance BEFORE
// running the OLD one's cleanup, both under strict mode's double-invoke and on every ordinary
// remount. So LAST PUBLISH WINS unconditionally, and a cleanup only clears if the owner on file is
// still its own. Without that check the survivor of a remount is the DEAD instance's clear: the
// live box has already published its real list and the outgoing one wipes it to empty, which here
// fails SAFE (a refusal) rather than open — but it would make a legitimately staged file
// unattachable until the next mutation, which reads as the feature being broken.
//
// Transient and deliberately NOT persisted, for the same reason as `pendingAttachmentsStore`: a
// path surviving a relaunch would name a file the box no longer holds.
import { create } from "zustand";

interface ComposerAttachmentsMirrorState {
  /** Absolute paths of the chips currently on the concierge compose box. Replaced wholesale. */
  paths: string[];
  /** WHO published them — the hook instance's own token, never inspected, only compared. */
  owner: object | null;
  /** Publish one reading, taking ownership. LAST PUBLISH WINS, UNCONDITIONALLY. */
  publish(owner: object, paths: string[]): void;
  /** Clear `owner`'s reading if it is still the published one. See the header. */
  clearFor(owner: object): void;
}

export const useComposerAttachmentsMirror = create<ComposerAttachmentsMirrorState>()(
  (set, get) => ({
    paths: [],
    owner: null,
    publish: (owner, paths) => set({ paths: [...paths], owner }),
    clearFor: (owner) => {
      if (get().owner !== owner) return;
      set({ paths: [], owner: null });
    },
  }),
);

/**
 * Publish the compose box's current chip paths, taking ownership.
 *
 * Called from `useConciergeAttachments` in two places, and both are needed: from `apply` — the one
 * funnel every mutation of the box passes through, so this cannot drift behind it — and from a
 * mount effect, so a freshly mounted box owns the reading before any mutation happens.
 *
 * REPLACES rather than appends. That is what keeps this a mirror rather than a queue.
 */
export function publishComposerAttachmentPaths(owner: object, paths: string[]): void {
  useComposerAttachmentsMirror.getState().publish(owner, paths);
}

/** Clear `owner`'s reading if it is still the published one — the box's unmount path. */
export function clearComposerAttachmentPaths(owner: object): void {
  useComposerAttachmentsMirror.getState().clearFor(owner);
}

/**
 * The compose box's current chip paths, readable from a service.
 *
 * `[]` when no box is mounted, which is the fail-SAFE direction for the one caller that matters:
 * `publish_attach_media` refuses rather than uploading a path nothing can vouch for.
 */
export function composerAttachmentPaths(): string[] {
  return [...useComposerAttachmentsMirror.getState().paths];
}
