// Which beads does a LANDED commit already name? The TS half of Rust `bead_landed::bead_landed_ids`,
// which runs `scripts/bead-landed-check.sh` and keeps its LANDED rows (bead sparkle-5wjy5a).
//
// `null` IS THE ONLY FAILURE VALUE. An unregistered command, a missing script, a timeout or a
// verdict outside the script's space all answer `null` — "could not tell" — and never an empty set,
// because an empty set is an answer ("none of these landed") and the caller would act on it.
import { invoke } from "@tauri-apps/api/core";

export async function landedBeadIds(
  projectPath: string,
  ids: readonly string[],
): Promise<ReadonlySet<string> | null> {
  if (ids.length === 0) return new Set();
  try {
    const reply = await invoke<unknown>("bead_landed_ids", { root: projectPath, ids: [...ids] });
    if (!Array.isArray(reply) || !reply.every((x) => typeof x === "string")) return null;
    return new Set(reply as string[]);
  } catch {
    return null;
  }
}
