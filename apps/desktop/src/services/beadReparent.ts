// apps/desktop/src/services/beadReparent.ts
//
// The frontend half of `beads_reparent` — move a SET of beads under one epic, or take them off the
// epic they are under. Founder (bead `sparkle-xelans.2`): *"I want the individual beads to be able
// to be consolidated into a larger epic"* — beads filed weeks apart, grouped once the theme becomes
// clear. The Rust side (`beads_cmd.rs::reparent_beads`) landed first and had no caller at all; this
// is that caller.
//
// ══ ONE INVOKE PER GESTURE — THE BATCHING IS THE CONTRACT, NOT AN OPTIMISATION ═════════════════
// `build_reparent_args` puts every id into ONE `bd update <id>… --parent <epic>`, and its own doc
// says why a per-id loop is wrong: the beads store is a single embedded Dolt DB shared by every
// worktree and polled by this board every few seconds, so N separate mutations can fail halfway —
// leaving HALF a move with nothing recording which half — and the poll can land between two of them
// and paint an epic mid-assembly. A caller that loops `reparentBeads` over a selection re-creates
// exactly that, so these functions take a LIST and there is deliberately no single-id variant to
// reach for. `beadReparent.test.ts` asserts the one-call shape rather than the arguments alone.
//
// ══ UNPARENTING IS A NAMED FUNCTION, NOT AN EMPTY STRING AT THE CALL SITE ══════════════════════
// bd documents `--parent ""` as "remove parent", so on the wire the unparent path IS the empty
// string — and `build_reparent_args` goes out of its way to keep it (`build_update_args` would
// filter it out and reject the patch as empty). But an empty string is a terrible thing to require
// of a UI: an epic picker with nothing chosen, a trimmed-to-blank text field, or a `parent` read
// from a bead that has none all produce `""` by ACCIDENT, and every one of them would silently
// detach the selection instead of reporting that nothing was chosen. So {@link reparentBeads}
// REFUSES a blank parent and {@link unparentBeads} is the only way to reach that branch. The
// empty string is written in exactly one place in this file.
import { invoke } from "./ipc";
import { toBeadsError, type BeadsError } from "./beadsCommands";

/** Mirror of `notes::valid_bead_id` — the charset `require_id` checks before bd is handed anything.
 *
 *  Duplicated deliberately rather than round-tripped: the point of checking here is that the user
 *  gets a sentence in the UI instead of a rejected promise from a command that already refused. The
 *  Rust side still checks (it is the real boundary — this one is reachable only through this file);
 *  the two agreeing is pinned by `beadReparent.test.ts`, which asserts the exact ids Rust's own
 *  `valid_bead_id_forbids_flag_like_and_exotic_ids` test names.
 *
 *  The leading-`-` rule is the flag-injection guard: bd would parse `-s` as an option, not an id. */
export function isValidBeadId(id: string): boolean {
  return id.length > 0 && !id.startsWith("-") && /^[A-Za-z0-9._-]+$/.test(id);
}

/** A client-side refusal, shaped as the `BeadsError` the Rust side rejects with.
 *
 *  Same shape on purpose: a call site renders `.message` and branches on `.kind` without caring
 *  whether the refusal came from here or from bd. `invalidInput` is the kind `reparent_beads` uses
 *  for all four of these, and the messages are its wording verbatim so the two surfaces cannot
 *  drift into saying different things about the same input. */
function refuse(message: string): BeadsError {
  return { kind: "invalidInput", message, exitCode: null };
}

/** Everything both paths check, plus the single `invoke`. `parent` is already resolved: `""` for
 *  the unparent path, a validated id for the reparent path. */
async function sendReparent(
  projectPath: string,
  ids: readonly string[],
  parent: string,
): Promise<void> {
  // EVERY id BEFORE anything is sent, matching `reparent_beads` — a bad id in the middle would
  // otherwise be found only after bd had been handed the whole batch.
  if (ids.length === 0) throw refuse("no beads selected — nothing to re-parent");
  for (const id of ids) {
    if (!isValidBeadId(id)) throw refuse(`invalid bead id: ${id}`);
  }
  if (parent !== "") {
    if (!isValidBeadId(parent)) throw refuse(`invalid bead id: ${parent}`);
    // A bead may not be its own parent. bd does not forbid the cycle, and an epic containing
    // itself is a data repair rather than a rejected input — see `reparent_beads`.
    const hit = ids.find((id) => id === parent);
    if (hit !== undefined) throw refuse(`a bead cannot be its own parent: ${hit}`);
  }
  try {
    // ONE call, whatever the selection size. `ids` is spread into a plain array because the Tauri
    // bridge serializes the argument object and a `readonly` alias is only a compile-time view.
    await invoke<void>("beads_reparent", { projectPath, ids: [...ids], parent });
  } catch (e) {
    throw toBeadsError(e);
  }
}

/** Move every bead in `ids` under the epic `parent`, in ONE `bd update`.
 *
 *  Rejects with a {@link BeadsError} — `invalidInput` for an empty selection, a flag-shaped id, a
 *  blank `parent` (see the file header: that is NOT the unparent path, use {@link unparentBeads}),
 *  or a bead named as its own parent; whatever bd reported otherwise. */
export async function reparentBeads(
  projectPath: string,
  ids: readonly string[],
  parent: string,
): Promise<void> {
  // TRIMMED FIRST, then required to be non-blank. The Rust side trims too and reads `"  "` as
  // "remove the parent" rather than as a bead named two spaces — so a whitespace-only value that
  // got this far would unparent the selection under a label that says "move to epic".
  const target = parent.trim();
  if (target === "") throw refuse("choose an epic to move these beads under");
  return sendReparent(projectPath, ids, target);
}

/** Take every bead in `ids` off whatever epic it is under, in ONE `bd update`.
 *
 *  The only place the empty-string parent is written. Rejects with a {@link BeadsError} the same
 *  way {@link reparentBeads} does, minus the parent checks — there is no id to check. */
export async function unparentBeads(projectPath: string, ids: readonly string[]): Promise<void> {
  return sendReparent(projectPath, ids, "");
}
