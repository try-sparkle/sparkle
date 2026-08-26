// adversarialReviewStore — one entry per (project root, branch) for the independent diff audit.
//
// KEYED BY ROOT **AND** BRANCH, and both halves are load-bearing. A verdict is a statement about a
// branch, and one app window routinely holds several projects with several branches each; keying on
// branch alone would let two projects' `feat/x` share an entry, which is the same class of bug the
// Rust side spends a filename hash preventing. The separator is `\u0001`, the same choice
// `pr_claims.rs` makes for the same reason: it cannot appear in a path or a branch name, so no pair
// can collide with another.
//
// ── THE STORE HOLDS A READING, NOT A JUDGEMENT ────────────────────────────────────────────────
// It stores whatever `adversarial_review_status` last said and never derives a verdict of its own.
// `gate` is computed in Rust, from the config that lives there — recomputing it here would be a
// second implementation of one rule, and the two would disagree the first time either side changed.
//
// ── A FAILED RUN DOES NOT CLEAR A STATUS ──────────────────────────────────────────────────────
// `failRun` records the error and leaves the last status standing, because the two facts are
// independent: "the run could not start" says nothing about what the previous review found. What it
// must NOT do is leave `running` true — an entry stuck mid-run renders a permanently disabled
// button, which reads as "reviewing…" forever.
import { create } from "zustand";

import {
  type AdversarialReviewStatus,
  type AdversarialVerdict,
  normalizeVerdictKind,
  type ReviewGate,
} from "../services/adversarialReview";

/** Everything known about one branch's review. */
export interface AdversarialReviewEntry {
  /** The last status read, or `null` before the first one lands. */
  status: AdversarialReviewStatus | null;
  /** A review is in flight right now. */
  running: boolean;
  /** Why the last run or read failed, or `null`. Independent of `status`. */
  error: string | null;
  /** When `status` was last written, for a surface that wants to say how fresh the reading is. */
  updatedAtMs: number;
}

interface AdversarialReviewState {
  entries: Record<string, AdversarialReviewEntry>;
  setStatus: (root: string, branch: string, status: AdversarialReviewStatus, nowMs?: number) => void;
  beginRun: (root: string, branch: string) => void;
  /** A finished run: fold the fresh record into the existing status so the panel updates without a
   *  second round trip, clear `running`, clear `error`. */
  finishRun: (root: string, branch: string, record: AdversarialVerdict, nowMs?: number) => void;
  failRun: (root: string, branch: string, error: string) => void;
  clear: (root: string, branch: string) => void;
}

/** The key separator — see the header. `\u0001` cannot appear in a path or a branch name. */
const KEY_SEP = "\u0001";

export function entryKey(root: string, branch: string): string {
  return `${root.trim().replace(/[/\\]+$/, "")}${KEY_SEP}${branch.trim()}`;
}

const EMPTY: AdversarialReviewEntry = {
  status: null,
  running: false,
  error: null,
  updatedAtMs: 0,
};

/** The entry for a pair, or a stable EMPTY. Exported so a component can read one pair without
 *  subscribing to the whole map — and so the EMPTY it gets is REFERENTIALLY STABLE, which is what
 *  keeps a `useStore(s => selectEntry(s, …))` selector from re-rendering on every unrelated write. */
export function selectEntry(
  state: AdversarialReviewState,
  root: string,
  branch: string,
): AdversarialReviewEntry {
  return state.entries[entryKey(root, branch)] ?? EMPTY;
}

function patch(
  entries: Record<string, AdversarialReviewEntry>,
  key: string,
  next: Partial<AdversarialReviewEntry>,
): Record<string, AdversarialReviewEntry> {
  const prev = entries[key] ?? EMPTY;
  return { ...entries, [key]: { ...prev, ...next } };
}

export const useAdversarialReviewStore = create<AdversarialReviewState>((set) => ({
  entries: {},

  setStatus: (root, branch, status, nowMs = Date.now()) =>
    set((s) => ({
      entries: patch(s.entries, entryKey(root, branch), {
        status,
        error: null,
        updatedAtMs: nowMs,
      }),
    })),

  beginRun: (root, branch) =>
    set((s) => ({
      entries: patch(s.entries, entryKey(root, branch), { running: true, error: null }),
    })),

  finishRun: (root, branch, record, nowMs = Date.now()) =>
    set((s) => {
      const key = entryKey(root, branch);
      const prev = s.entries[key] ?? EMPTY;
      // A fresh run reviewed the branch's CURRENT head by construction, so the record is not stale
      // — and saying so here is what stops the panel showing "stale" for a review that just
      // finished, which would send the user round the loop again for no reason.
      //
      // ── `gate` IS RECOMPUTED, NOT CARRIED OVER (roborev job 69293, High) ────────────────────
      // Carrying the previous `gate` publishes an internally inconsistent status: a fresh
      // `verdict: "block"` sitting beside `gate: "clear"` — and BOTH docs tell a consumer to branch
      // on `gate`, never on `record.verdict`. That is a fail-OPEN reading of the one field this
      // feature exists to gate on, and it is not merely a render-frame window: the panel's
      // corrective `refresh()` can itself fail (its catch records the error and leaves the status
      // standing), so a blocking verdict could sit here reporting "does not block" indefinitely.
      //
      // This is a deliberate LOCAL MIRROR of one branch of Rust `gate_for`, and only that branch is
      // reachable here: the project is enabled (a disabled one refuses the run outright), a record
      // is present (we just produced it) and it is not stale (we just reviewed this head). So every
      // earlier arm of that function is settled by construction and the only question left is the
      // `block_on` membership test — which is why `blockOn` is echoed on the status at all. The
      // next status read still overwrites this with the backend's own answer.
      //
      // ⚠️ EACH ENTRY IS PARSED, NOT STRING-MATCHED (roborev job 69330, High). Rust does
      // `block_on.iter().any(|v| Verdict::parse(v) == record.verdict)`, and `[adversarial_review]
      // .block_on`'s own doc ADVERTISES lenient spelling (`ship_with_notes` ≡ `ship-with-notes`);
      // config only trims and lowercases, so a non-canonical entry reaches the wire verbatim. A raw
      // `.includes()` therefore reproduced the very fail-open this recompute exists to close, just
      // narrowed to the projects that took the documented spelling at its word — and it also
      // swallowed a TYPO, since Rust parses an unrecognised entry to `unknown`, making an `unknown`
      // verdict blocking on the backend while this said `clear`. `normalizeVerdictKind` is exactly
      // `Verdict::parse`, which is why it is imported rather than re-spelled here.
      const gate: ReviewGate = prev.status
        ? prev.status.enabled === false
          ? "off"
          : prev.status.blockOn.some((v) => normalizeVerdictKind(v) === record.verdict)
            ? "blocking"
            : "clear"
        : "not-reviewed";
      const status: AdversarialReviewStatus | null = prev.status
        ? {
            ...prev.status,
            record,
            headSha: record.reviewedSha || prev.status.headSha,
            stale: false,
            gate,
          }
        : null;
      return {
        entries: patch(s.entries, key, {
          status,
          running: false,
          error: null,
          updatedAtMs: nowMs,
        }),
      };
    }),

  failRun: (root, branch, error) =>
    set((s) => ({
      // `running: false` is the load-bearing half — an entry stuck mid-run renders a permanently
      // disabled button that reads as "reviewing…" forever. The previous status is left standing:
      // "the run could not start" says nothing about what the previous review found.
      entries: patch(s.entries, entryKey(root, branch), { running: false, error }),
    })),

  clear: (root, branch) =>
    set((s) => {
      const next = { ...s.entries };
      delete next[entryKey(root, branch)];
      return { entries: next };
    }),
}));
