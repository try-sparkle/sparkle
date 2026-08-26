// ticketIntakeStore — the parsed ticket references and their fetch state (bead `.6`).
//
// IN-MEMORY ONLY, like `verifyGateStore` and for the same reason: the durable copies live
// elsewhere. The ticket is the tracker's; the downloaded screenshots are files on disk written by
// `ticket_intake.rs`. A persisted copy in the webview's `localStorage` could only ever drift from
// both — and it would be the one place in the app where somebody's ticket bodies were cached with
// no way to clear them.
//
// KEYED BY projectRoot, because intake is a property of a repo: which tracker, which credential,
// where the attachments land. Two projects open at once must not share a paste box.
//
// ══ EVERY OPTIONAL FIELD IS `T | null`, NEVER `T | undefined` ═══════════════════════════════════
// serde's derive emits an `Option::None` as the key with an explicit `null` value; it omits the key
// only under `#[serde(skip_serializing_if)]`, which `ticket_intake.rs` does not use anywhere. So a
// field written `provider?: Provider` describes a shape the wire CANNOT PRODUCE. The failure mode
// is silence (bead `sparkle-16y6h`): an all-or-nothing parser rejects the whole payload, falls back
// to its "we did not look" default, and the feature is permanently inert with nothing logged.
// `provider` is the field this bites hardest on — it is `null` for exactly the AMBIGUOUS reference
// this feature exists to surface, so a type that excluded null would break the interesting case and
// only the interesting case. Fixtures carry `null` too, or they test what production never sends.
import { create } from "zustand";

/** Which tracker. Mirrors `ticket_intake::Provider` (serde `snake_case`). */
export type Provider = "linear" | "jira" | "github" | "beads";

/**
 * One parsed reference. Mirrors `ticket_intake::TicketRef` field for field.
 *
 * `provider === null` IFF `ambiguous` — the shape a bare `ENG-1234` takes when no
 * `default_provider` is configured. The two are kept as separate fields deliberately: a consumer
 * that only checks `provider` still has to handle null, and a consumer that reads `ambiguous` says
 * what it means.
 */
export interface TicketRef {
  raw: string;
  provider?: Provider | null;
  candidates: Provider[];
  ambiguous: boolean;
  key: string;
  url?: string | null;
  branch: string;
  commitPrefix: string;
  prTitle: string;
  /** Why it is ambiguous, or where a non-obvious answer came from. */
  note?: string | null;
}

/** One image a ticket referred to. Mirrors `ticket_intake::IntakedImage`.
 *
 *  A FAILED download is a ROW with `ok: false`, never a missing entry — which is what lets the UI
 *  say "3 images, 1 could not be fetched" instead of showing 2 and implying that was all. */
export interface IntakedImage {
  sourceUrl: string;
  localPath?: string | null;
  ok: boolean;
  error?: string | null;
  bytes: number;
  /**
   * The stored file's media type, e.g. `image/png`.
   *
   * READ IT BEFORE PAINTING AN `<img>`. A ticket can attach a `log.txt` or a PDF, and an `<img>`
   * pointed at one paints a broken glyph on a row marked `ok: true` with a byte count and no
   * reason — which is the exact "a good download is indistinguishable from a dead one" failure the
   * `data:` URL work exists to close. Rust already refuses to download a non-image, so this is the
   * second of two locks on the same door; empty string when the download failed.
   */
  mime: string;
}

/** A fetched ticket. Mirrors `ticket_intake::IntakedTicket`. */
export interface IntakedTicket {
  provider: Provider;
  key: string;
  title: string;
  body: string;
  comments: string[];
  images: IntakedImage[];
  branch: string;
  commitPrefix: string;
  prTitle: string;
  url?: string | null;
}

/** One reference the batch could not intake. Mirrors `ticket_intake::RefFailure`. */
export interface RefFailure {
  raw: string;
  key: string;
  provider?: Provider | null;
  error: string;
}

/** A batch's per-reference outcomes. Mirrors `ticket_intake::BatchResult`. */
export interface BatchResult {
  tickets: IntakedTicket[];
  failures: RefFailure[];
}

/** One provider's readiness. Mirrors `ticket_intake::ProviderStatus`. NO CREDENTIAL is on it. */
export interface ProviderStatus {
  provider: Provider;
  enabled: boolean;
  configured: boolean;
  note: string;
}

/** The cheap poll answer. Mirrors `ticket_intake::TicketIntakeStatus`. */
export interface TicketIntakeStatus {
  enabled: boolean;
  defaultProvider?: Provider | null;
  providers: ProviderStatus[];
  imageDir: string;
}

/** What the panel needs about one project. */
export interface TicketIntakeEntry {
  /** What is in the paste box. Kept in the store so the panel is renderable from a seed. */
  text: string;
  refs: TicketRef[];
  tickets: IntakedTicket[];
  failures: RefFailure[];
  /** True while a fetch is in flight. Set optimistically on click. */
  fetching: boolean;
  /** The last failure of a COMMAND (the invoke itself threw), distinct from a per-ref failure. */
  error: string | null;
  /** `null` until a status has been read. NOT `false` — "we have not looked" and "intake is off"
   *  are different, and a panel that renders them the same tells the user their config is wrong
   *  when the truth is that nothing has been asked yet. */
  status: TicketIntakeStatus | null;
  /**
   * THE FAN-OUT INTENT. The keys the user asked to dispatch, in click order.
   *
   * WHY AN INTENT AND NOT A CALL: dispatching a worker is `worktree.rs` plus the spawn surface,
   * files this slice does not own (see `PRD/ticket-system-intake.md`). Rather than reach into a
   * sibling's file, the panel records WHAT WAS ASKED FOR here and whoever mounts the panel reads
   * it. That keeps the front door honest — the button does something observable — without
   * pretending the wiring exists.
   */
  dispatchRequests: string[];
}

/** The blank entry — ONE FROZEN INSTANCE, not a fresh object per call.
 *
 *  `entryFor` is read inside a zustand selector; a selector that BUILDS an object returns a new
 *  reference every render, `Object.is` never short-circuits, and React re-renders forever — the
 *  loop `verifyGateStore` measured as "Maximum update depth exceeded" on exactly the first-run case
 *  the panel exists to handle. `Object.freeze` makes the shared instance safe to hand out. */
const EMPTY_ENTRY: TicketIntakeEntry = Object.freeze({
  text: "",
  refs: Object.freeze<TicketRef[]>([]) as TicketRef[],
  tickets: Object.freeze<IntakedTicket[]>([]) as IntakedTicket[],
  failures: Object.freeze<RefFailure[]>([]) as RefFailure[],
  fetching: false,
  error: null,
  status: null,
  dispatchRequests: Object.freeze<string[]>([]) as string[],
});

export function emptyEntry(): TicketIntakeEntry {
  return EMPTY_ENTRY;
}

interface TicketIntakeState {
  byProject: Record<string, TicketIntakeEntry>;
  patch: (projectRoot: string, next: Partial<TicketIntakeEntry>) => void;
  /** Fold a parse reply in. Clears nothing else — a re-parse while results are on screen keeps
   *  them, because the user is usually editing the paste to ADD a ticket. */
  applyRefs: (projectRoot: string, refs: TicketRef[]) => void;
  applyBatch: (projectRoot: string, batch: BatchResult) => void;
  applyStatus: (projectRoot: string, status: TicketIntakeStatus) => void;
  /** Record that a ticket was asked to be dispatched. See {@link TicketIntakeEntry.dispatchRequests}. */
  requestDispatch: (projectRoot: string, key: string) => void;
  forget: (projectRoot: string) => void;
}

function sameEntry(a: TicketIntakeEntry, b: TicketIntakeEntry): boolean {
  return (
    a.text === b.text &&
    a.refs === b.refs &&
    a.tickets === b.tickets &&
    a.failures === b.failures &&
    a.fetching === b.fetching &&
    a.error === b.error &&
    a.status === b.status &&
    a.dispatchRequests === b.dispatchRequests
  );
}

export const useTicketIntakeStore = create<TicketIntakeState>((set, get) => ({
  byProject: {},

  patch: (projectRoot, next) => {
    const prev = get().byProject[projectRoot] ?? emptyEntry();
    const merged = { ...prev, ...next };
    if (sameEntry(prev, merged) && get().byProject[projectRoot]) return;
    set((s) => ({ byProject: { ...s.byProject, [projectRoot]: merged } }));
  },

  applyRefs: (projectRoot, refs) => {
    get().patch(projectRoot, { refs, error: null });
  },

  applyBatch: (projectRoot, batch) => {
    get().patch(projectRoot, {
      tickets: batch.tickets ?? [],
      failures: batch.failures ?? [],
      error: null,
    });
  },

  applyStatus: (projectRoot, status) => {
    get().patch(projectRoot, { status });
  },

  requestDispatch: (projectRoot, key) => {
    const prev = get().byProject[projectRoot] ?? emptyEntry();
    // Idempotent: pressing the button twice for one ticket is one request, not two workers.
    if (prev.dispatchRequests.includes(key)) return;
    get().patch(projectRoot, { dispatchRequests: [...prev.dispatchRequests, key] });
  },

  forget: (projectRoot) => {
    if (!get().byProject[projectRoot]) return;
    set((s) => {
      const next = { ...s.byProject };
      delete next[projectRoot];
      return { byProject: next };
    });
  },
}));

/** One project's entry, or a blank one. SAFE INSIDE A SELECTOR — see {@link EMPTY_ENTRY}. */
export function entryFor(
  state: Pick<TicketIntakeState, "byProject">,
  projectRoot: string,
): TicketIntakeEntry {
  return state.byProject[projectRoot] ?? EMPTY_ENTRY;
}

/** Human name for a provider. Words, not emoji — the founder's standing rule; the panel pairs
 *  these with `react-icons/fi` glyphs. */
export function providerLabel(p: Provider | null | undefined): string {
  switch (p) {
    case "linear":
      return "Linear";
    case "jira":
      return "Jira";
    case "github":
      return "GitHub";
    case "beads":
      return "beads";
    default:
      return "Unknown tracker";
  }
}

/**
 * The sentence for one reference's provider.
 *
 * AMBIGUITY IS SAID OUT LOUD. "Linear or Jira — pick one" is a question the reader can answer; a
 * silently-chosen tracker is a wrong answer they will not find out about until an agent is pointed
 * at the wrong issue.
 */
export function providerSentence(ref: TicketRef): string {
  if (!ref.ambiguous && ref.provider) return providerLabel(ref.provider);
  const names = (ref.candidates ?? []).map(providerLabel);
  if (names.length === 0) return "Unknown tracker";
  return `${names.join(" or ")} — pick one`;
}

/**
 * "3 images, 1 could not be fetched", or "" when there is nothing to say.
 *
 * COUNTS THE FAILURES, deliberately. Linear's attachment links expire in about five minutes, so a
 * failed download is the EXPECTED failure of this feature, not an exotic one — and a strip that
 * simply showed fewer thumbnails would report the loss as an absence nobody could notice.
 */
export function imageSummary(images: IntakedImage[]): string {
  const total = images.length;
  if (total === 0) return "";
  const bad = images.filter((i) => !i.ok).length;
  const noun = total === 1 ? "image" : "images";
  if (bad === 0) return `${total} ${noun}`;
  return `${total} ${noun}, ${bad} could not be fetched`;
}

/** Is this row something an `<img>` may be pointed at? See {@link IntakedImage.mime}. */
export function isRenderableImage(img: IntakedImage): boolean {
  return img.ok && !!img.localPath && (img.mime ?? "").startsWith("image/");
}

/** `2048` → `2.0 KB`. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Is this project ready to FETCH a reference for `provider`?
 *
 * THREE STATES, NOT TWO, and collapsing them is the way to get this wrong: a status we have not
 * read yet is not the same as intake being switched off, which is not the same as a provider with
 * no credential. Each needs a different sentence, so each gets a different answer here.
 */
export function fetchReadiness(
  status: TicketIntakeStatus | null,
  provider: Provider | null | undefined,
): { ready: boolean; reason: string } {
  if (!status) return { ready: false, reason: "checking how intake is configured…" };
  if (!status.enabled) {
    return { ready: false, reason: "ticket intake is off — set [ticket_intake].enabled = true" };
  }
  if (!provider) {
    return { ready: false, reason: "pick a tracker for this reference first" };
  }
  const row = status.providers.find((p) => p.provider === provider);
  if (!row) return { ready: false, reason: `${providerLabel(provider)} is not available` };
  if (!row.enabled) return { ready: false, reason: `${providerLabel(provider)} is switched off` };
  if (!row.configured) return { ready: false, reason: row.note };
  return { ready: true, reason: row.note };
}
