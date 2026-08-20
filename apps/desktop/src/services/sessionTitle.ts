// Auto-naming from Claude Code's own session title. Claude Code writes an `ai-title` into each
// agent's transcript, derived from the FULL conversation (prompts, responses, attached images) —
// a far better name than our prompt-only Haiku summary, and free (already on disk). This bridge
// reads that title (Rust `agent_session_title`, which tails the worktree's newest transcript) and
// applies it as the authoritative auto-name. The same transcript is the substrate the prompt/
// response SEARCH feature will index, so this reader is the shared, reusable primitive for both.
//
// Best-effort throughout: no worktree, no title yet (the first turn hasn't summarized), or any
// backend error simply leaves the current name untouched — the store action respects a pinned
// (manually-renamed) name and de-dupes an unchanged title.
//
// ONE TITLE IS REFUSED: one summarized from SPARKLE'S OWN TEXT rather than from the agent's work.
// Sparkle writes into an agent's PTY on its own initiative (the nudge ladder's ping above all), and
// for a silent agent that ping is the only user turn there is — so the title is a summary of Sparkle
// talking to itself and naming the agent after it actively misleads. The backend therefore hands
// back the title AND the transcript turn it was derived from, and
// `titleIsSparkleTalkingToItself` (below) declines the tainted ones.
import { invoke } from "./ipc";
import { useProjectStore } from "../stores/projectStore";
import { normalizeAgentName } from "../engine/decodeEntities";
import { reportNamingOutcome } from "./selfReportObservability";
import { isSystemAuthoredPrompt } from "../engine/agentOriginated";
import type { AgentKind } from "../types";

/**
 * Read the agent's Claude Code session title and apply it (no-op until a title exists).
 *
 * `opts.backfill` marks a Tier-1 name-from-work poll: an agent whose pane is CLOSED and that still
 * holds its unpinned "Build N"/"Worker N" default (see agentNaming.isNameFromWorkCandidate). When such
 * an agent finally has a title, applying it is a FREE win we tally distinctly (`named_from_session_
 * title_backfill`) so we can measure how often Tier 1 rescues a stuck default before the paid Tier-2
 * backstop ever runs. `opts.kind` is only used to label that telemetry.
 */
export async function refreshAgentTitle(
  projectId: string,
  agentId: string,
  worktreePath: string | null,
  opts?: { backfill?: boolean; kind?: AgentKind },
): Promise<void> {
  if (!worktreePath) return; // worktree not created yet → no transcript to read
  try {
    const basis = await invoke<SessionTitle | null>("agent_session_title", { worktreePath });
    const title = basis?.title ?? null;
    if (title && title.trim() && !titleIsSparkleTalkingToItself(basis)) {
      useProjectStore.getState().applyAiTitle(projectId, agentId, title);
      // Record the Tier-1 free win ONLY when the apply actually landed. applyAiTitle no-ops if the
      // agent became pinned/self-named between the sidebar's candidate check and this async resolution
      // (~one poll interval), so re-read the store and confirm the title stuck before tallying — a
      // backfill candidate starts with no aiTitle, so `aiTitle === trimmed` proves it applied here.
      if (opts?.backfill && opts.kind) {
        const applied = useProjectStore
          .getState()
          .projects.find((p) => p.id === projectId)
          ?.agents.find((a) => a.id === agentId)?.aiTitle;
        // Compare against the NORMALIZED form: applyAiTitle decodes HTML entities out of the
        // model-authored title before storing it (see engine/decodeEntities), so comparing against
        // the raw text would read a successful apply of "Ship &amp; Verify" as a no-op and
        // under-count Tier-1 coverage for exactly the names that fix targets.
        if (applied === normalizeAgentName(title.trim())) {
          reportNamingOutcome("named_from_session_title_backfill", opts.kind);
        }
      }
    }
  } catch (e) {
    // A transient FS/IPC error must not break the sidebar; the next poll retries.
    console.debug("session-title refresh skipped:", e);
  }
}

/**
 * What `agent_session_title` hands back: the title, plus the transcript turn it was derived from.
 *
 * `firstPrompt` is a Rust `Option<String>`, and serde emits `Option::None` as JSON **`null`**, never
 * as an absent key — so this is `string | null`, NOT `firstPrompt?: string`. Typing it optional
 * would describe a shape the wire cannot produce (see AGENTS.md, "A Rust `Option` crosses the wire
 * as `null`").
 */
type SessionTitle = {
  title: string;
  /** The first human-role turn of the SAME transcript, or null when there is no evidence. */
  firstPrompt: string | null;
};

/**
 * Would adopting this title name the agent after SPARKLE'S OWN TEXT rather than its work?
 *
 * ── THE BUG THIS CLOSES ──────────────────────────────────────────────────────────────────────
 * Sparkle writes into an agent's PTY on its own initiative — the nudge ladder's automated ping most
 * of all — and those writes land in the transcript as ordinary user turns, indistinguishable from
 * the founder typing. An agent that booted with no brief and sat silent therefore has ONE user turn
 * (the ping), Claude Code summarizes it into the `ai-title`, and this bridge adopted it as the
 * agent's NAME. The founder asked three times why unnamed orchestrators kept appearing called
 * "Sparkle-nudge automated ping", and reasonably read those rows as agents doing nudge work. 112
 * transcripts on one machine carried a nudge-derived title.
 *
 * ── WHY THIS MATCHES THE PROMPT AND NOT THE TITLE ────────────────────────────────────────────
 * The obvious fix — refuse titles that LOOK nudge-y — is wrong in both directions, measured:
 *   • 39 tainted sessions have a title with no recognisable nudge wording at all ("Resume task
 *     progress"), so a title match misses them.
 *   • 19 sessions have a nudge-ish title and a REAL first turn, because they are agents legitimately
 *     working ON the nudge ladder ("Fix sparkle-nudge loop for completed goals", first turn "You own
 *     bead sparkle-…"). A title match would strip the honest name off exactly those.
 * The prompt marker is the invariant; the title's wording is not. It also covers every historical
 * variant at once ("Sparkle-nudge #8", "Resume sparkle-nudge task", "Sparkle-nudge automation"),
 * because all of them were summarized from a prompt carrying the same marker.
 *
 * ── FAIL OPEN, DELIBERATELY ──────────────────────────────────────────────────────────────────
 * `firstPrompt: null` is NO EVIDENCE (unreadable transcript, or no human turn inside Rust's sniff
 * window) — not proof of a clean transcript. Adopting the title there preserves the behavior every
 * correctly-named agent already relies on. The asymmetry is on purpose: a missed refusal costs one
 * misleading row that the next poll can still fix, whereas refusing on no evidence would silently
 * stop naming agents whose transcripts merely read oddly.
 *
 * A refusal is not a dead end. The agent keeps its provisional "Build N"/"Worker N" — honest about
 * having done nothing — and the rest of the naming ladder still runs, including the Tier-2
 * name-from-work backstop that names an agent from its ACTUAL work (see engine/agentNaming).
 */
function titleIsSparkleTalkingToItself(basis: SessionTitle | null): boolean {
  const first = basis?.firstPrompt;
  return typeof first === "string" && isSystemAuthoredPrompt(first);
}
